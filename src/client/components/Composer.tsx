import {
  ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Eye, Folder,
  LoaderCircle, ShieldAlert, ShieldCheck, Square, X, Plus, Mic, MessageSquare, Sparkles, ListTodo
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { v4 as randomUUID } from 'uuid';
import { permissionLabel, type PermissionProfile } from '../../shared/permissions';
import type { ComposerAttachment, ContextUsage, ModelInfo, ProjectInfo, SkillInfo, SkillsResult } from '../types';
import { modelDisplayName, reasoningLabel, reasoningOptionsForModel } from '../workspace-model';
import { findSlashCommand, parseSlashQuery, slashOptions, type SlashCommandId, type SlashOption } from '../slash-commands';
import { composerKeyboardAction, insertComposerNewline } from '../composer-keyboard';
import { SlashMenu } from './SlashMenu';
import { ImagePreview } from './ImagePreview';
import { useComposerDraft } from './ComposerDrafts';
import { submittedComposerDraft } from '../composer-drafts';

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
  onSubmit: (text: string, attachments: ComposerAttachment[], skills: SkillInfo[]) => Promise<void>;
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
  onCommand, loadSkills, skillScope, hasSavedThread, mode, temporary = false, initialInput, queueMessages = false
}: ComposerProps) {
  const controlId = useId();
  const { text: draft, attachments, skills: selectedSkills, sending, owner } = useComposerDraft(draftKey, temporary, initialInput);
  const setDraft = (text: string) => owner.update(current => ({ ...current, text }));
  const setSending = (sending: boolean) => owner.update(current => ({ ...current, sending }));
  const setAttachments = (change: ComposerAttachment[] | ((current: ComposerAttachment[]) => ComposerAttachment[])) =>
    owner.update(current => ({ ...current, attachments: typeof change === 'function' ? change(current.attachments) : change }));
  const setSelectedSkills = (change: SkillInfo[] | ((current: SkillInfo[]) => SkillInfo[])) =>
    owner.update(current => ({ ...current, skills: typeof change === 'function' ? change(current.skills) : change }));
  const [changing, setChanging] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [listening, setListening] = useState(false);
  const [menu, setMenu] = useState<'settings' | 'models' | 'permissions' | 'projects' | null>(null);
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
  const recognitionRef = useRef<Dictation | null>(null);
  const commandRunningRef = useRef(false);
  const skillsLoaderRef = useRef(loadSkills);
  const skillScopeRef = useRef(skillScope);
  skillsLoaderRef.current = loadSkills;
  const speechConstructor = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
  const contextWindow = contextUsage?.modelContextWindow;
  const usedTokens = contextUsage?.last.totalTokens;
  const contextPercent = contextWindow && usedTokens != null
    ? Math.min(100, Math.max(0, usedTokens / contextWindow * 100)) : null;
  const modelInfo = models.find((entry) => entry.model === model);
  const effortOptions = useMemo(() => reasoningOptionsForModel(modelInfo), [modelInfo]);
  const menuLabel = menu === 'permissions' ? '访问权限' : menu === 'models' ? '模型' : menu === 'projects' ? '项目' : '推理强度';
  draftRef.current = draft;
  const slashQuery = parseSlashQuery(draft);
  const slashOpen = focused && Boolean(slashQuery) && !slashDismissed && !menu && !sending && !disabled;
  const skillsOnly = /^\/skills[ \t]/i.test(draft);
  const options = useMemo(() => slashOptions(slashQuery ?? { name: '', argument: '' }, skills, {
    hasThread: hasSavedThread, running: Boolean(activeTurnId), skillsOnly
  }), [slashQuery?.name, slashQuery?.argument, skills, hasSavedThread, activeTurnId, skillsOnly]);
  const slashId = `slash-${controlId}`;

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

  useEffect(() => () => { recognitionRef.current?.abort(); }, []);

  const dictate = () => {
    if (recognitionRef.current) { recognitionRef.current.stop(); return; }
    if (!speechConstructor) return;
    const recognition = new speechConstructor();
    recognitionRef.current = recognition;
    recognition.lang = document.documentElement.lang || navigator.language;
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => { recognitionRef.current = null; setListening(false); };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') onError(new Error(event.error === 'not-allowed' ? '请允许浏览器使用麦克风。' : '听写暂时不可用，请重试。'));
    };
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? '').join('');
      const current = draftRef.current;
      updateDraft(`${current}${current && !/\s$/.test(current) ? ' ' : ''}${transcript}`);
    };
    recognition.start();
  };

  const addFiles = async (files: FileList | null) => {
    const input = fileRef.current;
    try {
      const images = await Promise.all(Array.from(files ?? []).map(async (file) => {
        if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
        if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB。');
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
          reader.readAsDataURL(file);
        });
        return { id: randomUUID(), name: file.name, url };
      }));
      setAttachments((current) => [...current, ...images]);
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
    const trigger = menu === 'permissions' ? permissionButtonRef.current : menu === 'projects' ? projectButtonRef.current : settingsButtonRef.current;
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
          maxHeight: Math.min(window.innerHeight * .55, top - 16)
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
        maxHeight: Math.max(120, rect.top - 20)
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
  }, [layout, menu]);

  const changeSetting = async (action: () => void | Promise<void>) => {
    if (changing) return;
    setChanging(true);
    try {
      await action();
      closeMenu();
    } catch (error) {
      onError(error);
    } finally {
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
            const entry = models.find((entry) => entry.model === value || entry.displayName.toLocaleLowerCase() === value.toLocaleLowerCase());
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
    if (submitted.sending || disabled) return;
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
    setSending(true);
    try {
      await onSubmit(text, submitted.attachments, submitted.skills);
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

  return (
    <div className={`composer-wrap composer-wrap--${variant}`} ref={composerRef}>
      {slashOpen && <SlashMenu id={slashId} options={options} index={slashIndex} skillsOnly={skillsOnly}
        loading={skillsLoading} error={skillsError} anchor={composerRef}
        onSelect={(option) => void chooseSlash(option)} onIndex={setSlashIndex} onClose={() => setSlashDismissed(true)} />}
      {menu && createPortal(
        <>
          <button type="button" className={`composer-menu-dismiss${layout === 'mobile' ? ' composer-popover-backdrop' : ''}`}
            aria-label="关闭菜单" onClick={closeMenu} tabIndex={-1} />
          <div ref={popoverRef}
            className={`composer-popover${layout === 'mobile' ? ' composer-popover--mobile' : ''}`}
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
              {menu === 'models' && (
                <button type="button" className="icon-button icon-button--small" aria-label="返回推理强度"
                  title="返回推理强度" onClick={() => setMenu('settings')}><ArrowLeft size={15} /></button>
              )}
              <span>{menuLabel}</span>
              {layout === 'mobile' && <button type="button" className="icon-button" aria-label="关闭菜单" onClick={closeMenu}><X size={18} /></button>}
            </div>
            <div className="model-list">
              {menu === 'projects' ? (
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
              ) : menu === 'permissions' ? permissionProfiles.map((profile) => (
                <button type="button" role="menuitemradio" className="model-option" key={profile.id}
                  aria-checked={permissions === profile.id} disabled={changing || profile.allowed === false}
                  onClick={() => void changeSetting(() => onPermissionsChange(profile.id))}>
                  <span>{permissionLabel(profile.id)}</span>
                  {permissions === profile.id && <Check size={15} aria-hidden="true" />}
                </button>
              )) : menu === 'models' ? models.map((entry) => (
                <button type="button" role="menuitemradio" className="model-option" key={entry.id}
                  aria-checked={entry.model === model} title={entry.displayName} disabled={changing}
                  onClick={() => void changeSetting(() => onModelChange(entry.model))}>
                  <span>{modelDisplayName(models, entry.model)}</span>
                  {entry.model === model && <Check size={15} aria-hidden="true" />}
                </button>
              )) : effortOptions.map((option) => (
                <button type="button" role="menuitemradio" className="model-option" key={option.value}
                  aria-checked={option.value === effort} disabled={changing}
                  onClick={() => void changeSetting(() => onEffortChange(option.value))}>
                  <span>{option.label}</span>
                  {option.value === effort && <Check size={15} aria-hidden="true" />}
                </button>
              ))}
            </div>
            {menu === 'settings' && (
              <button type="button" role="menuitem" className="model-submenu-button" onClick={() => setMenu('models')}>
                <span>模型</span><span className="model-submenu-value">{modelDisplayName(models, model)}</span><ChevronRight size={15} />
              </button>
            )}
          </div>
        </>,
        document.body
      )}
      <div className="composer">
        {(attachments.length > 0 || selectedSkills.length > 0) && <div className="composer-context-tray">
          {selectedSkills.map((skill) => <div className="composer-context-chip" key={skill.path}>
            <Sparkles size={14} /><span>{skill.interface?.displayName || skill.name}</span>
            <button type="button" aria-label={`移除技能 ${skill.name}`}
              onClick={() => setSelectedSkills((current) => current.filter((entry) => entry.path !== skill.path))}><X size={12} /></button>
          </div>)}
          {attachments.map((attachment) => <div className="composer-image" key={attachment.id}>
            <ImagePreview src={attachment.url} alt={attachment.name} />
            <button type="button" className="composer-image-remove" aria-label={`移除 ${attachment.name}`} title={`移除 ${attachment.name}`}
              onClick={() => setAttachments((current) => current.filter((image) => image.id !== attachment.id))}><X size={14} /></button>
          </div>)}
        </div>}
        <input type="file" ref={fileRef} hidden multiple accept="image/*"
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
            if ([...files].some((file) => file.type.startsWith('image/'))) {
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
            <button type="button" className="composer-circle-button composer-add" aria-label="添加图片" title="添加图片"
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
              aria-label={`访问权限：${permissionLabel(permissions)}`} title={permissionLabel(permissions)}
              aria-haspopup="menu" aria-expanded={menu === 'permissions'}
              disabled={disabled || permissionProfiles.length === 0}
              onClick={() => setMenu((current) => current === 'permissions' ? null : 'permissions')}>
              {permissions === ':read-only' ? <Eye size={15} /> : permissions === ':danger-full-access' ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
              <span>{permissionLabel(permissions)}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <button type="button" className="composer-setting" ref={settingsButtonRef}
              aria-haspopup="menu" aria-expanded={menu === 'settings' || menu === 'models'} disabled={models.length === 0}
              onClick={() => setMenu((current) => current === 'settings' || current === 'models' ? null : 'settings')}
              aria-label={`${modelDisplayName(models, model)}，${reasoningLabel(modelInfo, effort)}`}
              title={`${modelDisplayName(models, model)} · ${reasoningLabel(modelInfo, effort)}`}>
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
            {speechConstructor && <button type="button" className={`composer-circle-button${listening ? ' is-listening' : ''}`}
              aria-label={listening ? '停止听写' : '开始听写'} title={listening ? '停止听写' : '开始听写'}
              aria-pressed={listening} onClick={dictate}><Mic size={15} /></button>}
            {activeTurnId && !draft.trim() && attachments.length === 0 && selectedSkills.length === 0 ? (
              <button type="button" className="composer-stop" disabled={stopping} onClick={() => void stop()}
                aria-label="停止任务" title="停止任务">
                {stopping ? <LoaderCircle size={16} className="spin" /> : <Square size={13} fill="currentColor" />}
              </button>
            ) : (
              <button type="button" className="composer-send" disabled={(!draft.trim() && attachments.length === 0 && selectedSkills.length === 0) || sending || disabled}
                 onClick={() => void submit()} aria-label={activeTurnId ? queueMessages ? '加入队列' : '发送补充要求' : '发送任务'}
                 title={activeTurnId ? queueMessages ? '加入队列' : '发送补充要求' : '发送任务'}>
                {sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface Dictation {
  lang: string;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Dictation;
  webkitSpeechRecognition?: new () => Dictation;
};
