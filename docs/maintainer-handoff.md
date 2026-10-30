# Maintainer Handoff

Last reconciled: 2026-10-30.

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

The 0.1.10 functional batch adds an optional Windows/macOS desktop manager:
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
   with version tag, exact source commit and changes; align release-notes.ts.
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
The subsequent manager release is 0.1.10. Its functional source and installers
are recorded by the v0.1.10 tag and Release; each installation's private
acceptance record remains the authority for its deployed version.
Documentation-only closeouts do not increment the application version, rebuild,
restart services or publish another Release.

Ignored QA artifacts, deployment backups and review branches can contain unique
or private evidence. Inventory them before proposing cleanup, distinguish
reproducible builds from unique diagnostics, and retain old deployed chunks for
open clients. Complete the report before requesting explicit cleanup approval.
Never upload ignored runtime evidence or use screenshots containing real chats
in public documentation.
