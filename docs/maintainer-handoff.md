# Maintainer Handoff

Last reconciled: 2026-11-02.

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

Remote 0.2.18 pairs with unchanged manager 0.2.3; its installers remain in
v0.2.17. PR #7 adds Desktop-managed side-chat viewers and mobile viewport fixes.
Follow loaded-thread cursors, require explicit native side-chat identity, preserve
native parent metadata, and keep these threads out of Remote's release ownership.
Flush pending live events before snapshot baselines and reconciliation; a late
read must not duplicate deltas, revive completed turns or reopen closed viewers.
Native settings events must win over older reads. Keep five-second foreground
heartbeats and twelve-second pong deadlines. Unknown actions are never replayed.
See [Muse audit and PR acceptance](pr-7-review.md) for the corrected findings,
synthetic checks and outstanding terminal/physical-device boundaries.

The preceding Remote 0.2.17 pairs with stable manager 0.2.3. External macOS Cloudflare jobs
now have explicit repair controls: discover existing official/Homebrew
LaunchAgents/Daemons, select ambiguous jobs, confirm, revalidate identity,
enable/start/restart, then check running/PID and public health independently.
System jobs use native administrator authorization. Ordinary Remote lifecycle
still leaves external tunnels alone; no plist, credentials or tunnel is created.
CI `41399876731`, runtime packages `41400151332` and manager packaging
`41400151329` pass for tag `v0.2.17` / source
`02d1a8c3e37251938f4f46ef311614aaff2468bd`.
See [manager acceptance](desktop-manager-acceptance.md). Real Mac recovery and
interactive authorization remain separate acceptance. This batch changes
Remote version/release metadata only; chat/backend behavior is unchanged.

The preceding Remote 0.2.16 pairs with stable manager 0.2.2. Repeated child-agent status
records retain state without splitting consecutive activity at invisible rows.
Final-answer completion evidence is shared across steering slices, while active
turns remain visible. Full-document Markdown previews preserve cross-block
formatting and reset source mode when changing targets.
Web-update state writes retry transient failures and can recover on later writes;
persistent failures still block service mutations. Files already equal to the
target are not custom build inputs, but their hashes still protect later edits.
Explicit proxy connection failures on GET/HEAD allow one direct attempt inside
the original deadline; stalled proxies and custom-source networks remain limits.
The manager keeps the release summary on its version page and asks only for the
version and a short interruption/data-preservation confirmation.
See [batch acceptance](update-preview-activity-acceptance.md).

The preceding 0.2.15 batch starts existing-chat resume alongside fresh reads,
merges the post-attach tail before the first commit when needed and preserves
mounted content on repeated selection. Native idle final answers fold before
late timings; stale completed turns cannot clear newer running turns. Chat
formulas load lazily. See [chat-open acceptance](chat-open-math-acceptance.md).

The preceding 0.2.14 batch improved chat freshness and motion.
New main-chat selections wait for fresh native text/timings instead of flashing
old memory/device/host previews; caches are failure fallback. Fresh host reads
bypass clean two-second reuse while sharing pending reads. Reconcile after
native resume, retain trailing completion refreshes and independently check the
foreground tail after a 15-second cooldown. Preserve history-navigation windows.
Reading-anchor capture and navigation measurement coalesce per frame and search
ordered positions. All 777 tests, typecheck, build and eight synthetic viewports
passed. Long-response anchor capture fell from roughly 9 ms to 0.5 ms under
four-times CPU throttling; ordinary scroll frame times did not improve consistently.
See [acceptance and device limits](chat-loading-acceptance.md).

The preceding 0.2.12 batch added PDF uploads and workspace fixes.
PDF uploads use authenticated private host storage and the Desktop text
file-context envelope. Preserve per-draft ownership, retry identity and the
retain-before-send boundary, including uncertain sends. Unsent uploads are
cleaned after 24 hours on the next upload, not by a timer; retained originals
do not expire automatically. Queue edits must preserve non-PDF file/application
context. Actual model PDF reading remains separate acceptance.
Task URLs retain selection through authenticated refresh/back/forward; cached
history stays visibly provisional until native verification. Preserve bounded
preloading and fresh subagent reads with independent native timing.
Inspectors keep opened built-in tabs; hidden descendants must not capture input.
Terminal input waits for its native snapshot. See
[batch acceptance and limits](review-fixes-acceptance.md).

The exact 0.2.12 source is `2818ae1dd53ec61068db8ad72e510baf3510bbf8`.
Three-platform CI and both packaged-runtime installation/recovery jobs passed;
the unchanged-manager packaging job was skipped. Both official runtime pairs
were downloaded in full and matched their release digests and manifest commit.
The download distribution was refreshed to 0.2.12; four complete downloads and
six route/range boundary checks passed. Origin and canonical public shell,
modules and styles agree, health is ready/desktop, and anonymous private reads
and PDF uploads return 401. These are Windows deployment observations, not
signed-in Mac, physical iPhone or model PDF-reading acceptance.
The 24 historical releases now share Chinese structure, with 108 original
assets and their states preserved. See [release organization](release-organization.md)
for the historical/current manager version distinction and draft URL behavior.

The preceding 0.2.11 activity groups consume each
previous key once when native history splits or merges them, preventing duplicate
React keys, orphan rows and dead disclosure buttons. Empty assistant placeholders
do not split activity or replace final-answer anchors. Device snapshots retain
lazy-detail markers while stripping output/diffs; reads reproject legacy snapshots
without rewriting storage or issuing network requests. Eight synthetic browser
viewports pass split/merge/reorder and nested command/detail expansion.
See [activity acceptance](activity-groups-acceptance.md).

Release metadata and assets prefer
the project-owned download distribution with official fallback and unchanged
checksum checks. Install manager 0.2.2 over an older manager and retry the same host
directory; a host update cannot change the installed app's bundled updater.
Known macOS metadata no longer forces a source build, and local `.env.example`
copies stay outside the installation plan. Actual custom inputs, missing baselines
or unsupported runtime architectures still need Git/npm networks.
See [downloads and maintenance](update-downloads.md).

Typecheck, builds and source Electron smoke acceptance passed for the update
batch; use each exact release's CI for platform results. The 2026-11-01 public
probe confirmed GitHub unauthenticated API HTTP 403 / RateLimitRemaining=0 at
Cloudflare egress. The verified 0.2.11 distribution deployment returned HTTP 200 /
`v0.2.11` from a checked release snapshot. Its internal timestamp expires cached
metadata after 60 seconds even when platform cache headers differ. Public GET/HEAD
headers retain `max-age=60`, without exposing the internal timestamp.
Explicit-proxy-free 0.2.11 probes fully checked both runtime manifests and archives
against official hashes; Mac/Windows archives took about 7/11 seconds on that
HTTP/2 route. Earlier 0.2.10 Mac runtime whole-file probes timed out at 600 seconds,
then range reconstruction passed. The 0.2.10 manager DMG passed a full hash check;
ZIP/EXE distribution checks covered HEAD/Range only. These probes do not establish TUN-off
acceptance on the user's Mac or Electron's full update path.
The token-free public metadata snapshot lives at ignored
`distribution/.cloudflare/release-snapshot.json`. After official assets/digests
are complete, run `node scripts/refresh-distribution-release.mjs`, set the download
host/zone, run `node scripts/prepare-distribution.mjs`, then `cf deploy --prebuilt`
from `distribution`. Preparation reads that snapshot by default;
`REMOTE_DOWNLOAD_METADATA` can select an explicitly verified public metadata file.
See [the maintenance sequence](update-downloads.md#维护分发服务). Refresh and redeploy
after each complete formal release, then verify the returned version and assets.
Final CI, packaged applications, signed-in Mac integration and unsigned-package
acceptance remain separate.

Remote 0.2.9 fixes missing/mismatched web-update tasks, durable job lookup,
bounded stalled downloads and worker takeover races. Query the saved job ID
after an uncertain install response; never replay installation automatically.
Claim the job under the existing update lock, then release it before preparing,
installing or recovering. See [web backend updates](web-backend-update.md).

Remote 0.2.8 adds optional host-side Office previews and hardens malformed
messages, login concurrency, proxy trust, HTML real-path grants and damaged
optional state. Preserve original downloads, private temporary conversion and
stable manager 0.2.0 health compatibility. LibreOffice is a separate optional
dependency, not an OS sandbox or an online document service. See
[document acceptance](document-preview-acceptance.md) and run its synthetic
checks after building. Active composers retain Stop even with draft content.

Remote 0.2.7 fixes skill-only input and same-turn work timing. Keep the native
text mention together with skill input for sending, steering, queues, side chats
and edits. Never rewrite persisted history to repair display. Work timing belongs
to the first response in a native turn; its final-answer anchor and process
expansion span all steering slices. Errors remain outside the fold at the last
response. Run `node scripts/check-skill-timing.mjs` after building; see
[acceptance and limits](skill-timing-acceptance.md).

Authenticated web backend updates are available in Settings. The independent
worker snapshots updater code and dependencies under output before replacing
the live installation; Windows WMI / a separate macOS launchd job isolates it
from service shutdown. Only the selected backend restarts. Keep the existing
transaction/rollback protocol, do not replay uncertain install POSTs, and expose
only projected progress over HTTP. Success refreshes the matching public client
through `/remote-client/`, bypassing independently deployed static edge assets.
This updates Remote separately from stable manager 0.2.2.
See [web updates](web-backend-update.md).

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
Stable manager 0.2.1 supersedes the 0.2.0 companion supplied with Remote v0.2.2
through manual installation. Self-update remains paused under the name 0.2.0AU on
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

The [manager guide](desktop-manager.md) defines current installation discovery,
owned service controls, windowless Windows tasks, external macOS tunnel limits,
verified runtime packages, persistent installation recovery and Chinese progress.
Keep cache isolation, stopped-state preservation, private data and later edits
protected. Standard updates do not need Git/npm/build; customized installations
retain the isolated source path. Manager packaging and
[platform smoke acceptance](desktop-manager-acceptance.md) remain separate.

The [documentation index](README.md) links historical PR reviews and investigations.
Use the current [guides](guide.md) for supported questions, approvals, summary
panels and mobile controls; do not treat old release descriptions as new defaults.

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
