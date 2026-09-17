// web/src/zoom-math.js
/* Cursor-anchored zoom, pure math: after the content box scales by f, return
   the scroll offsets that keep the viewport point (ax, ay) over the same
   content point. ax/ay of null anchor to the box centre. Deliberately
   DOM-free so scripts/test-anchor.mjs can exercise it in Node; the DOM side
   (getBoundingClientRect + scrollLeft/scrollTop assignment) lives in
   web/src/mermaid.js. */
export function anchoredScroll(sl, st, left, top, width, height, f, ax, ay) {
  const x = (ax == null ? width / 2 : ax - left) + sl;
  const y = (ay == null ? height / 2 : ay - top) + st;
  return [x * f - (ax == null ? width / 2 : ax - left),
          y * f - (ay == null ? height / 2 : ay - top)];
}
