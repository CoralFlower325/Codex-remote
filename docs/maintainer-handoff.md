# Maintainer Handoff

Last reconciled: 2026-11-07.

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

Remote 0.2.21 pairs with unchanged manager 0.2.3; manager installers remain
in v0.2.17. Tag v0.2.21 identifies functional source
`9a58ada18c9b13b6a4edfaa238212e1104f576e1`.
The [PR #10 review](pr-10-review.md) records functional checks;
the [download procedure](update-downloads.md#维护分发服务) records the current
release and distribution verification. Release publication, download distribution
and host installation are separate states.

The separately authorized Windows upgrade on 2026-11-07 installed formal Remote
0.2.21 and its matching public frontend. Local/public checks identify
`assets/index-BzEoI_da.js` and ready Desktop transport. Private data and old chunks
remain preserved; the manager stays 0.2.3. Consult the installation's own current
acceptance record for deployment evidence.

The next functional candidate is 0.2.22 for live file previews. Source validation
and a pull request do not publish or install that candidate. Report the completed
batch before publication/deployment, following the operator's approval boundary.

Remote now uses only Desktop's existing App Server. Bridge loss stays offline
and reconnects; it must never start a standalone server or replay uncertain
actions. The legacy orphan was removed after ownership checks, without editing
native sessions or locks. Writer conflicts stop automatic resume attempts;
actual sends and the old user-visible error after Retry remain live-acceptance
items. Terminal roots/cwd and preview path fixes are covered in the
[follow-up acceptance and physical-device checklist](review-followup-acceptance.md).
The macOS zsh byte/offset issue and logical-path assertion are fixed.
Windows runtime attempt 1 had a native PTY worker access violation; attempt 2
passed. Its intermittent root cause remains open. Physical iPhone and signed-in
macOS acceptance, manager self-update and signing retain their prior boundaries.

Use the [development contracts](development-contracts.md) before changing
code or tests. Current behavior belongs in the bilingual guides; dated
batch results, exact historical revisions and CI belong in the
[acceptance index](README.md#acceptance-and-reviews--验收与审查),
matching Git tags and Releases. Do not reuse old deployment observations
as the current installation state.

## Next Work

Refresh pending pull requests before starting the next batch. Treat contributions
as proposed changes: compare desktop and mobile behavior against the deployed
baseline and prior optimizations before integrating them. Use synthetic fixtures;
do not create real model turns or notifications just to verify layout.

Mobile composer controls intentionally use 36px sizing on small screens.
Preserve desktop sizing and corners; mobile adaptation must not become a global
style change. Main and side-chat controls must have matching mobile geometry.
Only a confirmed frontend update or successful backend update refreshes the page:
main-chat text drafts persist, while
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
   the origin. Restarting the origin does not update edge assets. After
   official release attachments are complete, refresh and deploy the
   separate [download snapshot](update-downloads.md#维护分发服务)
   and verify its version, attachment hashes and route boundaries.
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

Documentation-only closeouts do not increment the application version, rebuild,
restart services or publish another Release.

Ignored QA artifacts, deployment backups and review branches can contain unique
or private evidence. Inventory them before proposing cleanup, distinguish
reproducible builds from unique diagnostics, and retain old deployed chunks for
open clients. Complete the report before requesting explicit cleanup approval.
Never upload ignored runtime evidence or use screenshots containing real chats
in public documentation.
