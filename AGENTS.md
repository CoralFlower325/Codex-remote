# Codex Remote

Self-hosted React and Node.js workspace for Codex Desktop.

## Commands

- Install: `npm ci`
- Validate: `npm run typecheck`, `npm test`, `npm run build`
- Development: `npm run dev`
- Production: `npm start`

## Architecture

- `src/client/`: responsive workspace, native metadata menus, history, approvals.
- `src/client/remote-connection.ts`: socket lifecycle and recovery.
- `src/client/useWorkspaceDirectory.ts`: task/catalog reads and reconciliation;
  `useRemote.ts` retains native chat lifecycle and transport orchestration.
- `src/client/conversation-state.ts`: shared side/subagent event projection;
  their creation, history and closing policies stay in their own hooks.
- `src/client/components/{ThreadTimeline,TurnResponse,TimelineActivity,MarkdownText}.tsx`:
  viewport/history anchoring, response rendering, activity details and Markdown.
- `src/client/styles/`: ordered style sections; preserve declaration order.
- `src/server/`: authentication, HTTP/WebSocket transport, native desktop bridge.
- `src/server/thread-router.ts` and `peer-hub.ts`: bounded thread HTTP reads and
  the shared WS/SSE peer policy, assembled by `index.ts`.
- `src/shared/rpc-methods.ts`: the native RPC allowlist; classification never
  authorizes automatic action retries.
- `src/server/thread-history.ts`: native bounded history pagination.
- `src/shared/`: protocol and permission profiles.
- `scripts/`: Windows/macOS setup, services, tunnel, and platform controls.
- `desktop/`: optional Electron manager, isolated IPC, tray/menu-bar controls and
  staged local updates. Build with `npm run manager:build`; install its separate
  dependencies with `npm run manager:install`; package with `npm run manager:dist`.
  Backend installs do not download Electron.
- `desktop/manager-session.mjs`: serialized installation operations and state;
  `main.mjs` owns the Electron window, trusted IPC and tray/menu-bar lifecycle.
  `update-prepare.mjs` prepares inputs, `update-inputs.mjs` validates files/tools,
  `updater.mjs` installs, and `update-transaction.mjs` persists recovery.
- `scripts/runtime-files.mjs`: staging-only package exclusions. Preserve the
  target PTY binaries/helper and executable mode; archive debug symbols separately.

## Product Constraints

- Preserve the default light appearance, system typography, compact header, and
  separate mobile layout. Merge consecutive commands, edits, tools and searches
  into native-style summaries across types. Ordinary reasoning is hidden; viewed
  images and commentary keep their positions. Completed turns fold their process
  under the duration disclosure, leaving the final reply visible.
  Mobile attachment/dictation and conversation-index buttons use 36px controls
  to fit small screens, matching the model selector. Apply this exception only
  to the mobile layout, including side chats; preserve desktop sizes and
  desktop goal/queued-message corners. Other touch targets remain at least 44px.
  Conversation text follows native 14px/22.75px, weight 430; activity headers use
  14px/21px, weight 430. Keep the system font stack and lazy detail bodies.
- Use native turn timing, including metadata cursors for older history. Never
  derive the turn start from item timestamps or the browser connection time.
  Preserve native item timing anchors: the work divider freezes at the final
  answer's native startedAtMs, before answer generation ends. Use saved turn
  completedAt when that anchor is unavailable, then durationMs as a fallback.
  Format narrow Chinese units with zero units omitted, matching Desktop.
  Running labels use host time calibrated by existing heartbeat round trips,
  not an uncorrected phone/browser clock. Recalibrate on reconnect.
  Refresh only the active time label once per second. Keep user/assistant gaps
  larger than prose spacing without loosening command rows.
- Consecutive desktop activity headers use a compact 30px pitch; touch targets
  remain at least 44px. Command/output text uses the native ui-monospace stack,
  12px/18px, weight 400.
- Use the desktop's owning App Server for immediate synchronization.
- Task list requests include all providers with `modelProviders: []` and
  `useStateDbOnly: true`. Follow native cursors; never assume one page is complete.
- Keep history bounded and preserve reading position when prepending older pages.
  User attachments render in a compact row above the text bubble. Retain native
  local image inputs under private data/image-attachments when seen or read;
  never publish these files or silently display a missing original as blank.
  Anchor a visible stable item, not a scrollHeight snapshot taken before a
  request. Restore before paint and on delayed layout changes, while updating
  the anchor when the reader scrolls during a request.
  Prefetch at most one older page in memory within two viewport heights of the
  top; insert within 64px of the top after the gesture and momentum have settled,
  without replacing the visible stream. Recheck scroll idleness after network
  completion and retain the prepared page if the reader has left the top.
  After a page containing only folded activity, hidden reasoning or commentary,
  retain upward intent at the restored reading anchor and continue one bounded
  page at a time until a user message or final/legacy answer appears. Downward
  movement, navigation and activity expansion stop this continuation.
  Count only messages actually mounted outside process folds; an older answer
  folded into the existing response is not newly revealed conversation.
  Coalesce up to four 100-record native pages per older-history HTTP response
  on the host, stopping at readable context and retaining every record/cursor.
  Never prepend history or compensate its position during a drag.
  Use a passive history sentinel, never a load-more button. A new upward
  gesture retries a failed foreground page; idle failures must not loop.
  Clamp scroll offsets to their real range before inferring direction so
  Safari rubber-band rebound cannot cancel upward intent. Accumulate small
  touch movements across events; do not discard each sub-threshold move.
  Keep touch direction authoritative until the drag/momentum quiet period ends,
  including delayed fractional-position rounding events.
  Prepare native timings before insertion, share speculative/foreground reads, and discard
  abandoned pages. Preserve response/activity identities and expanded state
  across partial-turn boundaries. Do not estimate chat-block heights with
  content-visibility; reserve thumbnail geometry and reuse unchanged responses.
  Underfilled viewports prefetch but consume history only on upward intent.
  Older timing metadata fills missing turns; current live timings always win.
- Reply links open lazy inspector preview tabs. Resolve relative files against
  the owning chat's cwd, retain native line suffixes, and keep preview content
  out of public caches. HTML runs without same-origin privileges; its short-lived
  resource grant is read-only and confined to the document's directory.
  Never expose the Remote session to generated HTML. Binary Office formats are
  downloads; HTML preview does not build source projects.
  Load only active previews and release hidden document renderers. Surface
  local HTML HTTP failures before iframe rendering; renew grants on reopening.
  Bound metadata/HTML reads to 15 seconds and isolate lazy-module failures.
  Cap PDF backing canvases at 8 million pixels and 8192 pixels per dimension.
- Keep task pagination complete and yield to interaction; do not restart full
  task/outline pagination on routine native events. Short reconnects replay
  subscribed events from the bounded memory journal, with sequence deduplication
  and native snapshot fallback. Never resubmit uncertain model requests.
- PWA and edge caches contain public static assets only. Do not cache API,
  conversations, local images, approvals, or terminal output. Edge routes must
  leave /api, /ws and /health on the authenticated origin.
- Use scripts/acceptance-viewports.json for responsive acceptance, including
  402x874 and 874x402 CSS viewports at DPR 3. Physical-phone networks and
  signed-in macOS integration require separate live acceptance.
- Conversation marks use native summary cursors independently of history pages.
  Jump through native item cursors into a bounded window, with paging in both
  directions and return to latest. Preserve known turn ordering when a loaded
  item has no timing yet. Ignore window-external live items while reading older
  history. Follow-up user marks missing from native summaries are added as their
  history is loaded; do not claim a complete unread steering-message index.
- Start authentication status and authenticated bootstrap reads concurrently.
  Either verified server response can open the workspace; metadata must not
  block entry. Bound both reads to six seconds, with capped retry backoff and
  cancellation/restart on online/visibility recovery. A successful login POST
  establishes identity without another status round trip. Preserve HTTP-only
  authentication; local storage is never proof of access.
  After verified login, store only a boolean returning-device hint to render
  the empty Workspace before authentication finishes on repeat entry. Keep
  useRemote unauthenticated until the server confirms access; do not create
  sockets or start task reads from the hint. Preserve the mounted shell and
  local UI state when verification succeeds or an unfinished check restarts.
  Clear the hint and unmount private state on expiry/logout. Failed network
  checks show a nonblocking retry banner in the returning shell. Never present
  shell timing as faster authentication or chat readiness.
  Apply HTTP task/model/project snapshots independently of socket readiness.
  If bootstrap stalls for 1.5 seconds after authentication enables loading,
  start the task read directly, never from the unauthenticated returning shell.
  Page all tasks through authenticated /api/threads with native all-provider
  cursors, independently of the socket. Cancel downloads and background-yield
  waits on logout/unmount or archive-list changes. Share initial list loading across
  bootstrap, timeout fallback and reconnect; late metadata must not replace
  newer native results. Native model/project fallbacks wait at most 1.5 seconds
  after socket readiness. Open chats with one native-backed HTTP
  read-only request: start with 40 latest records without waiting for resume or
  timings. If these lack a visible user message and final/legacy assistant
  answer, follow at most two native 100-record pages, retaining the latest
  items and remaining cursor. This bounded fill is separate from scroll paging.
  Read timings independently; gate sending/queues on native metadata, timings,
  resume and the socket. Older paging obtains missing initial timing cursors
  and older timing pages through bounded authenticated HTTP, independently of
  realtime RPC. A failed initial timing read must not hide the history sentinel.
  Late initial timings must not rewind a cursor already advanced by paging.
  Task first pages contain 50 rows, then 200 per native cursor. Share pending
  native task reads across bootstrap/fallback, including bootstrap timeout.
  Pause background task pages during the selected chat's foreground read.
  Host snapshots keep task first pages and five chats with a two-second fresh
  window and five-minute retention; native events/actions invalidate them.
  Display stale data provisionally, then join a fresh read before using cursors.
  After server authentication only, read the bounded private IndexedDB snapshot:
  1000 task summaries, three chats of 40 items, 24 hours, 1 MiB total.
  Persist text/finished activity only; exclude image bodies, reasoning, tool
  output, diffs, permissions, running turns, ephemeral and subagent chats.
  Logout/expired authentication clears it and blocks prior asynchronous saves.
  Preserve newer native rows/live messages over every late snapshot; remove
  obsolete snapshot rows during final native reconciliation.
  Bound pooled HTTP reads to 15 seconds and surface expired authentication.
  Task first attempts use four seconds, then retry independently of WebSocket
  state at 0.5/1/2/4 seconds, capped at five seconds. Online/foreground recovery
  replaces a first-page read stalled for two seconds only after a real offline
  or hidden-page transition. Ordinary focus, redundant online and initial
  sync.ready must not cancel a healthy pending task read. Old completions must not
  clear replacement state. Bound shared native snapshot/metadata reads to eight
  seconds so retries cannot remain attached to a 120-second native read.
  Main-chat WebSocket attempts allow three seconds to connect and six seconds
  for sync.ready. After 500ms still connecting, warm authenticated HTTP
  EventSource in parallel; the first open transport wins and the unused
  candidate closes. Before sync, selecting a route is not a lost live session.
  On failure, use authenticated HTTP EventSource plus one-shot
  POSTs, with 12-second transport/sync deadlines. Both transports share native
  RPC handling, watched threads and the replay journal. Bind HTTP peers to the
  verified cookie session; flush uncompressed no-store events. Never retry an
  uncertain action POST. An isolated failed POST rejects only its matching RPC
  or approval, preserving a healthy SSE stream; 401/409 or stream failure
  invalidates the peer. Reads and pings bypass action acknowledgement waits.
  Sync/watch controls have a separate ordered lane, with three safe attempts
  at 0.5/1-second intervals; superseded watches stop. Never apply these retries
  to model or approval actions. Remember successful HTTP use in tab-session storage
  as a route preference only, never authentication. Foreground heartbeats run
  every five seconds. After two seconds without a reply on a synchronized main
  channel, verify a new HTTP peer with a ping before retiring the original.
  A late original pong cancels the candidate. Handover uses normal sync/replay
  and rejects pending actions without resending them. Heartbeat replies still
  allow 12 seconds; pause probes in hidden pages and start fresh on foreground/pageshow.
  Ordinary focus/pageshow must not shorten or reset handshake deadlines. Pause
  unfinished handshakes while hidden and give the current stage its full budget
  on actual foreground return. Redundant online events probe healthy channels
  instead of destroying them.
  Pongs do not count as sync readiness. Visible retry starts at 250ms and caps at
  five seconds. Manual reconnect preserves the mounted workspace and drafts,
  cancels stale task/history reads, and never repeats uncertain model actions.
  Preload the Workspace module from the shell. Return the installed version's
  cached public shell immediately, keeping its modules and document together;
  install newer versions through the service-worker update lifecycle. Never
  overwrite the installed shell with a different network version.
  Local User Timing marks remote:shell/auth/bootstrap/tasks/chat/connected contain
  timings only; do not export private content or add background telemetry.
- Abort abandoned HTTP history and permission reads when their selection changes;
  coalesce identical pending reads. Bootstrap and WebSocket share model/project
  lookups, with a five-second completed-result handoff. Invalidate on project
  creation or bridge loss. Never deduplicate or cancel model actions this way.
  Missing model/project catalogs use independent authenticated HTTP reads,
  without waiting for realtime synchronization or each other. Retry transient
  catalog and initial chat/timing reads at most three times, with 0.5/1s waits;
  initial chat/timing attempts allow 15s through the complete body, as do subsequent attempts. Do not retry
  expired authentication, permanent client errors or cancelled selections.
  Recover failed catalogs on real network/foreground recovery or manual retry.
  Replay reconnects fill incomplete chat reads without reopening healthy history.
  Background task pagination is not evidence that the current chat is incomplete.
  Existing main-thread subscription resume may retry three times at 0.5/1s,
  stopping on selection or connection changes. Never generalize this to retry
  model actions or new-chat creation.
- Do not resume a new unsent chat before its first persisted turn.
- Native `turn/steer` uses `expectedTurnId`.
- Edit only the latest interrupted main-chat turn's original input. Before
  `thread/revert`, recheck the latest native turn and original item; preserve
  attachments/skills and file/application context. Revert and resend once each,
  stop dependent sends after selection/transport changes, and retain uncertain
  drafts without replay. Reversion clears stale history/question caches and
  does not undo executed file changes.
- Composer slash commands use native RPC actions, not text prompts. Skills come
  from `skills/list` for the current directory and submit as native skill input.
  Keep collaboration mode synchronized through resume/settings notifications.
- Native async question messages preserve their questions and native index IDs. Submit
  explicit answers using the persisted Desktop reply envelope, directly steering an
  active turn with expectedTurnId or starting an idle turn; never queue these replies.
  Keep first-option defaults unsent until the user clicks submit, allow custom text,
  and retain failed drafts. Folded history command/tool bodies load only on expansion
  through authenticated native thread/items/read; preserve full prose, question
  payloads, file diffs for review, item identities and pagination cursors.
  Scope loaded details and read errors to the owning thread and item summary;
  full live output supersedes stale read errors. Do not serialize full native
  bodies just to measure history projection size in production.
- Native approvals arrive through `mcp-request`; responses use `mcp-response`.
  Respect the request's available decisions.
- Render native runtime `error` notifications and failed `turn.error` per turn in
  main/side/subagent chats, outside process folds. Preserve original text, public
  error metadata, actual HTTP codes and `willRetry`; never invent 429 from a
  usage limit or repeat model actions. Clear transient errors on resumed output
  or native completion, preserve them through late in-progress snapshots, and
  retain final errors in bounded native history reads. RPC bridges preserve
  numeric codes and projected public error data, never arbitrary result payloads.
- Permissions apply per chat. Do not rewrite global Codex config to change them.
- Do not start a second backend that replaces an active Desktop relay.
- Starting or stopping Remote must not terminate Codex Desktop.
- The desktop manager reuses owned platform controls. Close/minimize hides to the
  tray/menu bar; quitting preserves service state. Never expose manager operations
  through HTTP. Resident images reflect owned service run state: dim while stopped
  or unknown, solid while running; independent Desktop/public failures do not
  imply a stopped service. Adapt native images to the system surface theme.
  Updates require confirmation, conflict checks, isolated build,
  backup, old-process exit and recovery. Preserve explicit stopped state and
  private runtime data. External edge assets and the manager update separately.
  Keep locally modified Markdown documentation/rules during updates and retain
  incoming copies for reconciliation; source/configuration conflicts still block.
  Windows tasks use the windowless host with logs and owned-process shutdown.
  External macOS tunnels are not adopted; public health is a separate observation.
  Installation discovery is read-only. Preserve a valid saved selection; prefer
  registered services over guessed paths, and let users choose ambiguous roots.
  Serialize directory changes with service actions and preserve manual browsing.
  Update progress reflects completed stages, not invented download percentages.
  Validate offline dependencies before stopping; preserve old dependencies for
  recovery. Keep raw bounded tool output separate from Chinese status messages.
  Standard installations prefer checksum-verified platform runtime packages;
  preserve the isolated source path for local build customizations. Runtime
  packages must reject unsafe archives and verify every file before stopping.
  Persist installation phases before mutations; recover unfinished transactions
  before service actions on startup. Retain recovery evidence across crashes,
  preserve stopped state, and block overwriting edits made after interruption.
  Public probe timeout/network failures are unknown observations, not proof of
  downtime. Repairs require confirmation and fresh ownership checks, target only
  the selected service, and never adopt external tunnels or restart Desktop.
  Password/device administration uses local IPC and stdin, never HTTP routes or
  command-line secrets. Password changes invalidate all sessions; revoke live
  WS/SSE/terminal access as well as later requests. Store private device metadata.
- Windows Tunnel tasks run the owned Node supervisor. Restart exited cloudflared
  after one second, backing off repeated crashes to five seconds. Poll readiness
  every two seconds and wake on native address/availability events. Rebuild only
  after all edges remain unavailable for four seconds, eight seconds of startup
  grace, a bounded TCP 7844 probe, and a final readiness recheck. Retain healthy
  edges and a 15-second restart cooldown; network changes recheck the cooldown.
  Stop disables tasks and terminates only this checkout's supervisor, watcher,
  backend and token-file-matched Tunnel. Never revive an explicitly stopped task.
- Desktop panel widths resize through captured pointer events and keyboard
  separators. Persist preferred widths only when interaction finishes, keep the
  conversation at least 320px wide, and retain separate mobile drawers. Desktop
  inspectors dock from 900px; below that they overlay. Resize state belongs in
  the panel container so dragging does not rerender the conversation.
- The header terminal opens a real, Remote-owned PTY in the chat/project cwd.
  Sessions belong to their starting directory and survive panel hiding and
  socket reconnection. Only closing a terminal tab or stopping Remote ends it.
  Keep the xterm renderer lazy, output outside React chat state, and replay from
  bounded headless terminal snapshots. Terminal keys must retain shell behavior.
- Side chats use the shared transport and native ephemeral start/fork, created
  only on first send. Ephemeral forks cannot use `deferGoalContinuation`.
  Subscribe to all open side threads, batch their events separately from main
  history, and keep temporary drafts and recovery snapshots in memory only.
  Native ephemeral chats do not support persisted history or queues; steer active
  side turns directly. Closing a side tab interrupts and unsubscribes; hiding
  the inspector preserves tabs. Allow 30 seconds for socket reconnection.
  Ingest embedded items in native turn notifications as well as item events:
  live Desktop can send ephemeral replies only in turn/completed. Retain
  successfully submitted user input in the temporary snapshot with its
  clientUserMessageId; do not duplicate reply bodies inside timing state.
  Composer portals sit above the inspector, including expanded and mobile
  panels. Mobile focus trapping ignores portal targets. Dialogs and consumed
  shortcuts must not trigger workspace shortcuts. Preserve initial queued
  skills and current model choices across asynchronous side-thread creation.
- Subagents use native collabAgentToolCall and subAgentActivity records, merged
  per child within a response. Keep their clickable entrances outside completed
  process folds. Discover direct children using parentThreadId and
  sourceKinds: ['subAgentThreadSpawn'], all providers, both archive states and
  all native cursors. Keep agent conversations separate from ephemeral chats.
  Read bounded child history first; rejoin active children without config
  overrides. Closing a child viewer must never interrupt or unsubscribe its
  native thread. Compose watcher owners so side chats and children remain live
  together. Exclude subagent sources and ephemeral chats from bootstrap, paged
  task results, thread/started and incremental thread/read refreshes. Remove
  previously admitted child rows without archiving or deleting native chats.
- Device Web Push is opt-in, uses authenticated same-origin routes, and adds no
  notification reads to startup. Persist VAPID keys and subscriptions only in
  private runtime data. Watch ordinary chats opened/created through Remote;
  exclude children and ephemeral chats. Include the conversation title and a
  bounded final reply preview, never tool output or command bodies. Title metadata
  may delay delivery by at most 1.5 seconds; skip it without subscribers.
  Revoke the device subscription before logout;
  do not claim browser-session expiry revokes OS push. Test delivery acceptance
  separately from actual iPhone/iPad notification display. Native push delivery
  does not depend on a browser connection. Retry transient network/429/5xx
  delivery twice at one/four seconds; retain the notification tag, stop on
  unsubscribe, and remove expired endpoints without retrying them.
- Strip internal citation IDs from assistant prose only. Preserve user text,
  inline/fenced code and real links; do not invent missing source destinations.
- Main-chat queued submissions use native queue IDs and cursor pagination.
  Dispatch through native queue/start; steering uses expectedTurnId then removes
  the queued submission. Preserve image and skill inputs when editing text.
- Reply branches pass the selected completed lastTurnId. Folder selection uses
  native fs/readDirectory, fs/createDirectory and project/create. Keep these
  controls compact and consistent with Desktop, with 44px touch targets.

## Publication and Privacy

- Increment the package patch version once per completed functional change batch.
  Neat closeout, handoff and documentation-only updates do not increment it.
  Keep package.json, the lockfile, deployed assets and the visible version aligned.
  An explicit user version takes precedence.
- After completing and validating project changes, push the public repository
  by default unless the user explicitly asks not to. Never push the separate
  private deployment checkout or its runtime data.
- Publish a GitHub Release for each validated functional batch, with a matching
  version tag, exact source commit and concise change summary. Keep the public
  release metadata in src/shared/release-notes.ts aligned with that release.
- Write release titles, headings, change summaries and update-dialog notes in
  Chinese only. Keep necessary product names, commands and version identifiers;
  do not add an English duplicate or English headings such as "Changes".
- The conversation summary panel reads native PR attachments and projected
  artifacts/sources on demand. Keep its history cursor independent of chat
  history; routine native events refresh the head until known items, never
  restart a complete scan. Bound automatic batches and expose remaining pages.
  Never return raw tool results or reasoning through summary responses.
  Wide desktop may pin a 300px panel; narrow desktop and mobile use a modal.
- Version checks compare the loaded shell's version and build ID. If current,
  leave the page, drafts and service worker untouched. Show release summaries
  before a confirmed update and acknowledge completion after reload.
- Restart the local Remote service after every application update, including
  frontend-only updates. Verify its old listener and owned process exited before
  starting once; then verify ready Desktop transport without stopping Desktop.
- Never commit `.env`, `data/`, tokens, private keys, session cookies, logs,
  real chat exports, local machine identifiers, or private screenshots.
- Keep documentation examples generic. Use synthetic data for screenshots.
- Preserve upstream copyright and notices.
- README.md and README.zh-CN.md must describe the same behavior and limitations.
  Keep their overviews concise; detailed setup and operating contracts belong in
  docs/guide.md and docs/guide.zh-CN.md, with both languages updated together.
  docs/README.md indexes current guides separately from historical evidence.
- Model/project metadata currently reads its first requested page; model defaults
  can differ from global configuration overrides. Do not imply otherwise.
- Remote terminals are separate from Desktop shells and bypass model permission
  profiles; document this in both READMEs. Some approval forms and actual
  dictation still need dedicated live acceptance.
- Windows has live desktop acceptance. macOS has CI coverage for builds, unit
  tests, shell syntax, and generated LaunchAgents; signed-in desktop integration,
  login persistence, and the legacy tunnel still need live macOS acceptance.
