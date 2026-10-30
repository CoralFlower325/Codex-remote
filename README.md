# Codex Remote

[English](README.md) | [简体中文](README.zh-CN.md)

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-43853d)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0078d4)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/CoralFlower325/Codex-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/CoralFlower325/Codex-remote/actions/workflows/ci.yml)

A self-hosted web workspace for Codex Desktop. Continue chats, review changes, switch models, and respond to approvals from a phone or another computer.

The browser uses the local desktop's owning App Server through a private desktop bridge. It renders a responsive workspace rather than streaming a scaled desktop screen. Windows and macOS have installation and background service controls; both platforms are covered by CI. A signed-in Windows desktop has live acceptance; a signed-in macOS desktop still needs equivalent live acceptance.

Community project. Not affiliated with or endorsed by OpenAI.

![Codex Remote desktop workspace](docs/images/desktop.png)

## Screenshots

The screenshots show the actual frontend with synthetic projects, messages, paths, and model metadata. They contain no real account, conversation, or deployment data. The model shown is illustrative; available models depend on the connected runtime.

| Phone workspace | Change review |
| --- | --- |
| <img src="docs/images/mobile.png" alt="Phone chat workspace" width="280"> | <img src="docs/images/review.png" alt="Desktop change review panel" width="340"> |

Desktop capture: **2560 × 1440**. Phone capture: **390 × 844 CSS pixels**. These are capture sizes, not fixed rendering resolutions. The UI uses the browser's viewport and device pixel ratio, so a 390 × 844 CSS viewport on a 3× screen is rendered at 1170 × 2532 physical pixels.

The mobile layout activates below 720 CSS pixels wide, or below 980 pixels when the width/height ratio is less than 1.18. Touch screens narrower than 1024px and shorter than 540px also retain the phone layout in landscape. Dynamic viewport height and safe-area spacing are supported. The acceptance matrix in `scripts/acceptance-viewports.json` includes 2560×1440, 1920×1080, 1440×900, 1024×768, 402×874 at DPR 3 (1206×2622 physical pixels), its 874×402 landscape orientation (2622×1206), 390×844, and 320×568. Browser controls can reduce the available viewport; these are simulated dimensions, not physical-phone network acceptance.

Phones use compact header and composer spacing. Mobile layout follows the visible viewport when the keyboard opens and removes the duplicate bottom safe-area gap. Physical display safe areas remain protected. Desktop appearance is unchanged. Keyboard geometry has unit coverage; real iOS keyboard acceptance is separate.

Mobile attachment and conversation-index buttons remain 36px in main and side chats. Desktop control sizes are preserved. Both layouts show a plain Codex sidebar title and omit the help shortcut; the bottom Settings button remains the menu entry.

On phones, the conversation-index sheet uses the composer corner radius and a smaller close glyph within a 44px touch target. Opening focuses the sheet rather than highlighting its close button; keyboard navigation remains available. The phone composer index button keeps the input background and omits its touch/focus ring, using a darker glyph for keyboard focus. Desktop trigger backgrounds and focus outlines are preserved. The sidebar running indicator rotates an independent HTML layer instead of the SVG. Physical iOS Home Screen animation acceptance is still required.

On phones, swipe right from the leftmost 28 CSS pixels to open the conversation sidebar. Swipe left on the open sidebar or its backdrop to close it. A deliberate horizontal swipe travels at least 56 CSS pixels; vertical scrolling, input fields, text selection, and dialogs are excluded. Gesture logic and touch-event handling have automated coverage; physical iOS Safari/PWA gesture acceptance is separate, including browser-reserved history gestures.

Use **Settings → Refresh version → Check and update** to check uncached server metadata against the loaded page's version and build. An already current page stays open without refreshing. When an update exists, review its release summary and confirm **Update to ...**. Remote downloads the full public shell, verifies the new controller, then reloads and displays the completed update summary. Failures allow retry without removing login state, main-chat text drafts or push subscriptions. A successful update clears temporary side chats, unsent images and skill selections. Existing tabs keep their old public assets during manual activation; a later natural activation cleans obsolete app caches. Older installed shells can open **`/update.html` in the same browser or installed web app**. This independent recovery page and `/version.json` bypass the installed shell cache; a current recovery check offers a return link without navigating automatically. Updates require network access; physical iOS Safari/PWA acceptance remains separate.

The header's **Toggle summary panel pin** opens the conversation summary: attached pull requests, outputs, temporary side chats, native subagents and sources. A wide desktop can pin the 300px panel; narrower desktop and mobile use a dismissible overlay. PRs come from native thread attachments; completed answer links, generated images and supported structured MCP resource activities supply outputs. Missing local output files are filtered out. Sources include provided files/links, web searches and successful MCP connectors. Resource links use the existing preview/download inspector. Create-output actions and source-file selection append to the existing draft for review; they never send automatically. The MCP entry opens connected-server status, not a connector installer. Summary reads page independently of chat history, with **Load earlier summaries** after each bounded automatic batch. Provider-specific outputs without supported links or resource metadata may be absent.

Each validated functional batch also publishes a GitHub Release with its version, source commit and changes.

## Features

- **Shared desktop chats.** Open and continue chats through the same desktop backend, including activity originating in Desktop.
- **Projects and task navigation.** Browse all providers' tasks with paginated loading, search, archived browsing, rename, archive, and restore.
- **Readable long histories.** Load older pages on demand, preserve the reading position, and use Desktop-style activity summaries and completed-turn disclosures.
- **Conversation outline.** Desktop-style marks preview requests and replies and jump to earlier turns; phones use a touch list.
- **Side chats and queued messages.** Open temporary chats in inspector tabs. Queue follow-ups in the main chat, edit or remove them, steer the current turn, or move a prompt into a side chat.
- **Subagents.** Native delegation records show compact agent rows with live status. Click a row to read that agent's conversation in an inspector tab, including paginated history and folded tool activity.
- **Workspace and reply actions.** Create a host folder and add it as a project, archive chats from the sidebar, copy replies, and branch through a specific reply.
- **Native model metadata.** Model choices and supported reasoning levels come from the runtime, including custom model catalogs exposed by it.
- **Slash commands.** Search commands and native skills from the composer, with keyboard and touch selection, native plan mode, compaction, reviews, and chat forks.
- **Per-chat permissions.** Choose native read-only, workspace, or full-access profiles and respond to supported approval requests.
- **Images and review.** Upload or paste images, open originals, inspect changed files, and use unified or split diffs.
- **Workspace terminals.** Open an interactive shell in the current chat/project directory, with terminal tabs, Ctrl+C, preserved sessions, and reconnectable output.
- **Responsive light UI.** Drag the desktop sidebar and review dividers to resize all three columns; widths are remembered in the current browser, and double-clicking restores defaults. Phones use navigation drawers, with a compact composer and system typography.
- **Connection recovery.** Heartbeat deadlines, handshake timeouts, network/foreground recovery, and drafts stored per chat in the browser.
- **Device notifications.** Opt into encrypted Web Push for completed tasks, pending questions and approvals, test delivery, and turn off this device from Settings.
- **Faster repeat entry.** Previously verified devices can open the empty workspace while login is checked in the background; tasks and chats still require server authentication.
- **Self-hosted access.** Password login, signed HTTP-only sessions, local-only initial setup, and optional Cloudflare Tunnel.
- **Windows and macOS controls.** Double-click `.cmd` files on Windows or `.command` files on macOS to start and stop Remote.

## Execution Records

Consecutive commands, edits, tool calls, and searches share one compact summary,
even when their types alternate. Viewed images and progress messages retain their
places in the conversation. Raw reasoning does not produce separate timeline rows,
matching Desktop; stored history is preserved. Expand a summary to inspect
commands, output, paths, and available file diffs.

Active replies show elapsed work time. Completed turns fold their earlier activity
and progress under a duration disclosure, leaving the final reply visible.
Timing uses native turn timestamps and durations, including after reloading and
loading older history. Missing timing is never estimated from page-load time.
User requests and assistant responses have more space between them, while body
text and operation rows retain their compact line heights.

Inside expanded groups, issue controls filter failed and declined records, with separate status
labels. A tool failure does not mark the whole turn as failed. Running indicators
follow the active native turn, including when it ends with stale item statuses.
Long groups show the latest 60 records initially and load 120 earlier records at
a time. Log bodies mount only when opened; expanding preserves reading position.

Conversation and activity typography follows measurements from Windows Codex
Desktop: the system font stack, 14px text at weight 430, 22.75px paragraph line
height, and 21px activity-header line height. Font rendering still depends on the
operating system, browser, scaling, and available system fonts.

![Collapsed command and file-edit records](docs/images/activity.png)

## Conversation Navigation

The marks at the left of the conversation follow native turn summaries. Hover
or focus a mark to preview the request and final reply; click or press Enter to
jump. Up/Down and Home/End move keyboard focus, and Escape closes the preview.
The current reading position is highlighted. Narrow conversation panels and
touch devices use a 44px list button beside the model selector and a selectable sheet.

The outline follows all native summary cursors independently of the latest
40-record history page. A jump reads up to 100 target-turn records in one native request when a reversible cursor is available. Nearby context continues automatically as you scroll, without a show-more button; user text in the navigation window is expanded. Up to five windows are reused in memory for 30 seconds and invalidated by native changes. Older/newer paging remains bounded, with a return-to-latest button. New activity does not interrupt an older window. Native summaries can omit follow-up user messages within the
same turn; these additional marks appear when their history pages are loaded.
The outline therefore does not claim to index every raw steering message before
that history has been read.

![Conversation navigation and request preview](docs/images/navigation.png)

Goal and queued-message reads start over authenticated HTTP when a chat is selected, alongside history loading. They do not wait for realtime synchronization or thread resume; send/edit actions still require readiness. The Goal bar supports native pause/start, objective editing and deletion. Deletion requires a second click in the bar, and only explicit user actions submit goal mutations.

## Side Chats and Chat Actions

In the right inspector, choose **New tab (+) > Side chat**. Each tab has its own
draft, model, supported reasoning levels, permissions, and send/stop controls.
The native temporary chat is created on first send and inherits the main chat's
context at that moment. Later messages remain independent. Hiding the inspector
preserves its tabs; closing a side-chat tab interrupts its active turn and
releases the temporary chat.

Model and reasoning choices use the native catalog and apply to the next new
turn. Steering an already running turn retains that turn's existing model.
Changing the side-chat selection preserves its draft and attached skills without
changing the main chat's settings.

Side-chat tabs and drafts live in memory, not browser storage. A short socket
disconnect has a 30-second recovery grace; Remote keeps an in-memory event
snapshot to recover missed streaming output. Reloading/closing the page or
restarting Remote loses the temporary UI. These are Remote-managed tabs backed
by native ephemeral chats, not Desktop's existing side-chat UI. Native ephemeral
chats cannot use persisted-history commands or submission queues: follow-ups
while running use direct steering.
Some Desktop transports deliver ephemeral reply items only on turn completion.
Remote shows the submitted request and native elapsed progress, then renders the
completed reply; it uses incremental item events when the host supplies them.

In the main chat, sending while a turn runs adds a native queued submission.
The compact strip above the composer offers **Guide**, delete, and a menu with
edit, open in side chat, and disable queue. Disabling queue uses direct steering
for the rest of the active turn. Queued submissions are shared with Desktop;
the native queue consumes them when dispatched, without duplicating prompts.
Moving one to a side chat opens an editable draft and removes it from the queue.

Use the folder-plus button beside **Projects**, or the project picker, to browse
host directories, create a folder, and add it as a workspace. These are manual
host filesystem actions, independent of a model's chat permission profile.
Hover or focus a sidebar chat to archive it; the archived view offers restore.
Completed replies expose copy and a menu with **Branch to new chat**. That branch
includes the selected reply's turn and excludes later turns.

![Temporary side chat beside the main conversation](docs/images/side-chat.png)

### Subagent Conversations

Delegated agents appear beneath the parent turn with their native name, role,
and known status. Repeated spawn/wait/activity records merge into one entrance
per agent in that response, retained when the completed process folds.
Click an agent to open its conversation on the right. The **Subagents** inspector
tab also pages through the current chat's direct children, including archived
children that are absent from the currently loaded history.

Agent conversations share the native event transport, load recent history first,
and page older messages on demand. Running agents rejoin the native subscription;
finished and archived chats are read without restarting their work. Closing a
viewer only removes that tab and its Remote subscription: it does not interrupt,
archive, or unsubscribe the native agent. The viewer is for reading; delegated
instructions remain in the parent workflow. Temporary side chats keep their
separate close-and-interrupt behavior.

![Subagent conversation in the inspector](docs/images/subagents.png)

## File and Web Previews

Click a file or website link in a reply to open an inspector tab beside the chat.
Relative file links resolve against that chat's host directory, including on a
phone. Reopening a file reuses its tab. Code and JSON have syntax highlighting,
line numbers, wrapping, copy and download controls; native `:42` and `#L42` links
select the referenced line. Markdown and HTML offer preview/source switching.
Native `codex-file-citation` references in assistant replies appear as compact
blue filename links and open the same inspector. Literal examples in code and
user messages remain unchanged.
Images and PDFs open in the same panel. PDF rendering is loaded on demand and
provides page navigation, zoom and page-text copying. Office and other
binary files currently offer downloads rather than document rendering.

Local HTML runs in an isolated iframe, including relative CSS, images, scripts,
and modules within its directory. Its resource URL grants read access to that
directory for 15 minutes; do not share it, and use Refresh to renew it. This does
not start a development server or build a source project. External websites may
reject embedding; use the new-tab button when that happens.
Website URLs use the browser's network. Host-only `localhost` development
servers are not proxied to a remote phone by this feature.

Only the active preview loads content; hiding it releases its document renderer.
Local HTML is fetched before iframe rendering so request failures are visible,
and reopening renews its resource grant. Preview metadata and HTML reads time out
after 15 seconds; Refresh retries them. Failed preview modules show a reload
control without removing the conversation. PDF backing canvases are capped at
8 million pixels and 8192 pixels per dimension to bound high-DPR zoom memory.
File contents stay outside the public static cache.
Reading host files is a manual operator action, independent of the model's
permission profile. Older-history insertion preserves the current visible item
before paint and through subsequent layout changes.

User image attachments appear as small thumbnails above the text bubble
(96px on desktop, 84px on mobile); click one to open the original. Remote keeps
local attachments it receives or reads in the host's private
`data/image-attachments/` directory, so temporary-file cleanup does not remove
those copies. This directory is private runtime data, excluded from Git and
public caches. Copies remain until the operator removes them. Remote cannot
recover an older image whose original was deleted before it was retained; the
thumbnail shows an unavailable/retry control instead of a blank image.

![File preview beside the conversation](docs/images/file-preview.png)

## Workspace Terminal

Use the header's terminal button or Ctrl/Cmd+J. The panel starts PowerShell 7
when installed on Windows, otherwise Windows PowerShell. macOS uses the host
user's login shell. Enter commands directly; they do not go through the model.

Terminals belong to their starting working directory. Chats using the same
directory share its terminal tabs; switching directories restores the matching
tabs. A shell's own `cd` does not change that binding. Hide closes only the
panel, while a tab's trash button ends that terminal. Refreshing the page or
reconnecting preserves the process and restores its latest 1,000 scrollback
lines. Stopping/restarting Remote ends its terminal processes and clears them.

The terminal uses a separate authenticated WebSocket and loads its browser
renderer only when opened. Output bypasses conversation rendering; terminal
screen state is kept in bounded server memory. Phones have Ctrl+C, Tab, Esc,
history, and Enter controls.

These are **Remote-owned shells**, separate from Desktop's existing terminal
sessions and the model's execution records. They run as the host user and are
**not restricted by the chat's model permission profile**. Only give the Remote
login to the trusted machine operator. No terminal history is persisted by
Remote; the selected shell may keep its own normal command history.

## Slash Commands

Type `/` at the start of the composer to browse commands and enabled skills. Filter by typing, use Up/Down and Enter/Tab to select, or tap an entry. Escape closes the menu without losing the draft. Chinese IME confirmation does not submit a command.

| Command | Action |
| --- | --- |
| `/new` | Start a new chat; `/clear` is an alias |
| `/model` | Open the native model picker; `/model <model-id>` selects a catalog entry |
| `/reasoning` | Open the current model's reasoning levels; accepts a supported level as an argument |
| `/permissions` | Open per-chat permissions; `/approvals` is an alias |
| `/plan` | Toggle native plan mode; `/plan on` and `/plan off` select it explicitly |
| `/skills` | Browse enabled skills in the current working directory |
| `/<skill-name>` | Attach an enabled skill to the next message using native skill input |
| `/compact` | Request native context compaction for the current saved chat |
| `/review` | Choose uncommitted changes, a base branch, a commit, or custom review instructions |
| `/fork` | Fork the saved chat and open the new chat with bounded history |
| `/rename` | Open rename; `/rename <name>` renames directly |
| `/diff` | Open the changed-file inspector for the loaded history |
| `/status` | Show connection, model, reasoning, mode, permissions, directory, and context usage |
| `/mcp` | Read native MCP server status, following all returned pages |
| `/help` | Return to the command menu |

Selecting a skill adds a removable attachment; enter the request and send it normally. Skill input also works when adding instructions to an active turn. Disabled skills are excluded, and `/skills` still exposes skills whose names overlap built-in commands.

`/plan <request>` enables plan mode and leaves the request in the composer for review before sending. Plan settings use the selected provider model and reasoning level, and Desktop-origin mode updates are reflected in Remote. Compaction, review, and fork require a saved chat; they and mode changes are unavailable while a turn is active. Existing images remain attached when using settings commands.

Commands call the owning App Server or open the corresponding UI. A failed command keeps its draft and reports the native error. Unknown slash words are not silently sent to the model. Paths containing further slashes and multiline messages remain ordinary text. The available list is the adaptation above, not every CLI-only or Desktop-only command; unsupported runtime methods report an error. Native compaction/review/fork mutations have synthetic browser acceptance; this release's live native check covers skill/mode/MCP reads, not model-billed reviews or compaction on real chats.

## How It Works

```text
Phone / computer browser
        |
        | HTTPS + WebSocket / HTTP events
        v
Cloudflare Tunnel (optional)
        |
        v
Local Node.js server (127.0.0.1:4545)
        |
        | Private CDP bridge (127.0.0.1:9229)
        v
Codex Desktop -> its owning App Server
```

When Desktop is unavailable, Remote can fall back to a standalone App Server. Standalone mode does **not** share the desktop process's live events. Check the active transport at `/health`.

## Requirements

| Component | Requirement |
| --- | --- |
| Host | Windows 10/11, or macOS |
| Runtime | Node.js **22.19 or later**, with npm |
| Codex | Installed and authenticated Codex Desktop / compatible bundled CLI |
| Desktop sync | Desktop debug endpoint on loopback port `9229` |
| Public access | Optional `cloudflared`; a Cloudflare-managed hostname for the Windows helper |
| Windows tunnel helper | PowerShell 7 and an authenticated `cf` CLI |

This application uses internal desktop interfaces. Compatibility may change when Codex Desktop updates. Linux desktop integration is not validated.

## Quick Start

### 1. Clone

```bash
git clone https://github.com/CoralFlower325/Codex-remote.git
cd Codex-remote
```

### 2. Enable Desktop Synchronization

Save your work and fully quit Codex Desktop before launching it with the debug argument. This setup does not require Remote to restart Desktop during normal use.

For a Windows Store installation, in PowerShell:

```powershell
$package = Get-AppxPackage -Name "*Codex*" | Select-Object -First 1
& (Join-Path $package.InstallLocation "app\Codex.exe") --remote-debugging-port=9229 --remote-debugging-address=127.0.0.1
```

For another Windows installation, launch its actual `Codex.exe` with the same arguments. Package layouts can vary.

On macOS:

```bash
open -a Codex --args --remote-debugging-port=9229 --remote-debugging-address=127.0.0.1
```

Verify locally:

Windows:

```powershell
Invoke-RestMethod http://127.0.0.1:9229/json/list
```

macOS:

```bash
curl --fail http://127.0.0.1:9229/json/list
```

The result should include a page whose URL contains `app://-/index.html`. Keep this endpoint private; it can control the local app.

### 3. Install and Run

**Windows**

```powershell
npm run setup:windows
npm start
```

The setup script installs locked dependencies, builds the app, and prompts for an access password if one does not exist.

**macOS**

```bash
npm run setup:macos
npm start
```

Both setup commands use the lockfile, build the app, and ask for the first access password. Use `.env` for settings that must also apply to background services.

Open **http://127.0.0.1:4545** and sign in. Initial password setup is accepted only from the host computer.

### 4. Confirm the Transport

Windows:

```powershell
Invoke-RestMethod http://127.0.0.1:4545/health
```

macOS:

```bash
curl --fail http://127.0.0.1:4545/health
```

For live desktop synchronization, expect `codex: ready` and `transport: desktop`. A `standalone` transport means Remote is using a separate App Server.

## Windows Start / Stop

After building and setting the password:

| File | Behavior |
| --- | --- |
| `Start Remote.cmd` | Enables and starts scheduled tasks, checks local readiness, and opens the configured page |
| `Stop Remote.cmd` | Stops server and tunnel, and disables their login tasks |

Stopping Remote leaves Codex Desktop running. The tasks stay disabled across sign-in until Start is used again. Repeated Start does not create another running instance.

The first Start installs the current-user scheduled tasks when they are missing. If `data/cloudflared-token` exists, the tunnel task is included.

For terminal use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/remote-control-windows.ps1 -Action Start -NoBrowser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/remote-control-windows.ps1 -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/remote-control-windows.ps1 -Action Stop
```

Task installation and removal:

```powershell
npm run install-task:windows
npm run uninstall-task:windows
```

## macOS Start / Stop

After `npm run setup:macos`, use the executable files from a Git clone:

| File | Behavior |
| --- | --- |
| `Start Remote.command` | Installs a current-user LaunchAgent if absent, enables login startup, checks readiness, and opens the configured page |
| `Stop Remote.command` | Stops Remote and disables login startup; Codex Desktop remains open |

No administrator account is needed for the Remote service. The helpers find Node in the current `PATH` and standard Apple Silicon / Intel Homebrew paths. Codex detection includes `/Applications` and `~/Applications`; `CODEX_BINARY` can override detection.

```bash
npm run start:macos -- --no-browser
npm run status:macos
npm run stop:macos
npm run uninstall-service:macos
```

The service lives at `~/Library/LaunchAgents/com.codex.remote.plist`. Logs go to `DATA_DIR` (default `data/`). Another checkout's existing service is left untouched. Changes to `.env` take effect after stopping and starting Remote.

The macOS controls manage the Remote web server. An independently installed `cloudflared` service or reverse proxy is managed separately; stopping Remote closes its web endpoint. Windows controls also manage the project's configured tunnel task.

ZIP downloads may lose executable permissions. Restore them with `chmod +x *.command`, or use the npm commands above. If Node was installed with a shell version manager and Finder cannot find it, run Start from an initialized terminal once to install the service with the resolved Node path.

## Public Access

Local access does not require a domain. For a stable public URL, configure a hostname such as `codex.example.com`.

### Windows Cloudflare Helper

Install `cloudflared` and PowerShell 7, install the Cloudflare `cf` CLI, and authenticate:

```powershell
npm install --global cf
cf auth login
cf auth whoami
npm run tunnel:windows -- -PublicHost codex.example.com
```

The helper creates or reuses a remotely managed tunnel, sets its ingress, creates a matching DNS record when absent, saves the tunnel token locally, updates `.env`, and installs login tasks. An existing DNS record pointing elsewhere is not overwritten.

The tunnel targets `http://127.0.0.1:4545`. Its readiness endpoint is `http://127.0.0.1:20241/ready`; ordinary connection logs are written to `data/cloudflared.log`. These are local diagnostics.

### macOS

The included `scripts/cloudflared-tunnel.sh` is a legacy, interactive, locally managed setup. It writes `~/.cloudflared/config.yml` and installs a system service, requiring `sudo`. Review it before use if cloudflared is already configured. This path has not been revalidated on macOS in this release.

Another HTTPS reverse proxy is possible when it supports WebSocket upgrades and forwards to the local server. Set `PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` accordingly. Do not expose the desktop debug port.

## Configuration

Copy `.env.example` to `.env` for overrides:

Windows:

```powershell
Copy-Item .env.example .env
```

macOS:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local web listener |
| `PORT` | `4545` | Web server port |
| `PUBLIC_ORIGIN` | Empty | Final HTTPS origin |
| `ALLOWED_ORIGINS` | Empty | Additional comma-separated browser origins |
| `CODEX_BINARY` | Auto-detected | Explicit path to the bundled Codex CLI |
| `CODEX_HOME` | `~/.codex` | Codex state and configuration directory |
| `CODEX_WORKDIR` | Home directory | Default working directory |
| `CODEX_DESKTOP_DEBUG_PORT` | `9229` | Local Desktop debug endpoint |
| `TRUST_PROXY` | `1` | Trust forwarding headers behind the intended local proxy |
| `SESSION_DAYS` | `30` | Browser session lifetime |

Keep `HOST` on loopback when using a local tunnel or reverse proxy. The Windows tunnel helper assumes port `4545` unless you pass its `-LocalUrl` parameter.

Codex CLI detection checks Windows app packages, local standalone installations, and `PATH`. On macOS it checks supported app locations, the local standalone installation, and `PATH`. Set `CODEX_BINARY` if auto-detection does not find your installation.

## Models, Permissions, and State

- Models are read from native `model/list`; reasoning levels use each model's `supportedReasoningEfforts`. There is no fixed universal set of available levels.
- Custom providers are configured in Codex, not in a separate Remote provider editor. Their exposed catalog determines the available choices.
- Model and project metadata load in the authenticated bootstrap and refresh on reconnection. They are not continuously refreshed while the connection stays open. Currently, these two lists read their first requested page; task history, task lists, and permission profiles have separate pagination.
- New chats currently initialize reasoning from the model catalog default. This can differ from a global Codex configuration override; select the desired level explicitly.
- Permission profiles come from `permissionProfile/list` and update the current chat. Builtins include `:read-only`, `:workspace`, and `:danger-full-access`.
- Main-chat drafts live in browser `sessionStorage`. They survive switching chats and reconnecting, but do not synchronize with the Desktop composer or other devices. Temporary side-chat drafts remain in memory only.
- Uploads are sent to the local Codex workflow. The remote UI does not implement a separate hosted model service.

## Device Notifications

Open **Settings → Message notifications** to enable website notifications, send
a test, or disable this device. iPhone and iPad require iOS/iPadOS 16.4 or later:
open the HTTPS site in Safari, add it to the Home Screen, launch that icon, and
tap Enable to grant system permission. Other browsers must support Web Push.
Plain LAN HTTP does not support this; localhost is a browser development exception.

Push comes from the Remote server and can arrive while its page is closed.
Remote and its native Desktop connection must stay running. Notifications cover
ordinary chats opened or created through Remote, including completed, failed or
stopped turns, newly pending native questions and approval requests. Repeated item/turn
notifications do not resend the same question; history hydration does not push old questions. Child-agent and temporary chats are excluded.
Tapping a notification focuses the workspace and opens its chat.

Delivery does not depend on the page's WebSocket or HTTP event stream. For
background notifications, transient network failures, HTTP 429 and server
errors retry twice after one and four seconds with the same notification tag.
Expired endpoints are removed; unsubscribing stops further attempts.

VAPID keys, device subscriptions and notification chat scope are private runtime
data in `data/web-push.json`. Keep that file across updates and out of Git.
Browser push services, including Apple or the browser vendor, deliver encrypted
messages. Notifications include the conversation title, status, chat identifier
and up to 100 characters of the final reply or question preview. A title may fall back to the chat's
native preview; this content can appear on the device's lock screen. Tool and
command output are excluded. Title lookup falls back after 1.5 seconds.
Disable affects this device; successful
logout also removes its subscription. Expiring browser login alone does not
revoke an existing OS push subscription; use Disable or remove the site's
notification permission. Delivery depends on system settings, Focus modes and
the push service. A test accepted by the service is not proof that a real phone
displayed it.

## Loading and Mobile Networks

- Authentication status and authenticated bootstrap requests start together. Either verified response can open the workspace, so a stalled status request does not hold up a successful bootstrap. Both reads have six-second deadlines; total failure retries after 1, 2, 4, then at most 8 seconds. Network recovery or returning to the foreground can cancel an unfinished check and start again. A successful password login enters directly without an extra status round trip.
- Tasks, models and projects appear as HTTP bootstrap data arrives, independently of WebSocket readiness. If bootstrap stalls for 1.5 seconds after verified authentication enables task loading, tasks load through their own authenticated HTTP endpoint. Missing models and projects load through independent authenticated HTTP reads, without waiting for realtime synchronization or each other. Subsequent task pages follow native cursors over HTTP, yielding to typing and selection; all tasks remain accessible. Chat history can load while the real-time connection is still being established; sending messages and native actions require that connection.
- The task first page contains up to 50 rows; remaining pages follow native cursors at up to 200 rows each. Bootstrap and fallback share native reads, including requests that outlive the bootstrap deadline. Selecting a chat pauses further background task pages until its initial text read completes.
- Failed task reads retry automatically, independently of the live connection, after 0.5, 1, 2, 4, then at most 5 seconds. A first attempt has a four-second deadline; subsequent HTTP attempts allow 15 seconds. Returning after a real offline or hidden-page transition replaces an initial task read stalled for at least two seconds. Ordinary focus and redundant online events preserve pending reads. Shared native snapshot and model/project reads expire after eight seconds, so retries do not keep joining a stuck native read.
- Main-chat WebSocket attempts wait three seconds to connect and six seconds to synchronize. If still connecting after 500ms, authenticated HTTP server-sent events warm in parallel; the first open transport wins and the unused candidate closes. Failure also switches to HTTP events plus POSTs for the same native actions, subscriptions and replay. The working HTTP route is remembered for that tab session; it grants no access. HTTP connection/synchronization deadlines are 12 seconds. A single failed POST affects that request, preserving a healthy event stream; expired authentication or a stale peer still closes it. Reads and pings bypass action acknowledgement waits. Only safe sync/watch/ping controls retry; model and approval actions are sent once, even if their acknowledgement is lost.
- Foreground heartbeats run every five seconds and still allow 12 seconds for slow mobile replies. After two seconds without a main-channel pong, a new authenticated HTTP peer checks the route in parallel. Only a responding replacement retires the original; a late original pong cancels the candidate. Handover uses normal synchronization and event replay, preserving the workspace, draft and loaded history. Pending model actions are never resent. Probes pause in hidden pages, and foreground/pageshow starts a fresh probe instead of treating a suspended timer as a dead link. A successful heartbeat does not hide missing synchronization. Visible reconnect delays start at 250ms and cap at five seconds. A completely unavailable origin still cannot synchronize. Interactive PTY terminals retain their separate WebSocket connection.
- Ordinary focus/pageshow does not change a pending handshake's deadline; redundant online events do not destroy healthy connections. Hidden pages pause unfinished handshakes and resume with the current stage's full budget.
- Opening a chat starts with native metadata and the latest 40 items without waiting for resume or timing metadata. If this tool-heavy tail lacks a visible user message and final answer, it automatically reads up to two additional 100-item native pages, preserving the latest records and remaining cursor. Initial loading is bounded to 240 items; more distant history still loads on upward scrolling. Timings load separately; sending and queued actions wait for verified data, timings and native resume. Older history and missing timing pages use authenticated HTTP independently of realtime RPC. Failed initial timings do not disable upward paging; it can obtain its own initial timing cursor.
- Initial chat/timing and missing catalog reads retry transient failures up to three attempts, with 0.5/1-second waits. Every chat/timing attempt allows 15 seconds through the complete response body. Selection changes cancel reads and retry waits; expired authentication and permanent client errors do not retry. Replay reconnects fill incomplete reads while preserving already-loaded chat history.
- Rejoining an existing main-chat subscription also allows three attempts, stopping when the chat or connection changes. This does not retry prompts or model actions.
- Host memory retains task first pages and five recent chats for up to five minutes, with a two-second freshness window. Native events invalidate snapshots; stale display is followed by a shared fresh read. Authenticated endpoints still use `no-store`; snapshots never authorize actions.
- After server authentication, a fixed device can display its IndexedDB snapshot while refreshing. This stores up to 1000 task summaries and three recent chats of up to 40 items, for 24 hours and at most 1 MiB total. Only text and lightweight finished activity records persist: no image bodies, reasoning, tool output, file diffs, permissions, temporary side chats or subagent chats. Running state and paging cursors are not restored. Logout or detected session expiry clears it; clearing site data removes it too. This is private local storage, separate from the public service-worker cache.
- Scrolling toward older messages prepares one page and its timing metadata in memory before reaching the top. Older pages load automatically without a load-more button. The host coalesces up to four 100-record native pages per response when records contain no readable conversation, retaining all records and native cursors. This avoids a mobile network round trip for each execution-only page. Initial insertion waits until the reader is within 64px of the top, the finger is released, and scrolling has been quiet for 160ms. The same upward gesture continues at the preserved position until a user message or final/legacy answer is actually rendered outside a process fold. Downloading an earlier answer that remains folded into the existing response does not stop loading. Downward movement, navigation or expanding activity stops this continuation. A response arriving during a new gesture waits again; leaving the top retains the prepared page for a later upward scroll. Insertion preserves the visible message and expanded process details. Subagent viewers use the same mechanism. Speculative failures remain silent; after a failed foreground read, another upward gesture retries without an idle retry loop. Full history pages are not persisted; only the bounded device snapshot described above is saved locally.
- Switching chats, jumping to another history window or closing a chat aborts abandoned HTTP history downloads. Duplicate pending reads share one request. History and permission reads have 15-second HTTP deadlines; task deadlines and automatic recovery are described above. Expired authentication on task/chat opening returns to sign-in. Permission reads follow the selected directory. Cancellation does not interrupt model turns or undo native operations already dispatched.
- Mobile history preserves upward intent during Safari's top-edge rebound and accumulates small finger movements. An actual downward gesture still stops continuation; insertion waits until the finger is released and scrolling settles.
- Bootstrap and WebSocket initialization share pending model/project lookups. Completed metadata is reused for five seconds to cover transit between the two connections; project creation and bridge disconnection invalidate the relevant entries. Conversations and model actions do not use this metadata cache.
- Ordinary HTTP responses and supported WebSocket messages use compression. HTTP event streams flush uncompressed with `no-store, no-transform` to avoid buffered delivery. Fingerprinted assets have immutable caching; authenticated bootstrap and history responses use `no-store`.
- Native events update individual task rows; completion refreshes only the latest outline page. Full list/history calibration runs at most once every five minutes. Background pagination pauses in hidden tabs and yields on constrained connections. Streaming updates batch at 60ms, 100ms on constrained networks, and 250ms in hidden tabs. Markdown reuses completed blocks and unchanged responses retain their components. Conversation blocks use their actual layout heights; image thumbnails reserve a stable contain-fit area while originals remain available in the viewer.
- Short WebSocket outages replay subscribed events from a host-memory journal bounded to 90 seconds and 2 MiB. Healthy chat history stays mounted even while background task pagination is unfinished. Expired cursors or a host restart restore native snapshots. Replayed events are deduplicated, approvals use a fresh pending snapshot, and interrupted model requests are never automatically resubmitted.
- The production service worker caches only the public application shell and static assets. Repeat navigation returns the installed shell immediately; its document and modules stay on the same version while new versions install in the background. Close all open Remote windows and reopen to activate a waiting update. The Workspace module is preloaded on cold entry. API responses, chats, approvals, images, and terminal data are not stored in its cache. Offline shell availability does not make chats available offline. Install the site from a supporting HTTPS browser, or use Safari's Add to Home Screen.
- After a successful login, a boolean device hint allows repeat entry to display the empty workspace immediately while authentication runs in the background. The hint contains no credentials or chat data and never grants access. Tasks and the socket still wait for server verification; expiry and logout clear the hint. This shortens the full-screen wait, not the network authentication round trip.
- Local browser User Timing marks (`remote:shell`, `remote:auth`, `remote:bootstrap`, `remote:tasks`, `remote:chat`, `remote:connected`) record the latest completion of each phase without message content or automatic telemetry. Controlled before/after measurements and real-device limits are documented in [startup acceptance](docs/startup-acceptance.md).
- For a fixed trusted device, sign in once in the browser or installed app you will use, then pin that entry to the home screen or taskbar. The HTTP-only session lasts 30 days by default (`SESSION_DAYS`); expiry, signing out, clearing site data, or resetting the server session secret requires signing in again. Keep the same HTTPS origin and browser profile. A home-screen installation may have separate browser storage.
- The tunnel installers default to HTTP/2. Windows accepts `-TunnelProtocol auto|http2|quic` on `scripts/install-task-windows.ps1`; the macOS tunnel installer accepts `TUNNEL_PROTOCOL`. Compare protocols on the actual host before changing them; a slow route can still dominate dynamic requests.

### Updating a Home-Screen Installation

1. Open Remote while online so the new service worker can install in the background.
2. Close all Remote windows, including the home-screen app and same-origin browser tabs, then reopen.
3. Let the new version verify the session successfully once. Later openings in the same browser/app storage can use the returning-device hint.

The sidebar shows the loaded client's package version beside Settings, even
when the menu is closed. It is available without waiting for the connection.

The hint does not sign in a new device or make expired sessions valid. First
entry and browsers with unavailable storage still wait for server verification.
An early workspace can be empty while authenticated task data arrives. Clearing
site data removes both the installed cache and the hint and can require signing
in again. The shell, authenticated tasks, readable chat and live send connection
have different readiness times; physical iPhone 5G/Wi-Fi latency is not yet
accepted by the controlled browser tests.

### Optional Static Edge Hosting

Serve public frontend files from Cloudflare Workers Static Assets while keeping authenticated `/api/*`, `/ws`, and `/health` on the existing Tunnel. Install and authenticate the `cf` CLI, then set the hostname and zone for an existing deployment:

```powershell
$env:REMOTE_EDGE_HOST = "codex.example.com"
$env:REMOTE_EDGE_ZONE = "example.com"
npm run deploy:edge
```

On macOS, use `REMOTE_EDGE_HOST=codex.example.com REMOTE_EDGE_ZONE=example.com npm run deploy:edge`.
The build mounts only the exact application-shell paths and `/assets/*`; it does not publish host data or change DNS. Deploy the matching backend first when the transport protocol changes. Re-run the edge deployment after frontend changes; restarting the local service alone does not update edge assets.

### Optional LAN Fallback

Run `npm run setup:lan` in the installed checkout, then restart Remote. It enables a second listener on port 4546 that shares authentication, chats, and terminal sessions with the existing server. The settings menu lists available LAN/VPN addresses alongside the public entry. An optional port argument changes 4546; `LAN_ADDRESS` chooses the preferred local IPv4 address.

This fallback uses HTTP on a trusted private LAN/VPN, not public Internet access. HTTPS-only features such as PWA installation and dictation still require the public HTTPS entry. Windows firewall setup needs administrator rights; run the setup command in an administrator terminal if it reports that the rule could not be added. Other devices and the router must allow peer connections. Set `LAN_PORT=0` and restart to disable it.

Measure the current route with `node scripts/benchmark-network.mjs https://codex.example.com 10`. It reports median/P95 and failures for the shell and dynamic health request using reused connections. These host measurements do not replace tests on an actual phone, mobile network, or signed-in macOS desktop.

If the Tunnel log shows edge addresses in a proxy's `198.18.*` fake-IP range
instead of real Cloudflare addresses, add `+.argotunnel.com` to the existing
`dns.fake-ip-filter` list in blacklist mode. In Clash Verge, edit the persistent
DNS settings rather than only the generated runtime YAML, so a profile refresh
does not remove the exclusion. Retain all other filters, reload the core and
clear its fake-IP cache. Verify `region1.v2.argotunnel.com` and
`region2.v2.argotunnel.com` through the proxy's actual DNS listener before
restarting the Tunnel if its connections are still unavailable. A running
process with zero ready connections is still offline. HTTP/2 alone cannot fix
incorrect DNS answers.
Disabling a DNS override can also be sufficient when the resulting system/proxy
resolver returns real addresses. Check the effective resolver: a subscription
may itself enable fake-IP even with the override disabled.

If direct TCP `7844` works on the host, a TUN proxy can exclude the Tunnel's
IPv4 edge networks, `198.41.192.0/24` and `198.41.200.0/24`, through its persistent
`tun.route-exclude-address` list. Combine this with real DNS answers for
`+.argotunnel.com`; preserve other filters and exclusions. This keeps Tunnel
sockets on the physical uplink when TUN is toggled, without bypassing unrelated
proxy traffic. Verify the effective Windows route, readiness and connection
count before adopting it; some networks require the proxy instead. Do not pin
one edge IP or a changing Wi-Fi address. In Clash Verge, keep the exclusions in
its global profile script and persistent DNS settings, then verify after a
profile reload.

Windows `Status` checks the actual backend health, Desktop transport and
Tunnel readiness/edge connection count, in addition to scheduled-task state.
`Running` alone does not establish reachability. Request cancellation errors
can accompany navigation; edge dial timeouts and zero ready connections indicate
a different failure. Task crash recovery does not repair an unavailable uplink.

From version 0.1.1, the Windows Tunnel task runs a lightweight Node supervisor.
Re-run `npm run install-task:windows` after building to update an existing task.
An exited cloudflared process restarts after one second, with repeated crashes
backing off to five seconds. The supervisor polls local edge readiness every
two seconds and wakes on Windows network address/availability events; polling
also covers proxy changes that emit no event. It preserves every surviving
edge connection. When all edges remain unavailable for four seconds, after an
eight-second startup grace, it confirms outbound TCP 7844 reachability and
rechecks readiness before rebuilding the Tunnel. Restarts have a 15-second
cooldown, rechecked when the network changes. Stop disables the task and stops
its owned children; it remains off until Start. Recovery does not change proxy
settings or restart Desktop/the web backend. Logs stay in private
`data/tunnel-supervisor.log`. The outbound check targets Cloudflare's two edge
region hostnames; a network allowing only UDP may rely on cloudflared's own
recovery instead. This supervisor is installed by the Windows controls; macOS
continues to manage its independently installed tunnel separately.

## Security and Privacy

This is a control surface for **one trusted operator's own machine**, not a multi-user hosting platform. A logged-in operator can access chats, images, model actions allowed by the selected native permission profile, and a host-user interactive terminal. The manual terminal is outside the model permission sandbox.

- Set a strong access password and use HTTPS for remote access.
- Passwords use salted `scrypt` hashes. Sessions use signed, HTTP-only cookies, with `Secure` enabled over HTTPS and `SameSite=Strict`.
- Wrong-password attempts are rate-limited. Reset the password locally with `npm run set-password`.
- Keep `.env`, `data/`, tunnel credentials, session secrets, logs, and browser authentication exports private.
- Keep the Codex debug endpoint and the App Server transport on the host. Publish only the protected web origin.
- Full access can execute host actions; review the permission profile before running a task.

The source release excludes local runtime data and old development history. Documentation screenshots use synthetic data. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Development

```bash
npm ci
npm run dev
```

Vite serves the frontend, and the development server forwards API/WebSocket traffic to the local backend. Do not run another Remote backend against the same desktop relay while a production instance is active.

```bash
npm run typecheck
npm test
npm run build
```

The suite has **366 tests across 59 test files**, including readable-history detection, Safari overscroll direction and fine touch motion, isolated HTTP POST failure recovery, parallel transport selection, initial conversation-context filling, native read coalescing and timeout recovery, bounded host/device snapshots, foreground request priority, parallel session startup, returning-device hints, static-shell caching, native timing, activity folding, gesture-aware history insertion, bounded HTTP reads, preview canvas sizing, local attachment retention, conversation navigation, side-chat event isolation and recovery, child-task filtering, assistant citation display, device push registration/routing/retries, HTTP realtime fallback, queue dispatch, real PTY input, interruption, directory isolation, screen restoration, exit, and connection lifecycle tests. CI runs type checking, tests, and a production build on Windows, macOS, and Ubuntu. The macOS job also checks shell syntax and validates the generated LaunchAgent with the native plist tools. These checks do not replace testing against a signed-in desktop; an Ubuntu build does not establish Linux desktop support.

```text
src/client/       React workspace, composer, history, approvals, reconnect
src/server/       Express, authentication, desktop bridge, native history
src/shared/       Protocol and permission helpers
scripts/          Setup, services, tunnel, and platform controls
public/           Application assets
docs/images/      Sanitized documentation screenshots
```

## Verification Records

- [Startup and returning-device acceptance](docs/startup-acceptance.md): separate shell, authentication, task, chat and socket timings; controlled measurements and network limits.
- [History loading and side-chat acceptance](docs/history-loading-acceptance.md): automatic paging, touch gesture gates, reading anchors and side-chat settings.
- [Session, preview and attachment acceptance](docs/session-preview-acceptance.md): preview isolation, module failures, PDF limits and retained images.
- [Subagent acceptance](docs/subagent-acceptance.md): child discovery, history, streaming and safe viewer close.

Each record identifies its original verification scope; older test counts are
historical, not the current suite size. Current startup behavior is defined by
the startup record and the implementation.

### Native questions and bounded history payloads

Main conversations and temporary side chats display native asynchronous questions
as selectable options or multiline custom answers. First-option defaults remain
unsent until explicit submission. Replies use Desktop's persisted answer envelope,
steering active turns with `expectedTurnId` or starting idle turns without the
ordinary queue. Loaded replies from another client dismiss the matching questions.
Unanswered groups remain visible across turn completion and Goal continuation;
whole-turn notifications deliver their embedded messages immediately. Historical
navigation keeps its bounded reading window unchanged. Answer fields omit the black
focus ring; mobile answer text is 16px to avoid focus zoom without disabling user
page magnification.

The mobile and desktop task sidebar shows **待回答** for observed pending questions,
including live arrivals in unselected chats and blocking native user-input requests.
Count-only summaries travel over the existing authenticated live connection and
resynchronize on reconnect. Existing bounded history reads populate these summaries;
no extra full-history scan or public/private-content cache is added. The memory
index retains at most 1,000 chats and 1,000 pending/answered IDs per chat. After a
server restart, old unobserved questions outside loaded history have no badge until
native events or a bounded history read reveal them. Physical iOS and real native
answer submission still require separate acceptance.

History pages preserve complete conversation prose, questions, file diffs, identities
and native cursors. Folded command/tool bodies are retrieved from the original native
item when expanded, with explicit loading/retry feedback in the timeline and command
inspector. Loaded details and errors are scoped to their owning conversation;
fresh live output supersedes stale read errors. History/timing and dock reads allow 15 seconds through the response body
so a healthy slow public download is not abandoned at six seconds. This reduces
unnecessary transfer/retries; it does not eliminate tunnel latency. The new detail
route requires a Desktop version supporting `thread/items/read`.

Regression evidence, open-source assessment and verification scope are recorded in
[history and question investigation](docs/history-questions-investigation.md).

## Known Limits

- Interface labels are currently Simplified Chinese; both English and Chinese documentation are provided.
- This is an independent adaptation, not a pixel-exact copy of every Codex Desktop screen.
- Internal Desktop protocol changes can break synchronization; standalone fallback cannot reproduce Desktop live events.
- Remote terminals do not attach to Desktop-owned shells. The inspector derives review and file information from loaded chat history, not an unrestricted project explorer.
- Live command approval is verified. File-change, user-input, and persistent command/network-policy approvals have helpers and tests but still need dedicated live acceptance.
- Browser dictation requires browser support and microphone permission; actual spoken input has not been accepted in the release verification.
- Heartbeats recover stale connections, but cannot guarantee network uptime. Uncertain model actions are not replayed automatically; selected read-only requests have bounded retries.
- Physical iPhone Safari / Add to Home Screen behavior and real 5G/Wi-Fi tail latency still need device testing. Chromium and Windows WebKit emulation do not establish iOS performance.
- Windows is the live-tested deployment. macOS has build, unit-test, shell, and LaunchAgent CI coverage, but live desktop sync, login persistence, and the legacy tunnel still require acceptance on a signed-in Mac.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Desktop chats do not update live | `/health` must report `transport: desktop`; confirm the debug target and authenticated Desktop app |
| History appears incomplete | Load older history pages; confirm that the app is using the owning Desktop backend |
| A model or reasoning level is absent | Check the catalog returned by Codex; reconnect after changing the provider |
| Windows Start cannot find build output | Run `npm ci` and `npm run build` first |
| Public URL fails but localhost works | Check tunnel readiness, its login task, DNS, and `data/cloudflared.log` |
| Connection stalls after sleep | Return to the foreground or restore the network; the client probes and reconnects |
| Repeat entry still shows the full login check | Activate the waiting PWA update and complete one successful verification in the same browser/app; expired sessions or unavailable storage still require verification |
| Workspace opens quickly but tasks or chats are slow | Shell readiness is separate from authenticated data; inspect the local `remote:auth`, `remote:tasks` and `remote:chat` timings and compare the actual network route |
| Password forgotten | Run `npm run set-password` on the host |
| Codex logs an ignored global setting | Check your local Codex config; Remote does not manage deprecated global settings |

When reporting a problem, include the operating system, Node version, relevant Codex version, transport, and a redacted error. Never include tokens, `.env`, auth files, raw chat exports, or unredacted screenshots.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, and privacy expectations.

Maintainers can resume development with the [handoff and release checklist](docs/maintainer-handoff.md), including open review work and outstanding device acceptance.

## Credits and License

Released under the [MIT License](LICENSE).

- Original project: [Bones-star588/codex-remote](https://github.com/Bones-star588/codex-remote), copyright 2026 lezi-fun.
- Workspace and review UI reference: [Bones-star588/codex-webui](https://github.com/Bones-star588/codex-webui), copyright 2026 lezi-fun.
- Windows port and this distribution: [CoralFlower325](https://github.com/CoralFlower325).
- Built with React, TypeScript, Vite, Express, WebSocket, and Lucide icons.

Full upstream notices are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Codex and related branding belong to OpenAI; the software license does not grant trademark rights.
