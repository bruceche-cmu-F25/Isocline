/* Alfred's figure: a wireframe tesseract (the body), and a 3D wireframe one step simpler for every other state.
 *
 *   rest    tesseract, breathing, now and then a blink  hello   tesseract, slowly unfolding and back (the body)
 *   listen  a globe turning, swelling with your voice   think    an octahedron spinning like a top
 *   speak   four stacked rings swelling with a voice    work     the body turning slowly in two planes, endlessly
 *   notice  a tetrahedron, amber, hopping               done     a cube, settled, green
 *   error   two crossed beams, red, shaking             sleep    a flat slab lying down, breathing
 *   ponder  the same slow double turn: thinking for a while (think becomes this after PONDER_AFTER s)
 *   flow    the body turning slowly through its fourth dimension, the inner cube rolling out: loading, syncing
 *
 * One-shot moves of the body, played over rest or hello and back (figure.play):
 *   hop     crouch, spring up, flip inside out in the air, land with a bump. Played by itself when work ends.
 *   poke    a flinch and a wobble of every corner: when touched
 *   grow    a point, then a line, a square, a cube, the tesseract: an entrance (createFigure's `enter`)
 *   unfold  opens hinge by hinge into its net (a cross of eight cubes), turns, folds back: introducing itself
 *   twirl   crouch, spin once round in the air (the inner cube half a beat behind), land
 *   tiptoe  tips up onto one corner, spins twice like a top, wobbles as it slows, comes back down
 *   toss    the outer cube flings the inner one up; it turns over in the air and drops back in
 * grow and unfold end square-on (no sway, the inner cube dead centre) and the body holds still a moment, no breath or
 * blink, before the breathing eases back in.
 *
 * A change between two figures is a redraw: the old one's wires shrink back to their middles and fade while the new
 * one draws itself wire by wire, like a pen, turning gently into place. Poses of the same figure glide. Lines further
 * from the viewer are mixed toward the background colour, so the wireframes read as solid space; the menu-bar (mono)
 * version stays flat. Every move is continuous: no value jumps at a phase change or where a loop starts over.
 *
 * Used by the Mac app's presence window and menu-bar icon, and by the prototypes (prototype/figure.js links here).
 * Design record: docs/research/alfred-entity.md §4.4. State sheet: prototype/tesseract.html; the moves, larger:
 * prototype/tesseract-moves.html. Nothing here touches the DOM until createFigure() or drawMark() is called, so Node
 * can import the geometry.
 */

export const STATES = ["rest", "hello", "listen", "think", "speak", "work", "notice", "done", "error", "sleep", "ponder", "flow"];
export const MOVES = ["hop", "poke", "grow", "unfold", "twirl", "tiptoe", "toss"];
export const PALETTES = {
  light: { ind: "#4967c5", light: "#a9b8f2", amber: "#e09a1f", ok: "#2f9a64", now: "#d9443f" },
  dark: { ind: "#86a0f2", light: "#56649c", amber: "#efaa3e", ok: "#4cc38a", now: "#f05a54" },
};
/* States that show colour even in the monochrome (menu-bar) version. */
export const LOUD = ["notice", "done", "error"];
/* How long "think" holds its octahedron before it turns into the body pondering. */
const PONDER_AFTER = 8;
/* How fast the body turns (rad/s) while working or pondering (both planes), and in flow: slow enough to play all day. */
const TURN2_SPEED = 0.3, FLOW_SPEED = 0.42;
/* After grow or unfold: held square-on and still for SETTLE_HOLD s, then the breath, sway and blinks ease back in. */
const SETTLE_HOLD = 1.6, SETTLE_EASE = 2.4;

const S = Math.sin, Cs = Math.cos, PI = Math.PI, abs = Math.abs, max = Math.max;
const NSEG = 96;
const voice = (t) => max(0, 0.5 + 0.3 * S(t * 7.3) + 0.25 * S(t * 12.1 + 1) + 0.2 * S(t * 2.3));
/* Quintic: starts and stops with no sudden acceleration. */
const sm = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10));
const lerp = (a, b, u) => a + (b - a) * u;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/* Keyframes [[time, value]], eased between. */
const kf = (t, keys) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return lerp(keys[i - 1][1], keys[i][1], sm((t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0])));
  return keys[keys.length - 1][1];
};
/* A damped spring set off at d = 0 from rest: 0 at the start, rings, dies away. */
const ring = (d, freq, decay) => (d <= 0 ? 0 : Math.exp(-d * decay) * S(d * freq));
/* An angle whose speed builds up smoothly from 0 to `speed` (rad/s) over about `lag` s. */
const spinUp = (s, speed, lag = 0.8) => speed * (s - lag * (1 - Math.exp(-s / lag)));
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbHex = (c) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);

/* ── Viewing: a fixed three-quarter view. view() returns [x, y, nearness]; bigger nearness is closer. ── */
const YAW = 0.62, PITCH = 0.5;
const view = ([X, Y, Z]) => { const x1 = X * Cs(YAW) + Z * S(YAW), z1 = -X * S(YAW) + Z * Cs(YAW); return [x1, Y * Cs(PITCH) - z1 * S(PITCH), -(Y * S(PITCH) + z1 * Cs(PITCH))]; };
const rotY = ([x, y, z], a) => [x * Cs(a) + z * S(a), y, -x * S(a) + z * Cs(a)];
const rotX = ([x, y, z], a) => [x, y * Cs(a) - z * S(a), y * S(a) + z * Cs(a)];
const rotZ = ([x, y, z], a) => [x * Cs(a) - y * S(a), x * S(a) + y * Cs(a), z];
/* 4D → 3D: rotate in the XW, YW, ZW planes, then perspective along W. Returns [x, y, z, w]. */
function proj4(v, { xw = 0, yw = 0, zw = 0, D = 2.7 } = {}) {
  return v.map(([x, y, z, w]) => {
    let X = x * Cs(xw) - w * S(xw), W = x * S(xw) + w * Cs(xw);
    let Y = y * Cs(yw) - W * S(yw); W = y * S(yw) + W * Cs(yw);
    let Z = z * Cs(zw) - W * S(zw); W = z * S(zw) + W * Cs(zw);
    const k = 1 / (D - W); return [X * k, Y * k, Z * k, W];
  });
}
const TV = Array.from({ length: 16 }, (_, i) => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
/* Edges join vertices that differ in one coordinate; the third field marks the 8 edges along W (inner to outer cube). */
const TE = []; for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) { const x = i ^ j; if ((x & (x - 1)) === 0) TE.push([i, j, x === 8]); }
const fitOf = (p) => { const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); return { s: 92 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 }; };
const FIT = fitOf(proj4(TV).map(view));
/* Figures are drawn in a 120 × 120 box. */
const place = ([x, y], sc = 1, fit = FIT) => [60 + (x - fit.cx) * fit.s * sc, 60 + (y - fit.cy) * fit.s * sc];
/* A segment is [endA, endB, isWEdge, nearnessA, nearnessB]. */
const segs = (pts3, edges, { sc = 1, cam = view } = {}) => { const v = pts3.map(cam), p = v.map((q) => place(q, sc)); return edges.map(([i, j, w]) => [p[i], p[j], !!w, v[i][2], v[j][2]]); };
const near = (s) => (s[3] + s[4]) / 2;

/* Cut a figure's edges into exactly NSEG pieces. How many pieces each edge gets is fixed per figure (by length,
   the first time it is drawn), so pieces never jump between edges as the figure turns. */
const ALLOC = {};
function cut(list, key) {
  if (list.length === NSEG) return list;
  if (!ALLOC[key]) {
    const L = list.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-6), tot = L.reduce((x, y) => x + y, 0);
    const n = L.map((l) => Math.max(1, Math.floor((l / tot) * NSEG)));
    for (let left = NSEG - n.reduce((x, y) => x + y, 0); left > 0; left--) { let best = 0; for (let i = 1; i < n.length; i++) if (L[i] / n[i] > L[best] / n[best]) best = i; n[best]++; }
    ALLOC[key] = n;
  }
  const out = [], lerp2 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  list.forEach(([a, b, w, na, nb], i) => { const n = ALLOC[key][i]; for (let k = 0; k < n; k++) out.push([lerp2(a, b, k / n), lerp2(a, b, (k + 1) / n), w, na + (nb - na) * (k / n), na + (nb - na) * ((k + 1) / n)]); });
  return out;
}
const ring3 = (n, f) => { const pts = Array.from({ length: n }, (_, i) => f((i / n) * PI * 2)); return { pts, edges: pts.map((_, i) => [i, (i + 1) % n]) }; };
const merge = (...parts) => { const pts = [], edges = []; for (const p of parts) { const o = pts.length; pts.push(...p.pts); edges.push(...p.edges.map(([i, j]) => [i + o, j + o])); } return { pts, edges }; };

/* ── The body ── */
/* The tesseract's nearness adds its fourth dimension: the inner cube is further away along W, so it is a little lighter. */
const cam4 = (q) => { const v = view(q); return [v[0], v[1], v[2] + 0.25 * q[3]]; };
const BOT = Math.max(...proj4(TV).map((q) => view(q)[1])); // the body's lowest point, in view units: squashes pivot here
/* Projected 4D points → segments. jig nudges each point in 3D; yaw turns it as seen; sx / sy squash it about its
   base; sc scales it about the middle of the box; fit frames it (default: the resting body's frame). */
function body4(P, edges, o = {}) {
  const v = P.map((p, i) => {
    const q = o.jig ? [p[0] + o.jig[i][0], p[1] + o.jig[i][1], p[2] + o.jig[i][2], p[3]] : p;
    let [x, y, n] = cam4(q);
    if (o.yaw) [x, n] = [x * Cs(o.yaw) + n * S(o.yaw), -x * S(o.yaw) + n * Cs(o.yaw)];
    if (o.sy) y = BOT + (y - BOT) * o.sy;
    if (o.sx) { x *= o.sx; n *= o.sx; }
    return [x, y, n];
  });
  const p = v.map((q) => place(q, o.sc ?? 1, o.fit));
  return edges.map(([i, j, w]) => [p[i], p[j], !!w, v[i][2], v[j][2]]);
}
/* The tesseract. axes squeezes x, y, z, w (0 collapses one); yz turns it in the 4D yz plane; xw/yw/zw/D as proj4. */
function tesseract(o = {}) {
  let V = o.axes ? TV.map((v) => v.map((c, i) => c * o.axes[i])) : TV;
  if (o.yz) V = V.map(([x, y, z, w]) => [x, y * Cs(o.yz) - z * S(o.yz), y * S(o.yz) + z * Cs(o.yz), w]);
  return body4(proj4(V, o), TE, o);
}
const bodyCut = (o) => cut(tesseract(o), "body");

/* Rest: a slow sway through the fourth dimension; a breath (the two cubes draw together, in faster than out); and,
   every few seconds at a time of its own, a blink (the two cubes meet in one, a beat, and spring back a touch past).
   calm (0..1) is how much of all that is in it: 0 is the square-on mark, held still (just after grow and unfold). */
const sway = (t) => 0.12 * S(t * 0.55);
const blinkAt = (d) => {
  if (d <= 0 || d >= 0.45) return 0;
  if (d < 0.12) return sm(d / 0.12);
  if (d < 0.16) return 1;
  const x = (d - 0.16) / 0.29, c1 = 1.1, c3 = c1 + 1;
  return -(c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2);
};
const hash = (n) => { const x = S(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const BLINK_EVERY = 7;
function restPose(t, seed = 0, calm = 1) {
  const p = (((t + seed * 6) / 6) % 1 + 1) % 1, breath = p < 0.4 ? sm(p / 0.4) : 1 - sm((p - 0.4) / 0.6);
  const bt = t + seed * BLINK_EVERY, k = Math.floor(bt / BLINK_EVERY), local = bt - k * BLINK_EVERY;
  const at = 1.5 + 4 * hash(k + seed * 1000), twice = hash(k * 3.7 + seed * 99) < 0.3;
  const blink = Math.max(blinkAt(local - at), twice ? blinkAt(local - at - 0.55) : 0);
  const br = breath * calm, bl = blink * calm;
  return { xw: sway(t) * calm, axes: [1, 1, 1, (1 - 0.3 * br) * (1 - bl)], sc: 1 + 0.03 * br, dy: -1.2 * br };
}

/* The net: the inner cube in the middle, the six side cells hinged on its faces, the outer cube hinged on the far end
   of the +y cell. open: how far each hinge is open (x, y, z, then the outer cube's), 0 folded … 1 flat. */
const CUBEV = Array.from({ length: 8 }, (_, i) => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]);
const CUBEE = []; for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const x = i ^ j; if ((x & (x - 1)) === 0) CUBEE.push([i, j]); }
function netCells(open) {
  const list = [CUBEV.map(([x, y, z]) => [x, y, z, -1])];
  for (let a = 0; a < 3; a++) for (const sg of [-1, 1]) {
    const th = ((1 - open[a]) * PI) / 2, others = [0, 1, 2].filter((k) => k !== a);
    list.push(CUBEV.map(([p, q, r]) => { const v = [0, 0, 0, 0], s = r + 1; v[others[0]] = p; v[others[1]] = q; v[a] = sg * (1 + s * Cs(th)); v[3] = -1 + s * S(th); return v; }));
  }
  const ty = ((1 - open[1]) * PI) / 2, tw = ty + ((1 - open[3]) * PI) / 2;
  list.push(CUBEV.map(([p, q, r]) => { const s = r + 1; return [p, 1 + 2 * Cs(ty) + s * Cs(tw), q, -1 + 2 * S(ty) + s * S(tw)]; }));
  return list;
}
const CELLE = Array.from({ length: 8 }, (_, c) => CUBEE.map(([i, j]) => [c * 8 + i, c * 8 + j])).flat(); // 96 edges: NSEG
const NETD = 8.7;
const NETFIT = fitOf(proj4(netCells([1, 1, 1, 1]).flat(), { D: NETD }).map(cam4)); // the flat net's frame, worked out once

/* A fixed random direction for each corner (for the poke's wobble). */
const DIRS = TV.map((_, i) => { const a = i * 2.399, b = ((i * 0.618) % 1) * 2 - 1, r = Math.sqrt(1 - b * b); return [r * Cs(a), b, r * S(a)]; });

/* The resting body as 3D points (after the 4D projection), before it is seen: what the moves below bend. */
const restPoints = (r) => proj4(TV.map((v) => v.map((c, i) => c * r.axes[i])), { xw: r.xw });
const onPoints = (P, f) => P.map((p, i) => { const [x, y, z] = f([p[0], p[1], p[2]], i); return [x, y, z, p[3]]; });
const isOuter = (i) => TV[i][3] > 0;
const lowest = (list) => { let b = -Infinity; for (const [p, q] of list) b = Math.max(b, p[1], q[1]); return b; };

/* ── Moves: (time into the move, clock, seed, calm) → a frame. dur in s. Each starts on the resting pose at that calm
   and ends exactly on it; a move that `settles` ends on the square-on mark instead (calm 0), and the body holds it. ── */
const MOVE = {
  hop: { dur: 2.3, f: (u, t, seed, calm = 1) => {
    const r = restPose(t, seed, calm), up = 0.5, land = 1.1, air = clamp((u - up) / (land - up), 0, 1), q = u - land;
    const squash = kf(u, [[0, 0], [up, -0.13], [up + 0.12, 0.07], [land - 0.08, 0]]);
    const sy = 1 + squash - 0.12 * ring(q, 15, 6), sx = 1 - 0.5 * squash + 0.06 * ring(q, 15, 6);
    return { s: bodyCut({ ...r, xw: r.xw + PI * sm(air), sx, sy, sc: r.sc * (1 - 0.15 * S(PI * air)) }), col: "ind", dy: r.dy - 9 * S(PI * air), depth: true };
  } },
  poke: { dur: 1.6, f: (u, t, seed, calm = 1) => {
    const r = restPose(t, seed, calm), A = 0.15 * Math.exp(-u / 0.32) * (1 - Math.exp(-u / 0.06)), k = 0.11 * ring(u, 20, 8);
    const jig = DIRS.map((v, i) => v.map((c) => c * A * S(2 * PI * 4.2 * u + i * 1.7)));
    return { s: bodyCut({ ...r, jig, sy: 1 - k, sx: 1 + 0.6 * k }), col: "ind", dy: r.dy, depth: true };
  } },
  // from a point, so it can begin anywhere; it grows straight into the square-on mark
  grow: { dur: 3.3, dots: true, settles: true, f: (u, t, seed) => {
    const r = restPose(t, seed, 0), g = (start, dur) => sm((u - start) / dur);
    const k = [g(0.3, 0.9), g(0.85, 0.9), g(1.4, 0.9), g(1.95, 1.2)], axes = k.map((a, i) => a * r.axes[i]);
    return { s: bodyCut({ xw: r.xw, axes, sc: lerp(1, r.sc, k[3]) }), col: "ind", dy: r.dy * k[3], depth: true, op: sm(u / 0.35), sw: 1 + 0.6 * (1 - k[0]) };
  } },
  // the breath and blinks fade out as it starts to open, so it folds back into the square-on mark
  unfold: { dur: 7.4, settles: true, f: (u, t, seed, calm = 1) => {
    const r = restPose(t, seed, calm * (1 - sm(u / 0.8))), m0 = kf(u, [[0, 0], [2.8, 1], [4.6, 1], [7.4, 0]]);
    const open = [0, 0.26, 0.13, 0.4].map((a) => sm((m0 - a) / 0.6)), m = open.reduce((a, b) => a + b, 0) / 4;
    const V = netCells(open).flat().map(([x, y, z, w]) => [x, y, z, w * r.axes[3]]);
    const D = Math.max(lerp(2.7, NETD, sm(m)), Math.max(...V.map((v) => v[3])) + 1.7);
    const P = proj4(V, { xw: r.xw * (1 - m), D }), yaw = m * 0.45 * S(t * 0.6);
    // Framed between the body's frame and the flat net's, never so close that a half-open arm leaves the box.
    const v = P.map(cam4).map(([x, y, n]) => [x * Cs(yaw) + n * S(yaw), y]), now = fitOf(v);
    const fit = { s: Math.min(lerp(FIT.s, NETFIT.s, sm(m)), (now.s * 100) / 92), cx: lerp(FIT.cx, now.cx, sm(m)), cy: lerp(FIT.cy, now.cy, sm(m)) };
    return { s: body4(P, CELLE, { yaw, fit, sc: lerp(r.sc, 1, sm(m)) }), col: "ind", dy: r.dy * (1 - m), depth: true };
  } },
  twirl: { dur: 2.7, f: (u, t, seed, calm = 1) => {
    const r = restPose(t, seed, calm), up = 0.4, land = 1.75, air = clamp((u - up) / (land - up), 0, 1), q = u - land;
    const crouch = kf(u, [[0, 0], [up, -0.1], [up + 0.14, 0.05], [land - 0.1, 0]]);
    const outer = 2 * PI * sm(air), inner = 2 * PI * sm((u - up - 0.22) / (land - up));
    const P = onPoints(restPoints(r), (p, i) => rotY(p, isOuter(i) ? outer : inner));
    const sy = 1 + crouch - 0.1 * ring(q, 14, 6), sx = 1 - 0.5 * crouch + 0.05 * ring(q, 14, 6);
    return { s: cut(body4(P, TE, { sc: r.sc * (1 - 0.08 * S(PI * air)), sx, sy }), "body"), col: "ind", dy: r.dy - 8 * S(PI * air), depth: true };
  } },
  tiptoe: { dur: 4.6, f: (u, t, seed, calm = 1) => {
    const r = restPose(t, seed, calm), up = kf(u, [[0.1, 0], [1.0, 1], [3.6, 1], [4.5, 0]]);
    const spin = 4 * PI * sm((u - 0.55) / 3.4), wob = 0.07 * up * S(PI * clamp((u - 2.6) / 1.4, 0, 1)) * S(u * 9);
    // The outer cube's corner (1, 1, 1) tipped straight down, a spin about the upright, standing on that corner.
    const stand = (p) => rotX(rotZ(p, (up * PI) / 4), up * -0.6155);
    const P0 = restPoints(r), P = onPoints(P0, (p) => rotZ(rotY(stand(p), spin), wob));
    const list = body4(P, TE, { sc: r.sc * (1 - 0.1 * up) });
    return { s: cut(list, "body"), col: "ind", dy: r.dy + up * (lowest(body4(P0, TE, { sc: r.sc })) - lowest(list)), depth: true };
  } },
  toss: { dur: 2.7, f: (u, t, seed, calm = 1) => {
    const r = restPose(t, seed, calm), fling = 0.42, land = 1.5, x = clamp((u - fling) / (land - fling), 0, 1), q = u - land;
    const crouch = kf(u, [[0, 0], [fling - 0.05, -0.09], [fling + 0.12, 0.03], [fling + 0.4, 0]]);
    // Thrown up and caught: a parabola, turning over once on the way; caught with a dip and a bump.
    const h = 2 * x * (1 - x) - 0.06 * ring(q, 15, 6) + 0.02 * crouch, spin = 2 * PI * sm(x);
    const P = onPoints(restPoints(r), (p, i) => { if (isOuter(i)) return p; const [a, b, c] = rotX(rotY(p, spin), spin); return [a, b - h, c]; });
    const sy = 1 + crouch - 0.07 * ring(q - 0.03, 14, 6), sx = 1 - 0.5 * crouch + 0.04 * ring(q - 0.03, 14, 6);
    return { s: cut(body4(P, TE, { sc: r.sc * (1 - 0.1 * S(PI * x)), sx, sy }), "body"), col: "ind", dy: r.dy + 5 * S(PI * x), depth: true };
  } },
};

/** How long a move takes, in s (0 for a name that is not a move). */
export const moveSeconds = (move) => MOVE[move]?.dur ?? 0;

/* The greeting's timing in s: still, unfold, held open, fold back (also `move`), then still again till the cycle ends. */
const HELLO = { rest: 3, move: 2.6, hold: 1.2, cycle: 11 };

/* ── States: (time in s, entry spin in rad, { since, seed, calm }) → { s: segments, col: palette key, dx, dy, depth }.
   since: seconds since this state began on this figure; seed: this figure's own (0..1), so blinks are not in step;
   calm: how much breath and blink the resting body has (see restPose). ── */
const CTX0 = { since: 0, seed: 0, calm: 1 };
/* The body turning in two planes at once, the two cubes passing through each other; it speeds up from still. */
const turn2 = (t, e, c = CTX0) => { const a = spinUp(c.since, TURN2_SPEED, 1.6) + e; return { s: bodyCut({ xw: a, yz: a }), col: "ind", depth: true }; };
const STATE = {
  rest: (t, e, c = CTX0) => { const r = restPose(t, c.seed, c.calm ?? 1); return { s: bodyCut(r), col: "ind", dy: r.dy, depth: true }; },
  // a slow, full turn through the fourth dimension: the inner cube swells out until it is the outer one, a pause,
  // then it folds back the same way; long rests between
  hello: (t) => {
    const ph = t % HELLO.cycle, { rest, move, hold } = HELLO, glide = (x) => (1 - Cs(PI * Math.min(1, Math.max(0, x)))) / 2;
    const u = ph < rest ? 0 : ph < rest + move ? glide((ph - rest) / move) : ph < rest + move + hold ? 1 : 1 - glide((ph - rest - move - hold) / move);
    return { s: bodyCut({ xw: u * PI + sway(t) }), col: "ind", dy: -3 * S(u * PI), depth: true };
  },
  ponder: turn2,
  // the body rolling through its fourth dimension: the inner cube keeps coming out to be the outer one
  flow: (t, e, c = CTX0) => ({ s: bodyCut({ xw: spinUp(c.since, FLOW_SPEED, 1.4) + e, yaw: 0.15 * S(c.since * 0.25) }), col: "ind", depth: true }),
  // a globe: equator and three meridians, turning; it swells a little with your voice
  listen: (t, e) => {
    const R = 0.72 * (1 + 0.07 * voice(t * 0.7 + 3)), spin = t * 0.35 + e;
    const meridian = (phi) => ring3(24, (a) => [R * Cs(a) * Cs(phi), R * S(a), R * Cs(a) * S(phi)]);
    const g = merge(ring3(24, (a) => [R * Cs(a), 0, R * S(a)]), meridian(spin), meridian(spin + PI / 3), meridian(spin + (2 * PI) / 3));
    return { s: segs(g.pts.map((p) => rotX(p, 0.2)), g.edges), col: "ind", depth: true };
  },
  // a spinning top: speeds up and slows as it turns the idea over, and wobbles
  think: (t, e) => { const ry = t * 0.7 + 0.55 * S(t * 0.9) + e, rx = 0.2 * S(t * 0.6); return { s: cut(segs(OCTV.map((v) => rotX(rotY(v.map((c) => c * 0.88), ry), rx)), OCTE), "oct"), col: "ind", depth: true }; },
  // four rings stacked like a sphere's latitudes; each swells with the voice, one after another, bottom to top
  speak: (t, e) => {
    const R = 0.62, lat = [0.72, 0.25, -0.25, -0.72];
    const g = merge(...lat.map((u, i) => { const r = R * Math.sqrt(1 - u * u) * (1 + 0.32 * voice(t - i * 0.09)); return ring3(24, (a) => [r * Cs(a + e), R * u * 1.2, r * S(a + e)]); }));
    return { s: segs(g.pts.map((p) => rotZ(p, 0.08 * S(t * 0.9))), g.edges), col: "ind", depth: true };
  },
  // working: the slow double turn, for as long as the work takes
  work: turn2,
  notice: (t, e) => ({ s: cut(segs(TETV.map((v) => rotX(rotY(v.map((c) => c * 0.8), 0.5 + 0.25 * S(t * 1.5) + e), 0.05)), TETE), "tet"), col: "amber", dy: -5 * abs(S(t * 4.2)), depth: true }),
  done: (t, e) => ({ s: cut(segs(CUBEV.map((v) => rotY(v.map((c) => c * 0.55), 0.08 * S(t * 0.8) + e)), CUBEE), "cube"), col: "ok", depth: true }),
  // two crossed beams, seen a little from the side, shaking
  error: (t, e) => {
    const ph = (t * 0.9) % 1, swayX = 0.42 + 0.12 * S(t * 0.7) + e;
    const cam = (p) => { const q = rotX(rotY(p, swayX), -0.32); return [q[0], q[1], -q[2]]; };
    const pts = [...BEAMV.map((v) => rotZ(v, PI / 4)), ...BEAMV.map((v) => rotZ(v, -PI / 4))];
    return { s: cut(segs(pts, [...CUBEE, ...CUBEE.map(([i, j]) => [i + 8, j + 8])], { cam }), "x"), col: "now", dx: ph < 0.3 ? 4 * S(ph * 80) * (1 - ph / 0.3) : 0, depth: true };
  },
  // lying down: a flat slab that breathes
  sleep: (t, e) => { const h = 0.07 + 0.03 * S(t * 1.1); return { s: cut(segs(CUBEV.map(([x, y, z]) => rotY([x * 0.6, y * h, z * 0.6], 0.2 + e)), CUBEE), "slab"), col: "light", dy: 8, depth: true }; },
};
const OCTV = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCTE = []; for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if ((i >> 1) !== (j >> 1)) OCTE.push([i, j]);
const TETV = [[0, -1.15, 0], [0.94, 0.42, 0.54], [-0.94, 0.42, 0.54], [0, 0.42, -1.09]];
const TETE = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const BEAMV = CUBEV.map(([x, y, z]) => [x * 0.82, y * 0.13, z * 0.13]);

const BODY = ["rest", "hello"]; // the body's poses; moves play over these
const SPIN = ["ponder", "flow", "work"]; // the body turning: in mono and small sizes these drop the W edges too
const WHOLE = [...BODY, ...SPIN];

/**
 * The resting mark as plain segments in a 120 × 120 box: [[x1, y1], [x2, y2], nearness 0..1].
 * mono drops the 8 W edges (for 16 px and template images). Pure; safe to call from Node.
 */
export function markSegments({ mono = false } = {}) {
  const e = tesseract({}).filter((s) => !(mono && s[2])), ns = e.map(near), lo = Math.min(...ns), hi = Math.max(...ns);
  return e.map((s, i) => [s[0], s[1], (ns[i] - lo) / (hi - lo)]);
}

/* ── Colours from CSS: any syntax (oklch, color-mix…) resolved through a 1 px canvas. ── */
let probe = null;
function toRgba(css) {
  if (!probe) { const c = document.createElement("canvas"); c.width = c.height = 1; probe = c.getContext("2d", { willReadFrequently: true }); }
  probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#0000"; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data];
}
/* The colour the figure sits on: the first ancestor with a visible background. */
function findBackground(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = toRgba(getComputedStyle(n).backgroundColor); if (c[3] > 8) return c.slice(0, 3); }
  return null;
}
const resolveBg = (svg, background) => (background === "auto" ? findBackground(svg.parentElement) : background ? toRgba(background).slice(0, 3) : null);

/**
 * Draws the static mark into an <svg viewBox="0 0 120 120">. Far edges are mixed toward the background.
 * mono: no depth, W edges dropped, drawn in currentColor.
 */
export function drawMark(svg, { width = 5, dark = false, background = "auto", mono = false } = {}) {
  const bg = mono ? null : resolveBg(svg, background), ink = hexRgb(PALETTES[dark ? "dark" : "light"].ind);
  const lines = markSegments({ mono }).sort((a, b) => a[2] - b[2]).map(([a, b, f]) => {
    const stroke = mono ? "currentColor" : rgbHex(bg ? mix(ink, bg, (1 - f) * 0.62) : ink);
    return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${stroke}"/>`;
  });
  svg.innerHTML = `<g stroke-width="${width}" stroke-linecap="round">${lines.join("")}</g>`;
}

/* ── Live figures: one animation loop for all of them. ──
 * A change between two different figures is a redraw, not a reshuffle: the old figure's wires shrink back toward
 * their own middles and fade (in its own colour), while the new figure draws itself wire by wire, like a pen, turning
 * gently into place (already in its colour). The two overlap a little, so it reads as one motion, and the lines are
 * always whole. Between poses of the same figure (the body resting and greeting) it simply glides, and the body glides
 * into its turning (ponder, flow); out of a turn it is redrawn, since a turned tesseract's lines are far from home. */
const figures = new Set();
const SVGNS = "http://www.w3.org/2000/svg";
const GLIDE_S = 0.5, OUT_S = 0.42, IN_AT = 0.16, SWEEP_S = 0.22, IN_S = 0.5, ENTRY_SPIN = 0.55;
const REDRAW_S = IN_AT + SWEEP_S + IN_S;
const easeInOut = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const easeIn = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x);
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const family = (state) => (BODY.includes(state) ? "body" : state);
const glides = (from, to) => family(from) === family(to) || (BODY.includes(from) && SPIN.includes(to));
let running = false;

// While the body is idle it alternates turns and gestures. Each figure starts on its own beat.
// Use only the body here: the amber, green and red shapes, the microphone and the working shapes carry meaning.
const IDLE_CUES = ["flow", "twirl", "ponder", "toss", "unfold", "hop", "tiptoe"];
function pauseIdle(I, t) {
  if (!I.idle) return;
  I.idle.turn = null;
  I.idle.nextAt = t + 3.5 + I.seed * 1.5;
}

function idlePose(I, t) {
  const idle = I.idle;
  if (t >= idle.nextAt && !I.play) {
    const cue = IDLE_CUES[idle.index];
    idle.index = (idle.index + 1) % IDLE_CUES.length;
    if (SPIN.includes(cue)) {
      idle.turn = cue;
      idle.nextAt = t + idle.turnSeconds;
    } else {
      // Let the turn settle into the resting body before the gesture. The net needs more room than a button has.
      const move = cue === "unfold" && (I.small || I.mono) ? "poke" : cue;
      const start = t + (idle.turn ? GLIDE_S : 0);
      I.play = { move, start, idle: true };
      pauseIdle(I, start + MOVE[move].dur);
    }
  }
  return idle.turn ?? I.state;
}

/* A figure's wires: runs of pieces that join end to start (an edge cut into pieces, a ring), ordered around the
   figure so a redraw sweeps round it. Fixed per state, so worked out once. */
const WIRES = {};
function wiresOf(state) {
  if (WIRES[state]) return WIRES[state];
  const pieces = STATE[state](0, 0, CTX0).s, wires = [];
  let wire = [0];
  for (let k = 1; k < pieces.length; k++) {
    const [x0, y0] = pieces[k - 1][1], [x1, y1] = pieces[k][0];
    if ((x0 - x1) ** 2 + (y0 - y1) ** 2 < 1e-6) wire.push(k); else { wires.push(wire); wire = [k]; }
  }
  wires.push(wire);
  const middle = (w) => { const p = pieces[w[Math.floor(w.length / 2)]]; return Math.atan2((p[0][1] + p[1][1]) / 2 - 60, (p[0][0] + p[1][0]) / 2 - 60); };
  return (WIRES[state] = wires.map((w) => ({ w, key: middle(w) })).sort((a, b) => a.key - b.key).map(({ w }) => w));
}

function makeLayer() {
  const g = document.createElementNS(SVGNS, "g");
  const lines = Array.from({ length: NSEG }, () => {
    const line = g.appendChild(document.createElementNS(SVGNS, "line"));
    line.style.display = "none"; // until the first frame places it
    return line;
  });
  // `was`: what each line and the group were last given, so a frame writes only what changed.
  return { g, lines, order: [], was: lines.map(() => ({ hidden: true })), group: { hidden: false } };
}
const put = (el, was, name, value) => { if (was[name] !== value) { was[name] = value; el.setAttribute(name, value); } };
const hide = (el, was, hidden) => { if (was.hidden !== hidden) { was.hidden = hidden; el.style.display = hidden ? "none" : ""; } };

/* A figure inside a button turns around the button's centre. Perspective can move the bounds of even a
   symmetric shape. Use the whole pose so a wire being drawn or erased does not pull the rest of it along. */
function centeredOffset(pieces) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const [a, b] of pieces) {
    left = Math.min(left, a[0], b[0]);
    right = Math.max(right, a[0], b[0]);
    top = Math.min(top, a[1], b[1]);
    bottom = Math.max(bottom, a[1], b[1]);
  }
  return [60 - (left + right) / 2, 60 - (top + bottom) / 2];
}

/* Paints one figure into a layer. `span(wire, wires, length)` gives the visible part of each wire as
   [from, to] along it; pieces outside are hidden, pieces across an end are trimmed. With no span the whole figure is
   shown; zero-length pieces show as dots only when the frame asks for them (a figure growing from a point). */
function paint(I, layer, state, frame, span, fade) {
  const s = frame.s, pal = PALETTES[I.dark ? "dark" : "light"];
  const loud = I.mono && LOUD.includes(state);
  const base = I.mono && !loud ? null : hexRgb(pal[frame.col]), bg = I.bg || [255, 255, 255];
  const shade = frame.depth && !I.mono && I.bg ? 0.62 : 0;
  let lo = Infinity, hi = -Infinity;
  for (const piece of s) { const d = near(piece); if (d < lo) lo = d; if (d > hi) hi = d; }
  const depth = (i) => (hi > lo ? (near(s[i]) - lo) / (hi - lo) : 1);
  const shown = new Array(NSEG).fill(null);
  if (!span) {
    s.forEach(([p, q], i) => { if (frame.dots || (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > 1e-6) shown[i] = [p[0], p[1], q[0], q[1]]; });
  } else {
    const wires = wiresOf(state);
    wires.forEach((wire, n) => {
      const lengths = wire.map((i) => Math.hypot(s[i][1][0] - s[i][0][0], s[i][1][1] - s[i][0][1]));
      const total = lengths.reduce((a, b) => a + b, 0);
      const [from, to] = span(n, wires.length, total);
      let at = 0;
      wire.forEach((i, k) => {
        const a0 = at, a1 = at + lengths[k];
        at = a1;
        const u0 = Math.max(a0, from), u1 = Math.min(a1, to);
        if (u1 - u0 < 1e-3) return;
        const [p, q] = s[i], len = lengths[k] || 1, t0 = (u0 - a0) / len, t1 = (u1 - a0) / len;
        shown[i] = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0, p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1];
      });
    });
  }
  // Far lines first, so near lines cross over them; reorder the DOM only when the order changes.
  const order = Array.from({ length: NSEG }, (_, i) => i).sort((a, b) => depth(a) - depth(b));
  if (order.some((n, k) => n !== layer.order[k])) { for (const n of order) layer.g.appendChild(layer.lines[n]); layer.order = order; }
  const hideW = (I.mono || I.small) && WHOLE.includes(state);
  const opacity = fade < 0.98 ? fade.toFixed(2) : "1";
  for (let i = 0; i < NSEG; i++) {
    const line = layer.lines[i], v = shown[i], was = layer.was[i];
    if (!v || (hideW && s[i][2])) { hide(line, was, true); continue; }
    hide(line, was, false);
    put(line, was, "x1", v[0].toFixed(2)); put(line, was, "y1", v[1].toFixed(2));
    put(line, was, "x2", v[2].toFixed(2)); put(line, was, "y2", v[3].toFixed(2));
    put(line, was, "stroke", base ? rgbHex(mix(base, bg, (1 - depth(i)) * shade)) : "currentColor");
    put(line, was, "opacity", opacity);
  }
  const [dx, dy] = I.centered ? centeredOffset(s) : [frame.dx || 0, frame.dy || 0];
  put(layer.g, layer.group, "transform", `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
  const sw = frame.sw && frame.sw !== 1 ? (I.width * frame.sw).toFixed(2) : null;
  if (layer.group["stroke-width"] !== sw) {
    layer.group["stroke-width"] = sw;
    if (sw) layer.g.setAttribute("stroke-width", sw); else layer.g.removeAttribute("stroke-width");
  }
  hide(layer.g, layer.group, false);
}

/** A settled frame for recorded states. It uses the live pose and depth shading without joining the animation loop. */
export function drawFigurePose(svg, state, { width = 4, dark = false } = {}) {
  const layer = makeLayer();
  layer.g.setAttribute("stroke-linecap", "round");
  svg.replaceChildren(layer.g);
  const frame = STATE[state](0.6, 0, CTX0);
  paint({ width, dark, bg: resolveBg(svg, "auto") }, layer, state, frame, null, 1);
  layer.g.setAttribute("stroke-width", String(width * (frame.sw ?? 1)));
  svg.dataset.state = state;
}

function step(I, t, still) {
  if (still !== I.still) {
    // Reduced motion uses a fixed clock. Restart elapsed times when switching between the two clocks.
    I.still = still; I.entered = t; I.asked = t; I.mode = null; I.play = null;
    pauseIdle(I, t);
  }
  // Thinking for a while: the octahedron gives way to the body turning in two planes.
  let want = I.state;
  if (!still && I.idle && BODY.includes(want)) want = idlePose(I, t);
  else if (!still && want === "think" && t - I.asked > PONDER_AFTER) want = "ponder";
  if (want !== I.now) {
    const from = I.now;
    I.now = want;
    I.entered = t;
    if (I.play && !BODY.includes(want)) I.play = null; // a move belongs to the body
    if (still) I.mode = null;
    else if (I.mode === "redraw" && t - I.changed < REDRAW_S && family(want) === family(from)) {
      // Mid-redraw to another pose of the same figure: keep drawing, with the new pose.
    } else if ((glides(from, want) || (I.idle && SPIN.includes(from) && BODY.includes(want))) && I.mode !== "redraw") {
      I.mode = "glide"; I.changed = t; I.glideFrom = I.pose.map((piece) => [[...piece[0]], [...piece[1]]]);
    } else {
      // What was being drawn (perhaps half drawn) leaves from where it had got to.
      const drawn = I.mode === "redraw" ? Math.min(1, Math.max(0, (t - I.changed - IN_AT) / (SWEEP_S + IN_S))) : 1;
      I.out = { state: from, drawn }; I.mode = "redraw"; I.changed = t;
    }
    // Work is over: once the body is drawn again, a hop.
    if (!still && from === "work" && want === "rest" && !I.play) I.play = { move: "hop", start: t + (I.mode === "redraw" ? REDRAW_S : 0) };
  }
  const since = t - I.changed;
  if (I.mode && since >= (I.mode === "glide" ? GLIDE_S : REDRAW_S)) { I.mode = null; I.out = null; }
  // How much breath and blink the resting body has: none for a while after grow or unfold, then easing back.
  const calmNow = () => (still || I.calmAt == null ? 1 : sm((t - I.calmAt - SETTLE_HOLD) / SETTLE_EASE));

  // The leaving figure: its wires shrink toward their middles and fade, still moving as it did.
  if (I.mode === "redraw" && I.out && since < OUT_S) {
    const left = I.out.drawn * (1 - easeIn(since / OUT_S));
    paint(I, I.layers.out, I.out.state, STATE[I.out.state](t, 0, { since: t - I.entered, seed: I.seed }), (_, __, total) => [total * (1 - left) / 2, total * (1 + left) / 2], 0.35 + 0.65 * left);
  } else hide(I.layers.out.g, I.layers.out.group, true);

  // A move over the body, once anything being drawn is in place (a move asked for mid-redraw waits for it). A move
  // that never got its turn is let go.
  let frame = null;
  const P = I.play;
  if (P && (still || (P.started == null && t > P.start + REDRAW_S + 0.3))) I.play = null;
  else if (P && t >= P.start && BODY.includes(I.now) && I.mode !== "redraw") {
    P.started ??= t;
    const m = MOVE[P.move], u = t - P.start;
    if (u < m.dur) frame = { ...m.f(u, t, I.seed, calmNow()), dots: m.dots };
    else {
      if (m.settles) I.calmAt = t;
      // Every move ends on the resting pose, so at rest it simply hands over (its lines may be cut differently, but
      // they lie in the same places); over the greeting it glides into that pose.
      I.play = null;
      if (I.now !== "rest") { I.mode = "glide"; I.changed = t; I.glideFrom = I.pose.map((piece) => [[...piece[0]], [...piece[1]]]); }
    }
  }

  // The arriving figure: drawn wire by wire, sweeping round, turning into place as it forms.
  if (!frame) {
    const spin = I.mode === "redraw" ? (1 - easeOut((t - I.changed) / REDRAW_S)) * ENTRY_SPIN : 0;
    let since = t - I.entered;
    if (I.idle?.turn === I.now) {
      // Roll out and back along the same path so the next gesture starts with the cubes already back in place.
      const duration = I.idle.turnSeconds;
      since = duration * (1 - Cs(2 * PI * clamp(since / duration, 0, 1))) / 2;
    }
    frame = STATE[I.now](t, spin, { since, seed: I.seed, calm: calmNow() });
    if (I.mode === "glide") {
      const w = easeInOut((t - I.changed) / GLIDE_S);
      frame = { ...frame, s: frame.s.map((piece, i) => {
        const [a0, b0] = I.glideFrom[i];
        return [[a0[0] + (piece[0][0] - a0[0]) * w, a0[1] + (piece[0][1] - a0[1]) * w], [b0[0] + (piece[1][0] - b0[0]) * w, b0[1] + (piece[1][1] - b0[1]) * w], piece[2], piece[3], piece[4]];
      }) };
    }
  }
  I.pose = frame.s;
  const span = I.mode === "redraw"
    ? (n, count, total) => [0, total * easeOut((t - I.changed - IN_AT - (n / count) * SWEEP_S) / IN_S)]
    : null;
  // The same every frame but the one a state or a move changes on.
  const move = I.play?.started != null ? I.play.move : null, loud = I.mono && LOUD.includes(I.now);
  if (I.said.state !== I.now) { I.said.state = I.now; I.svg.dataset.state = I.now; }
  if (I.said.move !== move) { I.said.move = move; if (move) I.svg.dataset.move = move; else delete I.svg.dataset.move; }
  if (I.said.loud !== loud) { I.said.loud = loud; I.svg.classList.toggle("loud", loud); }
  // Settled in one figure (nothing arriving or leaving, no move), the pose only drifts: a breath, a slow sway. A
  // frame no corner of which is a quarter of a screen pixel from where it was last drawn would look the same, so it
  // is not drawn: at rest that is most of them, and a small figure's breath is a few frames in all. What is on
  // screen is never further than that from the true pose, and anything quicker is drawn the moment it shows.
  const offset = I.centered ? centeredOffset(frame.s) : [frame.dx || 0, frame.dy || 0];
  const settled = !I.mode && !I.play && I.layers.out.group.hidden && !I.fresh && I.drawn?.state === I.now;
  if (settled && drift(I.drawn, frame.s, offset) < I.fine) return;
  I.fresh = false;
  I.drawn = { state: I.now, s: frame.s, offset };
  paint(I, I.layers.in, I.now, frame, span, frame.op ?? 1);
}

/* How far the pose is from the one last drawn, in the 120 box: the corner that moved most, and the whole figure's
   own shift (a breath lifts it). */
function drift(drawn, s, offset) {
  let most = 0;
  for (let i = 0; i < s.length; i++) {
    for (let end = 0; end < 2; end++) {
      const dx = s[i][end][0] - drawn.s[i][end][0], dy = s[i][end][1] - drawn.s[i][end][1], d = dx * dx + dy * dy;
      if (d > most) most = d;
    }
  }
  return Math.sqrt(most) + Math.hypot(offset[0] - drawn.offset[0], offset[1] - drawn.offset[1]);
}
/* A quarter of a screen pixel, in the 120 box, for a figure drawn `px` wide. */
const fineOf = (px) => (px > 0 ? (0.25 * 120) / (px * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1)) : 0.05);

/* How long a figure can go before its next frame, in ms. Slow motion (the body breathing, a shape turning) reads the
   same at 30 frames a second as at 60 and costs half; a change between figures, a move and the shake of an error
   keep every frame. With motion reduced nothing moves, so it is only looked at now and then; a change asked of it
   (setState, play…) is drawn on the next frame whatever this says. */
const QUICK = ["error"];
const SLOW_MS = 1000 / 30, STILL_MS = 500;
const frameGap = (I, still) => (still ? STILL_MS : I.mode || I.play || QUICK.includes(I.now) ? 0 : SLOW_MS);

function frameAll(now) {
  if (!figures.size) { running = false; return; }
  const still = reduced(), t = still ? 0.6 : now / 1000;
  for (const I of figures) {
    // Not on the page, or out of view (scrolled away, in something folded shut): nothing to draw.
    if (!I.svg.isConnected || !I.seen || now < I.due) continue;
    step(I, t, still);
    // A little under the gap, so a frame that comes a touch early is not put off by a whole one.
    I.due = now + frameGap(I, still) - 6;
  }
  requestAnimationFrame(frameAll);
}
const clockNow = () => (reduced() ? 0.6 : (typeof performance === "object" ? performance.now() : Date.now()) / 1000);

/**
 * Animates the figure in an <svg viewBox="0 0 120 120">.
 * width: stroke width in the 120 box (≈ 4 at 100 px+, 5.5 at 36 px, 7 at 18 px).
 * mono: menu-bar style, currentColor except notice/done/error, no depth; small: drop the W edges at small sizes.
 * background: "auto" (nearest ancestor's background), a CSS colour, or null (no depth shading).
 * enter: a move to come in with ("grow": from a point), when the figure starts as the body.
 */
export function createFigure(svg, { state = "rest", width = 4, mono = false, small = false, centered = false, dark = false, background = "auto", enter = null, ambient = false } = {}) {
  const first = STATES.includes(state) ? state : "rest";
  const root = document.createElementNS(SVGNS, "g");
  root.setAttribute("stroke-width", String(width));
  root.setAttribute("stroke-linecap", "round");
  const layers = { out: makeLayer(), in: makeLayer() };
  root.append(layers.out.g, layers.in.g);
  svg.replaceChildren(root);
  const t0 = clockNow();
  const seed = Math.random();
  const I = {
    svg, layers, mono, small, centered, dark, width, state: first, now: first, mode: null, changed: -Infinity, out: null, asked: t0, entered: t0,
    seed, still: reduced(),
    idle: ambient ? { index: Math.floor(seed * IDLE_CUES.length), turn: null, turnSeconds: 5 + seed, nextAt: t0 } : null,
    play: null, pose: STATE[first](0, 0, CTX0).s, glideFrom: null, bg: resolveBg(svg, background),
    due: 0, seen: true, said: {}, drawn: null, fresh: true, fine: fineOf(svg.getBoundingClientRect?.().width ?? 0),
  };
  // How finely it has to be drawn follows the size it is shown at.
  const sized = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => { I.fine = fineOf(entries[entries.length - 1].contentRect.width); I.fresh = true; }) : null;
  sized?.observe(svg);
  // Out of view it is not drawn (frameAll); the clock goes on, so it comes back where it would have been.
  const watch = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => { I.seen = entries[entries.length - 1].isIntersecting; I.due = 0; }) : null;
  watch?.observe(svg);
  pauseIdle(I, t0);
  const play = (move) => {
    if (!MOVE[move] || reduced() || !BODY.includes(I.state)) return false;
    if (move === "unfold" && (I.mono || I.small)) return false; // the net needs room; at small sizes it is a tangle
    const start = clockNow() + (I.idle?.turn ? GLIDE_S : 0);
    pauseIdle(I, start + MOVE[move].dur);
    I.play = { move, start };
    I.due = 0;
    return true;
  };
  if (enter && BODY.includes(first)) play(enter);
  figures.add(I);
  if (!running) { running = true; requestAnimationFrame(frameAll); }
  return {
    get state() { return I.state; },
    setState(next) {
      if (!STATES.includes(next) || next === I.state) return;
      I.state = next; I.asked = clockNow(); I.due = 0;
      if (I.play?.idle) I.play = null;
      pauseIdle(I, I.asked);
    },
    /** Plays a one-shot move over the body (rest or hello). Returns false when it cannot: another figure is showing,
     * motion is reduced, or (unfold) the figure is too small. */
    play,
    setDark(next) { I.dark = !!next; I.bg = resolveBg(svg, background); I.due = 0; I.fresh = true; },
    /** Re-reads the background colour, e.g. after a theme change. */
    refresh() {
      const bg = resolveBg(svg, background);
      if (String(bg) === String(I.bg)) return;
      I.bg = bg; I.due = 0; I.fresh = true;
    },
    destroy() { figures.delete(I); watch?.disconnect(); sized?.disconnect(); svg.replaceChildren(); },
  };
}
