# Codex Remote

Self-hosted React and Node.js workspace for Codex Desktop.

## Commands

- Install: `npm ci`
- Validate: `npm run typecheck`, `npm test`, `npm run build`
- Development: `npm run dev`
- Production: `npm start`

## Scope and Required Reading

- Develop and publish in this public repository on `main`. The sibling
  private Windows installation is deployment-only; never push or reset it.
- Before changing code or tests, read all
  [development contracts](docs/development-contracts.md). They preserve the
  detailed UI, loading, history, transport, terminal and manager constraints.
- Read [code ownership](docs/code-organization.md) for affected modules and
  [maintainer handoff](docs/maintainer-handoff.md) for current state,
  acceptance gaps, release, recovery and cleanup. Before deployment, also
  read the installation's own current acceptance record.
- Preserve existing edits, private configuration/data, drafts and reading
  position. Use synthetic fixtures; distinguish CI/simulated viewports from
  actual sending, physical iPhone and signed-in macOS acceptance.
- Use only Desktop's existing App Server. Never start a standalone fallback,
  stop Desktop, bypass native writer locks or replay uncertain model,
  approval or archive actions. Bridge loss stays offline and reconnects.
- Probe comma-separated `CODEX_DESKTOP_DEBUG_PORT` candidates plus standard
  `9229`; on Windows and macOS, additionally discover the loopback debug port
  from the current top-level installed Codex/ChatGPT process. Accept only trusted
  installation paths and loopback CDP socket URLs, and prefer the main Codex
  window over overlays. A command timeout on an
  OPEN DevTools socket must discard that socket and reconnect instead of leaving
  every later request attached to a half-dead CDP connection.
- Follow the existing light, compact native UI. Keep desktop and mobile
  layouts distinct; do not weaken the detailed development contracts.
- Retain backups, evidence, old chunks and paused AU work. Inventory cleanup
  candidates, report the complete result, then wait for explicit user
  cleanup confirmation before deleting branches, worktrees or artifacts.

## Publication and Privacy

- Increment the package patch version once per completed functional change batch.
  Neat closeout, handoff and documentation-only updates do not increment it.
  Keep package.json, the lockfile, deployed assets and the visible version aligned.
  An explicit user version takes precedence.
  Remote and the desktop manager have independent versions. Remote's version lives
  in the root package/lockfile; the manager's lives in desktop/package/lockfile.
  The stable manager is independently versioned at 0.2.7; installers are in
  v0.2.29. Remote-only changes must not increment, rebuild
  or install the manager. Increment the manager patch only for its own changes.
  Manager self-update is paused as 0.2.0AU on archive/manager-0.2.0AU;
  keep AU self-update out of the stable manager and formal releases. Preserve AU history,
  artifacts and receipts; Mac signing/notarization remains a resume checkpoint.
  Runtime manifest authentication is separate: all new runtime releases require
  Ed25519 publisher signatures verified against pinned public keys. Source
  fallback must match a signed release commit; never bypass missing signatures.
  Remote 0.2.29 / manager 0.2.7 are the current formal release.
  Verify each installation against its own current acceptance record.
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
  Installed managers load their bundled updater: install manager 0.2.7 manually
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
- Model/project catalogs are read to completion with cursor-cycle and page
  limits; the client only commits a complete snapshot. Model defaults can still
  differ from global configuration overrides; do not imply otherwise.
- Remote terminals are separate from Desktop shells and bypass model permission
  profiles; document this in both READMEs. Some approval forms and native
  question submission still need dedicated live acceptance.
- Windows terminal workers attach to a kill-on-close Job Object before starting
  the shell; POSIX workers use an owned process group. Prebuilt runtime manifests
  pin Node 22.19.x and must fail closed on a different major/minor ABI.
- Windows has live desktop acceptance. macOS has CI coverage for builds, unit
  tests, shell syntax, and generated LaunchAgents; signed-in desktop integration,
  login persistence, and the legacy tunnel still need live macOS acceptance.
- Windows service start/stop, task migration and update actions must remain
  manager-owned and windowless. Use hidden scheduled tasks/processes; never open
  a visible command-prompt window for normal operation.
