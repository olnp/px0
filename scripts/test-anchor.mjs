#!/usr/bin/env node
/**
 * scripts/test-anchor.mjs
 *
 * Node-runnable invariant checks for the cursor-anchored zoom kernel
 * (web/src/zoom-math.js): after the content box scales by f, the content
 * point under the anchor (viewport point + scroll offset) must not move.
 * Zero dependencies; run via `node scripts/test-anchor.mjs` or `make test`.
 */
import { anchoredScroll } from '../web/src/zoom-math.js';

let failures = 0;

const eq = (a, b, label) => {
  if (!(Math.abs(a - b) < 1e-9)) {
    console.error(`FAIL ${label}: ${a} != ${b}`);
    failures++;
  }
};

// Box at viewport (120, 80), 600x400 client area.
const box = { sl: 0, st: 0, left: 120, top: 80, width: 600, height: 400 };

// 1. f = 1 is the identity: no scroll movement, anchor unchanged.
for (const ax of [null, box.left, box.left + 300, box.left - 5, 0, 1e6]) {
  for (const ay of [null, box.top + 200, 0, -50]) {
    const [x, y] = anchoredScroll(box.sl, box.st, box.left, box.top, box.width, box.height, 1, ax, ay);
    eq(x, box.sl, `f=1 x (ax=${ax})`);
    eq(y, box.st, `f=1 y (ay=${ay})`);
  }
}

// 2. Content point under the anchor is preserved across any zoom factor.
//    contentX = anchorViewportX - box.left + scrollX  (pre and post).
const check = (label, sl, st, f, ax, ay) => {
  const preX = (ax == null ? box.width / 2 : ax - box.left) + sl;
  const preY = (ay == null ? box.height / 2 : ay - box.top) + st;
  const [nx, ny] = anchoredScroll(sl, st, box.left, box.top, box.width, box.height, f, ax, ay);
  eq((ax == null ? box.width / 2 : ax - box.left) + nx, preX * f, `${label} content-x anchored`);
  eq((ay == null ? box.height / 2 : ay - box.top) + ny, preY * f, `${label} content-y anchored`);
};
for (const f of [1.25, 2, 8, 0.8, 0.25]) {
  check(`f=${f} centre`, 0, 0, f, null, null);
  check(`f=${f} cursor`, 40, 30, f, box.left + 150, box.top + 100);
  check(`f=${f} edge`, 100, 50, f, box.left + 590, box.top + 395);
  check(`f=${f} outside`, 0, 0, f, box.left - 40, box.top - 10);
}

// 3. Pre-existing scroll is carried through: content under the anchor scales
//    by f (centre anchor); scroll itself grows by f only for an edge anchor.
{
  const [x, y] = anchoredScroll(300, 200, box.left, box.top, box.width, box.height, 2, null, null);
  eq(x, 900, 'centre anchor: content point 600 -> 1200, scroll 1200 - 300');
  eq(y, 600, 'centre anchor: content point 400 -> 800, scroll 800 - 200');
  const [ex] = anchoredScroll(300, 0, box.left, box.top, box.width, box.height, 2, box.left, 0);
  eq(ex, 600, 'edge anchor: scroll grows by f');
}

// 4. Offsets may be negative; the browser clamps to [0, max] on assignment.
{
  const [x] = anchoredScroll(0, 0, box.left, box.top, box.width, box.height, 0.5, box.left + 10, 0);
  if (!(x < 0)) { console.error(`FAIL zoom-out near left edge should clamp negative, got ${x}`); failures++; }
}

if (failures) {
  console.error(`${failures} anchor-math check(s) failed`);
  process.exit(1);
}
console.log('anchor-math checks passed');
