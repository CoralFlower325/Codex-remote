# Code Organization

This map describes ownership boundaries. It does not change product behavior.

| Area | Entry / Owner | Supporting Modules |
| --- | --- | --- |
| Main chat | `src/client/useRemote.ts` | `useWorkspaceDirectory.ts` owns task/catalog reads; `remote-connection.ts` owns connection recovery |
| Other chat views | `useSideChats.ts`, `useSubagentChats.ts` | `conversation-state.ts` shares event projection, while each hook retains its own creation/history/closing policy |
| Conversation rendering | `components/ThreadTimeline.tsx` | `TurnResponse.tsx`, `TimelineActivity.tsx`, `MarkdownText.tsx` |
| Styles | `styles.css` | Ordered imports from `styles/`; declaration order is significant |
| Host assembly | `src/server/index.ts` | `thread-router.ts` handles bounded reads; `peer-hub.ts` shares peer policy across WS and SSE |
| Native RPC policy | `src/shared/rpc-methods.ts` | Both protocol typing and the host allowlist derive from this catalog |
| Manager window | `desktop/main.mjs` | Trusted IPC, window and tray/menu-bar lifecycle |
| Manager operations | `desktop/manager-session.mjs` | Installation selection, serialization, health, security, update and recovery operations |
| Updates | `release.mjs`, `update-inputs.mjs`, `update-prepare.mjs` | Release lookup, input validation and preparation; `updater.mjs` installs; `update-transaction.mjs` owns crash recovery |
| Manager rendering | `desktop/renderer/main.tsx` | `contract.ts` declares the renderer bridge and state |
| Runtime delivery | `scripts/package-runtime.mjs` | `runtime-files.mjs` filters staging; `archive-runtime-symbols.mjs` keeps separate CI diagnostics |

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
