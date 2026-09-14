// web/src/mermaid.js
// Mermaid rendering for Markdown previews. A ```mermaid fence reaches the page
// as a plain code block (the sanitizer keeps <pre data-lang="mermaid">); this
// module swaps each one for the diagram's SVG inline. The vendored ESM build
// in web/lib/mermaid/ (see scripts/vendor-mermaid.sh) is imported on the first
// diagram, so a preview without fences never fetches or parses it.

/* Keep in lockstep with scripts/vendor-mermaid.sh. The version directory keeps
   the immutable /static/lib/ caching safe across Mermaid upgrades. */
const MERMAID_VERSION = '11.17.2';
const MERMAID_URL = '/static/lib/mermaid/' + MERMAID_VERSION + '/mermaid.esm.min.mjs';

/* Hard caps: over-cap blocks stay readable as source with a short note. */
const MAX_BLOCKS = 50;
const MAX_CHARS = 2000;

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

/* Rebuild the server's block shape when the original node is gone. */
function sourceBlock(src) {
  const pre = document.createElement('pre');
  pre.className = 'md-code';
  pre.dataset.lang = 'mermaid';
  const code = document.createElement('code');
  code.textContent = src;
  pre.appendChild(code);
  return pre;
}

/* Put the block back exactly as the server rendered it and say what happened;
   a diagram must never vanish or blank because mermaid could not draw it. */
function fail(target, src, err) {
  rendered.delete(target);
  const original = snapshots.get(target) || sourceBlock(src);
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
  catch (err) { fail(target, src, err); return; }

  let svg;
  try {
    const parsed = await mermaid.parse(src, { suppressErrors: true });
    if (!parsed) throw new Error(await parseDetail(mermaid, src));
    svg = (await mermaid.render('px0-mermaid-' + (++svgSeq), src)).svg;
    if (!svg) throw new Error('render produced no SVG');
  } catch (err) { fail(target, src, err); return; }
  // Mermaid runs at securityLevel strict (it DOMPurifies labels itself); this
  // is defence in depth: parse inert, drop scripts and event handlers, then
  // adopt the tree. Nothing is serialised or re-parsed.
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.documentElement.localName === 'svg' && !doc.querySelector('parsererror')) {
    for (const el of [...doc.querySelectorAll('*')]) {
      if (el.localName === 'script' || el.namespaceURI === 'http://www.w3.org/2000/xhtml' && el.localName === 'iframe') {
        el.remove();
        continue;
      }
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name) || /^javascript:/i.test(a.value.replace(/[\t\n\r ]/g, ''))) el.removeAttribute(a.name);
      }
    }
    const holder = document.createElement('div');
    holder.className = 'md-mermaid-svg';
    holder.appendChild(document.adoptNode(doc.documentElement));
    target.replaceWith(holder);
  } else {
    fail(target, src, new Error('render produced no SVG'));
    return;
  }
  rendered.add(target);
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

/* Swap every mermaid fence for a wrapper before the code-block enhancer runs,
   so a diagram is never mistaken for a code block; the source stays on the
   wrapper for a failed render to restore. */
export function renderMermaidBlocks(root) {
  if (!root || !root.querySelectorAll) return;
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
