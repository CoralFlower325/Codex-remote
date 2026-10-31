# Desktop Manager

The optional local manager controls an existing, built Codex Remote installation,
independently of the web server. It leaves Codex Desktop running, creates no model
turns and exposes no network control API.

## Install And Open

Download the Windows installer or macOS DMG/ZIP from the matching
[GitHub Release](https://github.com/CoralFlower325/Codex-remote/releases).
Windows packages target x64; macOS packages target Apple Silicon (arm64).
Initial packages are unsigned; normal Windows reputation/Gatekeeper approval may
be required. Signing, notarization and live macOS GUI acceptance remain pending.

Source development:

```bash
npm ci
npm run manager:install
npm run manager
```

The manager restores a valid saved installation first. Otherwise it automatically
checks the Windows `CodexRemote` task or macOS `com.codex.remote` LaunchAgent,
nearby directories and common user folders. A single registered service takes
priority; multiple unregistered installations are offered in a selector instead
of guessed. The scan button repeats discovery; folder browsing remains available.
Select the configured directory containing `.env`, `package.json`, `scripts/`
and `dist-server/`. Complete host setup first if these are missing.
Discovery reads installation metadata and does not start or stop services.
Ownership conflicts disable controls instead of replacing another installation's
scheduled task or LaunchAgent.
Older platform scripts without JSON status use the manager's bundled read-only
probe; they do not need to be edited before opening the manager.

## Everyday Operation

- Start, stop and restart reuse existing platform controls and preserve Desktop.
- Windows runs server/tunnel tasks without persistent console windows. Start
  migrates older console tasks once; backend output goes to `data/server.out.log`
  and `data/server.err.log`. `npm start` remains a foreground developer command.
- Close/minimize keeps the manager in the Windows notification area or macOS
  **top menu bar**. The macOS Dock is separate. Use the icon to reopen the window.
- The resident icon is translucent gray while Remote is stopped or its status
  is unknown. An owned running service uses a solid icon: white on dark system
  surfaces and dark on light surfaces. Desktop/public-entry faults do not turn
  an owned running service into a stopped indication.
- Tray menus offer status, show/open, start/stop, update checks and quit.
  Quitting the manager preserves Remote's current state.
- Reopening the running macOS app through Finder, Spotlight or the Dock restores
  its hidden window after the brief Dock transition. Operation failures remain
  visible until dismissed or another operation begins, with a bounded reason in
  the operation records. Healthy polling does not erase them or disable recovery
  controls; health-read failures remain separate and clear on recovery.
- Installed builds offer manager login startup, separately from Remote service
  startup. Start/Stop continue enabling/disabling Remote's own login startup.
- Health refreshes every five seconds without overlapping reads: owned backend,
  Desktop transport, password and managed Windows tunnel. Running alone is not
  healthy. Readings older than twenty seconds become stale.
- Desktop diagnostics distinguish a missing debug endpoint, a missing Desktop
  page and a pending native bridge. Ordinary Codex launches do not necessarily
  enable port 9229; use the debug launch arguments from the setup guide. Another
  launcher such as Codex++ may supply these arguments. Remote uses Desktop's
  endpoint, not the launcher's own local server. Diagnostics clear on recovery.
  Start can succeed with Desktop sync still pending; the overall health remains
  degraded until Desktop connects.
- macOS LaunchAgent/daemon tunnels remain externally managed; the manager does
  not adopt or stop them. **Tunnel management** distinguishes managed tasks,
  external access and no managed configuration. **Public entry** independently
  checks the configured origin's `/health`, without cookies or redirects.
  Public reachability does not prove tunnel ownership or a particular route.
  A failed public check does not stop a healthy local service.
- Bounded operation records contain manager actions only and stay in memory.
  Installation files open locally; diagnostics are not uploaded.

## Diagnosis And Device Access

Version 0.1.15 organizes controls into Overview, Devices and Password, and Updates.
Network failures/timeouts show an unknown public-entry state; HTTP errors and
unexpected health responses remain distinct. Recheck uses a longer bounded probe
through the system network stack. Open the entry or inspect bounded, redacted local
logs. Confirmed repair restarts only the selected owned Remote service or Windows
managed tunnel. It never restarts Desktop or takes over external macOS tunnels.
Repair does not fix DNS, proxy settings or a disabled Desktop debug endpoint.

Devices and Password uses local IPC and a stdin-only administration command, with
native confirmation before changing credentials. Change the access password or
revoke one/all browser sessions; password changes invalidate every old login.
Existing WS/SSE/terminal connections stop accepting access immediately on activity
or within five seconds when idle. Already dispatched model work continues.
Device records contain browser/OS labels and timestamps, not cookies, raw user
agents or IPs. Each browser profile/login is a separate session. Up to 200 recent
active sessions are shown; legacy logins appear on their next use. Revoke all also
invalidates unseen legacy logins. OS Web Push permissions are managed separately.
Install the new manager and update the host to enable these controls.

## Local Updates

Check the release in **Version updates**, read its summary and confirm installation
in the native dialog. Already current checks leave the service and window intact.
Node.js 22.19+ must be on PATH, including standard Homebrew locations.
The customized source workflow also requires npm and Git; prebuilt runtime
updates do not require them.

The progress display uses Chinese stage labels, a percentage based on completed
steps, total/stage elapsed time and bounded recent command output. Percentages
use weighted stages, with actual byte progress inside runtime downloads; they do
not estimate time remaining. Other long steps hold their percentage;
after thirty seconds without output, the display explicitly says it is waiting.
Raw dependency/test output retains its original language. Network errors get a
Chinese explanation rather than replacing the whole screen with npm output.
Downloads use bounded npm request retries and at most one command retry for
transient network failures, preserving configured registries and proxies.
Each npm command has a ten-minute deadline; source fetches have three minutes.
Release checks and runtime downloads use the manager's native system network stack
and system proxy configuration; they do not modify system or npm proxy settings.

0. Manager 0.1.14+ checks the platform runtime manifest and its GitHub SHA-256.
   Standard installations use its source baseline; custom inputs or absent baselines
   select the source workflow below. Download and hash the runtime archive, reject
   unsafe paths, links, duplicate entries and size mismatches, verify every file and
   smoke-check dependencies plus the native terminal. This path needs Node.js 22.19+
   but no Git, npm installation or local test/build. Incomplete runtime asset pairs
   stop preparation instead of silently falling back.
1. For source installations, fetch official version tags into an isolated temporary directory.
2. Compare upstream-changed files with the installed release's originals. CRLF
   differences are accepted. Unrelated edits remain. Conflicting local Markdown
   in root `AGENTS.md`, `CLAUDE.md`, `README*.md` or `docs/` is retained, including
   deliberate deletions. Source/configuration conflicts, local source deletions,
   symlinks and protected runtime paths still block installation. Customized
   package/lockfiles may require maintainer assistance.
3. Combine the incoming changes with preserved local `src/`, `public/`, `scripts/`
   and standard build configuration in the isolated directory. Install dependencies,
   typecheck, test and build while the existing service runs. Runtime `.env` and
   private data are not copied into staging. Reinstall dependencies offline in staging
   to confirm the owned cache is usable before stopping anything.
   Recheck build input hashes before install.
4. Back up affected sources and builds under `output/manager-backup-*`. Stop Remote
   and wait for the old backend to exit before replacing files.
   Retained documentation has local copies under `source/`, incoming copies under
   `incoming/`, and deletion/retention entries in `receipt.json`. Completion lists
   the retained paths for manual reconciliation; local rules are never overwritten
   to resolve a conflict automatically.
5. Retain the original dependency directory in the backup, then install sources,
    builds and dependencies: copy verified runtime dependencies, or install offline
    from the validated cache for source builds. Restart and verify a previously
   running service; an explicitly stopped installation stays stopped.
6. Attempt backup recovery on installation/startup failure. Restore original
   dependencies directly when available, without a network request; an installation
   lacking dependencies must reinstall the old lockfile. Failed recovery displays
   the backup location and requires manual attention. Recovery has its own percentage
   and outcome; restored old versions are not presented as successful updates.
   Cleanup failures after a successful installation are warnings, not failed updates.

Before stopping service, persist `output/manager-update/active.json`. Record phases
around dependency moves, file installation, verification and commit. Reopening the
manager or selecting that installation recovers unfinished transactions first.
Failed recovery blocks service mutations and updates and offers a retry. Dependency
backups survive restoration so a second crash remains recoverable. Explicitly stopped
services stay stopped. Later manual source edits, missing or damaged backups stop
automatic overwrites and preserve the evidence. Committed transactions never roll
back; interrupted preparation leaves the live installation unchanged. The installation
filesystem must support atomic renames and hard links.

Source preparation, live dependency installation and rollback share one updater-owned
temporary npm cache, including nested npm commands. The updater neither uses
nor repairs the user's existing cache and removes its temporary cache at the end.
If macOS reports `EACCES`/`EEXIST` under `~/.npm/_cacache`, install manager 0.1.12
or later first, then retry the host update with the same installation selected.
An already connected Desktop must reconnect after an update; if Desktop was
unavailable before installation, that existing condition alone does not cause
rollback. Its diagnostic remains visible.

`.env`, `data/`, authentication, attachments and notifications are preserved.
The updater never resets Git or pushes the installation. Deployed files remain local
changes; future comparisons use the installed version tag rather than assuming a
clean HEAD. Backups and older frontend chunks for open tabs remain available.

This updates **the selected host installation**, not the manager executable.
The manager and Remote display their own versions and may differ. Update checks
compare the selected Remote installation with the release. Install a newer manager
separately when its controls or updater need a fix. Stable manager 0.2.0 does not
include manager self-update. Its paused 0.2.0AU development line and signing
prerequisites are preserved in [the resume checkpoint](manager-self-update-checkpoints.md).
The manager uses an independent version starting at 0.2.0. Remote-only updates
leave the manager and its version unchanged. Every Release lists both component
versions and their changes; unchanged manager installers remain in their original
Release rather than being rebuilt.
Install a newer manager from its Release. Independent static-edge/CDN assets and
external tunnels are not deployed here. Public-origin installations receive a
reminder to synchronize externally hosted frontend assets through the hosting guide.
If a 0.1.10 manager is blocked by Markdown conflicts, install the 0.1.11 or newer
manager first, select the same host directory and retry. The old executable cannot
use the fixed updater merely by checking for a new host release. Do not reset Git
or delete the local documents.

Cross-platform tests cover ownership, release selection, conflicts, protected paths,
backups, recovery and stopped-state preservation. macOS packaging, shell and
LaunchAgent CI do not establish signed-in Mac menu-bar, Dock, login or Desktop
integration acceptance.
The packaging workflow also opens a real Electron window against synthetic health
data on Windows and macOS, checking layout, isolation, current-version checks,
minimize/close residency and macOS Dock hiding/restoration. It does not connect
to a signed-in Desktop or change login items.
