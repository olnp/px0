# Mermaid Diagrams in the Markdown Preview

px0 renders ` ```mermaid ` fences as diagrams. This document covers the lazy loader, the vendored library, theming, and what happens when a diagram cannot be drawn.

Everything else about a Markdown tab — the server render, the sanitizer, source/preview switching, line anchors, and math — is in [markdown.md](markdown.md).

## Request Flow

```text
GET /api/markdown              goldmark keeps the fence as escaped source
        |
        v
mdSanitize()                   the fence survives as <pre class="md-code" data-lang="mermaid">
        |
        v
renderMermaidBlocks()          swaps each fence for a .md-mermaid wrapper
        |
        |  import('/static/lib/mermaid/<version>/mermaid.esm.min.mjs')   once, lazily
        v
mermaid.render()               one diagram at a time, in order
        |
        v
.md-mermaid-svg                the SVG mounted inline, bounded to the preview column
```

## Lazy Loading and Vendoring

Mermaid is not part of `web/app.js`. The bundle carries only the loader; the library is imported with a computed URL (`MERMAID_URL` in `web/src/mermaid.js`) the bundler cannot follow:

```js
const MERMAID_URL = '/static/lib/mermaid/' + MERMAID_VERSION + '/mermaid.esm.min.mjs';
mermaidPromise = import(MERMAID_URL);
```

The import happens only when a preview actually contains `pre[data-lang="mermaid"]`, so a document without diagrams downloads no Mermaid bytes. The vendored tree is immutable (`scripts/vendor-mermaid.sh` pins a sha256-verified npm tarball), which lets the server answer `/static/lib/` with `Cache-Control: public, max-age=31536000, immutable` while every other response stays `no-store`. One browser fetches the multi-megabyte library once, across sessions.

Diagrams draw as soon as the preview is shown, in order, through one queue (`render()` is not reentrant). A preview is capped at 50 diagrams and 50,000 source characters per diagram (the latter matches Mermaid's own `maxTextSize` parse limit, so px0's note always fires before a Mermaid parse failure would); beyond that the fence stays as source with a note. Rendering runs under Mermaid's `strict` security level.

## Zoom and Fullscreen

Mermaid renders with `useMaxWidth` (its default), so a wide diagram scales down to the column and its text becomes unreadable. The wrapper therefore stays in the DOM after a render: the SVG sits inside a `.md-mermaid-svg` stage sized `width: 100%`, and a hover toolbar (`.md-mermaid-tools`, zoom in / out / reset / fullscreen) is attached only when the diagram's natural width — read from the SVG `viewBox`, since a laid-out SVG never overflows — exceeds the wrapper. Small diagrams stay clean.

Once zoomed, the stage becomes a `60vh` scrollable box: the wheel zooms toward the cursor (1.25× per step, capped at 8×), drag pans, two fingers pinch; at 1× the column fit and document scrolling are restored. The fullscreen lightbox (`.md-mermaid-box`) zooms and pans the same way at any level, with `+`/`-`/`0` and the arrow keys; Esc, the × button or a click on the scrim closes it, Tab stays inside the dialog, and focus returns to the button that opened it. A theme-switch re-render replaces the stage in place. A diagram small at render time gains a toolbar if a later column shrink makes it overflow (`ResizeObserver`); a toolbar is never removed.

## Theming

The theme follows the active px0 theme's intent: `isDark()` reads `color-scheme`, falling back to `--bg` luminance, and picks Mermaid's `dark` or `default` base. `themeVariables` carries `--ui` and `--fs`. A `MutationObserver` on `html[data-theme]` re-initializes and re-renders every live diagram, so switching themes recolours diagrams with them.

## Failure Fallback

A parse or render failure puts the original fenced source back — `mdEnhance` never sees a diagram as a code block, because the swap happens before it — and adds a `.md-mermaid-note` naming the fence's own `data-line` and the first line of Mermaid's parse error. A diagram never blanks or vanishes. The SVG itself is parsed inertly (`DOMParser` as `text/html`), stripped of scripts, event handlers and `javascript:` URLs, then adopted; this is defence in depth on top of `securityLevel: strict`.
