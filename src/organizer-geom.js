/* Ribbed desk organizer v2: stepped, per-section heights, watertight mesh.
   Shared by the 3D viewer page and the STL export so both always match.
   Units: mm. Plan coordinates: u along the length (+u = pen end), v across
   (+v = back, where the books go), h = height. Built Z-up (u, v, h) for STL.

   Plan (from the sketch):        Side view (heights):
     +---------+-------+            books  ███████
     |  books  |       |            pens   ██████
     +---------+  pens |            notes  ██
     | post-its|       |
     +---------+-------+                                                      */
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
    ledge: 1.4         // flat strip a lower section keeps at a taller neighbour's divider
  };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function num(x, d) { x = +x; return isFinite(x) ? x : d; }

  function resolveParams(p) {
    var P = {}, k;
    for (k in DEFAULTS) P[k] = DEFAULTS[k];
    for (k in (p || {})) if (p[k] !== undefined && p[k] !== null && k in DEFAULTS) P[k] = num(p[k], DEFAULTS[k]);
    P.L = clamp(P.L, 140, 240); P.W = clamp(P.W, 70, 140); if (P.W > P.L) P.W = P.L;
    P.pitch = clamp(P.pitch, 3, 9); P.n = clamp(P.n, 2.2, 6);
    P.wall = clamp(P.wall, 2, 5); P.divider = clamp(P.divider, 2 * P.ledge + 0.6, 8);
    P.ribDepth = 0.32 * P.pitch;
    P.a = P.L / 2 - P.ribDepth; P.b = P.W / 2 - P.ribDepth;
    P.ai = P.a - P.wall; P.bi = P.b - P.wall;
    P.pensLen = clamp(P.pensLen, 25, 2 * P.ai - P.divider - 45);
    P.booksW = clamp(P.booksW, 16, 2 * P.bi - P.divider - 16);
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
  function outerProfile(P) {
    var B = makeBase(P.a, P.b, P.n), Nr = Math.max(8, Math.round(B.total / P.pitch));
    if (Nr % 2) Nr++;
    var pitch = B.total / Nr, A = P.ribDepth, segs = 12, g = 0.06, prof = [], i, j, pts = [];
    for (j = 0; j <= segs; j++) { var be = Math.PI * (1 - j / segs); prof.push([0.5 + (0.5 - g) * Math.cos(be), Math.sin(be)]); }
    for (i = 0; i < Nr; i++) for (j = 0; j < prof.length; j++) {
      var q = baseAt(B, (i + prof[j][0]) * pitch), nn = baseNormal(P.a, P.b, P.n, q[0], q[1]), off = A * Math.max(0, prof[j][1]);
      pts.push([q[0] + nn[0] * off, q[1] + nn[1] * off]);
    }
    return { pts: pts, ribs: Nr, pitch: pitch };
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
      var a = r0[(j - 1 + M) % M], b = r0[(j + 1) % M], m = r0[j];
      var ax = b[0] - a[0], ay = b[1] - a[1];
      if (Math.abs(ax * (m[1] - a[1]) - ay * (m[0] - a[0])) / (Math.hypot(ax, ay) || 1) > 2e-4) keep.push(thetas[j]);
    }
    var ext = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
    pts.forEach(function (q) { ext.u0 = Math.min(ext.u0, q[0]); ext.u1 = Math.max(ext.u1, q[0]); ext.v0 = Math.min(ext.v0, q[1]); ext.v1 = Math.max(ext.v1, q[1]); });
    var mid = [(ext.u0 + ext.u1) / 2, (ext.v0 + ext.v1) / 2];
    if (!(sdf(mid[0], mid[1]) < -P.coveR - 2)) mid = [cx, cy];
    return {
      id: spec.id, name: spec.name, top: spec.top, floor: spec.floor, depth: spec.top - spec.floor, sdf: sdf,
      center: [cx, cy], mid: mid, inradius: -best, thetas: keep, ext: ext, perimeter: per
    };
  }

  /* ---------- triangulation helpers ---------- */
  function area2(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]); }
  // triangulate a polygon (point list) with holes; returns triangles as index triplets into
  // [contour..., hole0..., hole1...] with the requested winding. Points earcut drops (exactly
  // collinear) are put back by splitting the triangle on their edge, so no T-junctions remain.
  function triangulate(THREE, contour, holes, ccw) {
    var all = contour.slice(), rings = [[0, contour.length]];
    holes.forEach(function (h) { rings.push([all.length, h.length]); all = all.concat(h); });
    var V = THREE.Vector2, toV = function (r) { return r.map(function (q) { return new V(q[0], q[1]); }); };
    var faces = THREE.ShapeUtils.triangulateShape(toV(contour), holes.map(toV)), tris = [];
    faces.forEach(function (f) {
      var a = f[0], b = f[1], c = f[2];
      if ((area2(all[a], all[b], all[c]) > 0) !== ccw) { var t = b; b = c; c = t; }
      tris.push([a, b, c]);
    });
    var used = new Uint8Array(all.length);
    tris.forEach(function (t) { used[t[0]] = used[t[1]] = used[t[2]] = 1; });
    rings.forEach(function (rg) {
      var start = rg[0], len = rg[1], i;
      for (i = 0; i < len; i++) {
        var m = start + i;
        if (used[m]) continue;
        var pa = i, pb = i;
        do { pa = (pa - 1 + len) % len; } while (!used[start + pa] && pa !== i);
        do { pb = (pb + 1) % len; } while (!used[start + pb] && pb !== i);
        var A = start + pa, B = start + pb;
        for (var t = 0; t < tris.length; t++) {
          var T = tris[t], e;
          for (e = 0; e < 3; e++) {
            var x = T[e], y = T[(e + 1) % 3];
            if ((x === A && y === B) || (x === B && y === A)) break;
          }
          if (e === 3) continue;
          var X = T[e], Y = T[(e + 1) % 3], Z = T[(e + 2) % 3];
          tris[t] = [X, m, Z]; tris.push([m, Y, Z]);
          used[m] = 1;
          break;
        }
      }
    });
    return tris;
  }

  /* ---------- printer fit (square bed, best rotation) ---------- */
  function bedFit(pts, bed) {
    var best = { angle: 0, size: Infinity };
    for (var deg = 0; deg <= 90; deg += 0.5) {
      var t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (var k = 0; k < pts.length; k++) {
        var x = pts[k][0] * c - pts[k][1] * s, y = pts[k][0] * s + pts[k][1] * c;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      var sz = Math.max(x1 - x0, y1 - y0);
      if (sz < best.size - 1e-9) best = { angle: deg, size: sz };
    }
    best.bed = bed; best.fits = best.size <= bed - 2;
    return best;
  }

  /* ---------- the model ---------- */
  function build(THREE, params) {
    var P = resolveParams(params), t = P.divider, e = P.ledge;
    var x1 = P.ai - P.pensLen - t / 2, v2 = P.bi - P.booksW - t / 2;
    var uA = x1 - t / 2 + e, uB = x1 + t / 2 - e, vA = v2 - t / 2 + e, vB = v2 + t / 2 - e;
    var Hp = P.pensH, Hb = P.booksH, Hn = P.notesH;
    var HC = { P: Hp, D1t: Math.max(Hp, Hb), D1m: Math.max(Hp, Hb, Hn), D1b: Math.max(Hp, Hn), B: Hb, D2: Math.max(Hb, Hn), N: Hn };
    function cellOf(u, v) {
      if (u > uB) return 'P';
      if (u > uA) return v > vB ? 'D1t' : (v > vA ? 'D1m' : 'D1b');
      return v > vB ? 'B' : (v > vA ? 'D2' : 'N');
    }
    var RANK = { P: 0, D1t: 1, D1m: 1, D1b: 1, B: 2, D2: 2, N: 2 }, VR = { D1t: 2, B: 2, D1m: 1, D2: 1, D1b: 0, N: 0 };

    // perimeter with the six crossing points inserted (exact coordinates on the break lines)
    var OUT = outerProfile(P), raw = OUT.pts, per = [], i, j;
    for (i = 0; i < raw.length; i++) {
      var p = raw[i], q = raw[(i + 1) % raw.length], cp = cellOf(p[0], p[1]), cq = cellOf(q[0], q[1]);
      per.push({ x: p[0], y: p[1], cell: cp });
      if (cp === cq) continue;
      var X;
      if (RANK[cp] !== RANK[cq]) {
        var cu = (RANK[cp] === 0 || RANK[cq] === 0) ? uB : uA, f = (cu - p[0]) / (q[0] - p[0]);
        X = { x: cu, y: p[1] + f * (q[1] - p[1]), f: f };
      } else {
        var cv = Math.max(VR[cp], VR[cq]) === 2 ? vB : vA, g = (cv - p[1]) / (q[1] - p[1]);
        X = { x: p[0] + g * (q[0] - p[0]), y: cv, f: g };
      }
      var cross = { x: X.x, y: X.y, cells: [cp, cq], inserted: true };
      if (Math.hypot(X.x - p[0], X.y - p[1]) < 0.02) { cross.inserted = false; per[per.length - 1] = cross; }
      else per.push(cross);
    }
    // drop original points that sit on top of a crossing
    per = per.filter(function (pt, k) {
      if (pt.cells) return true;
      var nx = per[(k + 1) % per.length];
      return !(nx.cells && Math.hypot(nx.x - pt.x, nx.y - pt.y) < 0.02 && (nx.inserted = false, true));
    });
    var Q = {};
    per.forEach(function (pt, k) { if (pt.cells) { var key = pt.cells.join('>'); Q[key] = (key in Q) ? -1 : k; } });
    var need = { qtB: 'P>D1t', qtA: 'D1t>B', qlB: 'B>D2', qlA: 'D2>N', qbA: 'N>D1b', qbB: 'D1b>P' }, idx = {};
    for (var nm in need) {
      if (!(need[nm] in Q) || Q[need[nm]] < 0) throw new Error('layout');
      idx[nm] = Q[need[nm]];
    }

    // points: perimeter ids 0..NP-1, then the four grid corners
    var NP = per.length, pt2 = per.map(function (q2) { return [q2.x, q2.y]; });
    var G = { AA: NP, AB: NP + 1, BA: NP + 2, BB: NP + 3 };
    pt2.push([uA, vA], [uA, vB], [uB, vA], [uB, vB]);
    var colH = pt2.map(function () { return []; });
    function addH(id, h) { if (colH[id].indexOf(h) < 0) colH[id].push(h); }
    per.forEach(function (q2, k) {
      addH(k, P.chamfer);
      if (q2.cells) { addH(k, HC[q2.cells[0]]); addH(k, HC[q2.cells[1]]); } else addH(k, HC[q2.cell]);
    });
    [['AA', ['D1m', 'D1b', 'N', 'D2']], ['AB', ['D1m', 'D1t', 'B', 'D2']], ['BA', ['D1m', 'D1b', 'P']], ['BB', ['D1m', 'D1t', 'P']]]
      .forEach(function (gc) { gc[1].forEach(function (c) { addH(G[gc[0]], HC[c]); }); });
    colH.forEach(function (a) { a.sort(function (m, n) { return m - n; }); });

    var pos = [], tri = [], vmap = pt2.map(function () { return {}; });
    function newV(x, y, z) { pos.push(x, y, z); return pos.length / 3 - 1; }
    function vid(id, z) { var m = vmap[id]; if (!(z in m)) m[z] = newV(pt2[id][0], pt2[id][1], z); return m[z]; }
    function chain(id, lo, hi) { return colH[id].filter(function (h) { return h >= lo - 1e-9 && h <= hi + 1e-9; }).map(function (h) { return vid(id, h); }); }
    function zOf(v) { return pos[3 * v + 2]; }
    function zipper(A, B) {        // vertical strip; outward = right-hand side of A -> B
      var a = 0, b = 0;
      while (a < A.length - 1 || b < B.length - 1) {
        var adv = a >= A.length - 1 ? 1 : (b >= B.length - 1 ? 0 : (zOf(B[b + 1]) <= zOf(A[a + 1]) ? 1 : 0));
        if (adv) { tri.push(A[a], B[b], B[b + 1]); b++; } else { tri.push(A[a], B[b], A[a + 1]); a++; }
      }
    }

    // bottom: chamfered ring at z = 0, triangulated without the inserted crossings
    var nrm = per.map(function (q2, k) {
      var a = per[(k - 1 + NP) % NP], b = per[(k + 1) % NP], tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
      return [ty / l, -tx / l];
    });
    var bot = per.map(function (q2, k) { return newV(q2.x - nrm[k][0] * P.chamfer, q2.y - nrm[k][1] * P.chamfer, 0); });
    var ess = [], essId = [];
    per.forEach(function (q2, k) { if (!q2.inserted) { ess.push([pos[3 * bot[k]], pos[3 * bot[k] + 1]]); essId.push(k); } });
    var bt = triangulate(THREE, ess, [], false).map(function (tr) { return tr.map(function (m) { return bot[essId[m]]; }); });
    per.forEach(function (q2, k) {          // put the crossings back on their edges
      if (!q2.inserted) return;
      var A = bot[(k - 1 + NP) % NP], B = bot[(k + 1) % NP], M = bot[k];
      for (var s = 0; s < bt.length; s++) {
        var T = bt[s];
        for (var e2 = 0; e2 < 3; e2++) {
          var x = T[e2], y = T[(e2 + 1) % 3];
          if ((x === A && y === B) || (x === B && y === A)) {
            var Z = T[(e2 + 2) % 3]; bt[s] = [x, M, Z]; bt.push([M, y, Z]); s = bt.length; break;
          }
        }
      }
    });
    bt.forEach(function (tr) { tri.push(tr[0], tr[1], tr[2]); });

    // chamfer strip and ribbed outer walls
    for (i = 0; i < NP; i++) {
      j = (i + 1) % NP;
      var c0 = vid(i, P.chamfer), c1 = vid(j, P.chamfer);
      tri.push(bot[i], bot[j], c1, bot[i], c1, c0);
      var mc = cellOf((per[i].x + per[j].x) / 2, (per[i].y + per[j].y) / 2);
      zipper(chain(i, P.chamfer, HC[mc]), chain(j, P.chamfer, HC[mc]));
    }

    // compartments
    var bd = baseSDF(P.a, P.b, P.n);
    var specs = [
      { id: 'pens', name: 'Pens', cell: 'P', top: Hp, floor: P.pensFloor, cons: [C('u', '>', x1 + t / 2)] },
      { id: 'books', name: 'Books', cell: 'B', top: Hb, floor: P.booksFloor, cons: [C('u', '<', x1 - t / 2), C('v', '>', v2 + t / 2)] },
      { id: 'notes', name: 'Post-its', cell: 'N', top: Hn, floor: P.notesFloor, cons: [C('u', '<', x1 - t / 2), C('v', '<', v2 - t / 2)] }
    ];
    var pockets = [], rimRing = {};
    specs.forEach(function (sp) {
      var pk = preparePocket(P, sp, bd), RS = 6, CS = 6, rings = [], q2, z, dl, ring;
      var rim = Math.min(P.rimR, (pk.depth - 2) / 3), cove = Math.min(P.coveR, (pk.depth - 2) / 2);
      for (q2 = 0; q2 <= RS; q2++) {
        var ph = Math.PI / 2 * (1 - q2 / RS);
        z = sp.top - rim + rim * Math.sin(ph); dl = rim * (1 - Math.cos(ph));
        ring = pocketRing(pk, dl); rings.push({ ids: ring.map(function (r) { return newV(r[0], r[1], z); }), xy: ring });
      }
      for (q2 = 0; q2 <= CS; q2++) {
        var al = -Math.PI / 2 * q2 / CS;
        z = sp.floor + cove + cove * Math.sin(al); dl = -cove + cove * Math.cos(al);
        ring = pocketRing(pk, dl); rings.push({ ids: ring.map(function (r) { return newV(r[0], r[1], z); }), xy: ring });
      }
      var M = pk.thetas.length;
      for (q2 = 0; q2 < rings.length - 1; q2++) {
        var lo = rings[q2 + 1].ids, hi = rings[q2].ids;
        for (var a = 0; a < M; a++) { var b = (a + 1) % M; tri.push(lo[a], hi[b], lo[b], lo[a], hi[a], hi[b]); }
      }
      var fl = rings[rings.length - 1].ids, ctr = newV(pk.center[0], pk.center[1], sp.floor);
      for (q2 = 0; q2 < M; q2++) tri.push(ctr, fl[q2], fl[(q2 + 1) % M]);
      rimRing[sp.cell] = rings[0];
      pk.wallRing = pocketRing(pk, 0);
      pockets.push(pk);
    });

    // flat tops of every cell, with the compartment openings as holes
    function run(from, to) { var r = [], k = from; for (;;) { r.push(k); if (k === to) break; k = (k + 1) % NP; } return r; }
    var cells = {
      P: run(idx.qbB, idx.qtB).concat([G.BB, G.BA]),
      D1t: run(idx.qtB, idx.qtA).concat([G.AB, G.BB]),
      B: run(idx.qtA, idx.qlB).concat([G.AB]),
      D2: run(idx.qlB, idx.qlA).concat([G.AA, G.AB]),
      N: run(idx.qlA, idx.qbA).concat([G.AA]),
      D1b: run(idx.qbA, idx.qbB).concat([G.BA, G.AA]),
      D1m: [G.AA, G.BA, G.BB, G.AB]
    };
    Object.keys(cells).forEach(function (c) {
      var ids = cells[c], h = HC[c], contour = ids.map(function (id) { return pt2[id]; });
      var vids = ids.map(function (id) { return vid(id, h); }), holes = [], holeIds = [];
      if (rimRing[c]) { holes.push(rimRing[c].xy); holeIds = rimRing[c].ids; }
      var map = vids.concat(holeIds);
      triangulate(THREE, contour, holes, true).forEach(function (tr) { tri.push(map[tr[0]], map[tr[1]], map[tr[2]]); });
    });

    // vertical steps where neighbouring cells have different heights
    [[G.BB, idx.qtB], [G.BA, G.BB], [idx.qbB, G.BA], [G.AB, G.BB], [G.AA, G.BA],
     [idx.qtA, G.AB], [G.AA, G.AB], [G.AA, idx.qbA], [idx.qlB, G.AB], [idx.qlA, G.AA]].forEach(function (sg) {
      var X = pt2[sg[0]], Y = pt2[sg[1]], dx = Y[0] - X[0], dy = Y[1] - X[1], l = Math.hypot(dx, dy) || 1;
      var mx = (X[0] + Y[0]) / 2, my = (X[1] + Y[1]) / 2, nx = dy / l * 0.05, ny = -dx / l * 0.05;
      var cr = cellOf(mx + nx, my + ny), cl = cellOf(mx - nx, my - ny);
      if (HC[cr] === HC[cl]) return;
      var lo = Math.min(HC[cr], HC[cl]), hi = Math.max(HC[cr], HC[cl]), a = sg[0], b = sg[1];
      if (HC[cr] > HC[cl]) { a = sg[1]; b = sg[0]; }   // right-hand side must face the lower cell
      zipper(chain(a, lo, hi), chain(b, lo, hi));
    });

    var u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    raw.forEach(function (q2) { u0 = Math.min(u0, q2[0]); u1 = Math.max(u1, q2[0]); w0 = Math.min(w0, q2[1]); w1 = Math.max(w1, q2[1]); });
    return {
      params: P,
      positions: Float32Array.from(pos),
      indices: Uint32Array.from(tri),
      pockets: pockets,
      outline: raw,
      size: { L: u1 - u0, W: w1 - w0, H: P.H },
      fit: bedFit(raw, 180),
      ribs: OUT.ribs, ribPitch: OUT.pitch,
      triangles: tri.length / 3
    };
  }

  function toSTL(model) {
    var p = model.positions, ix = model.indices, nt = ix.length / 3;
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

  /* ---------- minimal ZIP (stored) so the STL can travel as an allowed download ---------- */
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

  return { DEFAULTS: DEFAULTS, resolveParams: resolveParams, build: build, toSTL: toSTL, zip: zip };
});
