# Security

Codex Remote controls a trusted operator's local Codex runtime. A signed-in
operator may read local chat content and images, and execute actions allowed by
the native permission profile. Manual filesystem/preview operations and the
interactive terminal run with the host user's access, independently of that
model permission profile. This is not a multi-tenant isolation boundary.

The returning-device browser hint contains only a boolean and opens an empty
workspace. It does not authenticate requests: private reads and sockets still
require the signed HTTP-only session. The service worker and optional edge cache
store public static assets, not authenticated API responses or host file contents.

After server verification, the browser may read its private IndexedDB snapshot:
bounded task metadata and recent text, retained for at most 24 hours and 1 MiB.
It excludes credentials, permission settings, running state, image bodies,
reasoning, tool output and file diffs. Logout and detected session expiry clear
it. It is not an offline authentication mechanism. Operators on shared devices
should sign out or clear site data. Host memory snapshots remain behind the
existing authenticated HTTP endpoints; neither cache replays model actions.

## Device Notifications

Web Push is opt-in per device. Authenticated same-origin endpoints manage
subscriptions. VAPID private keys, push endpoints and watched chat identifiers
live in the private runtime file `data/web-push.json`; retain it during updates
and never publish it. Notifications cover ordinary chats opened or created
through Remote, excluding subagent and ephemeral chats.

Encrypted push payloads pass through Apple or the browser vendor's push service.
They contain the conversation title, status, chat identifier and up to 100
characters of the final reply or pending question. The title can fall back to
the native conversation preview. This content can appear on the device's lock
screen; it can include sensitive text or file names from that title, reply or
question. Tool and command output are excluded from the preview. Remote and its
native Desktop connection must
remain running. Closing the page does not cancel notifications. Successful
logout removes this device's subscription first; session expiry alone does not
revoke OS push. Disable device notifications or revoke the site's notification
permission when access should end. Push-service acceptance does not prove
delivery or display on a physical device.

## Deployment

- Use HTTPS and a strong access password.
- Keep the Desktop debug endpoint and the web origin's upstream listener private.
- Publish the password-protected web origin through a configured tunnel or
  trusted reverse proxy.
- Keep runtime secrets and logs outside source control.
- Review the selected native permission profile before granting full access.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/CoralFlower325/Codex-remote/security/advisories/new)
for suspected vulnerabilities. Do not post credentials, live hostnames, private
paths, or real chat content in public issues.

Include a minimal reproduction, affected versions, impact, and redacted
diagnostics. If a credential has already been exposed, revoke or rotate it at
its provider.

The project is maintained on a best-effort basis without a guaranteed response
time. There is currently no separate supported-version matrix.
