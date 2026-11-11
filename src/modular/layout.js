/* Modular desk organizer: layout analysis.
   Takes a design (settings + modules on the desk plan) and works out everything
   that depends on how the modules sit next to each other: which edges are shared,
   where the dovetails go and who carries the tabs, which stretches of each side
   are exposed (and get ribs), which corners are rounded, how thick each wall must
   be, and what is wrong with the layout. Pure functions, no geometry library.

   Conventions (see catalog.js for the module frame):
   - Global sides of a module: front (y = y0, runs along x), right (x = x1, runs
     along y), back (y = y1, along x), left (x = x0, along y). Positions along a
     side are GLOBAL coordinates (x for front/back, y for left/right).
   - A joint lies in the plane where two modules touch. axis 'x' means the plane
     is x = at and the joint runs along y; axis 'y' means y = at, running along x.
     `a` is the module on the low side of the plane, `b` on the high side.
   - Dovetails are vertical prisms: every module prints upright without supports
     and slides onto its neighbours from above. The taller neighbour carries the
     tabs, the lower one the slots (cut through its full height), so a tab never
     leaves an empty groove showing above it.                                    */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog.js'));
  else root.ModularLayout = factory(root.ModularCatalog);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var SIDES = C.SIDES, CORNERS = C.CORNERS, TOL = 0.01;
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function r0(x) { return Math.round(x); }

  /* ---------- frames ---------- */
  function localSize(m) { return m.rot % 2 ? { wL: m.d, dL: m.w } : { wL: m.w, dL: m.d }; }
  // local (front = -y, footprint wL x dL from the origin) -> global plan coordinates
  function toGlobal(m, lx, ly) {
    var s = localSize(m);
    switch (m.rot) {
      case 1: return [m.x + (s.dL - ly), m.y + lx];
      case 2: return [m.x + (s.wL - lx), m.y + (s.dL - ly)];
      case 3: return [m.x + ly, m.y + (s.wL - lx)];
      default: return [m.x + lx, m.y + ly];
    }
  }
  function toLocal(m, gx, gy) {
    var s = localSize(m), dx = gx - m.x, dy = gy - m.y;
    switch (m.rot) {
      case 1: return [dy, s.dL - dx];
      case 2: return [s.wL - dx, s.dL - dy];
      case 3: return [s.wL - dy, dx];
      default: return [dx, dy];
    }
  }
  function localSideOf(m, globalSide) { return SIDES[(SIDES.indexOf(globalSide) - m.rot + 4) % 4]; }
  function globalSideOf(m, localSide) { return SIDES[(SIDES.indexOf(localSide) + m.rot) % 4]; }
  // where a global side is: runs along `along` ('x' | 'y') from `from` to `to`, in the plane `at`; outward normal n
  function sideGeom(m, side) {
    if (side === 'front') return { along: 'x', at: m.y, from: m.x, to: m.x + m.w, n: [0, -1] };
    if (side === 'back') return { along: 'x', at: m.y + m.d, from: m.x, to: m.x + m.w, n: [0, 1] };
    if (side === 'right') return { along: 'y', at: m.x + m.w, from: m.y, to: m.y + m.d, n: [1, 0] };
    return { along: 'y', at: m.x, from: m.y, to: m.y + m.d, n: [-1, 0] };
  }
  // lowest point of the body along a stretch [c0, c1] (global coordinates) of a global side
  function heightAt(M, side, c0, c1) {
    var g = sideGeom(M, side), ls = localSideOf(M, side), prof = M.local[ls].profile;
    var p0 = g.along === 'x' ? toLocal(M, c0, g.at) : toLocal(M, g.at, c0), p1 = g.along === 'x' ? toLocal(M, c1, g.at) : toLocal(M, g.at, c1);
    var k = (ls === 'front' || ls === 'back') ? 0 : 1, ta = Math.min(p0[k], p1[k]), tb = Math.max(p0[k], p1[k]), h = Infinity;
    prof.forEach(function (s) {
      var a = Math.max(ta, s.t0), b = Math.min(tb, s.t1);
      if (b < a - 1e-9) return;
      var L = s.t1 - s.t0, at = function (t) { return L > 0 ? s.h0 + (s.h1 - s.h0) * (t - s.t0) / L : Math.min(s.h0, s.h1); };
      h = Math.min(h, at(a), at(b));
    });
    return isFinite(h) ? h : 0;
  }

  /* ---------- small helpers ---------- */
  function overlapArea(a, b) {
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), d = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
    return w > TOL && d > TOL ? w * d : 0;
  }
  // Smallest square plate a w x d rectangle fits on, turning it 0 or 45 degrees.
  function fitRect(w, d, plate, h, plateH) {
    var flat = Math.max(w, d), diag = (w + d) / Math.SQRT2, size = Math.min(flat, diag);
    var f = { size: size, angle: flat <= plate - 2 || flat <= diag ? 0 : 45, tall: h !== undefined && plateH !== undefined && h > plateH };
    f.wide = size > plate - 2; f.fits = !f.wide && !f.tall;
    return f;
  }
  function complement(from, to, cuts) {
    var out = [], at = from;
    cuts.slice().sort(function (p, q) { return p.from - q.from; }).forEach(function (c) {
      if (c.from > at + TOL) out.push({ from: at, to: c.from });
      at = Math.max(at, c.to);
    });
    if (to > at + TOL) out.push({ from: at, to: to });
    return out;
  }

  /* ---------- dovetail outline ----------
     Nominal outline of one dovetail (before the joint gap is taken off), as a counter-clockwise polygon in
     global plan coordinates. It starts 1 mm behind the joint plane inside the tab's owner, so it always
     overlaps the body it is fused to. The kernel shrinks it by gap/2 for the tab and grows it by gap/2 for
     the slot, which leaves `gap` between the mating faces all round.                                        */
  function tabPolygon(S, J, c) {
    var nw = S.tabHalfNeck, hw = S.tabHalfHead, d = S.tabDepth, k = S.tabChamfer, back = 1.0;
    var fl = Math.hypot(hw - nw, d), fx = (hw - nw) / fl, fy = d / fl;
    var half = [[nw + k, -back], [nw + k, 0], [nw + k * fx, k * fy], [hw - k * fx, d - k * fy], [hw - k, d]], tn = half.slice(), i;
    for (i = half.length - 1; i >= 0; i--) tn.push([-half[i][0], half[i][1]]);
    var pts = [], area = 0;
    tn.forEach(function (q) {
      var p = J.axis === 'x' ? [J.at + J.dir * q[1], c + q[0]] : [c + q[0], J.at + J.dir * q[1]], last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) pts.push(p);
    });
    for (i = 0; i < pts.length; i++) { var a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
    return area < 0 ? pts.reverse() : pts;
  }

  /* ---------- the analysis ---------- */
  function analyze(design) {
    var D = C.normalizeDesign(design), S = C.resolveSettings(D.settings), warnings = [], byId = {};
    function warn(code, level, ids, message) { warnings.push({ code: code, level: level, ids: ids, message: message }); }

    var mods = D.modules.map(function (m) {
      var T = C.TYPES[m.type], ls = localSize(m), M = {
        id: m.id, type: m.type, preset: m.preset, name: m.name, x: m.x, y: m.y, w: m.w, d: m.d, h: m.h, rot: m.rot,
        wL: ls.wL, dL: ls.dL, params: m.params, sides: {}, ins: {}, corners: {}, cornersL: {}, warnings: []
      };
      var res = T.resolve(M, S);
      M.params = res.params; M.ranges = res.ranges;
      var half = Math.floor(Math.min(M.w, M.d) / 2);        // the slider's far end is a fully round module
      M.ranges.round = { min: 0, max: half }; M.params.round = Math.min(M.params.round, half);
      M.local = T.sides(M, S);
      SIDES.forEach(function (side) {
        var g = sideGeom(M, side), lsn = localSideOf(M, side), info = M.local[lsn];
        M.sides[side] = { along: g.along, at: g.at, from: g.from, to: g.to, len: g.to - g.from, localSide: lsn,
          open: !!info.open, plain: !!info.plain, contacts: [], exposed: [], tabs: [], slots: [], ribbed: false, inset: 0 };
      });
      byId[M.id] = M;
      return M;
    });

    // overlaps
    var ok = true, i, j;
    for (i = 0; i < mods.length; i++) for (j = i + 1; j < mods.length; j++) {
      if (overlapArea(mods[i], mods[j]) > 0) {
        ok = false; mods[i].warnings.push('overlap'); mods[j].warnings.push('overlap');
        warn('overlap', 'error', [mods[i].id, mods[j].id], mods[i].name + ' and ' + mods[j].name + ' overlap. Move or resize one of them.');
      }
    }

    // shared edges -> joints
    var joints = [];
    function touch(A, B, axis) {      // A on the low side of the plane, B on the high side
      var x = axis === 'x', at = x ? A.x + A.w : A.y + A.d;
      if (Math.abs(at - (x ? B.x : B.y)) > TOL) return;
      var from = x ? Math.max(A.y, B.y) : Math.max(A.x, B.x), to = x ? Math.min(A.y + A.d, B.y + B.d) : Math.min(A.x + A.w, B.x + B.w);
      if (to - from <= TOL) return;
      var sideA = x ? 'right' : 'back', sideB = x ? 'left' : 'front';
      var J = { index: joints.length, axis: axis, at: at, from: from, to: to, length: to - from, a: A.id, b: B.id, sideA: sideA, sideB: sideB,
        blocked: false, owner: null, other: null, dir: 1, tabs: [], height: 0 };
      joints.push(J);
      A.sides[sideA].contacts.push({ from: from, to: to, other: B.id, joint: J.index });
      B.sides[sideB].contacts.push({ from: from, to: to, other: A.id, joint: J.index });
      if (A.sides[sideA].open || B.sides[sideB].open) {
        var shut = A.sides[sideA].open ? A : B, by = shut === A ? B : A;
        J.blocked = true; shut.warnings.push('blocked');
        warn('blocked', 'warn', [shut.id, by.id], by.name + ' blocks the front of ' + shut.name + '. Turn it or move one of them.');
        return;
      }
      if (overlapArea(A, B) > 0 || !S.dovetail) return;
      var usable = J.length - 2 * S.tabMargin;
      if (usable < 0) {
        warn('short', 'info', [A.id, B.id], A.name + ' and ' + B.name + ' touch along only ' + r0(J.length) + ' mm, too short for a dovetail.');
        return;
      }
      var n = clamp(Math.floor(usable / S.tabSpacing) + 1, 1, 6), cand = [], sa = 0, sb = 0, reach = S.tabHalfHead + 1;
      for (var k = 0; k < n; k++) {
        var c = from + S.tabMargin + usable * (k + 0.5) / n, ha = heightAt(A, sideA, c - reach, c + reach), hb = heightAt(B, sideB, c - reach, c + reach);
        cand.push({ c: c, h: Math.min(ha, hb) }); sa += ha; sb += hb;
      }
      var own = sb > sa + 1e-9 ? B : A, oth = own === A ? B : A;
      J.owner = own.id; J.other = oth.id; J.dir = own === A ? 1 : -1;
      J.tabs = cand.filter(function (t) { return t.h >= S.tabMinH; });
      J.tabs.forEach(function (t) {
        J.height = Math.max(J.height, t.h);
        own.sides[own === A ? sideA : sideB].tabs.push({ c: t.c, h: t.h, joint: J.index });
        oth.sides[oth === A ? sideA : sideB].slots.push({ c: t.c, h: t.h, joint: J.index });
      });
      if (!J.tabs.length) warn('low', 'info', [A.id, B.id], A.name + ' and ' + B.name + ' are too low where they meet for a dovetail.');
    }
    for (i = 0; i < mods.length; i++) for (j = 0; j < mods.length; j++) {
      if (i === j) continue;
      touch(mods[i], mods[j], 'x'); touch(mods[i], mods[j], 'y');
    }

    // sides: exposed stretches, ribs, wall thickness
    mods.forEach(function (M) {
      SIDES.forEach(function (side) {
        var s = M.sides[side], free = 0;
        s.contacts.sort(function (p, q) { return p.from - q.from; });
        s.exposed = complement(s.from, s.to, s.contacts);
        s.exposed.forEach(function (e) { free += e.to - e.from; });
        s.ribbed = S.ribbed && !s.plain && !s.open && free >= 2 * S.ribPitch;
        s.inset = s.open ? 0 : S.wall + (s.ribbed ? S.ribDepth : 0);
        if (s.slots.length) s.inset = Math.max(s.inset, S.band);
        M.ins[s.localSide] = s.inset;
      });
      // corners: rounded where both sides are free, sharp where a neighbour reaches the corner
      var x0 = M.x, x1 = M.x + M.w, y0 = M.y, y1 = M.y + M.d;
      function near(side, end) {       // distance from that end of the side to the nearest contact on it
        var s = M.sides[side], dmin = Infinity;
        s.contacts.forEach(function (c) { dmin = Math.min(dmin, end === 'from' ? c.from - s.from : s.to - c.to); });
        return dmin;
      }
      var defs = { fl: [['front', 'from'], ['left', 'from']], fr: [['front', 'to'], ['right', 'from']], br: [['right', 'to'], ['back', 'to']], bl: [['back', 'from'], ['left', 'to']] };
      CORNERS.forEach(function (cn, ci) {
        var r = Math.min(M.params.corners === 'own' ? M.params.round : S.cornerR, Math.min(M.w, M.d) / 2);
        defs[cn].forEach(function (q) {
          if (M.sides[q[0]].open) r = Math.min(r, 1.5);
          var dist = near(q[0], q[1]);
          r = dist < 0.5 ? 0 : Math.min(r, dist);
        });
        M.corners[cn] = r < 1 ? 0 : r;
        M.cornersL[CORNERS[(ci - M.rot + 4) % 4]] = M.corners[cn];
      });
      M.fit = fitRect(M.w, M.d, S.plate, M.h, S.plateH);
      if (!M.fit.fits) {
        M.warnings.push('big');
        warn('big', 'warn', [M.id], M.name + (M.fit.tall ? ' is taller than the printer allows (' + r0(S.plateH) + ' mm).' : ' is too big for the ' + r0(S.plate) + ' mm plate. Shrink it, or split it into two modules.'));
      }
      M.info = C.TYPES[M.type].info(M, S);
    });

    // groups: which modules end up attached to each other
    var parent = {};
    function find(a) { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; }
    mods.forEach(function (M) { parent[M.id] = M.id; });
    joints.forEach(function (J) { if (!J.blocked && (J.tabs.length || !S.dovetail)) parent[find(J.a)] = find(J.b); });
    var gm = {}, groups = [];
    mods.forEach(function (M) { var rt = find(M.id); (gm[rt] = gm[rt] || []).push(M.id); });
    Object.keys(gm).forEach(function (k) { groups.push(gm[k]); });
    groups.sort(function (p, q) { return q.length - p.length; });
    if (groups.length > 1) groups.slice(1).forEach(function (g) {
      g.forEach(function (id) { byId[id].warnings.push('loose'); });
      warn('loose', 'info', g, g.map(function (id) { return byId[id].name; }).join(', ') + (g.length > 1 ? ' are' : ' is') + ' not attached to the rest. Slide ' + (g.length > 1 ? 'them' : 'it') + ' against another module to add dovetails.');
    });

    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, h: 0 };
    mods.forEach(function (M) { b.x0 = Math.min(b.x0, M.x); b.y0 = Math.min(b.y0, M.y); b.x1 = Math.max(b.x1, M.x + M.w); b.y1 = Math.max(b.y1, M.y + M.d); b.h = Math.max(b.h, M.h); });
    if (!mods.length) b = { x0: 0, y0: 0, x1: 0, y1: 0, h: 0 };
    return { design: D, settings: S, modules: mods, byId: byId, joints: joints, groups: groups, bounds: b,
      size: { w: b.x1 - b.x0, d: b.y1 - b.y0, h: b.h }, warnings: warnings, ok: ok };
  }

  return {
    analyze: analyze, tabPolygon: tabPolygon, toGlobal: toGlobal, toLocal: toLocal, localSize: localSize,
    localSideOf: localSideOf, globalSideOf: globalSideOf, sideGeom: sideGeom, heightAt: heightAt,
    overlapArea: overlapArea, fitRect: fitRect, TOL: TOL
  };
});
