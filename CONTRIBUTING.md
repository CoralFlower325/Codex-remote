# Contributing

Thank you for helping improve Codex Remote.

## Local Development

Use Node.js 22.19 or newer.

```bash
npm ci
npm run dev
```

Configure a local Codex installation and, for live synchronization, its private
desktop debug endpoint. Stop another Remote backend before attaching this one
to the same Desktop process.

Before submitting:

```bash
npm run typecheck
npm test
npm run build
```

Add focused tests for changed behavior. For UI changes, check both desktop and
phone layouts, including a narrow 320px viewport. Use generic demo data in any
screenshots.

## Issues

Explain the expected and actual behavior and provide reproduction steps. Include
the OS, Node version, relevant Codex version, and whether `/health` reports
`desktop` or `standalone`. Redact paths, project names, chat content, domains,
and account information before uploading logs or images.

Never upload `.env`, `data/`, password hashes, tunnel credentials, API keys,
session cookies, or raw chat exports. Use private reporting for vulnerabilities;
see [SECURITY.md](SECURITY.md).

## Pull Requests

Keep changes focused. Explain the problem, the resulting behavior, and the
verification performed. Update both [README](README.md) languages and the
[English](docs/guide.md) / [Chinese](docs/guide.zh-CN.md) guides when setup or
behavior changes. Keep overview text concise and preserve detailed operating
limits in the guides. Check relative links, heading anchors and image paths after
moving documentation. Preserve upstream notices and identify any additional
third-party code.

Contributions are submitted under this repository's [MIT License](LICENSE).
