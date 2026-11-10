# History Loading and Side-Chat Acceptance

Updated: 2026-10-28. Earlier verification below retains its dated scope.

## Behavior

- Keep one speculative older page in memory and share the request with
  foreground consumption. Prepare native timing metadata before insertion.
  Older items and timing cursors use bounded authenticated HTTP, independently
  of the realtime channel. A failed initial timing read does not disable paging.
  The host coalesces at most four 100-record execution-only native pages per
  HTTP response, retaining every record and native cursor.
- Prefetch within two viewport heights. Automatic insertion requires upward
  intent, a position within 64px of the top, no finger down, and 160ms without
  scroll activity. Recheck these conditions after the network and timing reads.
  Leaving the top keeps the prepared page for a later upward scroll.
  A tool/reasoning/commentary-only page retains the upward intent at the
  restored anchor, even when compensation moves scrollTop beyond 64px.
   Continue one bounded page at a time until a user message or final/legacy
   answer is actually rendered outside a process fold. An older final answer
   folded into the current response does not stop continuation.
   Downward movement, navigation and activity expansion stop it.
  Short initial pages do not automatically consume the full history.
- Cancel abandoned downloads on selection, jumps and close. Speculative
  failures remain silent. A passive sentinel replaces the manual load button;
  another upward gesture retries a failed foreground page without idle loops.
- Retain visible message nodes, activity identities and disclosure state across
  partial-turn boundaries. Current turn timings override older page metadata.
- Preserve the current visible reading anchor before paint, during pending
  requests and after delayed layout changes. Reserve image-thumbnail geometry.
  Short pages retain the space needed for scroll compensation until navigation
  or returning to latest.
- Model, permission and slash portals render above mobile and expanded
  inspectors. Native dialogs consume their own shortcuts without closing the
  inspector. Initial queued skills and model selections survive side-chat
  mounting and asynchronous thread creation.

## Verification

### 2026-11-10 Later-Page Gate and Truncated-Turn Anchor

- Reproduced the reported failure before the fix with a synthetic 920-record
  chat whose folded activity leaves the 800-item window about 1,848px tall
  (roughly 2.1 viewports at 402x874): the later-page trigger (within two
  viewport heights of the window end) stayed true at the very top, so later
  pages repeatedly dragged the window back to the latest items. Thirty
  upward gestures produced 47 history reads in a repeating cycle, the
  earliest turn never mounted, and the 22-minute turn's divider cycled
  through its intermediate slices (3 and 7 minutes) between the native
  22 minutes and the final-answer anchor.
- Later pages now require the reader to be within half a viewport of the
  retained window's end with no upward intent; wheel and keyboard gestures
  settle direction before later paging is reconsidered, and the later
  sentinel's root margin matches the same half-viewport distance.
- A turn truncated by the window's newer boundary no longer anchors its
  work duration on an intermediate slice; the divider falls back to the
  native turn timing until the final answer is inside the window.
- After the fix, the same synthetic session reaches its earliest turn in
  nine older-page reads, returns to the latest items through forward
  paging, and shows only the native/final durations for the long turn.
  Unit coverage pins the later-page gate, the truncated-tail anchor and
  the rendered fallback. These are host browser checks with a synthetic
  backend, not physical iPhone Safari acceptance.

### 2026-10-28 Mobile Gesture Follow-up

- Reproduced two stopped-loading paths before the fix: top rubber-band return
  cleared upward intent, and a sequence of one-pixel finger movements never
  passed the per-event threshold. The older page was fetched but not inserted.
- Clamp scroll offsets before inferring direction. Accumulate small touch
  movements, and retain their explicit direction through the drag and momentum
  quiet period. This also handles a delayed one-pixel WebKit scroll correction
  after touchend. Deliberate downward gestures still stop continuation.
- All 293 unit tests / 47 files and both TypeScript targets pass; production
  build passes. Chromium and Windows WebKit pass all eight gesture scenarios:
  simulated rubber-band return, fine touch motion, delayed rounding and
  deliberate downward cancellation. No model actions were submitted.
- The 24 continuation cases at 2560x1440, 402x874 and 320x568 still pass with
  at most 0.5 CSS pixels of reading-anchor drift.
- Browser-level Chromium touch input at 402x874 and 320x568, DPR 3 and 4x CPU
  throttling retains the no-insertion-while-held gate. Each history insertion
  shifts the reading anchor by at most 0.5 CSS pixels.
- Deployed local/public native history checks pass in both engines at
  402x874/DPR3. One gesture mounts earlier readable messages, retains original
  message nodes and shifts the anchor by at most 0.5 CSS pixels, with zero
  page errors or model actions. A page already containing readable context
  correctly stops without requesting another page; acceptance checks actual
  mounted conversation rather than requiring an unnecessary extra HTTP read.
- These are controlled host-browser regressions. They reproduce reachable
  mobile gesture paths, but do not establish physical iPhone/5G acceptance.

### 2026-10-28 HTTP Paging and Folded Answers

- 290 tests across 47 files pass, including bounded host coalescing, partial
  failure/cursor retention and native timing cursor forwarding.
- A synthetic partial response with an earlier final answer in the same turn
  reproduced the old premature stop: only pages 0 and 1 were requested and
  no older user message was mounted. Chromium and Windows WebKit now continue
  through page 3 from one gesture and mount the older conversation.
- Both engines read missing older timing pages through HTTP with zero
  `thread/turns/list` realtime requests. A failed initial timing path can be
  recovered by paging without reconnecting or resubmitting model actions.
- The 24 existing continuation scenarios still pass across 2560x1440,
  402x874 and 320x568, with at most 0.5 CSS pixels of anchor drift.
  These are host browser checks, not physical iPhone Safari acceptance.
- Deployed Chromium at 402x874/DPR3 opens real local/public Windows history:
  one upward gesture mounts earlier readable messages, retains original nodes
  and advances native cursors, with 0.5px maximum drift and no model actions.
  Windows WebKit repeats these local/public checks with 0.3px maximum drift.
- A reused-connection public sample loaded the same 200 native records and
  remaining cursor in one coalesced request (656ms), versus two ordinary
  requests (1132ms). This measures host-origin access, not a physical phone.

### 2026-10-28 Continuation

- The current suite has 285 tests across 47 files; both TypeScript builds and
  the production bundle pass. Readable-history cases include final/legacy
  replies, image-only questions, blank messages and hidden/commentary records.
- A synthetic chat places three 100-record execution-only pages before the
  older user message and final answer. One upward gesture consumes those pages
  without requiring another gesture after each restored anchor.
- Chromium and Windows WebKit cover 2560x1440, 402x874 and 320x568, including
  hidden reasoning, downward cancellation and a failed read followed by a new
  upward gesture. Idle failures do not retry; all original anchors survive.
  All 24 scenarios pass with at most 0.5 CSS pixels of measured anchor drift.
  The next speculative page stays unconsumed after readable context appears.
- Browser-level Chromium touch injection at 402x874 and 320x568, DPR 3 and
  four-times CPU throttling blocks insertion while the finger is held.
  Natural touch/momentum movement is measured separately from insertion drift.
  Each insertion moves the anchor by at most 0.5 CSS pixels.
- Anchor restoration rounds its target to avoid WebKit truncating
  almost-integer scroll positions and applying a second correction.
  These are host browser checks, not physical iPhone Safari acceptance.
- Deployed local and public checks at 402x874 DPR 3 advance actual Windows
  native history cursors after one gesture. Original message nodes survive
  with 0.25px local and 0px public drift in these samples; no model actions or
  page errors occur. Matching static files and authenticated SSE hello/pong
  pass separately. These observations do not establish mobile-network latency.

### Earlier Checkpoint

- At the recorded acceptance checkpoint, 171 tests across 36 files passed;
  TypeScript and production build passed. See the README for the current suite.
- Synthetic history acceptance covers 2560x1440, 1024x768, 402x874 at DPR 3,
  390x844, 320x568 and touch landscape 874x402.
- Warm and cold paging, scrolling during a pending read, delayed images,
  expanded command output, abandoned requests and silent speculative failures
  were exercised. Measured anchor drift was at most 0.25 CSS pixels.
- One older page is fetched once and not inserted prematurely. Expanded command
  and activity disclosures retain their DOM and open state.
- A new Chromium touch probe with 4x CPU throttling reproduced the reported
  mid-scroll failure before this fix: with the finger still down, approximately
  430px from the top, an insertion changed scrollTop from 430 to 21931.75.
  The old 65%-of-viewport insertion threshold caused this before reaching the top.
  Final-anchor measurements alone had missed the intermediate disruption.
- Touch drags at 402x874 DPR 3, 390x844, 320x568 and 874x402 show zero
  mid-gesture insertions or scripted scroll corrections. A stationary held
  finger blocks insertion at the top. Slow network completion during a new
  touch also waits; after release, retained anchors drift at most 0.25px.
- Three consecutive pages remain uncommitted during controlled post-release
  scroll-event bursts. This exercises the quiet-period gate; it is not a
  physical-device momentum measurement. CDP synthesized fling did not produce
  usable inertia in this environment.
- Supplemental Windows WebKit responsive checks use a synthetic touch lifecycle,
  with measured CSS widths approximately 402, 320 and 874 after compensating
  the local display scaling in the test harness. Anchors remain connected,
  drift stays below 1px, and no horizontal overflow or page errors occur.
  These are not iOS touch/compositor tests.
- Child-view regression covers streaming, completion, archived paging,
  hide/reopen, reconnect, composed subscriptions and safe viewer close.
- Side-chat acceptance covers five desktop/mobile sizes, including expanded
  desktop inspectors. Two synthetic models expose different native reasoning
  options. Captured RPCs confirm the selected model, effort and collaboration
  settings, including selection during pending thread creation.
- Drafts and main-chat independence, mobile keyboard focus, permission menus,
  dialog Escape, and moving queued skills into a side chat pass browser checks.
  Model actions in these tests use only the synthetic server.
- Final deployed local/public browser checks read actual Windows native history
  at 402x874 DPR 3. Both retained the visible anchor with 0.25px drift.
  Cursor progression to the next native page proves foreground consumption,
  rather than treating a speculative HTTP request alone as successful insertion.
  The side-chat model menu displayed the host's four native models; the chosen
  model exposed three supported effort levels. Both health checks returned 200
  with Desktop transport. No real model instructions were sent.

## Limits

Browser touch and DPR emulation do not establish physical iPhone Safari
behavior, browser chrome or mobile-network performance. Signed-in macOS
integration remains separate. This work does not claim to eliminate all
rendering stalls on every device or connection.
