# Native Conversation Summary

The header summary control follows Desktop's compact panel model: 300px when
the desktop main region is at least 1096px wide, a modal on narrower screens,
and a persisted desktop pin preference. It yields space to the existing inspector.

## Data And Actions

- Pull requests use native `thread/attachment/list`, including its independent
  cursor and removal notifications. They are never inferred from tool prose.
- Outputs use completed final answer links, completed image generation records
  and successful MCP `openai/resourceActivities` version 1 metadata. Supported
  Google structured creation results also provide artifact links. Local paths
  resolve against the owning native thread directory; missing files are omitted.
- Sources use user files/Markdown links, native web searches and successful MCP
  connectors/resource reads. Arbitrary tool text and reasoning are excluded.
- Side chats are Remote's current temporary tabs. Native child entrances reuse
  existing discovery, status, subscriptions and read-only viewer behavior.
- File/site links reuse the authenticated preview inspector. Office binaries
  download through that existing flow.
- Output creation seeds document/presentation/spreadsheet/site text in the draft.
  Source selection reads the native host directory and appends a file reference.
  Neither action sends a model request. MCP opens the existing status dialog.

Summary HTTP reads are authenticated, no-store and bounded to 100 native records.
The browser automatically reads at most ten history pages per batch, yielding
between pages, then offers earlier summaries. Native events read the head until
known item identities; they do not restart all history. PR pagination remains
independent. Closing/navigating aborts reads and preserves main-history state.
Manual refresh rebuilds the summary, including removed attachment entries.

## Limits

This is a native-data integration, not a complete copy of every private Desktop
provider adapter. Unsupported external resource payloads, native page/message-file
systems and artifacts without supported final links may be absent. The MCP menu
does not install connectors. Temporary side tabs are not persisted between reloads.
The summary is session memory only and is not written to public static caches.

Synthetic responsive and live read-only acceptance must be recorded separately
from physical iPhone, signed-in macOS and newly created native-agent acceptance.

## 0.1.8 Verification

Unit coverage checks native item/attachment projection, independent cursors,
cwd-relative paths, missing output files, unsafe URLs and raw-body exclusion.
The update suite covers current-build no-op, same-version rebuilds, an old shell
under a new controller, changed deployment after confirmation, failures and aborts.

Chromium and Windows WebKit synthetic runs each cover 1920x1080, 1440x900,
1024x768 touch desktop, 402x874 DPR3, 874x402 DPR3 and 320x568 DPR3. Verified
pin/overlay placement, keyboard menus, nested file picker dismissal, preview
opening, append-only drafts, focus restoration and no-op version checks retaining
the original draft DOM. Mobile controls remain 36px; desktop attachments 28px.
Windows WebKit viewport scaling was calibrated to actual CSS dimensions.

A Chromium lifecycle fixture verifies notes before confirmation, successful
activation/completion receipt, failed-cache retry with the old controller intact,
text draft retention and another old tab remaining open. A native attachment
event issues one head request, removes its deleted PR, and does not rescan older
pages. Side-chat selection opens the existing tab with zero model submissions.
These are synthetic results, not physical-device or provider acceptance.

The unrelated existing HTTP dock fixture intermittently received an OS-assigned
port blocked by Node fetch. Its test client now uses Node HTTP directly so random
reserved ports do not cause false failures. Production transport is unchanged.
