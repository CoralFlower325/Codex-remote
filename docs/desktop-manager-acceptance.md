# Desktop Manager Acceptance

Functional batch: 0.1.10, 2026-10-30.

## Verified On Windows

- TypeScript checks, production web build and manager build pass.
- All 479 tests across 68 files pass, including changed-file conflicts, binary
  comparisons, symlink boundaries, preserved local build inputs, backups,
  rollback and explicitly stopped installations.
- A real Electron window passes 480x690, 400x550 and 780x800 layout checks.
  Healthy, stopped, degraded, conflict, busy and update states were inspected.
- The sandbox and context isolation are enabled; renderer Node integration is off.
  Minimize and close hide to the tray without destroying the window.
- A live already-current release check preserves the window. The cross-platform
  smoke check separately uses synthetic release metadata and verifies no reload.
- The packaged Windows application reads the selected installation and the
  bundled legacy status probe. Its real Stop/Start controls were exercised during
  the local 0.1.9 to 0.1.10 deployment. The old backend exited before replacement,
  the new backend reached ready Desktop transport, and Desktop kept its process.
  Quitting the manager left Remote running.
- The updater fetched the official 0.1.9/0.1.10 tags and completed real dependency
  installation, checks, tests, build and file installation in an isolated stopped
  fixture. A local source addition was compiled into the new backend, synthetic
  runtime data was preserved and the fixture remained stopped.
- The Windows x64 NSIS installer builds successfully. Packages are unsigned.

The live deployment used the maintainer's scoped copy procedure, preserving the
installation's customized package files. This is separate from the manager's
automated updater: that updater's transaction and failure paths are covered with
isolated fixtures, and overlapping private edits deliberately block installation.

## macOS And Release Gates

Only Apple Silicon (arm64) DMG and ZIP packages are produced. The packaging
workflow requires an arm64 runner and the same unit tests and manager build.
It opens a real Electron window against synthetic health data, checks three
window sizes, sandboxing, current-version behavior, minimize/close residency and
Dock hiding/restoration. Ordinary CI checks shell syntax and isolated LaunchAgent
start/stop ownership and structured status, including the legacy read-only probe.
See the repository's **Desktop Manager** and **CI** workflow results for the exact
source commit.

Synthetic runner checks do not establish signed-in macOS Desktop integration,
Gatekeeper behavior on a downloaded package, login-item persistence or independent
tunnel operation. Signing, notarization and physical Mac acceptance remain open.
No real model turn, answer or notification was submitted for these checks.

## Update Boundaries

Updates target the selected Remote host directory, require native confirmation,
build before service shutdown, preserve runtime data and retain backups. Already
current checks do not restart the service. A running installation is verified
after an update; a stopped installation stays stopped. The manager executable
and independent edge/CDN assets update separately.
