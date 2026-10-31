# Maintainer Handoff

Last reconciled: 2026-10-31.

## Authority

Read [AGENTS.md](../AGENTS.md) before implementation and
[CONTRIBUTING.md](../CONTRIBUTING.md) before publication.
The package and lockfile define the source version. A deployment's own acceptance
record must identify its actual source revision, assets, processes and live checks;
a merge or successful CI alone does not establish deployment.
The [README overviews](../README.md) introduce the product; the
[English](guide.md) and [Chinese](guide.zh-CN.md) guides define supported behavior
and operating limits. The [documentation index](README.md) separates these from
historical evidence. Dated acceptance records retain
their original scope and do not establish current physical-device performance.

Remote 0.2.6 adds authenticated web backend updates in Settings. The independent
worker snapshots updater code and dependencies under output before replacing
the live installation; Windows WMI / a separate macOS launchd job isolates it
from service shutdown. Only the selected backend restarts. Keep the existing
transaction/rollback protocol, do not replay uncertain install POSTs, and expose
only projected progress over HTTP. Success refreshes the matching public client
through `/remote-client/`, bypassing independently deployed static edge assets.
Manager stays 0.2.0. See [web updates](web-backend-update.md).

Remote 0.2.5 keeps image/skill drafts with their main chat across Composer
unmounts and asynchronous file/send completions. DraftsContext belongs to the
workspace, not a module global; temporary side drafts stay local. Only text is
stored in sessionStorage. Image previews reuse ImagePreview. Historical
reading-tail space releases after downward reading settles or when following
latest; observe viewport changes as well as content size. Keep this separate
from native history data/order. Run `node scripts/check-composer-layout.mjs`
after building, with the optional desktop Playwright dependencies installed.
See [draft and layout acceptance](composer-layout-acceptance.md).
Transport recovery is explicit `connectionError` state, separate from action
errors; never classify a model 429 as a lost browser connection by matching text.
`native-error-content.ts` projects native retry progress and terminal JSON messages
for display only, preserving the original public error model. The error row uses
compact monochrome styling; do not reintroduce generated titles/status labels.

The 0.2.4 completion of the native-order batch reconciles late events with
subsequent native reads without duplicating items or rewinding newer live text.
Native arrays determine shared-item order; retain live-only neighbours and
idempotent reconciliation. The preceding 0.2.3 fixes late native items/deltas being appended after a newer
conversation, which displayed the earlier turn's duration under the latest reply.
Keep native turn/item identity, timestamp anchors and bounded history; stale
completion events cannot clear a newer active turn. See [native order](native-history-order.md).
Stable manager code/installers remain at 0.2.0, matching Remote v0.2.2's companion
manager. Self-update is paused under the user-requested name 0.2.0AU on
archive/manager-0.2.0AU; preserve its commits, artifacts and acceptance records.
Manager signing/notarization remains a checkpoint, not current work.
See [the archive and resume conditions](manager-self-update-checkpoints.md).

The preceding 0.2.2 batch polishes the edit dialog without changing its native mutation
flow. Remote and manager now have independent package versions. The manager's
new baseline is 0.2.0; a Remote-only release must not bump, rebuild or install it.
The manager packaging workflow compares its version with the preceding Remote
tag and rejects manager source edits without a version change. Release notes
must list both versions and separate changes, explicitly stating no changes
where applicable. Existing published tags remain historical records.

The 0.2.1 batch adds service-state tray/menu-bar images and editing of the latest
interrupted turn's original input in the main chat. `message-edit.ts` owns fresh
native preflight and the once-only `thread/revert` then `turn/start` sequence;
the dialog retains drafts after failure. Preserve images, skills and native
file/application context. Navigation/reconnection must stop dependent sends.
Reverted history invalidates host/browser/device caches and observed question
counts; executed file changes remain. Synthetic acceptance covers eight
viewports, cancellation, changed history and uncertain acknowledgements.
Manager smoke checks actual native-image transitions on both packaged platforms.
Live signed-in Mac and physical-phone acceptance remain separate.

The preceding 0.2.0 batch organizes chat rendering, directory reads, host routes/peers,
manager operations and update preparation without changing the UI or native
behavior. Browser libraries are build dependencies; runtime staging removes
caches, symbols and foreign prebuilds while retaining the target PTY/helper.
See [code ownership](code-organization.md) and
[baseline acceptance](refactor-acceptance.md). Version changes follow acceptance,
not the initial extraction. Keep final platform package/CI evidence distinct
from synthetic UI comparison and physical-device acceptance.
Final source is tagged at `6bd9543b711ac06310ed0bda26b6e26a6d52a804`.
Three-platform CI and both platform package workflows passed; source/packaged
manager smoke and actual runtime upgrade/rollback acceptance passed on both.

The preceding 0.1.16 batch maps native runtime error events and failed-turn metadata across
main, side and subagent chats, outside process folds. Preserve actual native HTTP
codes and retry flags without inferring 429 or resubmitting model work. Bounded
history/outline projections retain final errors; late in-progress snapshots retain
active retry indications. RPC hops preserve numeric codes and public error data.
See [runtime errors](native-runtime-errors.md). Tests use synthetic failures.

The preceding 0.1.15 batch simplifies the manager and adds uncertainty-aware public diagnosis,
bounded redacted logs and confirmed repair of owned services. Device/password
administration is local-only, with stdin secrets and durable session revocation.
Old logins remain compatible until observed/revoked; password changes invalidate
all generations. Active WS/SSE/terminal peers check revocation on activity and at
five-second idle intervals. External tunnels and Desktop remain independently
owned. Install both the manager and host update for the security controls.

The preceding 0.1.14 batch adds verified platform runtime assets and durable installation
transactions. Standard updates use release-provided source baselines and production
dependencies without Git/npm/build; customized inputs retain the source path.
`runtime.yml` builds Windows x64 and Apple Silicon assets, validates the unpacked
runtime and uploads the manifest/archive pair. Manager 0.1.14 must be installed
separately to use the new updater. A flushed installation journal precedes service
stop; startup recovery restores the original run state and retains dependency
backups across repeated crashes. Recovery failure blocks mutations, preserving
later source edits and damaged evidence. Read the bilingual manager guides.

The preceding 0.1.13 batch exposes Chinese update stages, completed-step percentages,
elapsed times and bounded raw command output. Long steps do not fake progress.
Transient downloads retry within finite limits; the original registry/proxy
configuration remains authoritative. Preparation validates an actual offline
install before stopping service. Installation retains old dependencies for
network-independent recovery and uses the prepared cache offline.
Reports distinguish preparation failure, recovered old versions and incomplete
recovery; successful installs are not reported failed solely for cleanup errors.
Release titles, headings and summaries use Chinese, preserving necessary names
and identifiers. The manager executable updates separately from host files.

The preceding 0.1.12 batch isolates npm caches for update preparation, installation and
rollback, bypassing user-cache permission failures without modifying that cache.
Install the new manager executable before retrying a host update. Desktop
diagnostics distinguish endpoint/page/bridge readiness and clear on recovery;
Start can leave Desktop pending, while updates require a previously healthy
Desktop connection to recover. Ordinary Desktop launches need not expose 9229.
GUI review also corrected hidden diagnostics in the smallest manager window,
platform-specific log advice, lost operation errors and macOS activation after
hiding. Smoke checks cover visible diagnostics, dismissal/recovery and Mac
activation in addition to tray/menu-bar transitions.
First-run discovery validates existing service registrations, nearby paths and
common user folders without executing controls. A valid saved selection wins;
one registered service can be selected automatically, while ambiguous unowned
checkouts require the user's selection. Manual browsing remains available.

The preceding 0.1.11 batch preserves conflicting local Markdown during manager updates,
with incoming copies and a retention receipt, while continuing to reject source/
configuration conflicts. Windows tasks run without persistent consoles and migrate
on Start. External macOS tunnels stay externally owned; the manager separately
checks public-origin health. Users blocked in a 0.1.10 manager must install the
new manager executable before retrying. See the bilingual manager guide below.

The preceding 0.1.10 functional batch adds an optional Windows/macOS desktop manager:
tray/menu-bar residency, owned platform controls, layered local health and staged
release updates with conflict detection, backups and recovery. See the bilingual
[manager guide](desktop-manager.md). Electron dependencies are separately installed.
Unsigned packaging and live Mac acceptance have separate boundaries.
macOS installers target Apple Silicon only. The packaging workflow opens a
synthetic Electron window on each supported OS; signed-in Mac acceptance remains
separate. See [manager acceptance](desktop-manager-acceptance.md).

The preceding 0.1.9 functional batch integrates PR #6's native question visibility,
cross-turn pending forms, temporary-chat answers, sidebar badges and opt-in
question notifications. Maintainer corrections preserve embedded message order
and simultaneous approval indicators. See [the integration review](pr-6-review.md).

The preceding 0.1.8 functional batch adds an on-demand native conversation summary panel
and checks the loaded build before offering a confirmed update with release notes.
Already current checks preserve the page. See [summary scope](native-summary-panel.md)
and [the update investigation](manual-version-update.md). Functional batches now
publish a matching GitHub Release, source commit and change summary.

The preceding 0.1.7 functional batch integrates PR #5's phone conversation-index sheet
refinements and independent sidebar spinner layer. Maintainer corrections scope
the trigger background/focus changes to mobile and preserve the next patch
version. Physical iOS animation smoothness is not confirmed. See
[the integration review](pr-5-review.md).

The preceding 0.1.6 functional batch integrates PR #4's plain sidebar title and removal
of the help shortcut. The proposed further button shrinking was rejected:
mobile remains 36px and desktop retains its existing sizes. See
[the integration review](pr-4-review.md) for scope and verification.

The preceding 0.1.5 functional batch integrates PR #3 after maintainer corrections:
manual public-app updates, a standalone recovery entry and mobile-only control
and sidebar-gesture refinements. See [the integration review](pr-3-review.md)
for accepted changes, corrected regressions and desktop/mobile evidence.
Prior native question forms, lazy execution details, 15-second chat/timing
downloads, connection recovery and notification previews are retained.

## Next Work

Refresh pending pull requests before starting the next batch. Treat contributions
as proposed changes: compare desktop and mobile behavior against the deployed
baseline and prior optimizations before integrating them. Use synthetic fixtures;
do not create real model turns or notifications just to verify layout.

Mobile composer controls intentionally use 36px sizing on small screens.
Preserve desktop sizing and corners; mobile adaptation must not become a global
style change. Main and side-chat controls must have matching mobile geometry.
Only an actual manual update refreshes the page: main-chat text drafts persist, while
temporary side chats, unsent images and skill selections are cleared.

Outstanding acceptance:

- Physical iPhone Safari and Home Screen use on separate Wi-Fi and 5G:
  authentication, first task/chat loading, long-history upward paging without
  flashing, foreground recovery and actual notification display.
- Signed-in macOS Desktop integration, login persistence and tunnel operation.
- Actual native asynchronous answers and physical mobile keyboard behavior.
  Forms cover observed unanswered questions across loaded main-chat turns and
  temporary side chats. Questions beyond the bounded loaded window or an evicted
  memory index are not claimed complete.
- Some approval forms, actual dictation and a fresh active subagent lifecycle.
- Sustained connection stability under real network/proxy changes. Earlier
  intermittent public failures are not proven eliminated by short live probes.

Model/project catalogs currently read their first requested page. New-chat
reasoning defaults can differ from global configuration overrides. Remote PTYs
run as the host user outside model permission profiles.

## Release and Recovery

1. Inspect branch, status, worktrees, pending PRs and the deployment's current
   acceptance record. Preserve unrelated edits and machine-specific settings.
2. Develop in the public source checkout. Compare reviewed changes against the
   running installation before copying; never reset a private deployment to an
   old Git base or publish its local data.
3. Increment the patch once per completed functional change batch unless explicitly
   directed otherwise. Neat closeout, handoff and documentation-only updates do
   not increment it. Align package, lockfile, visible version, local build and edge.
4. Run appropriate checks. Application changes require typecheck, tests and build.
   Documentation-only changes need link/privacy checks; they do not require a
   release build or service restart. Record which functional tests were not repeated.
5. Back up the affected installation files and build. Preserve configuration,
   authentication, notification keys/subscriptions and retained attachments.
6. Publish only the reviewed public files, verify remote revision and CI, and
   install matching built assets. Upload assets before switching the shell.
   Keep older chunks for existing clients. Publish a matching GitHub Release
   with version tag, exact source commit and Chinese titles, headings and changes;
   align release-notes.ts.
7. For configured static-edge installations, use the existing authenticated
   `cf` workflow in the [operations guide](guide.md#optional-static-edge-hosting).
   Private API, socket and health routes stay on
   the origin. Restarting the origin does not update edge assets.
8. Restart Remote after every application update, including frontend updates.
   Verify that its old listener and process exited before starting it once.
   Leave Desktop running; restart the tunnel only when needed.
9. Verify local and canonical public health, Desktop transport, shell/worker/asset
   agreement and authenticated read-only history. Verify anonymous private reads
   are rejected. Do not print cookies or conversation contents.
10. Update the single current deployment record with exact evidence and limits.
    Installed PWAs require every Remote window to close before a waiting update
    activates; version-check the reopened application.

If deployment fails, restore only that batch's backed-up files and matching
assets, restart Remote and verify both origins again. Preserve runtime data and
do not roll back native conversation state. Check the actual active edge version
before claiming that rollback is complete.

## Evidence and Cleanup

The earlier 2026-10-30 README closeout reorganized both languages, moved detailed
instructions into bilingual guides and preserved 0.1.9 at that checkpoint.
Subsequent manager changes are recorded by their matching tags and Releases;
each installation's private acceptance record remains the authority for its
deployed version. Do not use this historical README checkpoint as a release pin.
Documentation-only closeouts do not increment the application version, rebuild,
restart services or publish another Release.

Ignored QA artifacts, deployment backups and review branches can contain unique
or private evidence. Inventory them before proposing cleanup, distinguish
reproducible builds from unique diagnostics, and retain old deployed chunks for
open clients. Complete the report before requesting explicit cleanup approval.
Never upload ignored runtime evidence or use screenshots containing real chats
in public documentation.
