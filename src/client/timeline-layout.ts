import type { TurnTiming } from '../shared/turn-timing';
import { documentReferences } from '../shared/document-input';
import { userMessageDisplayText } from '../shared/user-message';
import { finalAnswerIndex, type TimelineEntry, type TimelineSection, type TimelineTurnResponse } from './timeline-model';
import { isSubagentItem } from './subagents';
import type { ThreadItem } from './types';

/**
 * Layout projection: the turn is the semantic unit, the row is a
 * projection of it.
 *
 * The model layer groups entries into sections, and a single turn with
 * N mid-turn steering messages becomes N+1 response sections. Rendered
 * folded, most of those sections are empty (their whole content is the
 * process trace, which a completed turn hides under its duration
 * disclosure) — yet as virtual rows they still cost an estimated height
 * that the first real measurement later corrects in one jump at the
 * scroll idle point: the blank flash and settle jump seen when paging
 * through a steered conversation.
 *
 * This module is the single place that decides which sections become
 * virtual rows:
 *
 * - User sections are always rows.
 * - A completed, folded turn projects only its content-bearing
 *   response sections: the timing/divider section, sections holding
 *   the turn's final answer (or a local final answer), sections with
 *   subagent rows (rendered outside the fold), and the section that
 *   carries the native turn error. Trace-only mid-turn sections never
 *   become rows, so a folded turn's row count does not grow with its
 *   steering count and no zero-content row ever enters the virtualizer.
 * - An expanded or still-running turn projects every section, with the
 *   process trace inside each section row (the same granularity the
 *   sections already provide — no section is ever merged into an
 *   unbreakable super-row, so giant turns stay windowed).
 *
 * "Content-bearing" mirrors ResponseSection's folded rendering exactly
 * (same finalAnswerIndex, same subagent and error conditions), so the
 * projection can never hide something the component would have shown.
 *
 * The projection is cached per turn: a history prepend re-projects only
 * the new turns and the one boundary turn a page can cut through; every
 * other turn keeps its sections, keys and measurements. Its rows are
 * re-based on the shifted global indices by section identity (a row
 * wrapper is re-minted only where its index actually moved) — a global
 * section index is a coordinate of the current list, never a cacheable
 * property of the row. Expanding or folding a turn re-projects that
 * turn alone.
 */

export interface TimelineLayoutContext {
  expandedTurns: ReadonlySet<string>;
  activeTurnId: string | null;
  threadIdle: boolean;
  turnTimings: Record<string, TurnTiming>;
  responses: ReadonlyMap<string, TimelineTurnResponse>;
}

export interface LayoutRow {
  key: string;
  section: TimelineSection;
  sectionIndex: number;
}

/** Event entries that render as subagent rows outside the fold. */
export function sectionHasSubagentRows(section: TimelineSection): boolean {
  return section.entries.some(entry => entry.type === 'event' && isSubagentItem(entry.item));
}

/**
 * Whether a completed turn is folded shut. Mirrors ResponseSection's
 * `completed` for the whole turn: its `turnFinal` is the turn-level
 * final answer whenever one exists (per-section fallbacks only apply
 * when no section of the turn produced a final answer at all, in which
 * case every section's fallback is empty too).
 */
export function turnIsCompleted(
  turnId: string,
  context: Pick<TimelineLayoutContext, 'activeTurnId' | 'threadIdle' | 'turnTimings' | 'responses'>
): boolean {
  if (turnId === context.activeTurnId) return false;
  const timing = context.turnTimings[turnId];
  if (timing) return timing.status !== 'inProgress';
  const finalAnswer = context.responses.get(turnId)?.finalAnswer;
  return finalAnswer != null && (finalAnswer.completedAtMs != null ||
    (context.threadIdle && finalAnswer.type === 'agentMessage' && finalAnswer.phase === 'final_answer'));
}

/**
 * Whether a response section renders any visible content while its
 * turn is completed and folded — the exact union of ResponseSection's
 * folded branches: the worked divider (shown whenever the turn is
 * completed), the answer slice from the final answer on (including
 * trailing activity and the reply actions), subagent rows, and the
 * native turn error on the turn's last response section.
 */
export function sectionRendersFolded(section: TimelineSection, showError: boolean): boolean {
  if (section.user) return true;
  if (section.showTiming) return true;
  if (finalAnswerIndex(section.entries) >= 0) return true;
  if (sectionHasSubagentRows(section)) return true;
  return showError;
}

interface TurnGroup {
  cacheKey: string;
  turnId: string | undefined;
  sections: TimelineSection[];
  sectionIndices: number[];
}

interface CachedGroup {
  sections: TimelineSection[];
  contextSignature: string;
  rows: LayoutRow[];
}

export interface TimelineLayoutCache {
  groups: Map<string, CachedGroup>;
}

export function createTimelineLayoutCache(): TimelineLayoutCache {
  return { groups: new Map() };
}

function groupSections(sections: TimelineSection[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  sections.forEach((section, index) => {
    const last = groups[groups.length - 1];
    if (section.turnId !== undefined && last?.turnId === section.turnId) {
      last.sections.push(section);
      last.sectionIndices.push(index);
      return;
    }
    groups.push({
      cacheKey: section.turnId !== undefined ? `turn:${section.turnId}:${section.key}` : `section:${section.key}`,
      turnId: section.turnId,
      sections: [section],
      sectionIndices: [index]
    });
  });
  return groups;
}

function projectGroup(group: TurnGroup, context: TimelineLayoutContext): LayoutRow[] {
  const toRow = (section: TimelineSection, index: number): LayoutRow =>
    ({ key: section.key, section, sectionIndex: group.sectionIndices[index]! });
  if (group.turnId === undefined) return group.sections.map(toRow);
  const turnId = group.turnId;
  const folded = turnIsCompleted(turnId, context) && !context.expandedTurns.has(turnId);
  if (!folded) return group.sections.map(toRow);
  const response = context.responses.get(turnId);
  const rows: LayoutRow[] = [];
  group.sections.forEach((section, index) => {
    const showError = response?.lastResponseKey === section.key &&
      context.turnTimings[turnId]?.error != null;
    if (sectionRendersFolded(section, showError)) rows.push(toRow(section, index));
  });
  return rows;
}

function groupSignature(group: TurnGroup, context: TimelineLayoutContext): string {
  if (group.turnId === undefined) return '';
  const turnId = group.turnId;
  const timing = context.turnTimings[turnId];
  const response = context.responses.get(turnId);
  return [
    context.expandedTurns.has(turnId) ? 'open' : 'shut',
    turnIsCompleted(turnId, context) ? 'done' : 'live',
    timing?.status ?? '',
    timing?.error ? 'err' : '',
    response?.lastResponseKey ?? '',
    response?.finalAnswer ? 'fin' : '',
    context.threadIdle ? 'idle' : ''
  ].join('|');
}

export function projectLayoutRows(
  sections: TimelineSection[], context: TimelineLayoutContext, cache: TimelineLayoutCache
): { rows: LayoutRow[]; cache: TimelineLayoutCache } {
  const groups = groupSections(sections);
  const nextCache: TimelineLayoutCache = { groups: new Map() };
  const rows: LayoutRow[] = [];
  for (const group of groups) {
    const signature = groupSignature(group, context);
    const cached = cache.groups.get(group.cacheKey);
    if (cached && cached.contextSignature === signature &&
        cached.sections.length === group.sections.length &&
        cached.sections.every((section, index) => section === group.sections[index])) {
      // The cached rows were minted with the global section indices of
      // their time. A history prepend shifts every later section's
      // index, and a stale index is not a cosmetic error: consumers
      // (ThreadTimeline's failed-turn error check) slice the section
      // list at it. Re-base each row on the group's CURRENT indices,
      // resolved by section identity — rows whose index did not move
      // keep their object identity; only shifted rows are re-minted,
      // and the re-based rows replace the cache entry so the next hit
      // reuses them instead of re-minting forever. The work is bounded
      // by this group's own size, exactly like the identity check
      // above, so a prepend still never re-scans the retained window.
      const currentIndex = new Map(group.sections.map((section, index) =>
        [section, group.sectionIndices[index]!] as const));
      const emitted: LayoutRow[] = [];
      let reminted = false;
      for (const row of cached.rows) {
        const current = currentIndex.get(row.section)!;
        if (row.sectionIndex === current) emitted.push(row);
        else {
          emitted.push({ ...row, sectionIndex: current });
          reminted = true;
        }
      }
      nextCache.groups.set(group.cacheKey, reminted ? { ...cached, rows: emitted } : cached);
      rows.push(...emitted);
      continue;
    }
    const projected = projectGroup(group, context);
    nextCache.groups.set(group.cacheKey, { sections: group.sections, contextSignature: signature, rows: projected });
    rows.push(...projected);
  }
  return { rows, cache: nextCache };
}

// --- Structural height estimates -------------------------------------
// Estimates are only seeds for rows that have never been measured;
// once a row mounts, the virtualizer's measurement replaces them.
// They are calibrated in row-size space (what the virtualizer
// measures: content plus the section's own bottom margin) against the
// fixture geometry: a one-line user row measures ~121px, a worked
// divider block ~56px (duration line plus clock line), a folded
// trace-only section ~28px of margin alone. The old flat seeds (120 user / 150 folded / 680 expanded)
// made every steered turn over-report its height by hundreds of
// pixels; these follow the section's actual structure instead.

const CHARS_PER_LINE = 21;
const LINE_PX = 23;

function textLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').reduce((lines, part) => lines + Math.max(1, Math.ceil(part.length / CHARS_PER_LINE)), 0);
}

function paragraphBreaks(text: string): number {
  return (text.match(/\n\s*\n/g) ?? []).length;
}

function entryText(entry: TimelineEntry): string {
  return entry.type === 'message' && entry.item.type === 'agentMessage' ? entry.item.text : '';
}

function estimateUserSectionHeight(section: TimelineSection): number {
  const item = section.entries[0]?.type === 'message' ? section.entries[0].item : undefined;
  if (!item || item.type !== 'userMessage') return 121;
  const text = userMessageDisplayText(item.content ?? []);
  const images = (item.content ?? []).filter(part => part.type === 'image' || part.type === 'localImage').length;
  const documents = documentReferences(item.content ?? []).length;
  return 98 + LINE_PX * Math.max(1, textLines(text)) + images * 84 + documents * 30;
}

function estimateTraceHeight(entries: TimelineEntry[]): number {
  let height = 0;
  for (const entry of entries) {
    if (entry.type === 'activity') height += 36 + Math.min(entry.items.length, 8) * 4;
    else if (entry.type === 'message') height += 20 + LINE_PX * Math.max(1, textLines(entryText(entry)));
    else height += isSubagentItem(entry.item) ? 0 : 34;
  }
  return height;
}

function estimateAnswerHeight(entries: TimelineEntry[]): number {
  let height = 0;
  for (const entry of entries) {
    if (entry.type === 'message') {
      const text = entryText(entry);
      height += 6 + LINE_PX * Math.max(1, textLines(text)) + 14 * paragraphBreaks(text);
    }
    else if (entry.type === 'activity') height += 36;
    else if (!isSubagentItem(entry.item)) height += 34;
  }
  return height;
}

export interface RowEstimateContext {
  expanded: boolean;
  /** The section's turn is completed (folded rendering applies). */
  completed: boolean;
  /** This section carries the turn's native error. */
  showError: boolean;
}

/**
 * Structural seed height for one projected row. Folded rows are rows
 * the projection kept because they render content, so the folded
 * estimate prices exactly those visible parts (divider, answer slice,
 * subagent rows, error) instead of a flat constant.
 */
export function estimateLayoutRowHeight(section: TimelineSection, context: RowEstimateContext): number {
  if (section.user) return estimateUserSectionHeight(section);
  let height = 28; // .turn-response bottom margin, always part of the row
  if (section.showTiming) height += 56; // divider line + clock line + its margin
  const finalIndex = finalAnswerIndex(section.entries);
  // ResponseSection's own split: a live turn renders every entry as
  // trace and no answer; a completed turn renders the entries before
  // the final answer as trace and the rest as the answer.
  const traceEntries = !context.completed ? section.entries
    : finalIndex < 0 ? section.entries : section.entries.slice(0, finalIndex);
  const answerEntries = context.completed && finalIndex >= 0 ? section.entries.slice(finalIndex) : [];
  if (!context.completed || context.expanded) {
    // The trace is visible: price it, capped the way the component
    // windows a streaming trace at 200 entries.
    const visibleTrace = context.completed ? traceEntries : traceEntries.slice(-200);
    height += Math.max(estimateTraceHeight(visibleTrace), context.expanded ? 48 : 0);
  }
  if (answerEntries.length > 0) {
    if (section.showTiming) height += 16; // gap between divider and answer blocks
    height += estimateAnswerHeight(answerEntries.filter(entry =>
      entry.type !== 'event' || !isSubagentItem(entry.item)));
    height += 40; // reply actions
  }
  const subagents = section.entries.filter(entry => entry.type === 'event' && isSubagentItem(entry.item)).length;
  if (context.completed && subagents > 0) height += subagents * 38;
  if (context.showError) height += 44;
  return Math.max(height, 30);
}
