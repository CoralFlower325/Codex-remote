# Code Organization

This map describes ownership boundaries. It does not change product behavior.

| Area | Entry / Owner | Supporting Modules |
| --- | --- | --- |
| Main chat | `src/client/useRemote.ts` | `useWorkspaceDirectory.ts` owns task/catalog reads; `remote-connection.ts` owns connection recovery |
| Client contracts | `src/client/remote-contracts.ts` | `ConnectionView`, `DirectoryView`, `ConversationView`, `AttentionView`, and explicit action capabilities |
| RPC requests | `src/client/remote-request-registry.ts` | Request ids, action-intent completion, timeouts and transport-loss rejection |
| Workspace composition | `src/client/Workspace.tsx` | `components/HomeView.tsx`, `components/ThreadScreen.tsx`, and `useResponsiveLayout.ts` own extracted screens/layout |
| Stopped input editing | `src/client/message-edit.ts` | `EditMessageDialog.tsx` owns drafts; `useRemote.ts` owns selection guards and history invalidation |
| Other chat views | `useSideChats.ts`, `useSubagentChats.ts` | `conversation-state.ts` shares event projection, while each hook retains its own creation/history/closing policy |
| Conversation rendering | `components/ThreadTimeline.tsx` | `TurnResponse.tsx`, `TimelineActivity.tsx`, `MarkdownText.tsx` |
| Styles | `styles.css` | Ordered imports from `styles/`; declaration order is significant |
| Host assembly | `src/server/index.ts` | `thread-router.ts` handles bounded reads; `peer-hub.ts` shares peer policy across WS and SSE |
| Native RPC policy | `src/shared/rpc-methods.ts` | Both protocol typing and the host allowlist derive from this catalog |
| Native automations | `src/server/automations.ts` | HTTP input/projection; `desktop-bridge.ts` loads the bundled `src/desktop-relay/automations.ts` host-service client; Desktop owns persistence and execution |
| Manager window | `desktop/main.mjs` | Trusted IPC, window and tray/menu-bar lifecycle; `tray-state.mjs` maps owned service state to native images |
| Manager operations | `desktop/manager-session.mjs` | Installation selection, serialization, health, security, update and recovery operations |
| Updates | `release.mjs`, `update-inputs.mjs`, `update-prepare.mjs` | Release lookup, input validation and preparation; `updater.mjs` installs; `update-transaction.mjs` owns crash recovery |
| Manager rendering | `desktop/renderer/main.tsx` | `contract.ts` declares the renderer bridge and state |
| Runtime delivery | `scripts/package-runtime.mjs` | `runtime-files.mjs` filters staging; `archive-runtime-symbols.mjs` keeps separate CI diagnostics |
| Live file previews | `src/client/useFilePreview.ts` | `server/preview-watch.ts` owns scoped authenticated revision events; `FilePreview.tsx` and `PdfPreview.tsx` preserve reading state |
| Write identity | `client/action-intents.ts`, `server/action-ledger.ts` | `shared/action-policy.ts` selects native writes; `side-chat-actions.ts` retains the original ephemeral operation |
| History bounds | `client/history-window.ts`, `history-window-controller.ts` | `useRemote.ts` owns selection and native cursors; `ThreadTimeline.tsx` owns reading anchors and interaction idleness |
| API boundary | `server/api-boundary.ts` | Default authentication, exact public exceptions, real HTTP regression tests |
| Preview resource policy | `shared/preview-security.ts` | `server/file-preview.ts` checks lexical and real paths; `client/preview-rendering.ts` installs CSP before scripts |
| Terminal isolation | `server/terminal-process.ts`, `terminal-worker.ts` | `terminal-manager.ts` owns lifetime/limits; only the worker loads the native PTY |
| Publisher trust | `desktop/release-signature.mjs`, `release-keys.mjs` | `package-runtime.mjs` signs; `update-prepare.mjs` validates runtime and source fallback |
| Bounded service output | `scripts/rotating-log.mjs` | `background-service.mjs`, Windows host and tunnel supervisor capture owned output |

Main-chat bounded history, streaming batches and selection cancellation remain
distinct from side/subagent projections. A side tab closes its ephemeral native
chat; closing a subagent viewer never interrupts the native child. Keep these
policies explicit when changing shared code.

The RPC catalog is an allowlist, not a retry policy. Read classifications must
never cause uncertain model or approval actions to be replayed.

Browser renderer libraries are build dependencies: Vite bundles their required
code and assets into `dist/client` and the separate manager build. Host libraries
and the native PTY remain production dependencies. The runtime includes source
baselines, scripts, documentation and transaction recovery inputs. Staging excludes
test caches, command links, PDB symbols and other platforms' prebuild directories;
it preserves the target native binaries and the macOS executable helper.
Debug symbols are retained as a separate workflow artifact.

For refactoring acceptance, compare against an exact source tag and its built
client before changing the version. Run the existing behavior suite, typechecks,
builds, synthetic desktop/mobile UI comparisons, manager smoke checks, production
dependency/PTY checks and packaged-update/recovery checks. Synthetic tests do not
replace signed-in macOS integration or physical-phone network acceptance.
