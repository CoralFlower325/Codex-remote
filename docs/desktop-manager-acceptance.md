# Desktop Manager Acceptance

Latest functional batch: 0.1.14, 2026-10-30.

## Prebuilt Runtimes And Interrupted Updates

The updater checks the release-provided manifest/archive pair and GitHub digests,
validates every archive path and file checksum, and runs a production-dependency
plus native-terminal probe before live changes. Source modifications select the
existing isolated build path. Release CI packs Windows x64 and Apple Silicon
runtimes from production dependencies, unpacks them and exercises a real
old-source upgrade, stopped-state preservation and an injected verification
failure with old-dependency restoration. Local Windows production-package
acceptance passed; use the final tagged CI jobs for cross-platform results.

Child-process tests forcibly terminate installation before dependency moves,
after a move, before/after atomic source replacement and during verification.
They also terminate recovery itself and successfully retry it. Separate cases
preserve stopped state and later manual edits, reject damaged recovery evidence,
finalize committed transactions without rollback and resolve path aliases to
one canonical installation identity. These simulate abrupt process termination;
they do not claim physical power-loss testing.

## Update Progress And Recovery

The following 0.1.13 record retains its original scope and test counts.

Local validation passes 499 tests across 71 files, typecheck, web/manager builds
and source Electron checks at 400, 480 and 780 widths. Synthetic progress checks
verify the numeric progress element stays visible in the minimum window and
service controls remain disabled while updating. Statuses and error explanations
are Chinese; bounded raw npm/test output retains its original language.

An isolated real v0.1.12-to-v0.1.13 update fetched exact local Git source and used
real npm dependency installation, typecheck, tests and builds. An injected initial
ECONNRESET was retried. Staging completed an actual offline reinstall before the
install callback; final dependency installation succeeded offline with deliberately
unusable proxy settings. The original dependency directory remained in the backup,
private fixture files were unchanged and the stopped fixture stayed stopped.
Temporary cache/staging cleanup completed and progress reached 100 only at success.
This proves the local transaction boundary, not the user's macOS network.

Unit checks cover bounded/redacted output, percentages that remain stable during
logs, distinct recovery progress, one transient preparation retry, no retry for
validation failures, partial-stop recovery, failed recovery and restoration of old
dependencies without a second npm command. Final release packaging additionally
requires source and packaged Electron checks on Windows and Apple Silicon macOS.
Use the exact tagged workflow results and private deployment receipt for final
packaged/installed acceptance; signed-in Mac integration remains separate.

## Historical Baseline

The following 0.1.10 record retains its original scope; its counts are historical.

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
validate a prebuilt runtime or build before service shutdown, preserve runtime
data and retain backups. Already
current checks do not restart the service. A running installation is verified
after an update; a stopped installation stays stopped. The manager executable
and independent edge/CDN assets update separately.
