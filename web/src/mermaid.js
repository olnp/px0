// web/src/mermaid.js
// Mermaid rendering for Markdown previews. A ```mermaid fence reaches the page
// as a plain code block (the sanitizer keeps <pre data-lang="mermaid">); this
// module swaps each one for the diagram's SVG inline. The vendored ESM build
// in web/lib/mermaid/ (see scripts/vendor-mermaid.sh) is imported on the first
// diagram, so a preview without fences never fetches or parses it.
import { trapTab } from './ui.js';
import { anchoredScroll } from './zoom-math.js';

/* Keep in lockstep with scripts/vendor-mermaid.sh. The version directory keeps
   the immutable /static/lib/ caching safe across Mermaid upgrades. */
const MERMAID_VERSION = '11.17.2';
const MERMAID_URL = '/static/lib/mermaid/' + MERMAID_VERSION + '/mermaid.esm.min.mjs';

/* Hard caps: over-cap blocks stay readable as source with a short note. */
const MAX_BLOCKS = 50;
const MAX_CHARS = 50000;
let mermaidPromise = null;           // in-flight/finished import: mermaid loads once
let mermaidModule = null;            // resolved module, for theme re-initialize
let renderQueue = Promise.resolve(); // diagrams render one at a time
let svgSeq = 0;                      // unique id per mermaid.render() call
let themeWatcher = null;             // shared html[data-theme] observer
const rendered = new Set();          // wrapper nodes that currently hold an SVG
const snapshots = new WeakMap();     // wrapper -> its original <pre>, for restore

/* A literal dynamic specifier breaks the bundler (scripts/build-web.js has no
   import-graph resolution); keeping the URL in a variable leaves the import
   to the browser. */
async function loadMermaid() {
  if (!mermaidPromise) {
    const u = MERMAID_URL;
    mermaidPromise = import(u).then(mod => {
      const mermaid = mod.default || mod;
      mermaid.initialize(mermaidConfig());
      mermaidModule = mermaid;
      return mermaid;
    }).catch(err => {
      mermaidPromise = null; // a later preview may retry a transient failure
      throw err;
    });
  }
  return mermaidPromise;
}

/* The vendored theme derives its palette from darkMode, so the flag has to
   reach themeVariables. color-scheme names the active theme's intent;
   luminance of --bg is the fallback. */
function isDark() {
  const scheme = getComputedStyle(document.documentElement).getPropertyValue('color-scheme');
  if (scheme.indexOf('dark') >= 0) return true;
  if (scheme.indexOf('light') >= 0) return false;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(bg);
  if (!m) return true; // px0's default theme is dark
  const n = parseInt(m[1], 16);
  return (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 128;
}

function mermaidConfig() {
  const g = getComputedStyle(document.documentElement);
  const dark = isDark();
  const text = name => g.getPropertyValue(name).trim();
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    darkMode: dark,
    themeVariables: {
      darkMode: dark,
      fontFamily: text('--ui') || 'sans-serif',
      fontSize: text('--fs') || '14px',
    },
  };
}

/* One diagram at a time: render() is not reentrant, and chaining keeps the
   parse/render pairs off each other's shared state. */
function enqueue(target) {
  renderQueue = renderQueue.then(() => renderTarget(target)).catch(() => {});
}

function note(pre, text, isErr) {
  let el = pre.nextElementSibling;
  if (!el || !el.classList || !el.classList.contains('md-mermaid-note')) {
    el = document.createElement('small');
    el.className = 'md-mermaid-note';
    pre.after(el);
  }
  el.style.color = isErr ? 'var(--err)' : 'var(--faint)';
  el.textContent = text;
}

/* mermaid.parse with suppressErrors hides the grammar detail a reader needs
   to fix their diagram. A second, unsuppressed parse recovers the message. */
async function parseDetail(mermaid, src) {
  try {
    await mermaid.parse(src);
  } catch (err) {
    const msg = String((err && err.message) || err).split('\n').slice(0, 3).join(' ').trim();
    if (msg) return msg.slice(0, 140);
  }
  return 'invalid diagram syntax';
}

/* Put the block back exactly as the server rendered it and say what happened;
   a diagram must never vanish or blank because mermaid could not draw it. */
function fail(target, err) {
  rendered.delete(target);
  const original = snapshots.get(target);
  target.replaceWith(original);
  // Point at the fence's own source line: Mermaid counts within the diagram.
  const at = original.dataset.line ? ' (line ' + original.dataset.line + ')' : '';
  note(original, 'Mermaid' + at + ': ' + (err && err.message ? String(err.message).split('\n')[0] : 'render failed').slice(0, 140), true);
}

async function renderTarget(target) {
  if (!target.isConnected) return; // preview closed before its turn came
  const src = target.dataset.mermaidSource;
  if (!src) return;

  let mermaid;
  try { mermaid = await loadMermaid(); }
  catch (err) { fail(target, err); return; }

  let svg;
  try {
    const parsed = await mermaid.parse(src, { suppressErrors: true });
    if (!parsed) throw new Error(await parseDetail(mermaid, src));
    svg = (await mermaid.render('px0-mermaid-' + (++svgSeq), src)).svg;
    if (!svg) throw new Error('render produced no SVG');
  } catch (err) { fail(target, err); return; }
  // Mermaid runs at securityLevel strict (it DOMPurifies labels itself); this
  // is defence in depth: parse inert, drop scripts and event handlers, then
  // adopt the tree. The parse is HTML, not XML: labels live in foreignObject
  // and use HTML void tags (<br>), which strict XML rejects as a tag
  // mismatch. A DOMParser document runs no script and loads nothing.
  const doc = new DOMParser().parseFromString(svg, 'text/html');
  const root = doc.querySelector('svg');
  if (!root) { fail(target, new Error('render produced no SVG')); return; }
  for (const el of [...doc.querySelectorAll('*')]) {
    if (el.localName === 'script' || el.namespaceURI === 'http://www.w3.org/2000/xhtml' && el.localName === 'iframe') {
      el.remove();
      continue;
    }
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /^javascript:/i.test(a.value.replace(/[\t\n\r ]/g, ''))) el.removeAttribute(a.name);
    }
  }
  target.replaceChildren(); // a re-render (theme switch) replaces the previous stage
  buildZoom(target, document.adoptNode(root));
  rendered.add(target);
}

/* The wrapper stays: the SVG goes into a scrollable stage inside it, so the
   diagram can grow past the column once zoomed, and the wrapper hosts the
   hover toolbar. Zoom resizes the SVG box (width from the viewBox), never a
   transform: real layout keeps native scrolling and drag-pan honest. */
function buildZoom(target, svg) {
  const stage = document.createElement('div');
  stage.className = 'md-mermaid-svg';
  stage.appendChild(svg);
  target.append(stage);
  // The SVG carries its natural size in the viewBox; laid out it never
  // overflows (Mermaid fits it with width:100%), so compare against that.
  // The wrapper, not the stage, holds the preview column's width.
  const natural = svg.viewBox.baseVal.width;
  if (natural > target.clientWidth + 1) target.append(tools(stage));
  else if (natural > 1) {
    // A later column shrink (sidebar drag) promotes a small diagram; a
    // toolbar is never removed, so a zoomed diagram keeps its controls.
    new ResizeObserver(() => {
      // A theme-switch or tab switch replaced the stage; the old observer
      // would otherwise fire on the detached wrapper on every resize.
      if (!target.isConnected) return;
      if (!target.querySelector('.md-mermaid-tools') && natural > target.clientWidth + 1) {
        target.append(tools(stage));
      }
    }).observe(target);
  }
}

const ZOOM_MAX = 8;

/* Toolbar icons are built as DOM, never parsed from strings: the stage already
   went through the inert-document scrub, the toolbar does not get a parser. */
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', '12');
  s.setAttribute('height', '12');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}
const EXPAND = ['M6 2.5H2.5V6', 'M10 2.5h3.5V6', 'M6 13.5H2.5V10', 'M10 13.5h3.5V10'];

/* Cursor-anchored zoom kernel shared by the stage and the lightbox: after the
   content box scales by f, the point under (ax, ay) stays under it. The pure
   math lives in web/src/zoom-math.js so scripts/test-anchor.mjs can assert it
   in Node. */
function anchorScroll(el, f, ax, ay) {
  const r = el.getBoundingClientRect();
  const [x, y] = anchoredScroll(el.scrollLeft, el.scrollTop, r.left, r.top, r.width, r.height, f, ax, ay);
  el.scrollLeft = x;
  el.scrollTop = y;
}

/* Drag pans through native scroll; two pointers pinch-zoom through zoomAt.
   can() gates when the gesture is live; the surface sets touch-action: none
   in CSS. */
function gestures(el, can, zoomAt) {
  const pts = new Map();
  let d0 = 0;
  el.addEventListener('pointerdown', e => {
    if (!can() || e.button !== 0) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      d0 = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d1 = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d0 > 0 && d1 > 0) zoomAt(d1 / d0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      d0 = d1;
      return;
    }
    el.scrollLeft -= e.clientX - prev[0];
    el.scrollTop -= e.clientY - prev[1];
  });
  const drop = e => { pts.delete(e.pointerId); d0 = 0; };
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', drop);
}

/* Hover toolbar for oversized diagrams: zoom in, out, reset, fullscreen. The
   stage wheel zooms only once zoomed in (at rest it keeps scrolling the
   document). */
function tools(stage) {
  const svg = stage.querySelector('svg');
  let z = 1;
  const setZoom = (nz, ax, ay) => {
    const prev = z;
    z = Math.min(ZOOM_MAX, Math.max(1, nz));
    if (z === 1) {
      svg.style.width = '';
      svg.style.maxWidth = '';
      stage.classList.remove('md-mermaid-zoomed');
      stage.scrollLeft = stage.scrollTop = 0;
      return;
    }
    // Column width is the base the CSS fits the diagram to at rest; the
    // zoomed class only caps the height, so clientWidth is stable.
    svg.style.maxWidth = 'none';
    svg.style.width = stage.clientWidth * z + 'px';
    stage.classList.add('md-mermaid-zoomed');
    anchorScroll(stage, z / prev, ax, ay);
  };
  const bar = document.createElement('div');
  bar.className = 'md-mermaid-tools';
  for (const [content, title, fn] of [
    ['+', 'Zoom in', () => setZoom(z * 1.25)],
    ['−', 'Zoom out', () => setZoom(z / 1.25)],
    ['1:1', 'Reset zoom', () => setZoom(1)],
    [icon(EXPAND), 'Fullscreen', () => lightbox(svg, bar.lastElementChild)],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'md-mermaid-tb';
    if (typeof content === 'string') b.textContent = content;
    else b.append(content);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    bar.append(b);
  }
  stage.addEventListener('wheel', e => {
    if (z === 1) return; // at rest the wheel keeps scrolling the document
    e.preventDefault();
    setZoom(z * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX, e.clientY);
  }, { passive: false });
  gestures(stage, () => z > 1, (r, x, y) => setZoom(z * r, x, y));
  return bar;
}

/* Fullscreen lightbox: the SVG over a scrim, zoomed from its natural viewBox
   size. Wheel and pinch zoom at any level (nothing behind the fixed layer
   scrolls), drag pans, keys follow GitLab's enhancer, and Esc, the × button
   or a click on the scrim closes. Tab is trapped, and focus returns to the
   toolbar button that opened it. */
function lightbox(svg, opener) {
  const vb = svg.viewBox.baseVal;
  const scrim = document.createElement('div');
  scrim.className = 'md-mermaid-box';
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-label', 'Diagram fullscreen view');
  const stage = document.createElement('div');
  stage.className = 'md-mermaid-box-stage';
  const clone = svg.cloneNode(true);
  clone.removeAttribute('style'); // natural size from the viewBox, not the column fit
  stage.appendChild(clone);
  const hint = document.createElement('div');
  hint.className = 'md-mermaid-box-hint';
  hint.textContent = 'Scroll to zoom · drag to pan · 0 resets · Esc closes';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'md-mermaid-tb md-mermaid-box-x';
  x.textContent = '\u00d7';
  x.title = 'Close';
  x.setAttribute('aria-label', 'Close');
  scrim.append(stage, hint, x);
  // A drag ends in a browser-synthesized click on the stage; only a press
  // that stayed put closes the lightbox.
  let downX = 0, downY = 0;
  scrim.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
  scrim.addEventListener('click', e => {
    if (e.target !== scrim && e.target !== stage) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
    close();
  });
  document.body.append(scrim);

  let z = 1;
  const setZoom = (nz, ax, ay) => {
    if (!vb.width) return; // guard before touching state
    const prev = z;
    z = Math.min(ZOOM_MAX, Math.max(1, nz));
    clone.style.width = vb.width * z + 'px';
    clone.style.height = vb.height * z + 'px';
    anchorScroll(stage, z / prev, ax, ay);
  };
  const key = e => {
    if (e.key === 'Escape') return close();
    if (e.key === 'Tab') return trapTab(scrim, e);
    if (e.key === '+' || e.key === '=') return setZoom(z * 1.25);
    if (e.key === '-') return setZoom(z / 1.25);
    if (e.key === '0') return setZoom(1);
    if (e.key === 'ArrowLeft') stage.scrollLeft -= 60;
    else if (e.key === 'ArrowRight') stage.scrollLeft += 60;
    else if (e.key === 'ArrowUp') stage.scrollTop -= 60;
    else if (e.key === 'ArrowDown') stage.scrollTop += 60;
    else return;
    e.preventDefault();
  };
  addEventListener('keydown', key);
  const close = () => {
    removeEventListener('keydown', key);
    scrim.remove();
    if (opener && opener.isConnected) opener.focus();
  };
  stage.addEventListener('wheel', e => {
    e.preventDefault(); // nothing behind the fixed layer may scroll
    setZoom(z * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX, e.clientY);
  }, { passive: false });
  gestures(stage, () => true, (r, ax, ay) => setZoom(z * r, ax, ay));
  x.addEventListener('click', close);
  x.focus();
}

function watchTheme() {
  if (themeWatcher) return;
  themeWatcher = new MutationObserver(() => {
    if (!mermaidModule) return; // nothing rendered, nothing to refresh
    mermaidModule.initialize(mermaidConfig()); // computed styles already reflect the new theme
    for (const node of rendered) {
      if (!node.isConnected) { rendered.delete(node); continue; }
      enqueue(node);
    }
  });
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* True while a fullscreen diagram dialog is in the DOM; shortcuts.js stands
   down for every key while it is. */
export const lightboxOpen = () => !!document.querySelector('.md-mermaid-box');

/* Swap every mermaid fence for a wrapper before the code-block enhancer runs,
   so a diagram is never mistaken for a code block; the source stays on the
   wrapper for a failed render to restore. */
export function renderMermaidBlocks(root) {
  if (!root || !root.querySelectorAll) return;
  for (const node of rendered) if (!node.isConnected) rendered.delete(node);
  const codes = root.querySelectorAll('pre[data-lang="mermaid"] > code');
  if (!codes.length) return; // no blocks: mermaid is never imported
  watchTheme();
  let seen = 0;
  for (const code of codes) {
    const pre = code.parentElement;
    if (++seen > MAX_BLOCKS) {
      note(pre, 'Diagram not rendered: this preview has more than ' + MAX_BLOCKS + ' diagrams.');
      continue;
    }
    if (code.textContent.length > MAX_CHARS) {
      note(pre, 'Diagram not rendered: source is longer than ' + MAX_CHARS + ' characters.');
      continue;
    }
    const node = document.createElement('div');
    node.className = 'md-mermaid';
    node.dataset.mermaidSource = code.textContent;
    if (pre.dataset.line) node.dataset.line = pre.dataset.line; // keep line navigation
    snapshots.set(node, pre);
    pre.replaceWith(node);
    enqueue(node);
  }
}
