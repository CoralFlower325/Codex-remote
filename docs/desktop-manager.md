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

Select the configured directory containing `.env`, `package.json`, `scripts/`
and `dist-server/`. Complete host setup first if these are missing. Development
mode defaults to the source checkout; choose the actual installation if separate.
Ownership conflicts disable controls instead of replacing another installation's
scheduled task or LaunchAgent.
Older platform scripts without JSON status use the manager's bundled read-only
probe; they do not need to be edited before opening the manager.

## Everyday Operation

- Start, stop and restart reuse existing platform controls and preserve Desktop.
- Close/minimize keeps the manager in the Windows notification area or macOS
  **top menu bar**. The macOS Dock is separate. Use the icon to reopen the window.
- Tray menus offer status, show/open, start/stop, update checks and quit.
  Quitting the manager preserves Remote's current state.
- Installed builds offer manager login startup, separately from Remote service
  startup. Start/Stop continue enabling/disabling Remote's own login startup.
- Health refreshes every five seconds without overlapping reads: owned backend,
  Desktop transport, password and managed Windows tunnel. Running alone is not
  healthy. Readings older than twenty seconds become stale.
- macOS independent tunnels remain separately managed. Local tunnel readiness
  does not establish public DNS, proxy, HTTPS or browser reachability.
- Bounded operation records contain manager actions only and stay in memory.
  Installation files open locally; diagnostics are not uploaded.

## Local Updates

Check the release in **Version updates**, read its summary and confirm installation
in the native dialog. Already current checks leave the service and window intact.
Node.js 22.19+, npm and Git must be on PATH, including standard Homebrew locations.

1. Fetch official version tags into an isolated temporary directory.
2. Compare upstream-changed files with the installed release's originals. CRLF
   differences are accepted. Unrelated edits remain; conflicts, local deletions,
   symlinks and protected runtime paths block installation. Customized package/
   lockfiles may require maintainer assistance.
3. Combine the incoming changes with preserved local `src/`, `public/`, `scripts/`
   and standard build configuration in the isolated directory. Install dependencies,
   typecheck, test and build while the existing service runs. Runtime `.env` and
   private data are not copied into staging. Recheck build input hashes before install.
4. Back up affected sources and builds under `output/manager-backup-*`. Stop Remote
   and wait for the old backend to exit before replacing files.
5. Install sources/builds and locked dependencies. Restart and verify a previously
   running service; an explicitly stopped installation stays stopped.
6. Attempt backup recovery on installation/startup failure. Failed recovery displays
   the backup location and requires manual attention.

`.env`, `data/`, authentication, attachments and notifications are preserved.
The updater never resets Git or pushes the installation. Deployed files remain local
changes; future comparisons use the installed version tag rather than assuming a
clean HEAD. Backups and older frontend chunks for open tabs remain available.

This updates **the selected host installation**, not the manager executable.
Install a newer manager from its Release. Independent static-edge/CDN assets and
external tunnels are not deployed here. Public-origin installations receive a
reminder to synchronize externally hosted frontend assets through the hosting guide.

Cross-platform tests cover ownership, release selection, conflicts, protected paths,
backups, recovery and stopped-state preservation. macOS packaging, shell and
LaunchAgent CI do not establish signed-in Mac menu-bar, Dock, login or Desktop
integration acceptance.
The packaging workflow also opens a real Electron window against synthetic health
data on Windows and macOS, checking layout, isolation, current-version checks,
minimize/close residency and macOS Dock hiding/restoration. It does not connect
to a signed-in Desktop or change login items.
