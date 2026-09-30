# Vendored Markdown parser

`markdown-it.js` is the unchanged `dist/browser/markdown-it.esm.min.mjs` from
the official [markdown-it 15.0.2 npm tarball](https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.2.tgz),
renamed to `.js` for Branch's existing static-file content-type allowlist.
It is the browser ESM build, with dependencies bundled and no runtime package install.
The source map is not shipped.

SHA-256: `85feb50fd6ce1b7c49acb02b0337eb622ecc4fc2ed4ae0dcbb8c084556d463b6`

Upstream source/build reference:
[`3c51991c32aaa2b002a52c009334ebe5752c84b3`](https://github.com/markdown-it/markdown-it/tree/3c51991c32aaa2b002a52c009334ebe5752c84b3),
version 15.0.2. The `LICENSE` file contains markdown-it's MIT notice. The sibling
license files preserve notices for bundled entities 8.0.0 (BSD-2-Clause),
linkify-it 6.1.0, mdurl 2.1.0, punycode.js 2.3.1 and uc.micro 3.0.0 (MIT).

This dependency replaces the handwritten parser because Markdown lists, inline
code and balanced link destinations need a complete parser. Branch disables
raw HTML and images, accepts only http/https/mailto destinations, and keeps its
existing chart and Mermaid fence rendering in `chat/markdown.js`.
