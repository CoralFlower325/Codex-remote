# Physical Device Acceptance

This checklist records acceptance that cannot be claimed from automated
viewports alone. Run it against a named build and record the exact versions,
network types, device models and evidence paths. A synthetic browser pass does
not satisfy any item below.

## Test Target

| Field | Value |
| --- | --- |
| Date and operator | |
| Remote source commit/tag | |
| Deployed Remote version | |
| Manager version | |
| iPhone/iPad model and OS | |
| macOS version and Codex Desktop build | |
| Public origin | |

## iPhone / iPad

Use a physical device, not a desktop browser device emulator. Keep a second
terminal open on the host for logs and process checks.

- [ ] Join Wi-Fi, open the public origin, sign in with the current password,
  and confirm the connection changes to `已连接` without a manual reload.
- [ ] Disable Wi-Fi and verify the UI enters the reconnecting state without
  replaying a model action.
- [ ] Enable the TUN/proxy route, reopen the public origin, and confirm sign-in
  and the first task page work without opening a localhost URL.
- [ ] Repeat the same login on a 5G connection with Wi-Fi disabled. Record the
  time to first usable composer and any intermittent errors.
- [ ] Open the oldest accessible chat, scroll upward through at least five
  older pages, and verify the reading position does not jump when each page
  arrives.
- [ ] Open a chat with a running turn, send a follow-up steer, then send a queued
  message. Confirm the active turn, queue and visible order match Desktop.
- [ ] Send a PDF and an image. Confirm the composer remains usable during upload,
  the attachment is registered as a document/image, and a failed upload can be
  removed or retried without silently dropping the draft.
- [ ] Reopen the same chat after backgrounding the browser. Verify the newest
  reply is visible, drafts survive, and no duplicate user message appears.
- [ ] Add a conversation to the home screen, launch it from the icon, and
  repeat sign-in persistence and background/foreground recovery.
- [ ] Enable notifications explicitly. Complete a synthetic turn and record
  whether the OS notification appears, its title/body, and whether tapping it
  opens the same chat.
- [ ] Lock and unlock the device, switch networks, and repeat one read and one
  write. Record any 401, 409, timeout or uncertain-write warning.
- [ ] Open Settings and confirm version/build, model controls, permission
  explanations and update availability render without clipping.

## macOS Desktop

Use a signed-in installed Desktop app with the documented debug endpoint. Do
not start a second App Server or a standalone fallback.

- [ ] Confirm Codex Desktop is the only App Server owner and Remote reports
  Desktop transport ready.
- [ ] Open a Desktop chat in Remote, send a synthetic message, and confirm it
  appears once in both clients.
- [ ] Change model, reasoning strength and permission profile. Hold the setting
  request briefly, click Send, and verify the turn either waits for or carries
  the selected value instead of the previous value.
- [ ] Emit a native settings event that is newer than a delayed acknowledgement
  and confirm the newer value remains selected; repeat after reconnect.
- [ ] Open a child conversation and a side chat. Confirm their viewer actions
  do not interrupt or unsubscribe the native child/side thread.
- [ ] Close Remote only. Verify Desktop and its active turn continue. Restart
  Remote and confirm the old listener/process exited before the new service
  becomes ready.
- [ ] Stop the tunnel only when the operator explicitly requests it; verify an
  externally managed Cloudflare tunnel is never adopted or restarted by Remote.
- [ ] Inspect the local manager's public-entry diagnosis. If the entry is
  externally managed, use the one-click repair only after confirming ownership;
  record whether the repair remains usable after a host network change.

## Evidence

Store only sanitized evidence under `output/acceptance/physical-device/`:

- device model, OS and app version;
- network type and whether a proxy/TUN was active;
- timestamps for login, first useful screen, reconnect and update;
- screenshots with private conversation content removed;
- bounded service/tunnel logs with tokens, cookies and ids removed;
- a result row for every checkbox: `pass`, `fail`, `blocked` or `not run`.

Do not commit private screenshots, raw chat exports, cookies, tokens, session
ids or host paths. Do not mark an item passed from a Playwright viewport,
unit test or CI matrix alone.
