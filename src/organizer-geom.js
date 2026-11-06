/* Ribbed desk organizer v3: per-section heights, split into parts that fit the
   printer plate, joined with sliding dovetails. Every part is a watertight mesh.
   Shared by the 3D viewer page and the STL export so both always match.
   Units: mm. Plan coordinates: u along the length (+u = pen end), v across
   (+v = back, where the books go), h = height. Built Z-up (u, v, h) for STL.

   Plan (from the sketch):        Side view (heights):     Seams (only when split):
     +---------+-------+            books  ███████           S1  along the pen divider
     |  books  |       |            pens   ██████            S2  along the books/post-its divider
     +---------+  pens |            notes  ██
     | post-its|       |
     +---------+-------+

   The model is 2.5D: the plan is cut into faces, each with one top height.
   Vertical walls rise along the outline and wherever neighbouring faces differ
   in height; pockets are holes in their face. Splitting cuts the plan outline
   with a seam polyline (dovetails included), so parts stay printable upright
   with no overhangs and slide together from the top.                          */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrganizerGeom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    L: 200, W: 100,
    pitch: 5.0,        // rib width
    n: 3.0,            // footprint: 2 = ellipse, higher = boxier
    wall: 3.0,         // outer wall at the rib grooves
    divider: 4.5,
    floor: 2.4,        // thinnest floor
    pensLen: 55, pensH: 90, pensDepth: 0,     // depth 0 = full depth
    booksW: 36, booksH: 95, booksDepth: 0,
    notesH: 30, notesDepth: 0,
    cornerR: 6, rimR: 1.0, coveR: 3.0, chamfer: 0.6,
    ledge: 1.4,        // flat strip a lower section keeps at a taller neighbour's divider
    plate: 180,        // square print bed, mm
    split: 'auto',     // 'auto' | '1' | '2' | '3'
    joint: 'dovetail', // 'dovetail' | 'flat'
    gap: 0.15,         // clearance between mating faces
    tabDepth: 3.2, tabNeck: 6, tabAngle: 14, tabChamfer: 0.4
  };
  var CHOICES = { split: ['auto', '1', '2', '3'], joint: ['dovetail', 'flat'] };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function num(x, d) { x = +x; return isFinite(x) ? x : d; }

  function resolveParams(p) {
    var P = {}, k, v;
    p = p || {};
    for (k in DEFAULTS) {
      v = p[k];
      if (CHOICES[k]) P[k] = (v !== undefined && v !== null && CHOICES[k].indexOf(String(v)) >= 0) ? String(v) : DEFAULTS[k];
      else P[k] = (v === undefined || v === null || v === '') ? DEFAULTS[k] : num(v, DEFAULTS[k]);
    }
    P.L = clamp(P.L, 140, 300); P.W = clamp(P.W, 70, 160); if (P.W > P.L) P.W = P.L;
    P.pitch = clamp(P.pitch, 3, 9); P.n = clamp(P.n, 2.2, 6);
    P.wall = clamp(P.wall, 2, 5); P.divider = clamp(P.divider, 2 * P.ledge + 0.6, 10);
    P.plate = clamp(P.plate, 100, 400); P.gap = clamp(P.gap, 0, 0.5);
    P.tabDepth = clamp(P.tabDepth, 1.5, 6); P.tabNeck = clamp(P.tabNeck, 3, 14); P.tabAngle = clamp(P.tabAngle, 5, 25);
    P.ribDepth = 0.32 * P.pitch;
    P.a = P.L / 2 - P.ribDepth; P.b = P.W / 2 - P.ribDepth;
    P.ai = P.a - P.wall; P.bi = P.b - P.wall;
    // A divider that carries a seam is thickened. One part keeps the full-height wall (ownWall + ledge);
    // the other keeps a band at its own height that holds the slots, with 1.6 mm behind them.
    P.skirt = 0.5; P.ownWall = 2.2;
    P.band = (P.joint === 'dovetail' ? P.tabDepth : 0) + P.skirt + 1.6 + P.gap / 2;
    P.seamDivider = Math.max(P.divider, P.band + P.ownWall + P.ledge);
    var Tm = P.seamDivider;
    P.pensLen = clamp(P.pensLen, 25, 2 * P.ai - Tm - 45);
    P.booksW = clamp(P.booksW, 16, 2 * P.bi - Tm - 16);
    P.pensH = clamp(P.pensH, 25, 140); P.booksH = clamp(P.booksH, 25, 140); P.notesH = clamp(P.notesH, 16, 140);
    ['pens', 'books', 'notes'].forEach(function (s) {
      var H = P[s + 'H'], full = H - P.floor, d = P[s + 'Depth'];
      P[s + 'Full'] = !(d > 0) || d >= full - 1e-9;
      P[s + 'Depth'] = P[s + 'Full'] ? full : clamp(d, 8, full);
      P[s + 'Floor'] = H - P[s + 'Depth'];
    });
    P.H = Math.max(P.pensH, P.booksH, P.notesH);
    return P;
  }

  function makeLayout(P, cfg) {
    var e = P.ledge, Hp = P.pensH, Hb = P.booksH, Hn = P.notesH;
    var T1 = cfg.s1 ? P.seamDivider : P.divider, T2 = cfg.s2 ? P.seamDivider : P.divider;
    var x1 = P.ai - P.pensLen - T1 / 2, v2 = P.bi - P.booksW - T2 / 2;
    var Ly = { cfg: cfg, T1: T1, T2: T2, x1: x1, v2: v2, uA: x1 - T1 / 2 + e, uB: x1 + T1 / 2 - e, vA: v2 - T2 / 2 + e, vB: v2 + T2 / 2 - e };
    // A seam runs where a divider's full-height wall meets the band kept by the other side, so no part
    // ever gets a sliver of wall taller than its own section. The owner of the wall is the side whose
    // part grows least above its own rim; its tabs reach into the band and stop at that band's height.
    if (cfg.s1) {
      var Lt = Math.max(0, P.bi - v2), Lb = Math.max(0, P.bi + v2);
      var exP = (Math.max(Hp, Hb) - Hp) * Lt + (Math.max(Hp, Hn) - Hp) * Lb;
      var exR = (Math.max(Hp, Hb) - Hb) * Lt + (Math.max(Hp, Hn) - Hn) * Lb;
      Ly.own1 = exP <= exR ? 'pens' : 'rest';
      if (Ly.own1 === 'pens') { Ly.uA = x1 - T1 / 2 + P.band; Ly.s1u = Ly.uA - P.skirt; Ly.s1dir = -1; }
      else { Ly.uB = x1 + T1 / 2 - P.band; Ly.s1u = Ly.uB + P.skirt; Ly.s1dir = 1; }
    }
    if (cfg.s2) {
      Ly.own2 = Hb >= Hn ? 'books' : 'notes';
      if (Ly.own2 === 'books') { Ly.vA = v2 - T2 / 2 + P.band; Ly.s2v = Ly.vA - P.skirt; Ly.s2dir = -1; }
      else { Ly.vB = v2 + T2 / 2 - P.band; Ly.s2v = Ly.vB + P.skirt; Ly.s2dir = 1; }
    }
    Ly.HC = { P: Hp, D1t: Math.max(Hp, Hb), D1m: Math.max(Hp, Hb, Hn), D1b: Math.max(Hp, Hn), B: Hb, D2: Math.max(Hb, Hn), N: Hn };
    Ly.cellOf = function (u, v) {
      if (u > Ly.uB) return 'P';
      if (u > Ly.uA) return v > Ly.vB ? 'D1t' : (v > Ly.vA ? 'D1m' : 'D1b');
      return v > Ly.vB ? 'B' : (v > Ly.vA ? 'D2' : 'N');
    };
    return Ly;
  }

  /* ---------- footprint curve (superellipse) ---------- */
  function makeBase(a, b, n) {
    var N = 8192, xs = new Float64Array(N), ys = new Float64Array(N), i;
    for (i = 0; i < N; i++) {
      var t = i / N * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      var r = Math.pow(Math.pow(Math.abs(c) / a, n) + Math.pow(Math.abs(s) / b, n), -1 / n);
      xs[i] = r * c; ys[i] = r * s;
    }
    var cum = new Float64Array(N + 1);
    for (i = 0; i < N; i++) { var j = (i + 1) % N; cum[i + 1] = cum[i] + Math.hypot(xs[j] - xs[i], ys[j] - ys[i]); }
    return { xs: xs, ys: ys, cum: cum, N: N, total: cum[N] };
  }
  function baseAt(B, s) {
    s = ((s % B.total) + B.total) % B.total;
    var lo = 0, hi = B.N;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (B.cum[m] <= s) lo = m; else hi = m; }
    var seg = B.cum[lo + 1] - B.cum[lo], f = seg > 0 ? (s - B.cum[lo]) / seg : 0, j = (lo + 1) % B.N;
    return [B.xs[lo] + (B.xs[j] - B.xs[lo]) * f, B.ys[lo] + (B.ys[j] - B.ys[lo]) * f];
  }
  function baseNormal(a, b, n, x, y) {
    var gx = Math.sign(x) * Math.pow(Math.abs(x) / a, n - 1) / a, gy = Math.sign(y) * Math.pow(Math.abs(y) / b, n - 1) / b;
    var l = Math.hypot(gx, gy) || 1;
    return [gx / l, gy / l];
  }
  function baseSDF(a, b, n) {        // approximate signed distance (exact for circles)
    var minab = Math.min(a, b);
    return function (x, y) {
      var ax = Math.abs(x) / a, ay = Math.abs(y) / b, S = Math.pow(ax, n) + Math.pow(ay, n);
      if (S < 1e-12) return -minab;
      var G = Math.pow(S, 1 / n), k = Math.pow(G, 1 - n);
      return (G - 1) / Math.hypot(k * Math.pow(ax, n - 1) / a, k * Math.pow(ay, n - 1) / b);
    };
  }
  function baseV(P, u) { var t = Math.abs(u) / P.a; return t >= 1 ? 0 : P.b * Math.pow(1 - Math.pow(t, P.n), 1 / P.n); }
  function baseU(P, v) { var t = Math.abs(v) / P.b; return t >= 1 ? 0 : P.a * Math.pow(1 - Math.pow(t, P.n), 1 / P.n); }
  function outerProfile(P) {
    var B = makeBase(P.a, P.b, P.n), Nr = Math.max(8, Math.round(B.total / P.pitch));
    if (Nr % 2) Nr++;
    var pitch = B.total / Nr, A = P.ribDepth, segs = 12, g = 0.06, prof = [], i, j, pts = [];
    for (j = 0; j <= segs; j++) { var be = Math.PI * (1 - j / segs); prof.push([0.5 + (0.5 - g) * Math.cos(be), Math.sin(be)]); }
    for (i = 0; i < Nr; i++) for (j = 0; j < prof.length; j++) {
      var q = baseAt(B, (i + prof[j][0]) * pitch), nn = baseNormal(P.a, P.b, P.n, q[0], q[1]), off = A * Math.max(0, prof[j][1]);
      pts.push([q[0] + nn[0] * off, q[1] + nn[1] * off]);
    }
    var tags = pts.map(function (q, k) { return [Math.floor(k / prof.length), k % prof.length]; });
    return { pts: pts, tags: tags, per: prof.length, ribs: Nr, pitch: pitch };
  }

  /* ---------- small 2D helpers ---------- */
  function area2(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]); }
  function segInter(p, q, a, b) {      // p + t(q-p) = a + s(b-a)  ->  [t, s]
    var rx = q[0] - p[0], ry = q[1] - p[1], sx = b[0] - a[0], sy = b[1] - a[1], den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    var ax = a[0] - p[0], ay = a[1] - p[1];
    return [(ax * sy - ay * sx) / den, (ax * ry - ay * rx) / den];
  }
  function unit(dx, dy) { var l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; }
  function ek(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
  function inPoly(x, y, ring, P) {
    var c = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = P[ring[i]], b = P[ring[j]];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function cyc(r, i, j) { var out = []; for (var k = i; ; k = (k + 1) % r.length) { out.push(r[k]); if (k === j) break; } return out; }
  function offsetPoly(pts, dist) {     // dist > 0 = to the left of the direction of travel
    var n = pts.length, N = [], i, out = [];
    if (!dist) return pts.map(function (q) { return [q[0], q[1]]; });
    for (i = 0; i < n - 1; i++) { var u = unit(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); N.push([-u[1], u[0]]); }
    out.push([pts[0][0] + N[0][0] * dist, pts[0][1] + N[0][1] * dist]);
    for (i = 1; i < n - 1; i++) {
      var a1 = [pts[i - 1][0] + N[i - 1][0] * dist, pts[i - 1][1] + N[i - 1][1] * dist], b1 = [pts[i][0] + N[i - 1][0] * dist, pts[i][1] + N[i - 1][1] * dist];
      var a2 = [pts[i][0] + N[i][0] * dist, pts[i][1] + N[i][1] * dist], b2 = [pts[i + 1][0] + N[i][0] * dist, pts[i + 1][1] + N[i][1] * dist];
      var r = segInter(a1, b1, a2, b2);
      out.push(r ? [a1[0] + (b1[0] - a1[0]) * r[0], a1[1] + (b1[1] - a1[1]) * r[0]] : a2);
    }
    out.push([pts[n - 1][0] + N[n - 2][0] * dist, pts[n - 1][1] + N[n - 2][1] * dist]);
    return out;
  }
  function chamferPoly(pts, flags, k) {
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      if (!flags[i]) { out.push(pts[i]); continue; }
      var p = pts[i - 1], c = pts[i], q = pts[i + 1];
      var l1 = Math.hypot(c[0] - p[0], c[1] - p[1]), l2 = Math.hypot(q[0] - c[0], q[1] - c[1]);
      var d1 = unit(c[0] - p[0], c[1] - p[1]), d2 = unit(q[0] - c[0], q[1] - c[1]), k1 = Math.min(k, 0.4 * l1), k2 = Math.min(k, 0.4 * l2);
      out.push([c[0] - d1[0] * k1, c[1] - d1[1] * k1], [c[0] + d2[0] * k2, c[1] + d2[1] * k2]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /* ---------- seams ---------- */
  // Base line along D (from x0 to x1), dovetail tabs bulging toward N by `d`.
  function seamPoly(O, D, N, x0, x1, tabs, d, nw, hw, k) {
    var raw = [[x0, 0]], fl = [false];
    tabs.slice().sort(function (a, b) { return a - b; }).forEach(function (c) {
      raw.push([c - nw, 0], [c - hw, d], [c + hw, d], [c + nw, 0]); fl.push(true, true, true, true);
    });
    raw.push([x1, 0]); fl.push(false);
    return chamferPoly(raw, fl, k).map(function (q) { return [O[0] + D[0] * q[0] + N[0] * q[1], O[1] + D[1] * q[0] + N[1] * q[1]]; });
  }
  function makeSeams(P, Ly) {
    var dt = P.joint === 'dovetail', d = P.tabDepth, nw = P.tabNeck / 2, hw = nw + d * Math.tan(P.tabAngle * Math.PI / 180), k = P.tabChamfer;
    var S = { tabs: { S1: 0, S2: 0 } };
    if (Ly.cfg.s1) {               // runs front -> back (+v); tabs bulge from the wall's owner into the band
      var u0 = Ly.s1u, t1 = [];
      if (dt) {
        var vo = Math.min(baseV(P, u0), baseV(P, u0 + Ly.s1dir * d));
        var r1 = [Ly.vB + hw + 1.2, vo - hw - 2.5], r2 = [-vo + hw + 2.5, Ly.vA - hw - 1.2];
        if (r1[1] >= r1[0]) t1.push((r1[0] + r1[1]) / 2);
        if (r2[1] >= r2[0]) t1.push((r2[0] + r2[1]) / 2);
      }
      S.S1 = seamPoly([u0, 0], [0, 1], [Ly.s1dir, 0], -(P.b + 8), P.b + 8, t1, d, nw, hw, k);
      S.tabs.S1 = t1.length;
    }
    if (Ly.cfg.s2) {               // runs far end -> just past the S1 seam (+u)
      var v0 = Ly.s2v, t2 = [];
      if (dt) {
        var uo = Math.min(baseU(P, v0), baseU(P, v0 + Ly.s2dir * d));
        var lo = -uo + hw + 2.5, hi = Ly.x1 - Ly.T1 / 2 - hw - 1.5;
        if (hi >= lo) {
          var cnt = clamp(Math.floor((hi - lo) / 45) + 1, 1, 3);
          for (var i = 0; i < cnt; i++) t2.push(lo + (hi - lo) * (i + 0.5) / cnt);
        }
      }
      S.S2 = seamPoly([0, v0], [1, 0], [0, Ly.s2dir], -(P.a + 8), Ly.s1u + 1.2, t2, d, nw, hw, k);
      S.tabs.S2 = t2.length;
    }
    return S;
  }
  function partDefs(count) {
    if (count === 1) return [{ id: 'all', name: 'Organizer', cuts: [] }];
    if (count === 2) return [
      { id: 'pens', name: 'Pens', cuts: [['S1', 'right']] },
      { id: 'rest', name: 'Books + post-its', cuts: [['S1', 'left']] }];
    return [
      { id: 'pens', name: 'Pens', cuts: [['S1', 'right']] },
      { id: 'books', name: 'Books', cuts: [['S1', 'left'], ['S2', 'left']] },
      { id: 'notes', name: 'Post-its', cuts: [['S1', 'left'], ['S2', 'right']] }];
  }

  /* ---------- plan: outline, cuts, faces ---------- */
  function makePlan(OUT) {
    var per = OUT.pts, n = per.length, ring = new Array(n), type = new Array(n);
    for (var i = 0; i < n; i++) { ring[i] = i; type[i] = 'per'; }
    return { pts: per.map(function (q) { return [q[0], q[1]]; }), type: type, ring: ring, seam: {}, cdir: {}, edgeOf: {}, reed: OUT.tags.slice(), reedLen: OUT.per };
  }
  function addPt(plan, x, y, type) { plan.pts.push([x, y]); plan.type.push(type); return plan.pts.length - 1; }

  // Cut the outline with an open polyline that enters and leaves it once; keep one side.
  function cutOutline(plan, poly, keep) {
    var o = plan.ring, n = o.length, P = plan.pts, X = [], np = poly.length, k, i, j;
    for (k = 0; k < np - 1; k++) {
      var p = poly[k], q = poly[k + 1];
      var x0 = Math.min(p[0], q[0]) - 1e-7, x1 = Math.max(p[0], q[0]) + 1e-7, y0 = Math.min(p[1], q[1]) - 1e-7, y1 = Math.max(p[1], q[1]) + 1e-7;
      for (i = 0; i < n; i++) {
        var A = P[o[i]], B = P[o[(i + 1) % n]];
        if ((A[0] < x0 && B[0] < x0) || (A[0] > x1 && B[0] > x1) || (A[1] < y0 && B[1] < y0) || (A[1] > y1 && B[1] > y1)) continue;
        var r = segInter(p, q, A, B);
        if (!r) continue;
        var t = r[0], s = r[1];
        if (t < 0 || t > 1 || (t >= 1 && k < np - 2) || s < 0 || s >= 1) continue;
        X.push({ T: k + t, k: k, i: i, s: s, x: p[0] + (q[0] - p[0]) * t, y: p[1] + (q[1] - p[1]) * t });
      }
    }
    if (X.length !== 2) return false;
    X.sort(function (m, w) { return m.T - w.T; });
    var I1 = X[0], I2 = X[1];
    if (I1.i === I2.i) return false;
    function nearV(I) { return [o[I.i], o[(I.i + 1) % n]].some(function (id) { return Math.hypot(P[id][0] - I.x, P[id][1] - I.y) < 2e-3; }); }
    if (nearV(I1) || nearV(I2)) return false;
    var inner = [];
    for (j = Math.ceil(I1.T); j <= Math.floor(I2.T); j++) if (j > I1.T + 1e-9 && j < I2.T - 1e-9) inner.push(poly[j]);
    var cp = [[I1.x, I1.y]].concat(inner, [[I2.x, I2.y]]);
    for (j = 1; j < cp.length; j++) if (Math.hypot(cp[j][0] - cp[j - 1][0], cp[j][1] - cp[j - 1][1]) < 2e-3) return false;
    // commit
    var seam1 = !!plan.seam[ek(o[I1.i], o[(I1.i + 1) % n])], seam2 = !!plan.seam[ek(o[I2.i], o[(I2.i + 1) % n])];
    var m1 = addPt(plan, I1.x, I1.y, seam1 ? 'seam' : 'corner');
    var ids = inner.map(function (q2) { return addPt(plan, q2[0], q2[1], 'seam'); });
    var m2 = addPt(plan, I2.x, I2.y, seam2 ? 'seam' : 'corner');
    var d1 = unit(poly[I1.k + 1][0] - poly[I1.k][0], poly[I1.k + 1][1] - poly[I1.k][1]);
    var d2 = unit(poly[I2.k + 1][0] - poly[I2.k][0], poly[I2.k + 1][1] - poly[I2.k][1]);
    if (!seam1) plan.cdir[m1] = d1;
    if (!seam2) plan.cdir[m2] = [-d2[0], -d2[1]];
    var chain = [m1].concat(ids, [m2]);
    for (j = 0; j < chain.length - 1; j++) plan.seam[ek(chain[j], chain[j + 1])] = true;
    if (seam1) { plan.seam[ek(o[I1.i], m1)] = true; plan.seam[ek(m1, o[(I1.i + 1) % n])] = true; }
    if (seam2) { plan.seam[ek(o[I2.i], m2)] = true; plan.seam[ek(m2, o[(I2.i + 1) % n])] = true; }
    var ring;
    if (keep === 'left') {
      ring = chain.slice();
      for (j = (I2.i + 1) % n; ; j = (j + 1) % n) { ring.push(o[j]); if (j === I1.i) break; }
    } else {
      ring = chain.slice().reverse();
      for (j = (I1.i + 1) % n; ; j = (j + 1) % n) { ring.push(o[j]); if (j === I2.i) break; }
    }
    plan.ring = ring;
    return true;
  }
  function cutWithNudge(plan, poly, keep, half) {
    var base = offsetPoly(poly, keep === 'left' ? half : -half);
    for (var a = 0; a < 14; a++) {
      var dl = a === 0 ? 0 : (a % 2 ? 1 : -1) * Math.ceil(a / 2) * 0.0137;
      if (cutOutline(plan, dl ? offsetPoly(base, dl) : base, keep)) return;
    }
    throw new Error('seam');
  }

  // Split every face the segment p0-p1 crosses. Returns false (no change) on a degenerate hit.
  function splitByLine(plan, p0, p1) {
    var P = plan.pts, faces = plan.faces, seen = {}, edges = [], f, i, k;
    for (f = 0; f < faces.length; f++) {
      var r = faces[f].ring;
      for (i = 0; i < r.length; i++) { var a = r[i], b = r[(i + 1) % r.length], key = ek(a, b); if (!seen[key]) { seen[key] = 1; edges.push([a, b]); } }
    }
    var len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), hits = [];
    var x0 = Math.min(p0[0], p1[0]) - 1e-6, x1 = Math.max(p0[0], p1[0]) + 1e-6, y0 = Math.min(p0[1], p1[1]) - 1e-6, y1 = Math.max(p0[1], p1[1]) + 1e-6;
    for (i = 0; i < edges.length; i++) {
      var A = P[edges[i][0]], B = P[edges[i][1]];
      if ((A[0] < x0 && B[0] < x0) || (A[0] > x1 && B[0] > x1) || (A[1] < y0 && B[1] < y0) || (A[1] > y1 && B[1] > y1)) continue;
      var rr = segInter(p0, p1, A, B);
      if (!rr) {
        var cr = ((A[0] - p0[0]) * (p1[1] - p0[1]) - (A[1] - p0[1]) * (p1[0] - p0[0])) / len;
        if (Math.abs(cr) < 1e-6) return false;
        continue;
      }
      if (rr[0] < -1e-9 || rr[0] > 1 + 1e-9 || rr[1] < -1e-9 || rr[1] > 1 + 1e-9) continue;
      var elen = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (rr[1] * elen < 2e-3 || (1 - rr[1]) * elen < 2e-3) return false;   // too close to a vertex: nudge
      hits.push({ t: rr[0], a: edges[i][0], b: edges[i][1], s: rr[1] });
    }
    if (!hits.length) return true;
    hits.sort(function (m, w) { return m.t - w.t; });
    for (k = 1; k < hits.length; k++) if ((hits[k].t - hits[k - 1].t) * len < 0.02) return false;
    var byEdge = {};
    hits.forEach(function (h) { var key2 = ek(h.a, h.b); (byEdge[key2] = byEdge[key2] || []).push(h); });
    Object.keys(byEdge).forEach(function (key3) {
      var arr = byEdge[key3], a = arr[0].a, b = arr[0].b, cnt = 0, isSeam = !!plan.seam[key3];
      faces.forEach(function (fc) { var rg = fc.ring; for (var q = 0; q < rg.length; q++) { var u = rg[q], w = rg[(q + 1) % rg.length]; if ((u === a && w === b) || (u === b && w === a)) { cnt++; break; } } });
      arr.sort(function (m, w) { return m.s - w.s; });
      var A2 = P[a], B2 = P[b];
      arr.forEach(function (h) { h.id = addPt(plan, A2[0] + (B2[0] - A2[0]) * h.s, A2[1] + (B2[1] - A2[1]) * h.s, cnt === 1 ? (isSeam ? 'seam' : 'per') : 'int'); plan.edgeOf[h.id] = [a, b, h.s]; });
      var ids = arr.map(function (h) { return h.id; });
      if (isSeam) { var ch = [a].concat(ids, [b]); for (var q = 0; q < ch.length - 1; q++) plan.seam[ek(ch[q], ch[q + 1])] = true; }
      faces.forEach(function (fc) {
        var rg = fc.ring;
        for (var q = 0; q < rg.length; q++) {
          var u = rg[q], w = rg[(q + 1) % rg.length];
          if (u === a && w === b) { Array.prototype.splice.apply(rg, [q + 1, 0].concat(ids)); break; }
          if (u === b && w === a) { Array.prototype.splice.apply(rg, [q + 1, 0].concat(ids.slice().reverse())); break; }
        }
      });
    });
    for (k = 0; k < hits.length - 1; k++) {
      var va = hits[k].id, vb = hits[k + 1].id, mx = (P[va][0] + P[vb][0]) / 2, my = (P[va][1] + P[vb][1]) / 2;
      for (f = 0; f < faces.length; f++) {
        var ring = faces[f].ring, ia = ring.indexOf(va), ib = ring.indexOf(vb), L = ring.length;
        if (ia < 0 || ib < 0 || ib === (ia + 1) % L || ia === (ib + 1) % L) continue;
        if (!inPoly(mx, my, ring, P)) continue;
        faces.splice(f, 1, { ring: cyc(ring, ia, ib) }, { ring: cyc(ring, ib, ia) });
        break;
      }
    }
    return true;
  }
  function splitWithNudge(plan, ln) {
    var u = unit(ln[1][0] - ln[0][0], ln[1][1] - ln[0][1]), nx = -u[1], ny = u[0];
    for (var a = 0; a < 14; a++) {
      var dl = a === 0 ? 0 : (a % 2 ? 1 : -1) * Math.ceil(a / 2) * 0.0113;
      if (splitByLine(plan, [ln[0][0] + nx * dl, ln[0][1] + ny * dl], [ln[1][0] + nx * dl, ln[1][1] + ny * dl])) return;
    }
    throw new Error('line');
  }
  function internalLines(P, Ly) {
    var ext = 8;
    return [
      [[Ly.uA, -(P.b + ext)], [Ly.uA, P.b + ext]],
      [[Ly.uB, -(P.b + ext)], [Ly.uB, P.b + ext]],
      [[-(P.a + ext), Ly.vA], [Ly.uB + 0.5, Ly.vA]],
      [[-(P.a + ext), Ly.vB], [Ly.uB + 0.5, Ly.vB]]
    ];
  }

  /* ---------- pockets ---------- */
  function C(ax, op, val) { return { ax: ax, sign: op === '<' ? 1 : -1, val: val }; }
  function pocketSDF(bd, wall, cons, r) {
    return function (u, v) {
      var e = bd(u, v) + wall + r, mx = e, ss = e > 0 ? e * e : 0;
      for (var i = 0; i < cons.length; i++) {
        var c = cons[i], ei = c.sign * ((c.ax === 'u' ? u : v) - c.val) + r;
        if (ei > mx) mx = ei;
        if (ei > 0) ss += ei * ei;
      }
      return Math.sqrt(ss) + Math.min(mx, 0) - r;
    };
  }
  function rayHit(sdf, cx, cy, ux, uy, target) {
    var lo = 0, hi = 400;
    for (var it = 0; it < 30; it++) { var mid = 0.5 * (lo + hi); if (sdf(cx + ux * mid, cy + uy * mid) < target) lo = mid; else hi = mid; }
    var t = 0.5 * (lo + hi);
    return [cx + ux * t, cy + uy * t];
  }
  function pocketRing(pk, delta) {
    var r = [], cx = pk.center[0], cy = pk.center[1];
    for (var j = 0; j < pk.thetas.length; j++) r.push(rayHit(pk.sdf, cx, cy, Math.cos(pk.thetas[j]), Math.sin(pk.thetas[j]), delta));
    return r;
  }
  function pocketSpecs(P, Ly) {
    var t1 = Ly.T1, t2 = Ly.T2, x1 = Ly.x1, v2 = Ly.v2;
    return [
      { id: 'pens', name: 'Pens', cell: 'P', top: P.pensH, floor: P.pensFloor, cons: [C('u', '>', x1 + t1 / 2)] },
      { id: 'books', name: 'Books', cell: 'B', top: P.booksH, floor: P.booksFloor, cons: [C('u', '<', x1 - t1 / 2), C('v', '>', v2 + t2 / 2)] },
      { id: 'notes', name: 'Post-its', cell: 'N', top: P.notesH, floor: P.notesFloor, cons: [C('u', '<', x1 - t1 / 2), C('v', '<', v2 - t2 / 2)] }
    ];
  }
  function preparePocket(P, spec, bd) {
    var sdf = pocketSDF(bd, P.wall, spec.cons, P.cornerR), u0 = -P.a, u1 = P.a, v0 = -P.b, v1 = P.b, i, j;
    spec.cons.forEach(function (c) {
      if (c.ax === 'u') { if (c.sign > 0) u1 = Math.min(u1, c.val); else u0 = Math.max(u0, c.val); }
      else { if (c.sign > 0) v1 = Math.min(v1, c.val); else v0 = Math.max(v0, c.val); }
    });
    var best = Infinity, cx = 0, cy = 0, NX = 60, NY = 36;
    for (i = 0; i < NX; i++) for (j = 0; j < NY; j++) {
      var uu = u0 + (u1 - u0) * (i + 0.5) / NX, vv = v0 + (v1 - v0) * (j + 0.5) / NY, d = sdf(uu, vv);
      if (d < best) { best = d; cx = uu; cy = vv; }
    }
    var step = Math.max((u1 - u0) / NX, (v1 - v0) / NY);
    for (var it = 0; it < 60 && step > 1e-3; it++) {
      var moved = false;
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        var dd = sdf(cx + dx * step, cy + dy * step);
        if (dd < best - 1e-9) { best = dd; cx += dx * step; cy += dy * step; moved = true; }
      }
      if (!moved) step *= 0.5;
    }
    var K = 1440, pts = [];
    for (i = 0; i < K; i++) { var th = i / K * Math.PI * 2; pts.push(rayHit(sdf, cx, cy, Math.cos(th), Math.sin(th), 0)); }
    var cum = [0];
    for (i = 0; i < K; i++) { j = (i + 1) % K; cum.push(cum[i] + Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1])); }
    var per = cum[K], M = Math.round(clamp(per / 0.8, 96, 560)), thetas = [], k = 0;
    for (j = 0; j < M; j++) {
      var s = j * per / M;
      while (k < K - 1 && cum[k + 1] <= s) k++;
      thetas.push((k + (s - cum[k]) / ((cum[k + 1] - cum[k]) || 1)) / K * Math.PI * 2);
    }
    var probe = { sdf: sdf, center: [cx, cy], thetas: thetas }, r0 = pocketRing(probe, 0), keep = [];
    for (j = 0; j < M; j++) {   // drop inner points of straight runs (no zero-area slivers)
      var a = r0[(j - 1 + M) % M], b = r0[(j + 1) % M], m = r0[j], ax = b[0] - a[0], ay = b[1] - a[1];
      if (Math.abs(ax * (m[1] - a[1]) - ay * (m[0] - a[0])) / (Math.hypot(ax, ay) || 1) > 2e-4) keep.push(thetas[j]);
    }
    var ext = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
    pts.forEach(function (q) { ext.u0 = Math.min(ext.u0, q[0]); ext.u1 = Math.max(ext.u1, q[0]); ext.v0 = Math.min(ext.v0, q[1]); ext.v1 = Math.max(ext.v1, q[1]); });
    var mid = [(ext.u0 + ext.u1) / 2, (ext.v0 + ext.v1) / 2];
    if (!(sdf(mid[0], mid[1]) < -P.coveR - 2)) mid = [cx, cy];
    var pk = {
      id: spec.id, name: spec.name, cell: spec.cell, top: spec.top, floor: spec.floor, depth: spec.top - spec.floor, sdf: sdf,
      center: [cx, cy], mid: mid, inradius: -best, thetas: keep, count: keep.length, ext: ext, perimeter: per
    };
    var RS = 6, CS = 6, rim = Math.min(P.rimR, (pk.depth - 2) / 3), cove = Math.min(P.coveR, (pk.depth - 2) / 2), rings = [], q;
    for (q = 0; q <= RS; q++) { var ph = Math.PI / 2 * (1 - q / RS); rings.push({ z: spec.top - rim + rim * Math.sin(ph), xy: pocketRing(pk, rim * (1 - Math.cos(ph))) }); }
    for (q = 0; q <= CS; q++) { var al = -Math.PI / 2 * q / CS; rings.push({ z: spec.floor + cove + cove * Math.sin(al), xy: pocketRing(pk, -cove + cove * Math.cos(al)) }); }
    pk.rings = rings; pk.cove = cove; pk.wallRing = pocketRing(pk, 0);
    return pk;
  }

  /* ---------- triangulation ---------- */
  // Triangulate a polygon with holes; indices refer to [contour..., hole0..., ...]. Points that
  // earcut drops (exactly collinear) are put back by splitting the triangle on their edge.
  function triangulate(THREE, contour, holes, ccw) {
    var all = contour.slice(), rings = [[0, contour.length]];
    holes.forEach(function (h) { rings.push([all.length, h.length]); all = all.concat(h); });
    var V = THREE.Vector2, keepIdx = [], red = [];
    rings.forEach(function (rg) {          // points on a straight run go back in afterwards (no slivers)
      var s0 = rg[0], n = rg[1], kept = [];
      for (var i = 0; i < n; i++) {
        var a = all[s0 + (i - 1 + n) % n], m = all[s0 + i], b = all[s0 + (i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        var dot = (m[0] - a[0]) * (b[0] - a[0]) + (m[1] - a[1]) * (b[1] - a[1]);
        if (L > 0 && Math.abs(area2(a, m, b)) / L < 1e-4 && dot > 0 && dot < L * L) continue;
        kept.push(s0 + i);
      }
      red.push(kept);
    });
    red.forEach(function (k) { keepIdx = keepIdx.concat(k); });
    var toV = function (k) { return k.map(function (gi) { return new V(all[gi][0], all[gi][1]); }); };
    var faces = THREE.ShapeUtils.triangulateShape(toV(red[0]), red.slice(1).map(toV)), tris = [], sum = 0;
    faces.forEach(function (f0) {
      var f = [keepIdx[f0[0]], keepIdx[f0[1]], keepIdx[f0[2]]];
      sum += area2(all[f[0]], all[f[1]], all[f[2]]);
      tris.push(f);
    });
    if (sum < 0) tris.forEach(function (t) { var x = t[1]; t[1] = t[2]; t[2] = x; });   // work in CCW
    var used = new Uint8Array(all.length);
    tris.forEach(function (t) { used[t[0]] = used[t[1]] = used[t[2]] = 1; });
    rings.forEach(function (rg) {
      var start = rg[0], len = rg[1];
      for (var i = 0; i < len; i++) {
        var m = start + i;
        if (used[m]) continue;
        var pa = i, pb = i;
        do { pa = (pa - 1 + len) % len; } while (!used[start + pa] && pa !== i);
        do { pb = (pb + 1) % len; } while (!used[start + pb] && pb !== i);
        var A = start + pa, B = start + pb;
        for (var t = 0; t < tris.length; t++) {
          var T = tris[t], e;
          for (e = 0; e < 3; e++) { var x = T[e], y = T[(e + 1) % 3]; if ((x === A && y === B) || (x === B && y === A)) break; }
          if (e === 3) continue;
          var X = T[e], Y = T[(e + 1) % 3], Z = T[(e + 2) % 3];
          tris[t] = [X, m, Z]; tris.push([m, Y, Z]);
          used[m] = 1;
          break;
        }
      }
    });
    var fixed = {};
    rings.forEach(function (rg) { for (var i = 0; i < rg[1]; i++) { var a = rg[0] + i, b = rg[0] + (i + 1) % rg[1]; fixed[a * 1048576 + b] = fixed[b * 1048576 + a] = 1; } });
    delaunayFlips(tris, all, fixed);
    if (!ccw) tris.forEach(function (t) { var x = t[1]; t[1] = t[2]; t[2] = x; });
    return tris;
  }
  // Lawson flips (boundary edges fixed): removes the long zero-area slivers that collinear
  // rib grooves on flat stretches produce, and evens out the rest of the triangulation.
  function delaunayFlips(tris, all, fixed) {
    var em = new Map(), stack = [], K = 1048576, flips = 0, limit = 40 * tris.length + 100, i, e;
    function key(a, b) { return a * K + b; }
    function third(T, a, b) { for (var q = 0; q < 3; q++) if (T[q] === a && T[(q + 1) % 3] === b) return T[(q + 2) % 3]; return -1; }
    for (i = 0; i < tris.length; i++) for (e = 0; e < 3; e++) {
      var a0 = tris[i][e], b0 = tris[i][(e + 1) % 3];
      em.set(key(a0, b0), i);
      if (!fixed[key(a0, b0)]) stack.push([a0, b0]);
    }
    while (stack.length && flips < limit) {
      var ed = stack.pop(), A = ed[0], B = ed[1], t1 = em.get(key(A, B)), t2 = em.get(key(B, A));
      if (t1 === undefined || t2 === undefined) continue;
      var C = third(tris[t1], A, B), D = third(tris[t2], B, A);
      if (C < 0 || D < 0) continue;
      var pa = all[A], pb = all[B], pc = all[C], pd = all[D];
      var adx = pa[0] - pd[0], ady = pa[1] - pd[1], bdx = pb[0] - pd[0], bdy = pb[1] - pd[1], cdx = pc[0] - pd[0], cdy = pc[1] - pd[1];
      var det = (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) + (bdx * bdx + bdy * bdy) * (cdx * ady - adx * cdy) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
      if (!(det > 1e-6)) continue;
      if (area2(pa, pd, pc) <= 1e-12 || area2(pd, pb, pc) <= 1e-12) continue;
      em.delete(key(A, B)); em.delete(key(B, A));
      tris[t1] = [A, D, C]; tris[t2] = [D, B, C];
      em.set(key(A, D), t1); em.set(key(D, C), t1); em.set(key(C, A), t1);
      em.set(key(D, B), t2); em.set(key(B, C), t2); em.set(key(C, D), t2);
      [[A, D], [D, B], [B, C], [C, A]].forEach(function (q) { if (!fixed[key(q[0], q[1])]) stack.push(q); });
      flips++;
    }
  }
  // Cap faces that run along the ribs: fan each whole rib bump off first (it is convex), so the
  // rest of the face only sees the rib grooves, which line up on flat stretches and are then
  // handled as collinear points instead of turning into zero-area triangles.
  function triangulateRing(THREE, plan, ids, xy, holes, ccw) {
    var n = ids.length, R = plan.reedLen, tags = plan.reed, drop = new Uint8Array(n), fans = [], i, k;
    for (i = 0; i < n; i++) {
      var t0 = tags[ids[i]];
      if (!t0 || t0[1] !== 0 || n < R + 3) continue;
      var idx = [i], ok = true;
      for (k = 1; k < R; k++) { var tk = tags[ids[(i + k) % n]]; if (!tk || tk[0] !== t0[0] || tk[1] !== k) { ok = false; break; } idx.push((i + k) % n); }
      if (!ok) continue;
      for (k = 0; k < R && ok; k++) if (area2(xy[idx[(k + R - 1) % R]], xy[idx[k]], xy[idx[(k + 1) % R]]) <= 1e-10) ok = false;
      if (!ok) continue;
      for (k = 1; k < R - 1; k++) { drop[idx[k]] = 1; fans.push(ccw ? [idx[0], idx[k], idx[k + 1]] : [idx[0], idx[k + 1], idx[k]]); }
    }
    var keep = [];
    for (i = 0; i < n; i++) if (!drop[i]) keep.push(i);
    var core = triangulate(THREE, keep.map(function (j) { return xy[j]; }), holes, ccw), m = keep.length;
    return fans.concat(core.map(function (t) { return t.map(function (j) { return j < m ? keep[j] : n + (j - m); }); }));
  }
  function samplePoint(THREE, xy) {
    var V = THREE.Vector2, f = THREE.ShapeUtils.triangulateShape(xy.map(function (q) { return new V(q[0], q[1]); }), []), best = -1, pt = xy[0];
    f.forEach(function (t) {
      var a = xy[t[0]], b = xy[t[1]], c = xy[t[2]], ar = Math.abs(area2(a, b, c));
      if (ar > best) { best = ar; pt = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]; }
    });
    return pt;
  }

  /* ---------- mesh from plan ---------- */
  function buildMesh(THREE, P, plan) {
    var pts = plan.pts, faces = plan.faces, ch = P.chamfer, emap = {}, i;
    faces.forEach(function (f, fi) { var r = f.ring; for (var q = 0; q < r.length; q++) emap[r[q] + '>' + r[(q + 1) % r.length]] = fi; });
    var nextO = {}, outE = [];
    faces.forEach(function (f, fi) {
      var r = f.ring;
      for (var q = 0; q < r.length; q++) { var a = r[q], b = r[(q + 1) % r.length]; if (!((b + '>' + a) in emap)) { nextO[a] = b; outE.push([a, b, fi]); } }
    });
    var ring = [outE[0][0]];
    for (var c = nextO[ring[0]]; c !== ring[0]; c = nextO[c]) { ring.push(c); if (ring.length > outE.length + 1 || c === undefined) throw new Error('outline'); }
    if (ring.length !== outE.length) throw new Error('outline loops');
    function isSeam(a, b) { return !!plan.seam[ek(a, b)]; }
    var hs = [];
    function addH(id, h) { var a = hs[id] || (hs[id] = []); if (a.indexOf(h) < 0) a.push(h); }
    faces.forEach(function (f) { f.ring.forEach(function (id) { addH(id, f.h); }); });
    outE.forEach(function (e) { var z = isSeam(e[0], e[1]) ? 0 : ch; addH(e[0], z); addH(e[1], z); });
    hs.forEach(function (a) { if (a) a.sort(function (x, y) { return x - y; }); });
    var pos = [], tri = [], vmap = [], bot = [];
    function newV(x, y, z) { pos.push(x, y, z); return pos.length / 3 - 1; }
    function vid(id, z) {
      if (z === 0 && bot[id] !== undefined) return bot[id];
      var m = vmap[id] || (vmap[id] = {});
      if (!(z in m)) m[z] = newV(pts[id][0], pts[id][1], z);
      return m[z];
    }
    function chain(id, lo, hi) { return hs[id].filter(function (h) { return h >= lo - 1e-9 && h <= hi + 1e-9; }).map(function (h) { return vid(id, h); }); }
    function zOf(v) { return pos[3 * v + 2]; }
    function zipper(A, B) {        // vertical strip; outward = right-hand side of A -> B
      var a = 0, b = 0;
      while (a < A.length - 1 || b < B.length - 1) {
        var adv = a >= A.length - 1 ? 1 : (b >= B.length - 1 ? 0 : (zOf(B[b + 1]) <= zOf(A[a + 1]) ? 1 : 0));
        if (adv) { tri.push(A[a], B[b], B[b + 1]); b++; } else { tri.push(A[a], B[b], A[a + 1]); a++; }
      }
    }
    // bottom ring: perimeter points are chamfered inward; seam corners slide along their seam
    var R = ring.length, corners = [], segs = [];
    ring.forEach(function (id7) { if (plan.type[id7] === 'corner') corners.push(pts[id7]); });
    Object.keys(plan.seam).forEach(function (k7) { var ab = k7.split('_'); segs.push([pts[+ab[0]], pts[+ab[1]]]); });
    function segDist(q, a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2, 0, 1) : 0;
      return Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t);
    }
    function chamferScale(id8) {   // < 1 within 2 mm of a seam, so the inset never crosses it
      var q = pts[id8], near = false;
      for (var c = 0; c < corners.length; c++) if (Math.hypot(q[0] - corners[c][0], q[1] - corners[c][1]) < 4) { near = true; break; }
      if (!near) return 1;
      var d = Infinity;
      for (var k = 0; k < segs.length; k++) d = Math.min(d, segDist(q, segs[k][0], segs[k][1]));
      return clamp((d - 0.3) / 1.5, 0, 1);
    }
    function inserted(id5) { return plan.type[id5] === 'per' && plan.edgeOf[id5] !== undefined; }
    for (i = 0; i < R; i++) {
      var id = ring[i], tp = plan.type[id];
      if ((tp !== 'per' && tp !== 'corner') || inserted(id)) continue;
      var prev = ring[(i - 1 + R) % R], next = ring[(i + 1) % R];
      if (tp === 'per') {
        var pi = i, ni = i;
        do { pi = (pi - 1 + R) % R; } while (inserted(ring[pi]));
        do { ni = (ni + 1) % R; } while (inserted(ring[ni]));
        prev = ring[pi]; next = ring[ni];
        var nn = unit(pts[next][1] - pts[prev][1], -(pts[next][0] - pts[prev][0])), sc = chamferScale(id);
        bot[id] = newV(pts[id][0] - nn[0] * ch * sc, pts[id][1] - nn[1] * ch * sc, 0);
      } else bot[id] = newV(pts[id][0], pts[id][1], 0);   // seam corner: the chamfer fades out before the seam
    }
    ring.filter(inserted).sort(function (x, y) { return x - y; }).forEach(function (id6) {
      var e = plan.edgeOf[id6], A = bot[e[0]], B = bot[e[1]], s = e[2];
      bot[id6] = newV(pos[3 * A] + (pos[3 * B] - pos[3 * A]) * s, pos[3 * A + 1] + (pos[3 * B + 1] - pos[3 * A + 1]) * s, 0);
    });
    var bids = ring.map(function (id2) { return bot[id2] !== undefined ? bot[id2] : vid(id2, 0); });
    var bxy = bids.map(function (v) { return [pos[3 * v], pos[3 * v + 1]]; });
    triangulateRing(THREE, plan, ring, bxy, [], false).forEach(function (t) { tri.push(bids[t[0]], bids[t[1]], bids[t[2]]); });
    // outline walls
    outE.forEach(function (e) {
      var a = e[0], b = e[1], h = faces[e[2]].h;
      if (isSeam(a, b)) zipper(chain(a, 0, h), chain(b, 0, h));
      else {
        var ca = vid(a, ch), cb = vid(b, ch);
        tri.push(bot[a], bot[b], cb, bot[a], cb, ca);
        zipper(chain(a, ch, h), chain(b, ch, h));
      }
    });
    // steps between faces of different height
    var done = {};
    faces.forEach(function (f) {
      var r = f.ring;
      for (var q = 0; q < r.length; q++) {
        var a = r[q], b = r[(q + 1) % r.length], g = emap[b + '>' + a];
        if (g === undefined) continue;
        var key = ek(a, b);
        if (done[key]) continue;
        done[key] = 1;
        var hf = f.h, hg = faces[g].h;
        if (hf === hg) continue;
        var lo = Math.min(hf, hg), hi = Math.max(hf, hg);
        if (hf > hg) zipper(chain(a, lo, hi), chain(b, lo, hi)); else zipper(chain(b, lo, hi), chain(a, lo, hi));
      }
    });
    // tops, with the compartments as holes
    faces.forEach(function (f) {
      var holes = [], holeIds = [];
      if (f.pocket) {
        var pk = f.pocket, rings = pk.rings.map(function (rg) { return { ids: rg.xy.map(function (q) { return newV(q[0], q[1], rg.z); }), xy: rg.xy }; }), M = pk.count, q, a;
        for (q = 0; q < rings.length - 1; q++) {
          var lo = rings[q + 1].ids, hi = rings[q].ids;
          for (a = 0; a < M; a++) { var b = (a + 1) % M; tri.push(lo[a], hi[b], lo[b], lo[a], hi[a], hi[b]); }
        }
        var fl = rings[rings.length - 1].ids, ctr = newV(pk.center[0], pk.center[1], pk.floor);
        for (q = 0; q < M; q++) tri.push(ctr, fl[q], fl[(q + 1) % M]);
        holes.push(rings[0].xy); holeIds = rings[0].ids;
      }
      var vids = f.ring.map(function (id3) { return vid(id3, f.h); }), map = vids.concat(holeIds);
      triangulateRing(THREE, plan, f.ring, f.ring.map(function (id3) { return pts[id3]; }), holes, true).forEach(function (t) { tri.push(map[t[0]], map[t[1]], map[t[2]]); });
    });
    return { positions: Float32Array.from(pos), indices: Uint32Array.from(tri), outline: ring.map(function (id4) { return pts[id4]; }) };
  }

  /* ---------- printer fit (square bed, best rotation) ---------- */
  function bedFit(pts, bed) {
    var best = null, zero = null, step = Math.max(1, Math.floor(pts.length / 700));
    for (var deg = 0; deg <= 90; deg += 1) {
      var t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (var k = 0; k < pts.length; k += step) {
        var x = pts[k][0] * c - pts[k][1] * s, y = pts[k][0] * s + pts[k][1] * c;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      var rec = { angle: deg, size: Math.max(x1 - x0, y1 - y0), w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
      if (deg === 0) zero = rec;
      if (!best || rec.size < best.size - 1e-9) best = rec;
    }
    var pick = zero.size <= bed - 2 ? zero : best;
    pick.bed = bed; pick.fits = pick.size <= bed - 2;
    return pick;
  }

  /* ---------- planning: how many parts ---------- */
  function analyze(params, OUT) {
    var P = resolveParams(params);
    OUT = OUT || outerProfile(P);
    function config(count) {
      var cfg = { s1: count >= 2, s2: count >= 3 }, Ly = makeLayout(P, cfg), seams = makeSeams(P, Ly);
      var parts = partDefs(count).map(function (d) {
        var plan = makePlan(OUT);
        d.cuts.forEach(function (c) { cutWithNudge(plan, seams[c[0]], c[1], P.gap / 2); });
        var outline = plan.ring.map(function (id) { return plan.pts[id]; });
        return { id: d.id, name: d.name, plan: plan, outline: outline, fit: bedFit(outline, P.plate) };
      });
      return { count: count, cfg: cfg, Ly: Ly, seams: seams, parts: parts, fitsAll: parts.every(function (d) { return d.fit.fits; }) };
    }
    var choice;
    if (P.split === 'auto') {
      choice = config(1);
      if (!choice.fitsAll) { choice = config(2); if (!choice.fitsAll) choice = config(3); }
    } else choice = config(+P.split);
    return { P: P, OUT: OUT, choice: choice };
  }

  /* ---------- the model ---------- */
  function build(THREE, params) {
    var A = analyze(params), P = A.P, ch = A.choice, Ly = ch.Ly, bd = baseSDF(P.a, P.b, P.n);
    var pockets = pocketSpecs(P, Ly).map(function (sp) { return preparePocket(P, sp, bd); });
    var lines = internalLines(P, Ly), total = 0;
    var parts = ch.parts.map(function (d) {
      var plan = d.plan;
      plan.faces = [{ ring: plan.ring.slice() }];
      lines.forEach(function (ln) { splitWithNudge(plan, ln); });
      plan.faces.forEach(function (f) {
        var sp = samplePoint(THREE, f.ring.map(function (id) { return plan.pts[id]; }));
        f.cell = Ly.cellOf(sp[0], sp[1]); f.h = Ly.HC[f.cell];
      });
      var mine = [];
      pockets.forEach(function (pk) {
        for (var i = 0; i < plan.faces.length; i++) {
          if (!inPoly(pk.center[0], pk.center[1], plan.faces[i].ring, plan.pts)) continue;
          if (plan.faces[i].cell !== pk.cell) throw new Error('pocket');
          plan.faces[i].pocket = pk; mine.push(pk.id); break;
        }
      });
      var m = buildMesh(THREE, P, plan), cx = 0, cy = 0;
      d.outline.forEach(function (q) { cx += q[0]; cy += q[1]; });
      cx /= d.outline.length; cy /= d.outline.length;
      total += m.indices.length / 3;
      var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      d.outline.forEach(function (q) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); });
      var hmax = 0;
      plan.faces.forEach(function (f) { hmax = Math.max(hmax, f.h); });
      return {
        id: d.id, name: d.name, positions: m.positions, indices: m.indices, outline: d.outline, fit: d.fit, pockets: mine,
        centroid: [cx, cy], size: { L: u1 - u0, W: v1 - v0, H: hmax }, triangles: m.indices.length / 3,
        plan: params && params.debug ? plan : undefined
      };
    });
    if (parts.length > 1) parts.forEach(function (pt) { var u = unit(pt.centroid[0], pt.centroid[1]); pt.explode = [u[0] * 14, u[1] * 14]; });
    else parts[0].explode = [0, 0];
    var u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    A.OUT.pts.forEach(function (q) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); w0 = Math.min(w0, q[1]); w1 = Math.max(w1, q[1]); });
    return {
      params: P, layout: Ly, count: ch.count, fitsAll: ch.fitsAll, tabs: ch.seams.tabs,
      parts: parts, pockets: pockets, outline: A.OUT.pts,
      positions: parts[0].positions, indices: parts[0].indices,
      size: { L: u1 - u0, W: w1 - w0, H: P.H },
      fit: bedFit(A.OUT.pts, P.plate),
      ribs: A.OUT.ribs, ribPitch: A.OUT.pitch, triangles: total,
      bookRun: function (thick) { return floorRun(P, Ly, thick); }
    };
  }

  /* ---------- notebooks: does one stand in the book slot? ---------- */
  // Longest straight run of flat floor (clear of the cove) a notebook of this thickness can stand on.
  function floorRun(P, Ly, thick) {
    var sdf = pocketSDF(baseSDF(P.a, P.b, P.n), P.wall, [C('u', '<', Ly.x1 - Ly.T1 / 2), C('v', '>', Ly.v2 + Ly.T2 / 2)], P.cornerR);
    var m = P.coveR, best = { run: 0, uc: 0, v: Ly.v2 + Ly.T2 / 2 + m }, st = 0.5;
    var vlo = Ly.v2 + Ly.T2 / 2, vhi = P.bi, ulo = -P.a, uhi = Ly.x1 - Ly.T1 / 2;
    for (var v = vlo; v + thick <= vhi + 1e-9; v += st) {
      var run = 0;
      for (var u = ulo; u <= uhi; u += st) {
        if (sdf(u, v) < -m && sdf(u, v + thick) < -m) {
          run += st;
          if (run > best.run) best = { run: run, uc: u - run / 2 + st / 2, v: v };
        } else run = 0;
      }
    }
    best.flatWidth = (P.bi - (Ly.v2 + Ly.T2 / 2)) - 2 * m;
    return best;
  }
  function notebookFit(params, nb) {
    var A = analyze(params), r = floorRun(A.P, A.choice.Ly, nb.t);
    return { fits: r.run >= nb.w + 2, run: r.run, need: nb.w + 2, flatWidth: r.flatWidth, tooThick: r.flatWidth < nb.t + 1 };
  }
  // Grow the book slot (width first, then overall length) until the notebook stands in it.
  function fitNotebook(params, nb) {
    var p = {}, k;
    for (k in params) p[k] = params[k];
    var P0 = resolveParams(p), needW = Math.ceil(nb.t + 4 + 2 * P0.coveR), changed = [];
    if (P0.booksW < needW) {
      p.booksW = needW; changed.push('booksW');
      var P1 = resolveParams(p);
      if (P1.booksW < needW) { p.W = Math.min(160, Math.ceil(P0.W + (needW - P1.booksW) + 2)); changed.push('W'); }
    }
    var need = nb.w + 2;
    function runAt(L) { p.L = L; var A = analyze(p); return floorRun(A.P, A.choice.Ly, nb.t).run; }
    var L0 = resolveParams(p).L;
    if (runAt(L0) >= need) { p.L = L0; return { ok: true, params: p, changed: changed }; }
    if (runAt(300) < need) { p.L = L0; return { ok: false, params: p, changed: changed }; }
    var lo = L0, hi = 300;
    while (hi - lo > 1) { var mid = Math.round((lo + hi) / 2); if (runAt(mid) >= need) hi = mid; else lo = mid; }
    var L = hi;
    while (L < 300 && runAt(L) < need) L++;
    p.L = L; changed.push('L');
    return { ok: true, params: p, changed: changed };
  }

  /* ---------- STL ---------- */
  function placed(part) {        // rotate onto the plate the way it fits, centred on the origin
    var f = part.fit, src = part.positions;
    if (!f) return src;
    var t = f.angle * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), out = new Float32Array(src.length);
    for (var i = 0; i < src.length; i += 3) {
      var x = src[i], y = src[i + 1];
      out[i] = x * c - y * s - f.cx; out[i + 1] = x * s + y * c - f.cy; out[i + 2] = src[i + 2];
    }
    return out;
  }
  function toSTL(model, opts) {
    var p = opts && opts.place ? placed(model) : model.positions, ix = model.indices, nt = ix.length / 3;
    var buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf), o = 84, t2;
    var head = 'Ribbed desk organizer (mm)';
    for (t2 = 0; t2 < head.length; t2++) dv.setUint8(t2, head.charCodeAt(t2));
    dv.setUint32(80, nt, true);
    for (t2 = 0; t2 < nt; t2++) {
      var a = ix[3 * t2] * 3, b = ix[3 * t2 + 1] * 3, c = ix[3 * t2 + 2] * 3;
      var e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      var e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
      [a, b, c].forEach(function (q) { dv.setFloat32(o, p[q], true); dv.setFloat32(o + 4, p[q + 1], true); dv.setFloat32(o + 8, p[q + 2], true); o += 12; });
      dv.setUint16(o, 0, true); o += 2;
    }
    return new Uint8Array(buf);
  }

  /* ---------- minimal ZIP (stored) so the STLs can travel as one allowed download ---------- */
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(d) { var c = 0xFFFFFFFF; for (var i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function utf8(s) { if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s); var a = unescape(encodeURIComponent(s)), u = new Uint8Array(a.length); for (var i = 0; i < a.length; i++) u[i] = a.charCodeAt(i); return u; }
  function zip(files, date) {
    date = date || new Date();
    var dt = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF;
    var dd = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data, crc = crc32(data);
      var h = new Uint8Array(30 + name.length), v = new DataView(h.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
      v.setUint16(10, dt, true); v.setUint16(12, dd, true); v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
      h.set(name, 30);
      var c = new Uint8Array(46 + name.length), w = new DataView(c.buffer);
      w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true);
      w.setUint16(12, dt, true); w.setUint16(14, dd, true); w.setUint32(16, crc, true); w.setUint32(20, data.length, true); w.setUint32(24, data.length, true);
      w.setUint16(28, name.length, true); w.setUint32(42, offset, true);
      c.set(name, 46);
      parts.push(h, data); central.push(c); offset += h.length + data.length;
    });
    var csize = central.reduce(function (s, c) { return s + c.length; }, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, csize, true); ev.setUint32(16, offset, true);
    var out = new Uint8Array(offset + csize + 22), o = 0;
    parts.concat(central, [end]).forEach(function (u) { out.set(u, o); o += u.length; });
    return out;
  }

  return {
    DEFAULTS: DEFAULTS, resolveParams: resolveParams, analyze: analyze, build: build,
    notebookFit: notebookFit, fitNotebook: fitNotebook, toSTL: toSTL, zip: zip,
    _internals: { triangulate: triangulate, triangulateRing: triangulateRing, outerProfile: outerProfile, resolveParams: resolveParams }
  };
});
