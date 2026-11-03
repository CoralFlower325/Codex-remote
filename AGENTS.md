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
- `scripts/web-update*.mjs`: independent backend update task, projected durable
  progress and backend-only service controls. The authenticated server router
  accepts only a checked official version, token and idempotency ID.

## Product Constraints

- Preserve the default light appearance, system typography, compact header, and
  separate mobile layout. Merge consecutive commands, edits, tools and searches
  into native-style summaries across types. Ordinary reasoning is hidden; viewed
  images and commentary keep their positions. Completed turns fold their process
  under the duration disclosure, leaving the final reply visible.
  Mobile dictation and model controls use 36px controls; attachment and
  composer conversation-index buttons use two thirds of that size (24px).
  Desktop attachment and composer conversation-index buttons also use two
  thirds of their previous size: 28px becomes about 18.67px. Desktop standalone
  conversation-index and coarse-pointer side-chat attachment/index controls shrink
  from 44px to about 29.33px. Preserve desktop model/dictation sizing and
  goal/queued-message corners. Other touch targets remain at least 44px.
  Conversation text follows native 14px/22.75px, weight 430; activity headers use
  14px/21px, weight 430. Keep the system font stack and lazy detail bodies.
- Use native turn timing, including metadata cursors for older history. Never
  derive the turn start from item timestamps or the browser connection time.
  Preserve native item timing anchors: the work divider freezes at the final
  answer's native startedAtMs, before answer generation ends. Use saved turn
  completedAt when that anchor is unavailable, then durationMs as a fallback.
  Format narrow Chinese units with zero units omitted, matching Desktop.
  Keep one work divider at the first response of a native turn. Steering never
  moves or restarts it; share final-answer timing and process expansion across
  that turn's response slices while leaving steering messages and errors visible.
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
  Release temporary reading-tail space after downward reading settles or when
  following latest; composer resizing must retain bottom-following readers.
  Underfilled viewports prefetch but consume history only on upward intent.
  Older timing metadata fills missing turns; current live timings always win.
- Reply links open lazy inspector preview tabs. Resolve relative files against
  the owning chat's cwd, retain native line suffixes, and keep preview content
  out of public caches. HTML runs without same-origin privileges; its short-lived
  resource grant is read-only and confined to the document's directory.
  Never expose the Remote session to generated HTML. Resolve HTML grant resources
  against their real directory and reject symlink/junction escapes.
  Office previews use optional host LibreOffice conversion to temporary PDF,
  with isolated profiles, macros/active content/link updates disabled, bounded
  input/output, queue and owned-process timeouts. This is not an OS sandbox.
  Keep original downloads and actionable missing-converter errors. Do not upload
  documents to external viewers or persist converted content in public caches.
  HTML preview does not build source projects.
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
  item has no timing yet. Late native item events/deltas stay in their owning
  loaded turn; native turn timing must not pull unseen older turns into the
  latest window. A stale completion cannot clear a newer active turn.
  Native snapshots may reorder shared items; reconcile once per identity while
  retaining newer live text and live-only neighbours.
  Ignore window-external live items while reading older
  history. Follow-up user marks missing from native summaries are added as their
  history is loaded; do not claim a complete unread steering-message index.
- Start authentication status and authenticated bootstrap reads concurrently.
  Either verified server response can open the workspace; metadata must not
  block entry. Preserve six-second deadlines, bounded recovery and HTTP-only
  identity. Login success needs no extra status round trip. The returning-device
  boolean may show an empty shell but never authorize sockets, reads or sending.
  Expiry/logout unmount private state and clear the hint; network failure keeps
  the returning shell with a retry banner. Preserve mounted drafts across recovery.
  HTTP task/model/project reads work before socket readiness. Share bootstrap,
  fallback and reconnect reads; apply late metadata without rewinding live rows.
  Chat opening starts with 40 items and at most two 100-item fill pages; timing
  reads run separately. Gate sends/queues on native metadata, timings and resume.
  Main chats request fresh native text/timings before displaying a new selection;
  do not flash old memory/device/host previews while latest reads are pending.
  Keep already-mounted same-chat content; cached chat previews are failure fallback.
  Repeated selection of an already-open or opening chat must not reset its reads.
  Start existing-chat resume alongside native reads, retaining a fresh tail check
  after attach. Merge that check before the first commit when attach precedes
  the initial response. Keep timing readiness independent from resume effects;
  retries and return-to-latest remain explicit actions.
  Fresh chat/timing requests bypass the host's clean two-second reuse window,
  while identical pending reads still coalesce. Reconcile again after native
  resume attaches; retain a trailing read when completion arrives during refresh.
  A second stale response must retain an incomplete state and a retry control.
  Foreground tail checks have a 15-second cooldown independent of five-minute
  task-list recovery, and never replace a history-navigation window.
  Batch reading-anchor capture and navigation measurements per animation frame.
  Search ordered anchor positions instead of measuring every preceding message;
  preserve enclosing anchors and actual layout heights.
  Older paging must survive a failed initial timing read without rewinding cursors.
  Preserve the documented page sizes, bounded retries, timeouts, cancellation,
  foreground priority and snapshot freshness in
  [Loading and networks](docs/guide.md#loading-and-mobile-networks).
  Never cancel a healthy task read on routine focus, online or initial sync.ready.
  Private IndexedDB snapshots require verified authentication: 1000 task rows,
  three chats of 40 items, 24 hours and 1 MiB total. Save only finished text/
  activity, excluding images, reasoning, output, diffs, permissions, running,
  ephemeral and subagent chats. Logout clears them and blocks late saves.
  WebSocket and authenticated SSE share native RPC, watch ownership and replay.
  Race the HTTP candidate after 500ms; close the unused route. Preserve the
  existing handshake budgets and pause unfinished attempts while hidden.
  HTTP peers bind to the verified cookie; events stay uncompressed and no-store.
  Never retry uncertain action POSTs. Isolated POST failure rejects its own RPC;
  401/409 or stream failure invalidates the peer. Reads/pings bypass action waits.
  Only sync/watch controls have safe ordered retries; never model/approval actions.
  HTTP route preference is not authentication. Five-second foreground heartbeats
  retain the 12-second reply deadline; after two seconds without a pong, verify
  a new HTTP peer before handover. A late original pong cancels the candidate.
  Handover rejects uncertain actions without replay. Redundant focus/online
  probes healthy connections without resetting deadlines; pongs are not sync.ready.
  Manual reconnect preserves the workspace, drafts and reading state while
  cancelling stale reads. Serve the installed public shell
  immediately with its matching modules and install newer shells through SW.
  Workspace prewarming starts only for a returning-device shell or after verified
  authentication/login. Do not inject its modulepreload into anonymous HTML.
  The service worker may still cache the complete public shell in the background.
  Local remote:shell/auth/bootstrap/tasks/chat/connected marks contain timings
  only; never export private content or add background telemetry.
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
  Include the native `[$name](path)` text mention as well, including skill-only
  sends, queues, steering, side chats and edits; do not duplicate existing mentions.
  Display legacy skill-only inputs without rewriting persisted history.
  Keep collaboration mode synchronized through resume/settings notifications.
  Keep main-chat image/skill drafts in workspace memory per chat, including
  pending file reads/sends across navigation. Persist text only; reload discards
  unsent images/skills. Show removable image previews above the input.
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
  Use Desktop-style compact error rows without generated titles/HTTP labels;
  project native retry progress and JSON messages for display only. Top transport
  recovery uses explicit connection state and monochrome Reconnecting/Retry.
- Permissions apply per chat. Do not rewrite global Codex config to change them.
- Do not start a second backend that replaces an active Desktop relay.
- Starting or stopping Remote must not terminate Codex Desktop.
- The desktop manager reuses owned platform controls. Close/minimize hides to the
  tray/menu bar; quitting preserves service state. Manager operations stay local;
  the explicit web backend-update exception reuses installation transactions
  through an independently owned worker, never generic manager IPC or commands.
  Resident images reflect owned service run state: dim while stopped
  or unknown, solid while running; independent Desktop/public failures do not
  imply a stopped service. Adapt native images to the system surface theme.
  Updates require confirmation, conflict checks, isolated build,
  backup, old-process exit and recovery. Preserve explicit stopped state and
  private runtime data. External edge assets and the manager update separately.
  Keep locally modified Markdown documentation/rules during updates and retain
  incoming copies for reconciliation; source/configuration conflicts still block.
  Windows tasks use the windowless host with logs and owned-process shutdown.
  External macOS tunnels retain their original configuration and management.
  Explicit confirmed repair may enable/bootstrap/kickstart a selected existing
  cloudflared LaunchAgent/Daemon after fresh definition and loaded-job checks;
  system jobs require native administrator authorization. Never create/adopt
  a tunnel or include it in ordinary Remote Start/Stop. Public health is a separate observation.
  Installation discovery is read-only. Preserve a valid saved selection; prefer
  registered services over guessed paths, and let users choose ambiguous roots.
  Serialize directory changes with service actions and preserve manual browsing.
  Update progress reflects completed stages, not invented download percentages.
  Validate offline dependencies before stopping; preserve old dependencies for
  recovery. Keep raw bounded tool output separate from Chinese status messages.
  Standard installations prefer checksum-verified platform runtime packages;
  preserve the isolated source path for local build customizations. Runtime
  packages must reject unsafe archives and verify every file before stopping.
  Ignore only known macOS metadata (.DS_Store, AppleDouble ._* and __MACOSX)
  consistently in build-input discovery and merging. Explain source fallback
  with bounded relative paths or a missing baseline/platform; retain .env.example
  without treating it as an installation input. Never touch runtime .env files.
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
  side turns directly. Adopt loaded Desktop side conversations from
  `thread/loaded/list` plus `thread/read`, and detect live `thread/started`
  copies by explicit `side_chat` / `queued_side_chat` metadata. Never treat an
  ordinary fork or subagent as a side chat. Open the adopted conversation in the
  inspector, merge its native turns before live events, and continue watching it
  across main-chat changes. Closing a Desktop-managed Remote tab removes only its
  viewer; unlike a Remote-created tab, it must not interrupt or unsubscribe the
  Desktop side chat. Closing a Remote-created side tab interrupts and
  unsubscribes; hiding the inspector preserves tabs. Allow 30 seconds for socket
  reconnection.
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
- Render chat math with bounded, untrusted KaTeX in a lazy module. Support dollar
  and escaped-parenthesis/bracket delimiters without rewriting native content.
  Protect code and explicit Markdown links; preserve incomplete/invalid text and
  ordinary prices. Keep long equations scrollable inside the conversation.
  Do not precache the math module/fonts for ordinary chats. Source transforms
  must keep virtual-file offsets consistent with reparsed trees.
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
  Remote and the desktop manager have independent versions. Remote's version lives
  in the root package/lockfile; the manager's lives in desktop/package/lockfile.
  The stable manager is 0.2.3 with Remote 0.2.19; installers remain in v0.2.17. Remote-only changes must not increment, rebuild
  or install the manager. Increment the manager patch only for its own changes.
  Manager self-update is paused as 0.2.0AU on archive/manager-0.2.0AU;
  keep AU self-update out of the stable manager and formal releases. Preserve AU history,
  artifacts and receipts; Mac signing/notarization remains a resume checkpoint.
- After completing and validating project changes, push the public repository
  by default unless the user explicitly asks not to. Never push the separate
  private deployment checkout or its runtime data.
- Publish a GitHub Release for each validated functional batch, with a matching
  version tag, exact source commit and concise change summary. Keep the public
  release metadata in src/shared/release-notes.ts aligned with that release.
- After formal release assets finish publishing, refresh the download Worker's
  checked public snapshot with `node scripts/refresh-distribution-release.mjs`,
  then prepare and deploy its separate `distribution/` cf build. Keep generated
  metadata ignored; GitHub API rate limits may require this snapshot fallback.
- Write release titles, headings, change summaries and update-dialog notes in
  Chinese only. Keep necessary product names, commands and version identifiers;
  do not add an English duplicate or English headings such as "Changes".
  Every Release must list both Remote and manager versions with separate change
  summaries. Explicitly mark an unchanged component as having no changes.
  Manager packaging runs only when desktop/package.json's version changes;
  unchanged manager installers remain available in their original Release.
  Keep release bodies under Chinese sections 版本、本版变更、下载、验证与边界.
  Historical pages point to the latest stable release while retaining their own
  versions and evidence. Preserve tags, assets and draft/prerelease states when
  editing metadata. See docs/release-organization.md for same-number historical
  manager builds and draft tag/URL handling.
- The conversation summary panel reads native PR attachments and projected
  artifacts/sources on demand. Keep its history cursor independent of chat
  history; routine native events refresh the head until known items, never
  restart a complete scan. Bound automatic batches and expose remaining pages.
  Never return raw tool results or reasoning through summary responses.
  Wide desktop may pin a 300px panel; narrow desktop and mobile use a modal.
- Version checks compare the loaded shell's version and build ID. If current,
  leave the page, drafts and service worker untouched. Show release summaries
  before a confirmed frontend-only update and acknowledge completion after reload.
  Web backend checks show versions without summaries. Require an authenticated
  trusted-origin confirmation, fresh service ownership, official latest version
  and idempotency ID. Persist real progress outside replaceable runtime files.
  Restart only the backend, never Desktop or the tunnel; preserve rollback.
  After verified installation, activate its matching public frontend through
  /remote-client and refresh. Keep every private API out of public worker caches.
- Release metadata/assets prefer the project-owned downloads.73916482.xyz
  distribution, with official GitHub fallback and unchanged checksum requirements.
  Metadata allows 15 seconds per source; asset attempts allow 30 seconds for
  headers, 60 seconds without body data and 600 seconds overall.
  Standard runtime updates need no direct GitHub/Git/npm connection when
  distribution works. Custom source, absent baselines and unsupported runtime
  architectures still need Git/npm networks; never promise universal TUN-free use.
  The distribution Worker exposes only allowlisted public repository release
  routes, never arbitrary URL proxying, private routes or client credentials.
  Cache public metadata for 60 seconds; stream assets with no-store.
  Prepare it with scripts/prepare-distribution.mjs and deploy cf deploy --prebuilt
  from distribution. See docs/update-downloads.md.
  Installed managers load their bundled updater: install manager 0.2.3 manually
  over 0.2.0 and retry the same host root; a Remote update cannot patch the old app.
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
