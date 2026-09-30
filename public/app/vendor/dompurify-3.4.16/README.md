# DOMPurify browser module

DOMPurify 3.4.16, Cure53 and contributors, distributed here under Apache-2.0.
The original copyright/license banner and upstream Apache `LICENSE` are retained.

`purify.js` is the unchanged prebuilt ES module `dist/purify.es.mjs` from:
https://github.com/cure53/DOMPurify/blob/368ee78d528087ab192bcf06838013ec61c87ec8/dist/purify.es.mjs

Only the filename differs, for Branch's existing JavaScript static-file allow-list.
Size: 84,443 bytes. SHA-256:
`c44274a7959cfdd4da871fa78a5d5fbbef55db68d118c5c0833bc4b5cf9633ad`.
The optional source map is not shipped; no runtime dependency requires it.

This dependency implements the requested second boundary after markdown-it.
Raw HTML and images remain disabled in the parser. Branch uses a private sanitizer
instance and explicit tags/attributes; it does not enable arbitrary SVG, iframes,
styles, event handlers or data attributes in Markdown. Existing escaped chart
markup and sealed Mermaid frames are restored from private per-render markers.

The allow-list approach was informed by OpenClaw (OpenClaw Foundation, MIT):
https://github.com/openclaw/openclaw/blob/1794d8b4ef8dde46f39a16da2bdbcf0bf2b519ef/ui/src/components/markdown.ts
No OpenClaw implementation is copied. Branch's sanitizer configuration and hooks
are original code.
