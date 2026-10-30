# PR #6 integration review

## Decision

Adopt the native question visibility, pending sidebar badge, temporary-chat form
and opt-in question notifications as version 0.1.9, after maintainer corrections.
The PR was reviewed against 0.1.8, including summary panels, release-aware updates,
bounded history, native timing and separate phone/desktop layouts.

## Corrections

- The proposed whole-turn reducer appended every missing message at the end of
  loaded history. A delayed payload could put its question or final reply after
  a later turn. Reconcile within the owning turn, preserving native item order,
  existing timing anchors and untouched later turns. Historical navigation still
  updates known identities only.
- The proposed question icon displaced a simultaneous approval indicator.
  Preserve the approval icon alongside the visible pending-question badge.
- An empty embedded question could be mistaken for the final reply, folding
  the preceding answer away and replacing its work-duration anchor. Keep that
  answer and its native timing anchor visible while the dock shows the question.
- Keep a subtle accent border for keyboard-focused answer fields after removing
  the dark outline. The mobile 16px answer font is scoped to mobile; desktop
  composer dimensions and goal/queue corners retain their deployed values.
- Align the patch version and public release notes with current main. Distinguish
  contributor-reported checks from this integration's verification.

## Scope

Native question/reply IDs, explicit unsent defaults, custom multiline input,
failed drafts, direct steering with expectedTurnId and idle starts are retained.
Question summaries contain counts only and reconnect through the existing
authenticated channel. Existing history reads hydrate the bounded memory index;
they do not send old-question notifications or scan all chat histories.
Notifications retain ordinary-chat watch scope, opt-in subscriptions, title and
100-character preview limits, deduplication and existing retry policy.

After restart or index eviction, old questions outside observed native history
are unknown until a native event or bounded read reveals them. This is not a
complete server-wide pending-question search. Physical iOS keyboard/OS push and
actual native answer delivery require separate acceptance; synthetic checks send
no real model input, answers, Goal mutations or device pushes.

## Maintainer verification

447 tests across 66 files, TypeScript checks and the production build pass.
Chromium and Windows WebKit each pass nine synthetic combinations: 2560x1440,
1920x1080, 1440x900, desktop and touch 1024x768, phone 402x874, landscape
874x402, 390x844 and 320x568. WebKit CSS viewports are calibrated.

Checks cover whole-turn question arrival, later Goal-turn steering, explicit
unsent defaults, multiline failed drafts and retry, unselected badges, exact
answer clearing, final reply visibility, temporary-chat replies and no queue use.
No page exceptions or horizontal overflow are observed. Main and side controls
remain 36px on mobile; desktop main stays 28px and coarse-pointer desktop side
controls stay 44px. Answer text remains 13px on desktop and is 16px on mobile.
Short docks scroll to their submit control. Screenshots use synthetic content.
Mocked push tests cover repeat item/turn events, history hydration, exact newly
pending IDs, Unicode preview limits, blocking questions and notification scope.
