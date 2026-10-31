# Third-Party Notices

## Original Codex Remote

This distribution is based on [Bones-star588/codex-remote](https://github.com/Bones-star588/codex-remote).
The upstream project is distributed under the MIT license reproduced below.
Windows support, native desktop transport, responsive workspace integration,
history handling, approvals, and connection recovery have been developed further
in this distribution.

## codex-webui

The light workspace layout and review presentation were adapted from
[Bones-star588/codex-webui](https://github.com/Bones-star588/codex-webui), inspected
at commit `e7e5e7fc1cd3f041d8cdc134f8b9afe199d85376`.
`src/client/review-model.ts` adapts its unified diff grouping and split alignment.

Both upstream projects carry the following notice:

```text
MIT License

Copyright (c) 2026 lezi-fun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Branding and Dependencies

The monochrome mark in `public/codex-mark.svg` is reproduced from the reference
project's `public/codex-brand.js` to identify the connected runtime. Codex branding
belongs to OpenAI. The MIT license covers software and does not grant trademark
rights or imply endorsement.

Interface icons use `lucide-react`. Dependency packages retain their own
licenses; their exact versions and package sources are recorded in
`package-lock.json`. No upstream motion assets or proprietary Codex application
binaries are bundled.

Interactive terminals use the MIT-licensed `node-pty` and xterm.js packages
(`@xterm/xterm`, `@xterm/headless`, `@xterm/addon-fit`, and
`@xterm/addon-serialize`). Their package distributions retain the authors'
copyright and license notices, including platform-native terminal components.

Documentation screenshots show this project's UI with synthetic data, not real
user conversations or an official OpenAI product screenshot.

File previews use Highlight.js (BSD-3-Clause, copyright Ivan Sagalaev) and
Mozilla PDF.js through `pdfjs-dist` (Apache-2.0). Unmodified package license
texts are distributed in `public/licenses/`; PDF.js's worker remains a separate
asset. Both renderers load on demand.

Prebuilt runtime archives and the desktop updater use the BlueOak-1.0.0-licensed `tar`
package. Runtime bundles retain dependency packages' copyright and license files.

Web backend updates use the MIT-licensed Node.js `undici` HTTP client to respect
explicit host proxy environment settings. Its runtime package retains its license.
