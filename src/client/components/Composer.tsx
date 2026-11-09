import {
  ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Eye, Folder,
  LoaderCircle, ShieldAlert, ShieldCheck, Square, X, Plus, MessageSquare, Sparkles, ListTodo,
  FileText, RotateCw, CornerDownRight, ListEnd
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { v4 as randomUUID } from 'uuid';
import { permissionDescription, permissionLabel, type PermissionProfile } from '../../shared/permissions';
import type { ComposerAttachment, ComposerDocumentAttachment, ContextUsage, ModelInfo, ProjectInfo, SkillInfo, SkillsResult } from '../types';
import { findModelInfo, modelDisplayName, reasoningLabel, reasoningOptionsWithInherit } from '../workspace-model';
import { findSlashCommand, parseSlashQuery, slashOptions, type SlashCommandId, type SlashOption } from '../slash-commands';
import { composerKeyboardAction, insertComposerNewline } from '../composer-keyboard';
import { SlashMenu } from './SlashMenu';
import { ImagePreview } from './ImagePreview';
import { useComposerDraft } from './ComposerDrafts';
import { submittedComposerDraft, type ComposerInput } from '../composer-drafts';
import { retainDocuments, uploadDocument } from '../document-attachments';
import { PreviewLink } from './PreviewLinks';

interface ComposerProps {
  variant: 'home' | 'thread';
  layout: 'desktop' | 'mobile';
  model: string;
  effort: string;
  models: ModelInfo[];
  permissions: string;
  permissionProfiles: PermissionProfile[];
  onPermissionsChange: (permissions: string) => Promise<void>;
  projects?: ProjectInfo[];
  selectedProjectId?: string;
  activeTurnId?: string | null;
  focusRequest?: number;
  insertRequest?: { id: number; text: string } | null;
  draftKey?: string;
  temporary?: boolean;
  queueMessages?: boolean;
  initialInput?: { text: string; attachments: ComposerAttachment[]; skills: SkillInfo[] };
  disabled?: boolean;
  placeholder?: string;
  onProjectChange?: (projectId: string) => void;
  onModelChange: (model: string) => void | Promise<void>;
  onEffortChange: (effort: string) => void | Promise<void>;
  onSubmit: (text: string, attachments: ComposerAttachment[], skills: SkillInfo[], submitted?: ComposerInput) => Promise<void>;
  onCommand: (command: SlashCommandId, argument: string) => Promise<void>;
  loadSkills: () => Promise<SkillsResult>;
  skillScope: string;
  hasSavedThread: boolean;
  mode: 'default' | 'plan';
  contextUsage?: ContextUsage;
  onStop?: () => Promise<void>;
  onError: (error: unknown) => void;
}

export function Composer({
  variant, layout, model, effort, models, permissions, permissionProfiles, onPermissionsChange,
  projects = [], selectedProjectId = '', activeTurnId, focusRequest = 0, insertRequest,
  draftKey = variant, disabled = false, placeholder, onProjectChange,
  onModelChange, onEffortChange, onSubmit, onStop, onError, contextUsage,
  onCommand, loadSkills, skillScope, hasSavedThread, mode, temporary = false, initialInput, queueMessages = false,
}: ComposerProps) {
  const controlId = useId();
  const { text: draft, attachments, skills: selectedSkills, sending, owner, recoveryNotice } = useComposerDraft(draftKey, temporary, initialInput);
  const setDraft = (text: string) => owner.update(current => ({ ...current, text }));
  const setSending = (sending: boolean) => owner.update(current => ({ ...current, sending }));
  const setAttachments = (change: ComposerAttachment[] | ((current: ComposerAttachment[]) => ComposerAttachment[])) =>
    owner.update(current => ({ ...current, attachments: typeof change === 'function' ? change(current.attachments) : change }));
  const setSelectedSkills = (change: SkillInfo[] | ((current: SkillInfo[]) => SkillInfo[])) =>
    owner.update(current => ({ ...current, skills: typeof change === 'function' ? change(current.skills) : change }));
  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [menu, setMenu] = useState<'settings' | 'models' | 'permissions' | 'projects' | null>(null);
  const [renderedMenu, setRenderedMenu] = useState<typeof menu>(null);
  const [popoverPhase, setPopoverPhase] = useState<'enter' | 'idle' | 'exit'>('enter');
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const draftRef = useRef(draft);
  const inserted = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const permissionButtonRef = useRef<HTMLButtonElement>(null);
  const projectButtonRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const commandRunningRef = useRef(false);
  const skillsLoaderRef = useRef(loadSkills);
  const skillScopeRef = useRef(skillScope);
  skillsLoaderRef.current = loadSkills;
  const contextWindow = contextUsage?.modelContextWindow;
  const usedTokens = contextUsage?.last.totalTokens;
  const contextPercent = contextWindow && usedTokens != null
    ? Math.min(100, Math.max(0, usedTokens / contextWindow * 100)) : null;
  const modelInfo = findModelInfo(models, model);
  const effortOptions = useMemo(() => reasoningOptionsWithInherit(modelInfo), [modelInfo]);
  const activeMenu = renderedMenu ?? menu;
  const menuLabel = activeMenu === 'permissions' ? '访问权限' : activeMenu === 'models' ? '模型' : activeMenu === 'projects' ? '项目' : '推理强度';
  draftRef.current = draft;
  const slashQuery = parseSlashQuery(draft);
  const slashOpen = focused && Boolean(slashQuery) && !slashDismissed && !menu && !sending && !disabled;
  const skillsOnly = /^\/skills[ \t]/i.test(draft);
  const options = useMemo(() => slashOptions(slashQuery ?? { name: '', argument: '' }, skills, {
    hasThread: hasSavedThread, running: Boolean(activeTurnId), skillsOnly
  }), [slashQuery?.name, slashQuery?.argument, skills, hasSavedThread, activeTurnId, skillsOnly]);
  const slashId = `slash-${controlId}`;

  useEffect(() => {
    if (menu) {
      setRenderedMenu(menu);
      setPopoverPhase('enter');
      const timer = window.setTimeout(() => setPopoverPhase('idle'), 180);
      return () => window.clearTimeout(timer);
    }
    if (!renderedMenu) return;
    setPopoverPhase('exit');
    const timer = window.setTimeout(() => {
      setRenderedMenu(null);
      setPopoverPhase('enter');
    }, 150);
    return () => window.clearTimeout(timer);
  }, [menu]);

  const updateDraft = (text: string) => {
    draftRef.current = text;
    setDraft(text);
    setSlashDismissed(false);
  };

  const insertNewline = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const next = insertComposerNewline(draftRef.current, {
      start: textarea.selectionStart ?? draftRef.current.length,
      end: textarea.selectionEnd ?? draftRef.current.length
    });
    updateDraft(next.text);
    window.requestAnimationFrame(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus({ preventScroll: true });
      current.setSelectionRange(next.caret, next.caret);
    });
  };
  useEffect(() => {
    if (!insertRequest || inserted.current === insertRequest.id) return;
    inserted.current = insertRequest.id;
    updateDraft([draftRef.current, insertRequest.text].filter(Boolean).join('\n'));
    textareaRef.current?.focus({ preventScroll: true });
  }, [insertRequest]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (layout !== 'mobile' || !textarea) return;
    const beforeInput = (event: InputEvent) => {
      if (!event.cancelable || event.isComposing ||
          (event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph')) return;
      event.preventDefault();
      insertNewline();
    };
    textarea.addEventListener('beforeinput', beforeInput);
    return () => textarea.removeEventListener('beforeinput', beforeInput);
  }, [layout, draftKey, temporary]);
  useEffect(() => {
    setSlashIndex(Math.max(0, options.findIndex((option) => !option.disabledReason)));
  }, [draft, skills, hasSavedThread, activeTurnId]);
  useEffect(() => {
    if (skillScopeRef.current === skillScope) return;
    skillScopeRef.current = skillScope;
    setSkills([]);
    setSelectedSkills([]);
    setSkillsError(null);
  }, [skillScope]);
  useEffect(() => {
    if (!slashOpen) return;
    let cancelled = false;
    setSkillsLoading(true);
    void skillsLoaderRef.current().then((result) => {
      if (cancelled) return;
      setSkills(result.skills);
      setSkillsError(result.errors.length ? `部分技能读取失败：${result.errors[0]?.message}` : null);
    }).catch((error: Error) => {
      if (!cancelled) setSkillsError(`无法读取技能：${error.message}`);
    }).finally(() => { if (!cancelled) setSkillsLoading(false); });
    return () => { cancelled = true; };
  }, [slashOpen, skillScope]);

  const upload = async (attachment: ComposerDocumentAttachment) => {
    if (!attachment.file) return;
    setAttachments(current => current.map(entry => entry.id === attachment.id
      ? { ...attachment, status: 'uploading' as const, error: '' } : entry));
    try {
      const document = await uploadDocument(attachment.file, attachment.id);
      setAttachments(current => current.map(entry => entry.id === attachment.id ? document : entry));
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传失败，请重试。';
      setAttachments(current => current.map(entry => entry.id === attachment.id
        ? { ...attachment, status: 'failed' as const, error: message } : entry));
    }
  };
  const addFiles = async (files: FileList | null) => {
    const input = fileRef.current;
    try {
      const results = await Promise.allSettled(Array.from(files ?? []).map(async (file) => {
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
          if (file.size > 20 * 1024 * 1024 || file.size === 0) throw new Error('单个 PDF 不能超过 20 MB，且不能为空。');
          const attachment: ComposerDocumentAttachment = { id: randomUUID(), name: file.name, kind: 'document',
            path: '', url: '', size: file.size, status: 'uploading', file };
          setAttachments(current => [...current, attachment]);
          await upload(attachment);
          return;
        }
        if (!file.type.startsWith('image/')) throw new Error('请选择图片或 PDF 文件。');
        if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB。');
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
          reader.readAsDataURL(file);
        });
        setAttachments(current => [...current, { id: randomUUID(), name: file.name, url }]);
      }));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) onError(failed.reason);
    } catch (error) { onError(error); }
    finally { if (input) input.value = ''; }
  };
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(() => {
    if (focusRequest > 0) textareaRef.current?.focus();
  }, [focusRequest]);

  const closeMenu = () => {
    const trigger = activeMenu === 'permissions' ? permissionButtonRef.current : activeMenu === 'projects' ? projectButtonRef.current : settingsButtonRef.current;
    setMenu(null);
    trigger?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!composerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setMenu(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      }
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    const updatePosition = () => {
      if (layout === 'mobile') {
        const top = composerRef.current?.getBoundingClientRect().top ?? window.innerHeight - 118;
        setPopoverStyle({
          position: 'fixed', left: 8, right: 8, width: 'auto',
          bottom: window.innerHeight - top + 8,
          maxHeight: Math.min(window.innerHeight * .55, top - 16),
          transformOrigin: '50% 100%'
        });
        return;
      }
      const trigger = menu === 'permissions' ? permissionButtonRef.current : menu === 'projects' ? projectButtonRef.current : settingsButtonRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const alignStart = menu === 'permissions' || menu === 'projects';
      const width = Math.min(alignStart ? 296 : 224, window.innerWidth - 24);
      setPopoverStyle({
        position: 'fixed',
        left: Math.max(12, Math.min(alignStart ? rect.left : rect.right - width, window.innerWidth - width - 12)),
        width,
        bottom: window.innerHeight - rect.top + 8,
        maxHeight: Math.max(120, rect.top - 20),
        transformOrigin: alignStart ? 'left bottom' : 'right bottom'
      });
    };
    updatePosition();
    const frame = requestAnimationFrame(() => {
      const root = popoverRef.current;
      (root?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
        root?.querySelector<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'))?.focus();
    });
    window.addEventListener('resize', updatePosition);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
    };
  }, [activeMenu, layout]);

  const changeSetting = async (action: () => void | Promise<void>) => {
    if (changingRef.current) return;
    changingRef.current = true;
    setChanging(true);
    try {
      await action();
      closeMenu();
    } catch (error) {
      onError(error);
    } finally {
      changingRef.current = false;
      setChanging(false);
    }
  };

  const chooseSlash = async (option: SlashOption) => {
    if (commandRunningRef.current || option.disabledReason || disabled) return;
    const source = draftRef.current;
    const query = parseSlashQuery(source);
    if (!query) return;
    if (option.skill) {
      setSelectedSkills((current) => current.some((entry) => entry.path === option.skill!.path) ? current : [...current, option.skill!]);
      updateDraft(skillsOnly ? '' : query.argument);
      textareaRef.current?.focus();
      return;
    }
    const command = option.command;
    if (!command) return;
    if (command === 'skills' || command === 'help') {
      updateDraft(command === 'skills' ? '/skills ' : '/');
      textareaRef.current?.focus();
      return;
    }
    commandRunningRef.current = true;
    setSending(true);
    try {
      if (command === 'model' || command === 'reasoning' || command === 'permissions') {
        if (query.argument.trim()) {
          const value = query.argument.trim();
          if (command === 'model') {
            const entry = findModelInfo(models, value) ??
              models.find((entry) => entry.displayName.toLocaleLowerCase() === value.toLocaleLowerCase());
            if (!entry) throw new Error('没有匹配的模型，请使用 /model 选择。');
            await onModelChange(entry.model);
          } else if (command === 'reasoning') {
            const entry = effortOptions.find((entry) => entry.value === value || entry.label === value);
            if (!entry) throw new Error('当前模型不支持该推理强度，请使用 /reasoning 选择。');
            await onEffortChange(entry.value);
          } else {
            const entry = permissionProfiles.find((entry) => entry.id === value || entry.id === `:${value}` || permissionLabel(entry.id) === value);
            if (!entry || entry.allowed === false) throw new Error('没有可用的匹配权限，请使用 /permissions 选择。');
            await onPermissionsChange(entry.id);
          }
        } else setMenu(command === 'model' ? 'models' : command === 'reasoning' ? 'settings' : 'permissions');
      } else {
        await onCommand(command, query.argument.trim());
      }
      if (command === 'new') { setAttachments([]); setSelectedSkills([]); }
      if (owner.get().text === source) updateDraft(
        command === 'plan' && !['on', 'off', ''].includes(query.argument.trim()) ? query.argument : ''
      );
    } catch (error) { onError(error); }
    finally {
      commandRunningRef.current = false;
      setSending(false);
    }
  };

  const submit = async () => {
    const submitted = owner.get();
    const text = submitted.text.trim();
    if (submitted.sending || disabled || changingRef.current) {
      if (changingRef.current) onError(new Error('模型设置仍在保存，请稍候再发送。'));
      return;
    }
    const query = parseSlashQuery(submitted.text);
    if (query) {
      const exact = findSlashCommand(query.name);
      const option = options.find((entry) => entry.command === exact?.id && Boolean(exact)) ??
        options.find((entry) => entry.skill?.name.toLocaleLowerCase() === query.name.toLocaleLowerCase());
      if (option) {
        if (option.disabledReason) onError(new Error(option.disabledReason));
        else await chooseSlash(option);
      } else if (slashOpen && options[slashIndex] && !options[slashIndex].disabledReason) {
        await chooseSlash(options[slashIndex]);
      } else onError(new Error('未知命令，请输入 / 选择可用命令。'));
      return;
    }
    if (!text && submitted.attachments.length === 0 && submitted.skills.length === 0) return;
    if (submitted.attachments.some(attachment => attachment.kind === 'document' && attachment.status)) {
      onError(new Error('请等待附件上传完成，或重试、移除上传失败的附件。')); return;
    }
    setSending(true);
    try {
      await retainDocuments(submitted.attachments);
      await onSubmit(text, submitted.attachments, submitted.skills, submitted);
      owner.update(current => submittedComposerDraft(current, submitted));
    } catch (error) {
      onError(error);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!onStop || stopping) return;
    setStopping(true);
    try { await onStop(); }
    catch (error) { onError(error); }
    finally { setStopping(false); }
  };
  const hasComposerContent = Boolean(draft.trim()) || attachments.length > 0 || selectedSkills.length > 0;

  return (
    <div className={`composer-wrap composer-wrap--${variant}`} ref={composerRef}>
      {slashOpen && <SlashMenu id={slashId} options={options} index={slashIndex} skillsOnly={skillsOnly}
        loading={skillsLoading} error={skillsError} anchor={composerRef}
        onSelect={(option) => void chooseSlash(option)} onIndex={setSlashIndex} onClose={() => setSlashDismissed(true)} />}
      {renderedMenu && createPortal(
        <>
          <button type="button" className={`composer-menu-dismiss${layout === 'mobile' ? ' composer-popover-backdrop' : ''}${popoverPhase === 'exit' ? ' is-exiting' : ''}`}
            aria-label="关闭菜单" onClick={closeMenu} tabIndex={-1} />
          <div ref={popoverRef}
            className={`composer-popover${layout === 'mobile' ? ' composer-popover--mobile' : ''} composer-popover--${popoverPhase}`}
            style={popoverStyle} role="menu"
            aria-label={menuLabel}
            onKeyDown={(event) => {
              const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)'
              )];
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
              }
              if (event.key === 'Home') { event.preventDefault(); options[0]?.focus(); }
              if (event.key === 'End') { event.preventDefault(); options.at(-1)?.focus(); }
              if (event.key === 'Tab' && layout === 'mobile') {
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
                if (event.shiftKey && document.activeElement === buttons[0]) {
                  event.preventDefault(); buttons.at(-1)?.focus();
                } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
                  event.preventDefault(); buttons[0]?.focus();
                }
              } else if (event.key === 'Tab') setMenu(null);
            }}
          >
            <div className="popover-heading">
              {activeMenu === 'models' && (
                <button type="button" className="icon-button icon-button--small" aria-label="返回推理强度"
                  title="返回推理强度" onClick={() => setMenu('settings')}><ArrowLeft size={15} /></button>
              )}
              <span>{menuLabel}</span>
              {layout === 'mobile' && <button type="button" className="icon-button" aria-label="关闭菜单" onClick={closeMenu}><X size={18} /></button>}
            </div>
            <div className="model-list">
              {activeMenu === 'projects' ? (
                <>
                  <button type="button" role="menuitemradio" className="model-option project-option"
                    aria-checked={!selectedProjectId} onClick={() => void changeSetting(() => onProjectChange?.(''))}>
                    <MessageSquare size={15} /><span>无项目</span>{!selectedProjectId && <Check size={15} aria-hidden="true" />}
                  </button>
                  {projects.map((project) => (
                    <button type="button" role="menuitemradio" className="model-option project-option" key={project.id}
                      title={project.roots[0]?.path} aria-checked={project.id === selectedProjectId}
                      onClick={() => void changeSetting(() => onProjectChange?.(project.id))}>
                      <Folder size={15} /><span>{project.name}</span>{project.id === selectedProjectId && <Check size={15} aria-hidden="true" />}
                    </button>
                  ))}
                </>
              ) : activeMenu === 'permissions' ? permissionProfiles.map((profile) => (
                <button type="button" role="menuitemradio" className="model-option" key={profile.id}
                  aria-checked={permissions === profile.id} title={permissionDescription(profile.id, profile.description)}
                  disabled={changing || profile.allowed === false}
                  onClick={() => void changeSetting(() => onPermissionsChange(profile.id))}>
                  <span className="model-option-copy"><span>{permissionLabel(profile.id)}</span>
                    <small>{permissionDescription(profile.id, profile.description)}</small></span>
                  {permissions === profile.id && <Check size={15} aria-hidden="true" />}
                </button>
              )) : activeMenu === 'models' ? models.map((entry) => (
                <button type="button" role="menuitemradio" className="model-option" key={entry.id}
                  aria-checked={entry.id === model || entry.model === model}
                  title={entry.description || entry.displayName} disabled={changing}
                  onClick={() => void changeSetting(() => onModelChange(entry.model))}>
                  <span className="model-option-copy"><span>{modelDisplayName(models, entry.model)}</span>
                    {entry.description && <small>{entry.description}</small>}</span>
                  {(entry.id === model || entry.model === model) && <Check size={15} aria-hidden="true" />}
                </button>
              )) : effortOptions.map((option) => (
                <button type="button" role="menuitemradio" className="model-option" key={option.value}
                  aria-checked={option.value === effort}
                  title={modelInfo?.supportedReasoningEfforts?.find(entry => entry.reasoningEffort === option.value)?.description ||
                    '推理强度影响模型思考深度、响应时间和用量。'} disabled={changing}
                  onClick={() => void changeSetting(() => onEffortChange(option.value))}>
                  <span>{option.label}</span>
                  {option.value === effort && <Check size={15} aria-hidden="true" />}
                </button>
              ))}
            </div>
            {activeMenu === 'settings' && <p className="settings-note model-menu-note">推理强度影响思考深度、响应时间和用量；可用档位由当前模型决定。</p>}
            {activeMenu === 'settings' && effortOptions.length === 1 &&
              <p className="settings-note model-menu-note">当前模型目录未返回可用推理档位，请稍后重试同步。</p>}
            {activeMenu === 'settings' && (
              <button type="button" role="menuitem" className="model-submenu-button" onClick={() => setMenu('models')}>
                <span>模型</span><span className="model-submenu-value">{modelDisplayName(models, model)}</span><ChevronRight size={15} />
              </button>
            )}
          </div>
        </>,
        document.body
      )}
      {recoveryNotice && <div className="draft-recovery-notice" role="status">
        <span>{recoveryNotice}</span><button type="button" className="icon-button" title="关闭提示" aria-label="关闭草稿提示"
          onClick={() => owner.update(current => ({ ...current, recoveryNotice: undefined }))}><X size={13} /></button>
      </div>}
      <div className="composer">
        {(attachments.length > 0 || selectedSkills.length > 0) && <div className="composer-context-tray">
          {selectedSkills.map((skill) => <div className="composer-context-chip" key={skill.path}>
            <Sparkles size={14} /><span>{skill.interface?.displayName || skill.name}</span>
            <button type="button" aria-label={`移除技能 ${skill.name}`}
              onClick={() => setSelectedSkills((current) => current.filter((entry) => entry.path !== skill.path))}><X size={12} /></button>
          </div>)}
          {attachments.map((attachment) => attachment.kind === 'document' ? (
            <div className="composer-document" key={attachment.id}>
              <FileText size={18} aria-hidden="true" />
              <div className="composer-document-label">
                {attachment.path ? <PreviewLink href={attachment.path} title={attachment.name}>{attachment.name}</PreviewLink>
                  : <span title={attachment.name}>{attachment.name}</span>}
                <small role={attachment.status ? 'status' : undefined}>
                  {attachment.status === 'uploading' ? '正在上传' : attachment.status === 'failed'
                    ? attachment.error : attachment.size != null ? `${(attachment.size / 1024 / 1024).toFixed(1)} MB` : 'PDF'}
                </small>
              </div>
              {attachment.status === 'uploading' && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
              {attachment.status === 'failed' && <button type="button" className="icon-button" title="重试上传"
                aria-label={`重试上传 ${attachment.name}`} onClick={() => void upload(attachment)}><RotateCw size={15} /></button>}
              <button type="button" className="icon-button" title="移除附件" aria-label={`移除 ${attachment.name}`}
                onClick={() => setAttachments(current => current.filter(entry => entry.id !== attachment.id))}><X size={15} /></button>
            </div>
          ) : <div className="composer-image" key={attachment.id}>
            <ImagePreview src={attachment.url} alt={attachment.name} />
            <button type="button" className="composer-image-remove" aria-label={`移除 ${attachment.name}`} title={`移除 ${attachment.name}`}
              onClick={() => setAttachments((current) => current.filter((image) => image.id !== attachment.id))}><X size={14} /></button>
          </div>)}
        </div>}
        <input type="file" ref={fileRef} hidden multiple accept="image/*,application/pdf,.pdf"
          onChange={(event) => void addFiles(event.target.files)} />
        <label className="sr-only" htmlFor={controlId}>{temporary ? '侧边聊天消息' : variant === 'home' ? '输入任务内容' : '继续当前任务'}</label>
        <textarea id={controlId} ref={textareaRef} value={draft}
          role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={slashOpen}
          aria-controls={slashOpen ? slashId : undefined}
          aria-activedescendant={slashOpen && options[slashIndex] ? `${slashId}-${slashIndex}` : undefined}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onPaste={(event) => {
            if (sending || disabled) return;
            const files = event.clipboardData.files;
            if ([...files].some((file) => file.type.startsWith('image/') || file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) {
              event.preventDefault(); void addFiles(files);
            }
          }}
          onChange={(event) => {
            updateDraft(event.target.value);
            setMenu(null);
          }}
          onKeyDown={(event) => {
            const action = composerKeyboardAction({
              layout,
              key: event.key,
              shiftKey: event.shiftKey,
              slashOpen,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode
            });
            if (action === 'none') return;
            if (action === 'submit') {
              event.preventDefault();
              void submit();
              return;
            }
            if (action === 'newline') {
              event.preventDefault();
              event.stopPropagation();
              insertNewline();
              return;
            }
            if (action === 'dismiss-slash') {
                event.preventDefault(); event.stopPropagation(); setSlashDismissed(true); return;
            }
            if (action === 'move-up' || action === 'move-down') {
              event.preventDefault();
              const enabled = options.map((option, index) => option.disabledReason ? -1 : index).filter((index) => index >= 0);
              const at = enabled.indexOf(slashIndex);
              setSlashIndex(enabled[(at + (action === 'move-down' ? 1 : -1) + enabled.length) % enabled.length] ?? 0);
              return;
            }
            if (action === 'choose-slash') {
              event.preventDefault();
              const option = options[slashIndex];
              if (option && !option.disabledReason) {
                void chooseSlash(option);
              }
            }
          }}
          placeholder={placeholder ?? (activeTurnId ? '补充要求' : variant === 'home' ? '有什么需要处理？' : '继续向 Codex 提问')}
          rows={1}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <button type="button" className="composer-circle-button composer-add" aria-label="添加图片或 PDF" title="添加图片或 PDF"
              disabled={sending || disabled} onClick={() => fileRef.current?.click()}><Plus size={15} /></button>
            {mode === 'plan' && <button type="button" className="composer-plan" title="退出计划模式"
              aria-label="退出计划模式" disabled={sending || disabled || Boolean(activeTurnId)}
              onClick={() => void onCommand('plan', 'off').catch(onError)}><ListTodo size={14} /><span>计划</span><X size={12} /></button>}
            {variant === 'home' && projects.length > 0 && (
              <button type="button" ref={projectButtonRef} className="project-picker"
                aria-label="选择项目" aria-haspopup="menu" aria-expanded={menu === 'projects'}
                title={projects.find((project) => project.id === selectedProjectId)?.name ?? '选择项目'}
                onClick={() => setMenu((current) => current === 'projects' ? null : 'projects')}>
                <Folder size={15} aria-hidden="true" /><span className="sr-only">选择项目</span>
                <span className="project-picker-label">{projects.find((project) => project.id === selectedProjectId)?.name ?? '选择项目'}</span>
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            )}
            <button type="button" ref={permissionButtonRef}
              className={`composer-permission${permissions === ':danger-full-access' ? ' composer-permission--full' : ''}`}
              aria-label={`访问权限：${permissionLabel(permissions)}`} title={permissionDescription(permissions)}
              aria-haspopup="menu" aria-expanded={menu === 'permissions'}
              disabled={disabled || permissionProfiles.length === 0}
              onClick={() => setMenu((current) => current === 'permissions' ? null : 'permissions')}>
              {permissions === ':read-only' ? <Eye size={15} /> : permissions === ':danger-full-access' ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
              <span>{permissionLabel(permissions)}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <button type="button" className="composer-setting" ref={settingsButtonRef}
              aria-haspopup="menu" aria-expanded={menu === 'settings' || menu === 'models'}
              disabled={models.length === 0 || changing}
              onClick={() => setMenu((current) => current === 'settings' || current === 'models' ? null : 'settings')}
              aria-label={`${modelDisplayName(models, model)}，${reasoningLabel(modelInfo, effort)}`}
              title={`${modelInfo?.description || modelDisplayName(models, model)}\n推理强度：${reasoningLabel(modelInfo, effort)}；影响思考深度、响应时间和用量。`}>
              <span>{modelDisplayName(models, model)}</span>
              {effort && <span className="composer-effort">{reasoningLabel(modelInfo, effort)}</span>}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            <span className="composer-turn-slot" data-thread-navigation-slot={variant === 'thread' ? '' : undefined} />
          </div>
          <div className="composer-submit">
            {contextPercent !== null && <span className="context-usage" role="img" tabIndex={0}
              aria-label={`上下文已用 ${Math.round(contextPercent)}%`}
              title={`上下文已用 ${Math.round(contextPercent)}%\n${usedTokens?.toLocaleString()} / ${contextWindow?.toLocaleString()} tokens`}
              style={{ '--context-percent': contextPercent } as CSSProperties}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <circle className="context-usage-track" cx="6" cy="6" r="5" pathLength="100" />
                <circle className="context-usage-progress" cx="6" cy="6" r="5" pathLength="100" />
              </svg>
            </span>}
            {activeTurnId && !hasComposerContent && (
              <button type="button" className="composer-stop" disabled={stopping} onClick={() => void stop()}
                aria-label="停止任务" title="停止任务">
                {stopping ? <LoaderCircle size={16} className="spin" /> : <Square size={13} fill="currentColor" />}
              </button>
            )}
            {(!activeTurnId || hasComposerContent || sending) && (
              <button type="button" className="composer-send" disabled={(!draft.trim() && attachments.length === 0 && selectedSkills.length === 0) ||
                attachments.some(attachment => attachment.kind === 'document' && Boolean(attachment.status)) ||
                sending || disabled || changing}
                 onClick={() => void submit()} aria-label={activeTurnId ? queueMessages ? '加入队列' : '发送补充要求' : '发送任务'}
                 title={activeTurnId ? queueMessages ? '加入队列' : '发送补充要求' : '发送任务'}>
                {sending ? <LoaderCircle size={17} className="spin" /> : activeTurnId && queueMessages
                  ? <ListEnd size={18} /> : activeTurnId ? <CornerDownRight size={18} /> : <ArrowUp size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
