# Maintainer Handoff

Last reconciled: 2026-11-08.

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

The last published release is Remote **0.2.23** / manager **0.2.4**, tag
`v0.2.23`, functional commit `348e457899172a91d1c6936b045082096794e74f`
merged through PR #14. The
[adversarial-review reconciliation](adversarial-review-0.2.22-fixes.md) records
all 31 findings, corrections, implementation and acceptance boundaries.
Local validation passed 127 test files (1016 tests, two platform skips),
typecheck, both builds, eight synthetic viewports, Windows manager source smoke,
update-worker install/rollback and an isolated signed runtime with a real compiled
PTY worker. The final directory-fsync change was followed by the full suite and
server compilation; the preceding test runtime is not a formal release asset.
The operator authorized pushing, publication, distribution and the local upgrade
on 2026-11-08. Main CI `42482630537`, runtime CI `42482760659` and manager CI
`42482760660` passed, including packaged PTY and manager startup checks.
All seven official and distribution attachments passed complete size/digest checks.
The signed Windows/macOS archives passed pinned-key verification, exact source-tree
comparison and individual checks of 3073/3066 files. The download snapshot and
matching static edge were deployed separately.
The authorized Windows installation runs Remote 0.2.23 and manager 0.2.4;
local/public versions and nine asset digests agree, Desktop transport is ready,
authenticated task/history reads succeed and anonymous private reads return 401.
Only Remote restarted; Desktop, Tunnel and the domestic relay were preserved.
The manager retained its selected root/settings and passed current-version and
tray checks. Its separate installation receipt and all rollback backups are retained
in the private deployment record. Never start another App Server.

Runtime updates now require Ed25519 publisher signatures against bundled public
keys, including signed commit identity for source fallback. The private key stays
outside the repository; the `RELEASE_SIGNING_KEY` GitHub secret and formal
two-platform signing workflow have been validated. Follow [release-signing.md](release-signing.md) before a
formal runtime release. Manager 0.2.4 requires its own installer; changing Remote
does not patch an already installed manager. AU self-update and macOS application
signing/notarization remain paused.

Native PTYs are now isolated in owned processes with bounded IPC and session
counts. A worker crash is visible and does not terminate Remote or replay input.
The historical native access violation still has no established upstream root
cause. Platform output uses bounded rotating logs; macOS controls use the
same-PID background wrapper and retain ownership checks. Local synthetic checks
do not establish signed-in macOS service behavior.

The following paragraphs retain historical 0.2.22 and earlier observations:
Remote 0.2.22 pairs with unchanged manager 0.2.3; manager installers remain
in v0.2.17. Tag v0.2.22 identifies functional source
`139affce9c29517a36188db22e4fd228c86c2636`, merged through PR #12.
The [live-preview acceptance](live-preview-acceptance.md) records this batch;
the [PR #10 review](pr-10-review.md) retains the preceding functional checks.
The [download procedure](update-downloads.md#维护分发服务) records the current
release and distribution verification. Release publication, download distribution
and host installation are separate states.

The authorized Windows upgrade on 2026-11-07 installed formal Remote
0.2.22 and its matching public frontend. Local/public checks identify
`assets/index-CMnycR24.js` and ready Desktop transport. Private data and old chunks
remain preserved; the manager stays 0.2.3. Consult the installation's own current
acceptance record for deployment evidence.

Live file previews are published and installed. Main CI `42335330164` and runtime
CI `42335449436` passed; four official attachments, both archive file manifests,
and four complete distribution downloads were verified. The first Windows runtime
attempt hit two existing five-second test timeouts; the unchanged source passed
on rerun. This does not resolve the historical native-worker crash.
Installed compiled preview routes passed synthetic write and atomic-save checks.
Physical-device and sustained real Office conversion acceptance remain separate.
The current 0.2.23 evidence is recorded above. Source validation alone does not
establish publication or installation; retain the operator's approval boundary
for subsequent batches.

Remote **0.2.24** is the current functional candidate; the manager remains
**0.2.4** without changes. It adds Windows discovery of the loopback
`--remote-debugging-port` supplied to the current trusted Codex/ChatGPT process.
The implementation rejects non-loopback addresses, renderer children, untrusted
install paths and CDP socket URLs that leave the selected loopback port. Existing
explicit candidates and 9229 remain fallbacks. An on-host compiled check selected
the current Codex++ port `4952`, found `app://-/index.html` and connected without
starting another App Server. Local validation passed 128 test files (1022 tests,
two platform skips), typecheck and both builds. Publish the signed runtime, update
the distribution Worker, install Remote locally and replace this candidate note
with the exact Release/deployment receipt before claiming completion.

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
main-chat text drafts and bounded, ready attachment/skill context persist in
tab-scoped storage. Context expires after 24 hours, at 2 MiB per draft and 4 MiB
total; omitted or unfinished content gets a recovery warning. Logout/expired
authentication clears private context. Temporary side chats remain memory-only.

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
