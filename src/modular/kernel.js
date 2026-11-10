/* Modular desk organizer: the geometry kernel.
   Turns an analysed design (catalog.js + layout.js) into one watertight mesh per
   printable part, with the Manifold library (WASM) doing the solid modelling.

   How a module is built (all in the module's own "frame": global axes, origin at
   the footprint's min corner, so a module that is only moved is never rebuilt):
   1. Shell: the plan outline is walked side by side from the analysis. Contact
      stretches are flat and sit gap/2 behind the joint plane, exposed stretches
      carry half-round ribs (crests on the footprint edge), rounded corners carry
      the ribs round without a break. The outline is extruded with a real 45 degree
      base chamfer (the bottom ring is the outline's mitred inset).
   2. Dovetails: tabs are fused on (gap/2 smaller than nominal, chamfered at the
      base and the top), slots are cut through the full height (gap/2 larger,
      flared at the base).
   3. Interior: pockets, holes, the stand's side profile or the cabinet's bays are
      modelled in the module's LOCAL frame (front at -y) and turned into place.
   4. A sloped top is one plane cut at the end.
   Everything is a vertical prism or opens upwards, so every part prints upright
   without supports; only a cabinet's ceilings bridge.

   Manifold objects live in WASM memory and are freed per module build (Arena);
   only typed arrays are cached.                                                */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog.js'), require('./layout.js'));
  else root.ModularKernel = factory(root.ModularCatalog, root.ModularLayout);
})(typeof self !== 'undefined' ? self : this, function (C, L) {
  'use strict';

  var PI = Math.PI, EPS = 1e-6, KEY_VERSION = 1;
  var BRIDGE_MAX = 120;          // a cabinet ceiling wider than this gets a warning
  var MAX_HOLES = 1500;          // more holes than this in one block are not cut
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function r0(x) { return Math.round(x); }
  function q4(x) { return Math.round(x * 1e4) / 1e4; }
  function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  /* ---------- STL and ZIP (same as the classic organizer) ---------- */
  function stlBytes(p, ix) {
    var nt = ix.length / 3, buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf), o = 84, t, k;
    var head = 'Modular desk organizer (mm)';
    for (t = 0; t < head.length; t++) dv.setUint8(t, head.charCodeAt(t));
    dv.setUint32(80, nt, true);
    for (t = 0; t < nt; t++) {
      var a = ix[3 * t] * 3, b = ix[3 * t + 1] * 3, c = ix[3 * t + 2] * 3, v = [a, b, c];
      var e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      var e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
      for (k = 0; k < 3; k++) { dv.setFloat32(o, p[v[k]], true); dv.setFloat32(o + 4, p[v[k] + 1], true); dv.setFloat32(o + 8, p[v[k] + 2], true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
    return new Uint8Array(buf);
  }
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

  /* ---------- plan helpers ---------- */
  // One rib across a unit pitch: [position along, height 0..1]. Half-round with a 6% flat in each groove.
  var RIB = (function () {
    var segs = 12, g = 0.06, out = [], j;
    for (j = 0; j <= segs; j++) { var be = PI * (1 - j / segs); out.push([0.5 + (0.5 - g) * Math.cos(be), j === 0 || j === segs ? 0 : Math.sin(be)]); }
    return out;
  })();

  // The four sides in walking order (counter-clockwise seen from above), in the module frame.
  // P = where the walk along the side starts, t = walking direction, n = outward normal.
  function walkSides(M) {
    var w = M.w, d = M.d;
    return [
      { name: 'front', P: [0, 0], t: [1, 0], n: [0, -1], len: w, rev: false, c0: 'fl', c1: 'fr', along: 'x', at: 0 },
      { name: 'right', P: [w, 0], t: [0, 1], n: [1, 0], len: d, rev: false, c0: 'fr', c1: 'br', along: 'y', at: w },
      { name: 'back', P: [w, d], t: [-1, 0], n: [0, 1], len: w, rev: true, c0: 'br', c1: 'bl', along: 'x', at: d },
      { name: 'left', P: [0, d], t: [0, -1], n: [-1, 0], len: d, rev: true, c0: 'bl', c1: 'fl', along: 'y', at: 0 }];
  }

  // Rounded rectangle, counter-clockwise from the front-left corner, grown by delta (negative shrinks it).
  // Always 4 * (seg + 1) points, so rings at different deltas can be lofted point to point.
  function rrect(x0, y0, x1, y1, rad, delta, seg) {
    var X0 = x0 - delta, Y0 = y0 - delta, X1 = x1 + delta, Y1 = y1 + delta, lim = Math.max(0, Math.min(X1 - X0, Y1 - Y0) / 2), out = [], c, k;
    var cs = [[X0, Y0, 1, 1, PI], [X1, Y0, -1, 1, 1.5 * PI], [X1, Y1, -1, -1, 0], [X0, Y1, 1, -1, 0.5 * PI]];
    for (c = 0; c < 4; c++) {
      var r = clamp(rad[c] + delta, 0, lim), cx = cs[c][0] + cs[c][2] * r, cy = cs[c][1] + cs[c][3] * r;
      for (k = 0; k <= seg; k++) { var a = cs[c][4] + PI / 2 * k / seg; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    }
    return out;
  }
  function circle(cx, cy, r, n) { var out = [], k; for (k = 0; k < n; k++) out.push([cx + r * Math.cos(2 * PI * k / n), cy + r * Math.sin(2 * PI * k / n)]); return out; }

  // The outline moved inwards by `ch`, point for point (mitred), for the base chamfer. An edge that would
  // flip (a feature narrower than the chamfer) is collapsed to a point; the loft welds such points.
  function insetRing(pts, ch) {
    var n = pts.length, out = new Array(n), i, j, pass;
    for (i = 0; i < n; i++) {
      var a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      var l1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, l2 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
      var n1x = -(b[1] - a[1]) / l1, n1y = (b[0] - a[0]) / l1, n2x = -(c[1] - b[1]) / l2, n2y = (c[0] - b[0]) / l2, dn = 1 + n1x * n2x + n1y * n2y;
      var mx = n1x + n2x, my = n1y + n2y;
      if (dn > 0.3) { mx /= dn; my /= dn; } else { var ml = Math.hypot(mx, my); if (ml > 1e-9) { mx *= 2.4 / ml; my *= 2.4 / ml; } else { mx = n1x; my = n1y; } }
      out[i] = [b[0] + ch * mx, b[1] + ch * my];
    }
    for (pass = 0; pass < 6; pass++) {
      var bad = 0;
      for (i = 0; i < n; i++) {
        j = (i + 1) % n;
        if (out[i] === out[j]) continue;
        if ((pts[j][0] - pts[i][0]) * (out[j][0] - out[i][0]) + (pts[j][1] - pts[i][1]) * (out[j][1] - out[i][1]) < 0) {
          out[i] = out[j] = [(out[i][0] + out[j][0]) / 2, (out[i][1] + out[j][1]) / 2]; bad++;
        }
      }
      if (!bad) break;
    }
    return out;
  }

  /* The shell's plan outline, in the module frame.
     Each side is cut into stretches: contact (flat, gap/2 behind the joint plane), flat (exposed, on the footprint
     edge) or rib. Ribs are laid out per "run": a chain of ribbed stretches and of the rounded corners between
     them, with a whole number of ribs. A run ends in a groove; what it ends against decides the detail:
       - a neighbour (contact on the same side, or round a sharp corner): the seam hides in that groove;
       - a corner the ribs cannot wrap (sharp, tiny radius, or the other side is plain): a short flat corner post.
     Returns the outline counter-clockwise, without repeated points.                                          */
  function shellOutline(M, S) {
    var sides = walkSides(M), g2 = S.gap / 2, A = S.ribDepth, pitch = S.ribPitch, ribOn = !!S.ribbed && A > 0, i;
    sides.forEach(function (sd) {
      var s = M.sides[sd.name], cuts = [], st = [], at;
      sd.r0 = M.corners[sd.c0] || 0; sd.r1 = M.corners[sd.c1] || 0;
      sd.ribbed = ribOn && !!s.ribbed;
      sd.lo = Math.min(sd.r0, sd.len / 2); sd.hi = Math.max(sd.len - sd.r1, sd.len / 2);
      s.contacts.forEach(function (c) {
        var a = clamp(sd.rev ? s.to - c.to : c.from - s.from, sd.lo, sd.hi), b = clamp(sd.rev ? s.to - c.from : c.to - s.from, sd.lo, sd.hi);
        if (b - a > EPS) cuts.push([a, b]);
      });
      cuts.sort(function (p, q) { return p[0] - q[0]; });
      at = sd.lo;
      cuts.forEach(function (c) {
        if (c[1] <= at + EPS) return;
        if (c[0] > at + EPS) st.push({ u0: at, u1: c[0], kind: sd.ribbed ? 'rib' : 'flat' });
        st.push({ u0: Math.max(at, c[0]), u1: c[1], kind: 'contact' }); at = c[1];
      });
      if (sd.hi > at + EPS) st.push({ u0: at, u1: sd.hi, kind: sd.ribbed ? 'rib' : 'flat' });
      sd.st = st;
    });
    // corners the ribs run round
    var wrap = [];
    for (i = 0; i < 4; i++) wrap[i] = sides[i].r1 >= A + 1 && sides[i].ribbed && sides[(i + 1) % 4].ribbed;
    // corner posts
    function post(sd, st, atEnd, r, other, otherAtCorner) {
      if (r === 0 && other && other.kind === 'contact' && otherAtCorner) return;       // seam in the groove, no post
      var cut = Math.max(r, 0.5 * pitch) - r;
      if (st.u1 - st.u0 - cut < 0.6 * pitch) { st.kind = 'flat'; return; }
      if (cut <= EPS) return;
      if (atEnd) { st.u1 -= cut; sd.st.push({ u0: st.u1, u1: sd.hi, kind: 'flat' }); }
      else { st.u0 += cut; sd.st.unshift({ u0: sd.lo, u1: st.u0, kind: 'flat' }); }
    }
    for (i = 0; i < 4; i++) {
      var sd = sides[i], prev = sides[(i + 3) % 4], next = sides[(i + 1) % 4], o;
      if (!sd.st.length) continue;
      var last = sd.st[sd.st.length - 1];
      if (last.kind === 'rib' && last.u1 >= sd.hi - EPS && !wrap[i]) { o = next.st[0]; post(sd, last, true, sd.r1, o, !!o && o.u0 <= next.lo + EPS); }
      var first = sd.st[0];
      if (first.kind === 'rib' && first.u0 <= sd.lo + EPS && !wrap[(i + 3) % 4]) { o = prev.st[prev.st.length - 1]; post(sd, first, false, sd.r0, o, !!o && o.u1 >= prev.hi - EPS); }
    }
    // sharp corners: both sides stop at the mitre of their end depths
    function endDepth(st) { return !st ? 0 : st.kind === 'contact' ? g2 : st.kind === 'rib' ? A : 0; }
    for (i = 0; i < 4; i++) {
      var sa = sides[i], sb = sides[(i + 1) % 4];
      if (sa.r1 > 0) { sa.uhi = sa.hi; sb.ulo = sb.lo; }
      else { sa.uhi = sa.len - endDepth(sb.st[0]); sb.ulo = endDepth(sa.st[sa.st.length - 1]); }
    }
    var pieces = [];
    for (i = 0; i < 4; i++) {
      var sx = sides[i];
      sx.st.forEach(function (s) {
        var u0 = clamp(s.u0, sx.ulo, Math.max(sx.ulo, sx.uhi)), u1 = clamp(s.u1, sx.ulo, Math.max(sx.ulo, sx.uhi));
        if (u1 - u0 > EPS) pieces.push({ sd: sx, u0: u0, u1: u1, kind: s.kind, len: u1 - u0, rib: s.kind === 'rib' });
      });
      if (sx.r1 > 0) pieces.push({ arc: true, sd: sx, r: sx.r1, len: PI / 2 * sx.r1, rib: wrap[i] });
    }
    // emit
    var out = [];
    function push(p) {
      var q = out[out.length - 1];
      if (q && Math.abs(q[0] - p[0]) < 1e-7 && Math.abs(q[1] - p[1]) < 1e-7) return;
      out.push(p);
    }
    function at(p, s, depth) {
      var sd = p.sd;
      if (!p.arc) { var u = p.u0 + s; return [sd.P[0] + sd.t[0] * u - sd.n[0] * depth, sd.P[1] + sd.t[1] * u - sd.n[1] * depth]; }
      var r = p.r, kx = sd.P[0] + sd.t[0] * sd.len, ky = sd.P[1] + sd.t[1] * sd.len, cx = kx - (sd.t[0] + sd.n[0]) * r, cy = ky - (sd.t[1] + sd.n[1]) * r;
      var th = s / r, co = Math.cos(th), si = Math.sin(th), rr = r - depth;
      return [cx + rr * (sd.n[0] * co + sd.t[0] * si), cy + rr * (sd.n[1] * co + sd.t[1] * si)];
    }
    function plain(p) {
      if (p.arc) { var n = clamp(Math.ceil(p.len / 0.8), 4, 24), k; for (k = 0; k <= n; k++) push(at(p, p.len * k / n, 0)); }
      else { var dep = p.kind === 'contact' ? g2 : 0; push(at(p, 0, dep)); push(at(p, p.len, dep)); }
    }
    function ribs(run, closed) {
      var Lr = 0, n, pp, s0 = 0, a, j;
      run.forEach(function (p) { p.s0 = Lr; Lr += p.len; });
      function atS(s, depth) {
        if (closed) s = ((s % Lr) + Lr) % Lr;
        for (var k = run.length - 1; k > 0; k--) if (s >= run[k].s0) break;
        return at(run[k], Math.min(s - run[k].s0, run[k].len), depth);
      }
      if (closed) { n = Math.max(2, 2 * Math.round(Lr / (2 * pitch))); s0 = run[0].len / 2; }     // a groove on the centre line, front and back
      else n = Math.max(1, Math.round(Lr / pitch));
      pp = Lr / n;
      if (!closed) push(atS(0, A));
      for (a = 0; a < n; a++) for (j = 0; j < RIB.length; j++) push(atS(s0 + (a + RIB[j][0]) * pp, A * (1 - RIB[j][1])));
      if (!closed) push(atS(Lr, A));
    }
    var np = pieces.length, start = -1, k = 0, order = [];
    for (i = 0; i < np; i++) if (!pieces[i].rib) { start = i; break; }
    for (i = 0; i < np; i++) order.push(pieces[((start < 0 ? 0 : start) + i) % np]);
    while (k < np) {
      if (!order[k].rib) { plain(order[k++]); continue; }
      var run = [], Lrun = 0;
      while (k < np && order[k].rib) { Lrun += order[k].len; run.push(order[k++]); }
      if (Lrun < 0.6 * pitch) run.forEach(plain); else ribs(run, start < 0);
    }
    while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-7 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-7) out.pop();
    return out;
  }

  /* ---------- mesh builder: stacks of rings ("lofts") ---------- */
  function MeshBuilder(triangulate) { this.pos = []; this.idx = []; this.triangulate = triangulate; }
  // rings: [{ pts: [[x, y], ...], z: number | array of numbers }] from the bottom up, all with the same number of
  // points, counter-clockwise seen from above. Adds one closed solid. Repeated neighbours in a ring are welded.
  MeshBuilder.prototype.loft = function (rings) {
    var pos = this.pos, idx = this.idx, n = rings[0].pts.length, ids = [], uniq = [], k, i;
    function zOf(R, q) { return typeof R.z === 'number' ? R.z : R.z[q]; }
    function same(R, a, b) { return Math.abs(R.pts[a][0] - R.pts[b][0]) < 1e-7 && Math.abs(R.pts[a][1] - R.pts[b][1]) < 1e-7 && Math.abs(zOf(R, a) - zOf(R, b)) < 1e-7; }
    for (k = 0; k < rings.length; k++) {
      var R = rings[k], row = new Array(n), u = [], end = n;
      while (end > 1 && same(R, end - 1, 0)) end--;                 // trailing points that repeat the first one
      for (i = 0; i < n; i++) {
        if (i >= end) { row[i] = row[0]; continue; }
        if (i > 0 && same(R, i, i - 1)) { row[i] = row[i - 1]; continue; }
        row[i] = pos.length / 3; u.push(i);
        pos.push(R.pts[i][0], R.pts[i][1], zOf(R, i));
      }
      ids.push(row); uniq.push(u);
    }
    for (k = 0; k + 1 < ids.length; k++) {
      var a = ids[k], b = ids[k + 1];
      for (i = 0; i < n; i++) {
        var j = (i + 1) % n;
        if (a[i] !== a[j]) idx.push(a[i], a[j], b[j]);
        if (b[i] !== b[j]) idx.push(a[i], b[j], b[i]);
      }
    }
    this.cap(rings[0], ids[0], uniq[0], false);
    this.cap(rings[rings.length - 1], ids[ids.length - 1], uniq[uniq.length - 1], true);
    return this;
  };
  MeshBuilder.prototype.cap = function (R, row, u, up) {
    if (u.length < 3) return;
    var tris = this.triangulate([u.map(function (q) { return R.pts[q]; })]), idx = this.idx, t;
    for (t = 0; t < tris.length; t++) {
      var a = row[u[tris[t][0]]], b = row[u[tris[t][1]]], c = row[u[tris[t][2]]];
      if (up) idx.push(a, b, c); else idx.push(a, c, b);
    }
  };

  /* ---------- the kernel ---------- */
  function createKernel(wasm) {
    var Manifold = wasm.Manifold, CrossSection = wasm.CrossSection, Mesh = wasm.Mesh;
    var geomCache = new Map(), placedCache = new Map(), tabCache = new Map();
    var GEOM_MAX = 96, PLACED_MAX = 192;

    // Every Manifold / CrossSection made while building goes through an arena and is freed with it.
    function Arena() { this.live = []; }
    Arena.prototype.own = function (o) { if (Array.isArray(o)) Array.prototype.push.apply(this.live, o); else this.live.push(o); return o; };
    Arena.prototype.free = function () { for (var i = this.live.length - 1; i >= 0; i--) { try { this.live[i].delete(); } catch (e) { /* already freed */ } } this.live.length = 0; };
    function builder() { return new MeshBuilder(wasm.triangulate); }
    function solid(ar, mb) { return ar.own(new Manifold(new Mesh({ numProp: 3, vertProperties: new Float32Array(mb.pos), triVerts: new Uint32Array(mb.idx) }))); }
    function box(ar, x0, y0, z0, x1, y1, z1) { var c = ar.own(Manifold.cube([x1 - x0, y1 - y0, z1 - z0])); return ar.own(c.translate([x0, y0, z0])); }
    function union(ar, list) { return list.length === 1 ? list[0] : ar.own(Manifold.union(list)); }
    function difference(ar, list) { return list.length === 1 ? list[0] : ar.own(Manifold.difference(list)); }
    function lru(map, key, value, max) {
      map.delete(key); map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    }

    // local frame (front at -y, footprint wL x dL) -> module frame, as a column-major 4 x 4
    function frameMat(M) {
      switch (M.rot) {
        case 1: return [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, M.dL, 0, 0, 1];
        case 2: return [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, M.wL, M.dL, 0, 1];
        case 3: return [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, M.wL, 0, 1];
        default: return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      }
    }
    function effChamfer(S) { return Math.max(0, Math.min(S.chamfer, S.floor / 2, S.wall / 2, S.ribbed ? 0.2 * S.ribPitch : 9)); }

    /* ----- shell ----- */
    function shellSolid(ar, M, S, H, ch) {
      var top = shellOutline(M, S), mb = builder();
      if (ch > 0.01) mb.loft([{ pts: insetRing(top, ch), z: 0 }, { pts: top, z: ch }, { pts: top, z: H }]);
      else mb.loft([{ pts: top, z: 0 }, { pts: top, z: H }]);
      return solid(ar, mb);
    }

    /* ----- dovetails -----
       The nominal outline comes from ModularLayout.tabPolygon. It is offset once per settings, in its own (u, v)
       frame (u along the joint, v from the tab's owner into the other module), and each offset outline is cut
       at its waist into two convex pieces. A tab or a slot is then two convex hulls: that gives exact 45 degree
       chamfers (tab: base and top; slot: flared base) even where the chamfer swallows a short edge.        */
    function tabShapes(S, ch) {
      var key = [S.tabDepth, S.tabNeck, S.tabAngle, S.tabChamfer, S.gap, ch].join('/'), hit = tabCache.get(key);
      if (hit) return hit;
      var g2 = S.gap / 2, tc = Math.min(0.3, S.tabNeck / 10), ar = new Arena(), sh;
      var nominal = L.tabPolygon(S, { axis: 'y', at: 0, dir: 1 }, 0).map(function (p) { return [p[0], p[1] < -0.5 ? -10 : p[1]]; });   // root pushed far back; set per tab later
      try {
        var cs = ar.own(new CrossSection([nominal], 'Positive'));
        var outline = function (delta) {
          var o = Math.abs(delta) > 1e-9 ? cs.offset(delta, 'Miter', 3) : cs, pg = o.toPolygons();
          if (o !== cs) o.delete();
          return pg.length === 1 && pg[0].length >= 4 ? pg[0] : null;
        };
        var level = function (delta, z) {        // the outline at this offset, cut at its waist into two convex halves
          var pts = outline(delta), minU = Infinity, vs = -Infinity;
          if (!pts) return null;
          pts.forEach(function (p) { if (p[1] > -5) minU = Math.min(minU, Math.abs(p[0])); });
          pts.forEach(function (p) { if (p[1] > -5 && Math.abs(p[0]) <= minU + 1e-6) vs = Math.max(vs, p[1]); });
          return { z: z, lower: pts.filter(function (p) { return p[1] <= vs + 1e-9; }), upper: pts.filter(function (p) { return p[1] >= vs - 1e-9; }) };
        };
        // Levels of a chamfer between offsets d0 (at height z0) and d1 (at z1). Where a short edge of the outline
        // vanishes on the way, a level is added right there, so the convex hull through the levels is exact.
        var ramp = function (d0, z0, d1, z1) {
          var out = [level(d0, z0)], a = d0, na = (outline(d0) || []).length, nb = (outline(d1) || []).length, guard = 0;
          while (na && nb && na !== nb && guard++ < 4) {
            var lo = a, hi = d1, it, mid;
            for (it = 0; it < 20; it++) { mid = (lo + hi) / 2; if ((outline(mid) || []).length === na) lo = mid; else hi = mid; }
            out.push(level(hi, z0 + (z1 - z0) * (hi - d0) / (d1 - d0)));
            a = hi; na = (outline(hi) || []).length;
          }
          out.push(level(d1, z1));
          return out.every(Boolean) ? out : null;
        };
        var tab = level(-g2, 0), slot = level(g2, 0);
        if (!tab || !slot) throw new Error('dovetail profile');
        // heights are relative: `base` runs from the plate (z = 0) up to z = ch, `top` from -tc up to 0 below the tab's top
        sh = { tc: tc, tab: tab, slot: slot,
          tabBase: (ch > 0.01 && ramp(-(g2 + ch), 0, -g2, ch)) || [tab],
          tabTop: ramp(-g2, -tc, -(g2 + tc), 0) || [tab],
          slotFlare: ch > 0.01 ? ramp(g2 + ch + 1, -1, g2, ch) : null };
      } finally { ar.free(); }
      lru(tabCache, key, sh, 8);
      return sh;
    }
    // where a dovetail sits: its centre on the side, the axis along the joint, the axis into the other module
    function tabPlace(sd, cRel, outward, rootV) {
      var base = sd.along === 'x' ? [cRel, sd.at] : [sd.at, cRel], ux = sd.along === 'x' ? 1 : 0, uy = 1 - ux, sg = outward ? 1 : -1;
      return function (pts, z, into) {
        pts.forEach(function (p) { var v = p[1] < -5 ? rootV : p[1]; into.push([base[0] + ux * p[0] + sg * sd.n[0] * v, base[1] + uy * p[0] + sg * sd.n[1] * v, z]); });
      };
    }
    function tabSolid(ar, sd, cRel, h, S, ch, ins) {
      var sh = tabShapes(S, ch), g2 = S.gap / 2, tc = Math.min(sh.tc, h / 4), k = tc / sh.tc;
      var put = tabPlace(sd, cRel, true, -(g2 + clamp(Math.min(ins - 0.4, ch + 0.5), 0.3, 3)));     // the root reaches this far into its owner's wall
      return union(ar, ['lower', 'upper'].map(function (half) {
        var pts = [];
        sh.tabBase.forEach(function (lv) { put(lv[half], sh.tabBase.length > 1 ? lv.z : 0, pts); });
        if (sh.tabBase.length === 1) put(sh.tab[half], ch, pts);
        sh.tabTop.forEach(function (lv) { put(lv[half], sh.tabTop.length > 1 ? h + lv.z * k : h, pts); });
        return ar.own(Manifold.hull(pts));
      }));
    }
    // A slot is not convex in height (flared at the base, straight above), so it is a straight prism plus a flare.
    function slotSolid(ar, sd, cRel, H, S, ch) {
      var sh = tabShapes(S, ch), put = tabPlace(sd, cRel, false, -1.5), list = [];
      ['lower', 'upper'].forEach(function (half) {
        var pts = [], fl = [];
        put(sh.slot[half], -1, pts); put(sh.slot[half], H + 1, pts);
        list.push(ar.own(Manifold.hull(pts)));
        if (sh.slotFlare) { sh.slotFlare.forEach(function (lv) { put(lv[half], lv.z, fl); }); list.push(ar.own(Manifold.hull(fl))); }
      });
      return union(ar, list);
    }

    /* ----- pockets and holes (local frame) ----- */
    // z of every point of a ring: `fn(x, y)`, but never below the ring underneath (keeps a loft valid where a
    // sloped top dips towards the floor)
    function zRing(pts, fn, below) {
      var z = new Array(pts.length), i;
      for (i = 0; i < pts.length; i++) { z[i] = fn(pts[i][0], pts[i][1]); if (below) z[i] = Math.max(z[i], (typeof below.z === 'number' ? below.z : below.z[i]) + 0.02); }
      return { pts: pts, z: z };
    }
    // A pocket cutter: floor with a cove, straight wall, rounded rim that follows the top surface, then on up.
    //   o = { rect: [x0, y0, x1, y1], rad: [fl, fr, br, bl], floor, cove, rim, top: fn(x, y), above }
    function pocketRings(o) {
      var x0 = o.rect[0], y0 = o.rect[1], x1 = o.rect[2], y1 = o.rect[3], rmax = Math.max(o.rad[0], o.rad[1], o.rad[2], o.rad[3]);
      var seg = clamp(Math.ceil(PI / 2 * (rmax + o.rim) / 1.1), 2, 12), rings = [], k, CS = 5, RS = 4;
      function ring(delta) { return rrect(x0, y0, x1, y1, o.rad, delta, seg); }
      function add(pts, fn) { rings.push(zRing(pts, fn, rings[rings.length - 1])); }
      if (o.cove > 0.05) {
        for (k = 0; k <= CS; k++) (function (al) { add(ring(-o.cove + o.cove * Math.cos(al)), function () { return o.floor + o.cove + o.cove * Math.sin(al); }); })(-PI / 2 + PI / 2 * k / CS);
      } else add(ring(0), function () { return o.floor; });
      if (o.rim > 0.05) {
        for (k = 0; k <= RS; k++) (function (ph) { add(ring(o.rim * (1 - Math.cos(ph))), function (x, y) { return o.top(x, y) - o.rim + o.rim * Math.sin(ph); }); })(PI / 2 * k / RS);
        add(ring(o.rim), function () { return o.above; });
      } else add(ring(0), function () { return o.above; });
      return rings;
    }
    function binCutters(ar, M, S, g, hasSlots) {
      var p = M.params, h = M.h, cl = M.cornersL, ins = M.ins, rs = 1.5, cutters = [], cw = g.cellW, cd = g.cellD;
      if (cw < 2 || cd < 2) return cutters;
      var top = g.sloped ? function (x, y) { return g.frontH + (h - g.frontH) * clamp(y / M.dL, 0, 1); } : function () { return h; };
      var full = g.dividerTop >= h - 1e-6, divided = p.cols > 1 || p.rows > 1;
      var corner = { fl: Math.max(rs, cl.fl - Math.min(ins.front, ins.left)), fr: Math.max(rs, cl.fr - Math.min(ins.front, ins.right)),
        br: Math.max(rs, cl.br - Math.min(ins.back, ins.right)), bl: Math.max(rs, cl.bl - Math.min(ins.back, ins.left)) };
      var rim = Math.max(0, Math.min(S.rimR, (g.depth - 2) / 3, hasSlots ? 0.8 : 9, divided && full ? (S.divider - 0.8) / 2 : 9));
      var cove = Math.max(0, Math.min(S.coveR, (g.depth - 2) / 2, Math.min(cw, cd) / 4)), lim = Math.min(cw, cd) / 2 - 0.05, mb = builder();
      g.cells.forEach(function (c) {
        var rad = [c.col === 0 && c.row === 0 ? corner.fl : rs, c.col === p.cols - 1 && c.row === 0 ? corner.fr : rs,
          c.col === p.cols - 1 && c.row === p.rows - 1 ? corner.br : rs, c.col === 0 && c.row === p.rows - 1 ? corner.bl : rs].map(function (r) { return Math.min(r, lim); });
        if (full) mb.loft(pocketRings({ rect: [c.x0, c.y0, c.x1, c.y1], rad: rad, floor: g.floorZ, cove: cove, rim: rim, top: top, above: h + 2 }));
        else mb.loft(pocketRings({ rect: [c.x0, c.y0, c.x1, c.y1], rad: rad, floor: g.floorZ, cove: Math.min(cove, (g.dividerTop - g.floorZ) / 2), rim: 0, top: top, above: g.dividerTop + 0.3 }));
      });
      cutters.push(solid(ar, mb));
      if (!full) {            // dividers lower than the walls: one open pocket above them
        var i = g.inner, lim2 = Math.min(i.x1 - i.x0, i.y1 - i.y0) / 2 - 0.05, mb2 = builder();
        mb2.loft(pocketRings({ rect: [i.x0, i.y0, i.x1, i.y1], rad: [corner.fl, corner.fr, corner.br, corner.bl].map(function (r) { return Math.min(r, lim2); }),
          floor: g.dividerTop, cove: 0, rim: Math.max(0, Math.min(rim, (h - g.dividerTop - 0.5) / 2)), top: top, above: h + 2 }));
        cutters.push(solid(ar, mb2));
      }
      return cutters;
    }
    function blockCutters(ar, M, S, g, warn) {
      var h = M.h, holes = g.holes, n = holes.length, mb = builder(), made = 0;
      if (n > MAX_HOLES) { warn('holes', 'warn', '%s would have ' + n + ' holes, more than can be built. Only the first ' + MAX_HOLES + ' are cut: use bigger holes or a smaller block.'); n = MAX_HOLES; }
      var coarse = n > 300, top = g.sloped ? function (x, y) { return g.frontH + (h - g.frontH) * clamp(y / M.dL, 0, 1); } : function () { return h; };
      for (var q = 0; q < n; q++) {
        var o = holes[q], zt = top(o.x, o.y - o.sy / 2), zb = g.holeDepth > 0 ? Math.max(g.floor, zt - g.holeDepth) : g.floor;
        if (o.sx < 0.6 || o.sy < 0.6 || zt - zb < 1) continue;                // nothing worth cutting here
        var c = coarse ? 0 : Math.min(0.6, Math.min(o.sx, o.sy) / 6, (zt - zb) / 4), rings = [];
        var ring = (function (o) {
          if (g.shape === 'round') { var seg = coarse ? 10 : clamp(Math.round(PI * o.sx / 0.9), 12, 48); return function (dl) { return circle(o.x, o.y, o.sx / 2 + dl, seg); }; }
          var r = g.shape === 'slot' ? Math.min(o.sy / 2 - 0.02, 1) : Math.min(0.6, o.sx / 5), rad = [r, r, r, r], sg = coarse ? 1 : 3;
          return function (dl) { return rrect(o.x - o.sx / 2, o.y - o.sy / 2, o.x + o.sx / 2, o.y + o.sy / 2, rad, dl, sg); };
        })(o);
        rings.push({ pts: ring(0), z: zb });
        if (c > 0.05) {
          rings.push(zRing(ring(0), function (x, y) { return top(x, y) - c; }, rings[0]));
          rings.push(zRing(ring(c), top, rings[1]));
          rings.push({ pts: ring(c), z: h + 2 });
        } else rings.push({ pts: ring(0), z: h + 2 });
        mb.loft(rings); made++;
      }
      return made ? [solid(ar, mb)] : [];
    }

    /* ----- stand: the side profile, as a solid to intersect the shell with (local frame) ----- */
    function standProfile(ar, M, g) {
      var dL = M.dL, far = 12;       // reaches past the footprint so dovetail tabs survive the cut
      var pts = [[-far, -5], [dL + far, -5], [dL + far, g.topH], [g.restTopY, g.topH], [g.grooveY1, g.floorZ], [g.grooveY0, g.floorZ], [g.grooveY0, g.lipH], [-far, g.lipH]];
      var cs = ar.own(new CrossSection([pts], 'Positive')), slotW = g.grooveY1 - g.grooveY0;
      var ro = Math.min(1, g.lipT / 4), rc = Math.min(1.5, slotW / 4);
      cs = ar.own(ar.own(cs.offset(-ro, 'Round', 2, 32)).offset(ro, 'Round', 2, 32));      // round the lip and the top of the rest
      cs = ar.own(ar.own(cs.offset(rc, 'Round', 2, 32)).offset(-rc, 'Round', 2, 32));      // fillet the bottom of the groove
      cs = ar.own(cs.simplify(1e-4));
      var prism = ar.own(cs.extrude(M.wL + 2 * far));                       // profile (y, z) extruded along x
      return ar.own(prism.transform([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -far, 0, 0, 1]));
    }

    /* ----- cabinet drawers (local frame) ----- */
    function drawerSolid(ar, S, dr, pull, ch) {
      var x0 = dr.x0, x1 = dr.x1, y0 = dr.y0, y1 = dr.y1, z0 = dr.z0, z1 = dr.z1, t = S.drawerWall, W = x1 - x0, D = y1 - y0, H = z1 - z0;
      var c = Math.min(ch, 0.5, H / 6), rad = [0.6, 0.6, 1.5, 1.5].map(function (r) { return Math.min(r, W / 4, D / 4); }), mb = builder(), body, cut = [];
      if (c > 0.01) mb.loft([{ pts: rrect(x0, y0, x1, y1, rad, -c, 4), z: z0 }, { pts: rrect(x0, y0, x1, y1, rad, 0, 4), z: z0 + c }, { pts: rrect(x0, y0, x1, y1, rad, 0, 4), z: z1 }]);
      else mb.loft([{ pts: rrect(x0, y0, x1, y1, rad, 0, 4), z: z0 }, { pts: rrect(x0, y0, x1, y1, rad, 0, 4), z: z1 }]);
      body = solid(ar, mb);
      if (W - 2 * t > 3 && D - 2 * t > 3 && H - t > 2) {
        var mi = builder(), ri = Math.min(1.2, (W - 2 * t) / 4, (D - 2 * t) / 4);
        mi.loft(pocketRings({ rect: [x0 + t, y0 + t, x1 - t, y1 - t], rad: [ri, ri, ri, ri], floor: z0 + t, cove: Math.min(1.5, (H - t) / 3, (W - 2 * t) / 6, (D - 2 * t) / 6), rim: 0, top: null, above: z1 + 1 }));
        cut.push(solid(ar, mi));
      }
      var cx = (x0 + x1) / 2;
      if (pull === 'handle') {
        // a hooked wedge on the front: underside steeper than 45 degrees, nose, and a trough behind it for the fingertips
        var th = clamp(0.25 * H, 3, 7), e = 1.2, rise = 1.15 * th, hh = rise + e, zb = z0 + (H - hh) / 2, hw = Math.min(21, 0.3 * W), tap = 0.6 * th;
        if (hw > tap + 2 && zb > z0 + 0.5) {
          var prof = ar.own(new CrossSection([[[-0.8, zb], [0, zb], [th, zb + rise], [th, zb + hh], [th - 1, zb + hh], [0, zb + hh - 0.45 * th], [-0.8, zb + hh - 0.45 * th]]], 'Positive'));
          var bar = ar.own(ar.own(prof.extrude(2 * hw)).transform([0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, cx + hw, y0, 0, 1]));
          var plan = ar.own(new CrossSection([[[cx - hw, y0 + 0.8], [cx - hw, y0], [cx - hw + tap, y0 - th - 0.1], [cx + hw - tap, y0 - th - 0.1], [cx + hw, y0], [cx + hw, y0 + 0.8]]], 'Positive'));
          var trim = ar.own(ar.own(plan.extrude(hh + 2)).translate([0, 0, zb - 1]));
          body = ar.own(Manifold.union([body, ar.own(bar.intersect(trim))]));
          pull = 'done';
        }
      }
      if (pull !== 'done') {
        // finger notch: a U cut into the top of the front wall
        var nh = Math.min(11, 0.3 * W), nd = Math.min(10, 0.42 * H), fl = Math.min(1.2, nd / 4), rb = Math.max(0.2, Math.min(nh, nd - fl - 0.2)), zb2 = z1 - nd, pts = [], k;
        if (nh > 3 && nd > 2) {
          pts.push([cx - nh - fl, z1 + 1], [cx - nh - fl, z1], [cx - nh, z1 - fl]);
          for (k = 0; k <= 6; k++) { var a1 = PI + PI / 2 * k / 6; pts.push([cx - nh + rb + rb * Math.cos(a1), zb2 + rb + rb * Math.sin(a1)]); }
          for (k = 0; k <= 6; k++) { var a2 = 1.5 * PI + PI / 2 * k / 6; pts.push([cx + nh - rb + rb * Math.cos(a2), zb2 + rb + rb * Math.sin(a2)]); }
          pts.push([cx + nh, z1 - fl], [cx + nh + fl, z1], [cx + nh + fl, z1 + 1]);
          var ncs = ar.own(new CrossSection([pts], 'Positive'));
          cut.push(ar.own(ar.own(ncs.extrude(t + 1.5)).transform([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, y0 + t + 0.5, 0, 1])));
        }
      }
      return cut.length ? difference(ar, [body].concat(cut)) : body;
    }

    /* ----- one module -> its parts, in the module frame ----- */
    function meshData(man) {
      var m = man.getMesh(), np = m.numProp, src = m.vertProperties, nv = src.length / np, pos = new Float32Array(nv * 3), i;
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (i = 0; i < nv; i++) for (var k = 0; k < 3; k++) { var v = src[i * np + k]; pos[i * 3 + k] = v; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
      return { positions: pos, indices: new Uint32Array(m.triVerts), triangles: m.triVerts.length / 3, volume: man.volume(), bbox: { min: lo, max: hi } };
    }
    function buildGeom(M, S, A) {
      var ar = new Arena(), T = C.TYPES[M.type], g2 = S.gap / 2, ch = effChamfer(S), warns = [], out = [];
      function warn(code, level, tpl) { warns.push({ code: code, level: level, tpl: tpl }); }
      try {
        var g = T.derive(M, S), sides = walkSides(M), mat = frameMat(M), H = M.type === 'stand' ? g.topH : M.h, bridge = 0;
        function placed(list) { return list.map(function (m) { return ar.own(m.transform(mat)); }); }
        var body = shellSolid(ar, M, S, M.type === 'stand' ? H + 1 : H, ch), add = [body], cut = [], hasSlots = false;
        sides.forEach(function (sd) {
          var s = M.sides[sd.name], org = sd.along === 'x' ? M.x : M.y;
          s.tabs.forEach(function (t) { add.push(tabSolid(ar, sd, t.c - org, Math.min(t.h, H), S, ch, s.inset || S.wall)); });
          s.slots.forEach(function (t) { cut.push(slotSolid(ar, sd, t.c - org, H + 2, S, ch)); hasSlots = true; });
        });
        body = union(ar, add);
        if (M.type === 'bin') cut = cut.concat(placed(binCutters(ar, M, S, g, hasSlots)));
        else if (M.type === 'block') cut = cut.concat(placed(blockCutters(ar, M, S, g, warn)));
        else if (M.type === 'stand') {
          body = ar.own(body.intersect(placed([standProfile(ar, M, g)])[0]));
          if (M.params.cable) {
            var fs = M.sides[L.globalSideOf(M, 'front')], mid = (fs.from + fs.to) / 2, clear = g.cableW / 2 + S.tabHalfHead + 1.5;
            if (fs.tabs.concat(fs.slots).some(function (t) { return Math.abs(t.c - mid) < clear; })) warn('cable', 'info', '%s has no cable notch: a dovetail sits where it would go.');
            else if (M.wL > g.cableW + 12) cut = cut.concat(placed([box(ar, M.wL / 2 - g.cableW / 2, -12, g.floorZ, M.wL / 2 + g.cableW / 2, g.grooveY0 + Math.min(1.5, M.params.slotW / 4) + 0.05, M.h + 5)]));
          }
        } else if (M.type === 'cabinet') {
          cut = cut.concat(placed(g.bays.map(function (b) { return box(ar, b.x0, -12, b.z0, b.x1, b.y1, b.z1); })));
          bridge = g.span;
          if (g.span > BRIDGE_MAX) warn('bridge', 'warn', '%s has ceilings that bridge ' + r0(g.span) + ' mm with nothing under them. Above ' + BRIDGE_MAX + ' mm they tend to sag: make it narrower, or print it slowly with good cooling.');
        }
        if (cut.length) body = difference(ar, [body].concat(cut));
        if ((M.type === 'bin' || M.type === 'block') && g.sloped) {
          // one plane from the back edge (h) down to the front edge (frontH), in the module frame
          var k = (M.h - g.frontH) / M.dL, pl = [[g.frontH, 0, k], [M.h, -k, 0], [M.h, 0, -k], [g.frontH, k, 0]][M.rot], nl = Math.hypot(pl[1], pl[2], 1);
          body = ar.own(body.trimByPlane([pl[1] / nl, pl[2] / nl, -1 / nl], -pl[0] / nl));
        }
        var main = meshData(body);
        if (!main.triangles || !(main.volume > 0)) throw new Error('empty solid');
        main.suffix = ''; main.role = 'body'; main.slide = null; main.bridge = bridge;
        out.push(main);
        if (M.type === 'cabinet' && M.params.drawers) {
          var front = M.sides[L.globalSideOf(M, 'front')], shut = front.contacts.length > 0, dir = [-mat[4] || 0, -mat[5] || 0, 0];
          g.bays.forEach(function (b, bi) {
            var dr = { x0: b.drawer.x0, x1: b.drawer.x1, y0: shut ? g2 : b.drawer.y0, y1: b.drawer.y1, z0: b.drawer.z0, z1: b.drawer.z1 };
            if (dr.x1 - dr.x0 < 6 || dr.y1 - dr.y0 < 6 || dr.z1 - dr.z0 < 4) return;
            var dm = meshData(placed([drawerSolid(ar, S, dr, shut ? 'notch' : M.params.pull, ch)])[0]), depth = dr.y1 - dr.y0;
            dm.suffix = ':drawer' + (bi + 1); dm.role = 'drawer'; dm.label = 'drawer ' + (bi + 1); dm.bridge = 0;
            dm.slide = { dir: dir, travel: Math.round(Math.max(0, depth - Math.max(12, 0.3 * depth))) };    // a third stays in the bay, so it cannot tip out
            out.push(dm);
          });
        }
      } catch (e) {
        // never let one module take the whole build down: show a plain block and say so
        out = [];
        var fb = meshData(box(ar, g2, g2, 0, M.w - g2, M.d - g2, M.h));
        fb.suffix = ''; fb.role = 'body'; fb.slide = null; fb.bridge = 0; fb.failed = String(e && e.message || e);
        out.push(fb);
        warn('geometry', 'error', '%s could not be built with these settings and is shown as a plain block. Try a different size or undo the last change.');
      } finally { ar.free(); }
      return { parts: out, warnings: warns };
    }

    /* ----- cache keys: everything a module's geometry depends on, relative to its own corner ----- */
    var GEOM_SETTINGS = C.SETTINGS.map(function (s) { return s.key; }).filter(function (k) { return k !== 'plate' && k !== 'plateH' && k !== 'grid'; });
    function settingsKey(S) { return GEOM_SETTINGS.map(function (k) { return typeof S[k] === 'number' ? q4(S[k]) : S[k]; }).join('|'); }
    function moduleKey(M, skey) {
      var sd = C.SIDES.map(function (name) {
        var s = M.sides[name], org = s.along === 'x' ? M.x : M.y;
        return [s.ribbed ? 1 : 0, q4(s.inset),
          s.contacts.map(function (c) { return q4(c.from - org) + ':' + q4(c.to - org); }).join(','),
          s.tabs.map(function (t) { return q4(t.c - org) + ':' + q4(t.h); }).join(','),
          s.slots.map(function (t) { return q4(t.c - org); }).join(',')].join(';');
      });
      return [KEY_VERSION, M.type, q4(M.w), q4(M.d), q4(M.h), M.rot, JSON.stringify(M.params), sd.join('/'),
        C.CORNERS.map(function (c) { return q4(M.corners[c]); }).join(','), skey].join('~');
    }
    function place(G, x, y) {
      return G.parts.map(function (p) {
        var src = p.positions, pos = new Float32Array(src.length), i;
        for (i = 0; i < src.length; i += 3) { pos[i] = src[i] + x; pos[i + 1] = src[i + 1] + y; pos[i + 2] = src[i + 2]; }
        return { positions: pos, indices: p.indices, bbox: { min: [p.bbox.min[0] + x, p.bbox.min[1] + y, p.bbox.min[2]], max: [p.bbox.max[0] + x, p.bbox.max[1] + y, p.bbox.max[2]] } };
      });
    }

    function build(design) {
      var t0 = now(), A = L.analyze(design), S = A.settings, skey = settingsKey(S), parts = [], byModule = {}, warnings = A.warnings.slice();
      var rebuilt = [], reused = 0, tris = 0, vol = 0, b = A.bounds, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      A.modules.forEach(function (M) {
        var key = moduleKey(M, skey), G = geomCache.get(key);
        if (G) reused++; else { G = buildGeom(M, S, A); rebuilt.push(M.id); }
        lru(geomCache, key, G, GEOM_MAX);
        var pkey = key + '@' + q4(M.x) + ',' + q4(M.y), P = placedCache.get(pkey) || place(G, M.x, M.y);
        lru(placedCache, pkey, P, PLACED_MAX);
        var ex = [M.x + M.w / 2 - cx, M.y + M.d / 2 - cy], el = Math.hypot(ex[0], ex[1]);
        var explode = A.modules.length > 1 && el > 1e-6 ? [ex[0] / el, ex[1] / el, 0] : [0, 0, 0];
        byModule[M.id] = G.parts.map(function (gp, i) {
          var pp = P[i], sz = [pp.bbox.max[0] - pp.bbox.min[0], pp.bbox.max[1] - pp.bbox.min[1], pp.bbox.max[2] - pp.bbox.min[2]];
          var f = L.fitRect(sz[0], sz[1], S.plate, sz[2], S.plateH);
          var part = { id: M.id + gp.suffix, moduleId: M.id, role: gp.role, name: gp.role === 'drawer' ? M.name + ' ' + gp.label : M.name,
            positions: pp.positions, indices: pp.indices, triangles: gp.triangles, volume: gp.volume, bbox: pp.bbox, explode: explode,
            slide: gp.slide ? { dir: gp.slide.dir.slice(), travel: gp.slide.travel } : null,
            print: { angle: f.angle, size: sz, fits: f.fits, wide: f.wide, tall: f.tall, bridge: gp.bridge }, key: pkey + gp.suffix };
          tris += gp.triangles; vol += gp.volume; parts.push(part);
          if (gp.role === 'body' && !f.fits && M.fit.fits) {
            M.warnings.push('big');
            warnings.push({ code: 'big', level: 'warn', ids: [M.id], message: M.name + ' fits the ' + r0(S.plate) + ' mm plate only without its dovetails. Make it a few millimetres smaller.' });
          }
          return part;
        });
        G.warnings.forEach(function (w) {
          if (M.warnings.indexOf(w.code) < 0) M.warnings.push(w.code);
          warnings.push({ code: w.code, level: w.level, ids: [M.id], message: w.tpl.replace('%s', M.name) });
        });
      });
      return { analysis: A, parts: parts, byModule: byModule, warnings: warnings,
        stats: { parts: parts.length, triangles: tris, volume: vol, ms: now() - t0, rebuilt: rebuilt, reused: reused } };
    }

    /* ----- print orientation and export ----- */
    // Turned for the plate: rotated by print.angle about Z, centred on the origin, sitting on Z = 0.
    function printMesh(part) {
      var src = part.positions, n = src.length, pos = new Float32Array(n), t = (part.print ? part.print.angle : 0) * PI / 180, c = Math.cos(t), s = Math.sin(t), i;
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
      for (i = 0; i < n; i += 3) {
        var x = src[i] * c - src[i + 1] * s, y = src[i] * s + src[i + 1] * c, z = src[i + 2];
        pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z;
      }
      var mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      for (i = 0; i < n; i += 3) { pos[i] -= mx; pos[i + 1] -= my; pos[i + 2] -= z0; }
      return { positions: pos, indices: part.indices };
    }
    function toSTL(part, opts) {
      var m = opts && opts.print ? printMesh(part) : part;
      return stlBytes(m.positions, m.indices);
    }
    function fileNames(result) {
      var names = {};
      result.analysis.modules.forEach(function (M, i) {
        var base = pad2(i + 1) + '-' + (slug(M.name) || M.type);
        (result.byModule[M.id] || []).forEach(function (p, k) {
          names[p.id] = p.role === 'drawer' ? base + '-drawer-' + k + '.stl' : base + '-' + r0(M.w) + 'x' + r0(M.d) + 'x' + r0(M.h) + '.stl';
        });
      });
      return names;
    }
    function readme(result, design, names) {
      var A = result.analysis, S = A.settings, D = A.design, out = [], n1 = function (x) { return (Math.round(x * 10) / 10).toString(); };
      var gapNote = S.gap < 0.13 ? 'a tight, press fit' : S.gap < 0.19 ? 'a normal sliding fit' : 'a loose fit: add a drop of glue';
      out.push(D.name, new Array(D.name.length + 1).join('='), '');
      out.push('Overall ' + r0(A.size.w) + ' x ' + r0(A.size.d) + ' x ' + r0(A.size.h) + ' mm, ' + result.parts.length + ' part' + (result.parts.length === 1 ? '' : 's') + ', about ' + r0(result.stats.volume / 1000) + ' cm3 of solid plastic before infill.', '');
      out.push('PARTS', '');
      A.modules.forEach(function (M) {
        (result.byModule[M.id] || []).forEach(function (p) {
          var f = p.print, fit = f.fits ? (f.angle ? 'fits the plate turned 45 degrees (already turned in the file)' : 'fits the plate') : f.tall ? 'TOO TALL for a ' + r0(S.plateH) + ' mm printer' : 'TOO BIG for a ' + r0(S.plate) + ' mm plate';
          out.push('  ' + names[p.id]);
          out.push('      ' + p.name + ', ' + n1(f.size[0]) + ' x ' + n1(f.size[1]) + ' x ' + n1(f.size[2]) + ' mm, ' + fit + (f.bridge ? ', bridges ' + r0(f.bridge) + ' mm' : ''));
        });
      });
      out.push('', 'PRINTING', '');
      out.push('  Every file is already the right way up: flat on the plate, no supports.');
      out.push('  Plate ' + r0(S.plate) + ' mm, max height ' + r0(S.plateH) + ' mm. Walls ' + n1(S.wall) + ' mm, floors ' + n1(S.floor) + ' mm, ' + (S.ribbed ? 'ribs ' + n1(S.ribPitch) + ' mm wide' : 'smooth sides') + '.');
      out.push('  0.2 mm layers and 3 walls work well; 10 to 15 % infill is plenty.');
      if (A.modules.some(function (M) { return M.type === 'cabinet'; })) out.push('  Drawer cabinets and shelves have flat ceilings that print as bridges: keep the part-cooling fan on.');
      out.push('  Drawers have ' + n1(S.drawerGap) + ' mm of play on each side.');
      out.push('', 'ASSEMBLY', '');
      var joined = A.joints.filter(function (J) { return !J.blocked && J.tabs.length; }), flatJ = A.joints.filter(function (J) { return !J.blocked && !J.tabs.length; });
      if (!S.dovetail) {
        out.push(flatJ.length ? '  Joints are flat (' + n1(S.gap) + ' mm gap). Glue the parts side by side on a flat surface:' : '  The parts stand on their own, nothing to join.');
        flatJ.forEach(function (J) { out.push('    ' + A.byId[J.a].name + ' + ' + A.byId[J.b].name); });
      } else if (!joined.length) out.push('  No dovetails in this design: the parts stand on their own.');
      else {
        out.push('  The parts lock together with vertical dovetails (' + n1(S.gap) + ' mm gap, ' + gapNote + ').');
        out.push('  Stand one part on the desk and slide its neighbour straight down beside it, so the tabs run into the slots.');
        out.push('  A good order:');
        var done = {}, step = 1;
        A.groups.forEach(function (grp) {
          var order = [], queue = [grp[0]];
          while (queue.length) {
            var id = queue.shift();
            if (done[id]) continue;
            done[id] = 1; order.push(id);
            joined.forEach(function (J) { var o = J.a === id ? J.b : J.b === id ? J.a : null; if (o && !done[o]) queue.push(o); });
          }
          if (order.length < 2) return;
          order.forEach(function (id, i) {
            var M = A.byId[id], to = [];
            joined.forEach(function (J) {
              var o = J.a === id ? J.b : J.b === id ? J.a : null;
              if (o && order.indexOf(o) >= 0 && order.indexOf(o) < i) to.push(A.byId[o].name + ' (' + J.tabs.length + ' dovetail' + (J.tabs.length > 1 ? 's' : '') + ')');
            });
            out.push('    ' + (step++) + '. ' + (i === 0 ? 'Start with ' + M.name + '.' : 'Slide ' + M.name + ' down onto ' + to.join(' and ') + '.'));
          });
        });
        if (S.gap >= 0.19) out.push('  With this gap the joints are loose on purpose: a drop of superglue in each slot makes them permanent.');
        else out.push('  If a joint is too tight, sand the tab lightly; if it is loose, a drop of superglue fixes it for good.');
      }
      var loose = A.modules.filter(function (M) { return M.warnings.indexOf('loose') >= 0; });
      if (loose.length && S.dovetail && joined.length) out.push('  Not attached to the rest: ' + loose.map(function (M) { return M.name; }).join(', ') + '.');
      if (result.parts.some(function (p) { return p.role === 'drawer'; })) out.push('  Drawers simply slide into their bays from the front.');
      if (result.warnings.length) {
        out.push('', 'NOTES', '');
        result.warnings.forEach(function (w) { out.push('  - ' + w.message); });
      }
      out.push('', 'design.json holds this design: load it in the builder to change it.', '');
      return out.join('\n');
    }
    function exportFiles(result, design) {
      var names = fileNames(result), files = result.parts.map(function (p) { return { name: names[p.id], data: toSTL(p, { print: true }) }; });
      files.push({ name: 'design.json', data: C.serialize(design || result.analysis.design) });
      files.push({ name: 'README.txt', data: readme(result, design, names) });
      return files;
    }
    function dispose() { geomCache.clear(); placedCache.clear(); tabCache.clear(); }

    return { build: build, printMesh: printMesh, toSTL: toSTL, exportFiles: exportFiles, zip: zip, dispose: dispose };
  }

  /* ---------- loading Manifold ----------
     Node: the manifold-3d package. Built page: scripts/build.js inlines Manifold's glue (the factory ends up on
     window.ManifoldModule) and the .wasm as base64 in a global, so nothing is fetched.                      */
  function decode64(b64) {
    if (typeof atob === 'function') { var s = atob(b64), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  function load(opts) {
    opts = opts || {};
    function start(factory, binary) {
      return Promise.resolve(factory(binary ? { wasmBinary: binary } : {})).then(function (wasm) { wasm.setup(); return createKernel(wasm); });
    }
    return new Promise(function (resolve, reject) {
      if (opts.wasm) return resolve(createKernel(opts.wasm));
      if (typeof WebAssembly !== 'object') return reject(new Error('This browser cannot run WebAssembly, which the 3D model needs. Try a current version of Chrome, Firefox, Safari or Edge.'));
      if (opts.factory) return resolve(start(opts.factory, opts.wasmBinary));
      var page = typeof window !== 'undefined' && typeof document !== 'undefined' ? window : null, B64 = '__MANIFOLD_' + 'WASM_B64__';   // spelled in two halves: the build replaces the whole word
      if (!page) {
        if (typeof module === 'object' && module.exports) return resolve(import('manifold-3d').then(function (ns) { return start(ns.default, opts.wasmBinary); }));
        return reject(new Error('The geometry library (Manifold) is not available here.'));
      }
      // the glue is a module script, which may run after this one: give it a moment
      var tries = 0;
      (function wait() {
        if (typeof page.ManifoldModule === 'function') {
          var b64 = page[B64], bin = opts.wasmBinary || (typeof b64 === 'string' && b64.length > 1000 ? decode64(b64) : null);
          return resolve(start(page.ManifoldModule, bin));
        }
        if (++tries > 200) return reject(new Error('The geometry library (Manifold) did not load. Reload the page; if that does not help, the file is incomplete.'));
        setTimeout(wait, 50);
      })();
    });
  }

  return { load: load, zip: zip, _internals: { shellOutline: shellOutline, insetRing: insetRing, rrect: rrect, walkSides: walkSides } };
});
