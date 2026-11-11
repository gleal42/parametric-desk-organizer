/* Modular desk organizer: the catalog.
   What a design is made of: global settings, module types (with their parameter
   schemas), palette presets and starter templates. Pure data and pure functions:
   no geometry library, no DOM. Shared by the layout analysis, the geometry kernel
   and the builder UI, so all three always agree.

   Units: mm. A module is an axis-aligned box on the desk plan:
     { id, type, name, x, y, w, d, h, rot, params }
   (x, y) is the footprint's min corner, w runs along +x, d along +y, h is the height.
   The desk's "front" is -y (towards the person sitting at it).

   Module-local frame: every type is modelled with its own front at local -y, in a
   footprint wL x dL. `rot` (0..3) turns it by quarter turns counter-clockwise seen
   from above, so its local front faces: 0 front (-y), 1 right (+x), 2 back (+y),
   3 left (-x). When rot is odd, wL = d and dL = w.                                */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModularCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var SIDES = ['front', 'right', 'back', 'left'];      // counter-clockwise from -y; also the corner order fl, fr, br, bl
  var CORNERS = ['fl', 'fr', 'br', 'bl'];

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function num(x, d) { x = +x; return isFinite(x) ? x : d; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r0(x) { return Math.round(x); }

  /* ---------- global settings ---------- */
  // group: where the UI shows it ('style' | 'print' | 'layout'); entries without a label are advanced (no control).
  var SETTINGS = [
    { key: 'surface', label: 'Surface', type: 'select', group: 'style', default: 'ribbed',
      options: [{ value: 'ribbed', label: 'Ribbed' }, { value: 'smooth', label: 'Smooth' }] },
    { key: 'ribPitch', label: 'Rib width', type: 'range', group: 'style', min: 3, max: 9, step: 0.5, unit: 'mm', default: 5, showIf: { surface: 'ribbed' } },
    { key: 'cornerR', label: 'Corner rounding', type: 'range', group: 'style', min: 0, max: 60, step: 1, unit: 'mm', default: 8,
      hint: 'A module can also use its own rounding. A corner is never rounder than half the module, and stays square where a neighbour touches it.' },
    { key: 'wall', label: 'Wall', type: 'range', group: 'style', min: 1.6, max: 5, step: 0.2, unit: 'mm', default: 2.4 },
    { key: 'floor', label: 'Floor', type: 'range', group: 'style', min: 1.2, max: 5, step: 0.2, unit: 'mm', default: 2.4 },
    { key: 'joint', label: 'Joints', type: 'select', group: 'print', default: 'dovetail',
      options: [{ value: 'dovetail', label: 'Dovetails' }, { value: 'flat', label: 'Flat, glued' }] },
    { key: 'gap', label: 'Joint gap', type: 'range', group: 'print', min: 0, max: 0.5, step: 0.05, unit: 'mm', default: 0.15,
      hint: '0.10 holds by friction, 0.15 is normal, 0.20 or more is loose and should be glued.' },
    { key: 'plate', label: 'Print plate', type: 'range', group: 'print', min: 120, max: 400, step: 1, unit: 'mm', default: 180 },
    { key: 'plateH', label: 'Max print height', type: 'range', group: 'print', min: 100, max: 400, step: 1, unit: 'mm', default: 180 },
    { key: 'grid', label: 'Snap', type: 'select', group: 'layout', default: 5,
      options: [{ value: 1, label: '1 mm' }, { value: 5, label: '5 mm' }, { value: 10, label: '10 mm' }] },
    // advanced: dovetail profile (same as the classic organizer), finishing radii, drawer fit
    { key: 'tabDepth', min: 1.5, max: 6, default: 3.2 },
    { key: 'tabNeck', min: 3, max: 14, default: 6 },
    { key: 'tabAngle', min: 5, max: 25, default: 14 },
    { key: 'tabChamfer', min: 0, max: 1, default: 0.4 },
    { key: 'tabSpacing', min: 25, max: 120, default: 45 },   // about one dovetail per this many mm of shared edge
    { key: 'tabMinH', min: 3, max: 30, default: 6 },         // a dovetail lower than this is left out
    { key: 'chamfer', min: 0, max: 1.2, default: 0.6 },      // base chamfer, against elephant's foot
    { key: 'rimR', min: 0, max: 2, default: 1.0 },           // rounded pocket rims
    { key: 'coveR', min: 0, max: 6, default: 3.0 },          // rounded pocket floors
    { key: 'divider', min: 1.2, max: 5, default: 2.0 },      // internal divider thickness
    { key: 'drawerGap', min: 0.2, max: 1, default: 0.4 },    // clearance around a drawer, each side
    { key: 'drawerWall', min: 1.2, max: 3, default: 1.6 },
    { key: 'shelfT', min: 1.2, max: 4, default: 2.0 }        // shelf between two bays of a cabinet
  ];
  var PRINTERS = [
    { id: 'a1mini', label: 'Bambu A1 mini', plate: 180, plateH: 180 },
    { id: 'mk4', label: 'Prusa MK4 / MK3', plate: 210, plateH: 210 },
    { id: 'ender3', label: 'Ender 3', plate: 220, plateH: 250 },
    { id: 'x1', label: 'Bambu A1 / P1 / X1', plate: 256, plateH: 256 }
  ];
  var DEFAULT_SETTINGS = {};
  SETTINGS.forEach(function (s) { DEFAULT_SETTINGS[s.key] = s.default; });

  function resolveSettings(s) {
    var S = {}, i, d, v;
    s = s || {};
    for (i = 0; i < SETTINGS.length; i++) {
      d = SETTINGS[i]; v = s[d.key];
      if (d.type === 'select') {
        S[d.key] = d.default;
        d.options.forEach(function (o) { if (String(o.value) === String(v)) S[d.key] = o.value; });
      } else S[d.key] = clamp(num(v === undefined || v === null || v === '' ? d.default : v, d.default), d.min, d.max);
    }
    // derived
    S.ribbed = S.surface === 'ribbed';
    S.ribDepth = S.ribbed ? 0.32 * S.ribPitch : 0;
    S.dovetail = S.joint === 'dovetail';
    S.tabHalfNeck = S.tabNeck / 2;
    S.tabHalfHead = S.tabNeck / 2 + S.tabDepth * Math.tan(S.tabAngle * Math.PI / 180);
    S.tabMargin = S.tabHalfHead + 2.5;                    // dovetail centre to the end of the shared edge, at least
    S.band = (S.dovetail ? S.tabDepth : 0) + S.gap / 2 + 1.6;   // thinnest wall that can carry a dovetail slot
    return S;
  }

  /* ---------- parameter schema helpers ----------
     A param: { key, label, type: 'range' | 'int' | 'select' | 'toggle', default, min, max, step, unit, options, hint,
                auto: { label }   -> the stored value 0 means "automatic" and is shown at the slider's far (max) end
                showIf: { key: value } }
     Dynamic limits (they depend on the module's size) come from TYPE.resolve(), not from the schema.              */
  function clampParams(schema, params, ranges) {
    var out = {}, p = params || {};
    schema.forEach(function (d) {
      var v = p[d.key], rg = (ranges && ranges[d.key]) || d;
      if (d.type === 'toggle') out[d.key] = v === undefined || v === null ? !!d.default : !!v;
      else if (d.type === 'select') {
        out[d.key] = d.default;
        d.options.forEach(function (o) { if (String(o.value) === String(v)) out[d.key] = o.value; });
      } else {
        v = num(v === undefined || v === null || v === '' ? d.default : v, d.default);
        if (d.auto && !(v > 0)) out[d.key] = 0;
        else {
          v = clamp(v, rg.min, Math.max(rg.min, rg.max));
          out[d.key] = d.type === 'int' ? Math.round(v) : v;
          if (d.auto && v >= rg.max - 1e-9 && d.auto.atMax !== false) out[d.key] = 0;
        }
      }
    });
    return out;
  }
  function flat(len, h) { return [{ t0: 0, t1: len, h0: h, h1: h }]; }

  /* ---------- module types ----------
     Each type: { label, blurb, icon, directional, min/max size, params (schema),
       resolve(m, S)  -> { params, ranges }      clamped params + the limits that depend on the module's size
       sides(m, S)    -> { front, right, back, left }  per LOCAL side:
                         { profile: [{t0,t1,h0,h1}], open, plain }
                         profile = height of the body along the side (t in mm from the side's start: local x for
                         front/back, local y for left/right; linear from h0 to h1). Dovetails only rise as high as
                         both neighbours are. open = nothing may attach (a drawer front). plain = never ribbed.
       derive(M, S)   -> type-specific dimensions computed once and used by BOTH the kernel and the UI text
       info(M, S)     -> one short sentence for the panel ("Inside 51 x 51 x 93 mm.")
     `m` passed to resolve/sides has wL, dL (local footprint) and h. `M` passed to derive/info is the analysed
     module from ModularLayout.analyze(): it also has ins = { front, right, back, left } (wall thickness on each
     LOCAL side, measured from the footprint edge) and params already resolved.                                  */
  var TYPES = {};

  /* --- bin: an open-top compartment, optionally divided, optionally with a lower front --- */
  TYPES.bin = {
    label: 'Compartment', icon: 'bin', directional: false,
    blurb: 'An open pocket: pen cup, tray, notebook slot or letter sorter.',
    min: { w: 25, d: 25, h: 12 }, max: { w: 320, d: 320, h: 250 },
    params: [
      { key: 'depth', label: 'Depth', type: 'range', min: 6, max: 200, step: 1, unit: 'mm', default: 0, auto: { label: 'Full' },
        hint: 'Below full, the pocket becomes a raised, shallow tray.' },
      { key: 'cols', label: 'Columns', type: 'int', min: 1, max: 8, step: 1, default: 1 },
      { key: 'rows', label: 'Rows', type: 'int', min: 1, max: 8, step: 1, default: 1 },
      { key: 'dividerH', label: 'Divider height', type: 'range', min: 5, max: 200, step: 1, unit: 'mm', default: 0, auto: { label: 'Full' } },
      { key: 'frontH', label: 'Front height', type: 'range', min: 10, max: 250, step: 1, unit: 'mm', default: 0, auto: { label: 'Level' },
        hint: 'Lower than the back, the top slopes down to the front like a letter sorter.' }
    ],
    resolve: function (m, S) {
      var p0 = m.params || {}, full = m.h - S.floor;
      var ranges = { depth: { min: 6, max: Math.max(6, r1(full)) }, frontH: { min: Math.min(10, m.h), max: m.h } };
      var innerW = m.wL - 2 * (S.wall + S.ribDepth), innerD = m.dL - 2 * (S.wall + S.ribDepth);
      ranges.cols = { min: 1, max: clamp(Math.floor((innerW + S.divider) / (10 + S.divider)), 1, 8) };
      ranges.rows = { min: 1, max: clamp(Math.floor((innerD + S.divider) / (8 + S.divider)), 1, 8) };
      var p = clampParams(this.params, p0, ranges);
      var depth = p.depth > 0 ? p.depth : full;
      ranges.dividerH = { min: 5, max: Math.max(5, r1(depth)) };
      p.dividerH = clampParams([this.params[3]], p0, ranges).dividerH;
      if (p.cols === 1 && p.rows === 1) p.dividerH = 0;
      return { params: p, ranges: ranges };
    },
    sides: function (m, S) {
      var p = m.params, fh = p.frontH > 0 ? Math.min(p.frontH, m.h) : m.h;
      var slope = [{ t0: 0, t1: m.dL, h0: fh, h1: m.h }];
      return { front: { profile: flat(m.wL, fh) }, right: { profile: slope }, back: { profile: flat(m.wL, m.h) }, left: { profile: slope } };
    },
    derive: function (M, S) {
      var p = M.params, i = M.ins, fh = p.frontH > 0 ? Math.min(p.frontH, M.h) : M.h;
      var x0 = i.left, x1 = M.wL - i.right, y0 = i.front, y1 = M.dL - i.back;
      var depth = p.depth > 0 ? Math.min(p.depth, M.h - S.floor) : M.h - S.floor;
      var cw = (x1 - x0 - (p.cols - 1) * S.divider) / p.cols, cd = (y1 - y0 - (p.rows - 1) * S.divider) / p.rows, cells = [];
      for (var r = 0; r < p.rows; r++) for (var c = 0; c < p.cols; c++) {
        var cx0 = x0 + c * (cw + S.divider), cy0 = y0 + r * (cd + S.divider);
        cells.push({ col: c, row: r, x0: cx0, x1: cx0 + cw, y0: cy0, y1: cy0 + cd });
      }
      return {
        inner: { x0: x0, x1: x1, y0: y0, y1: y1 }, floorZ: M.h - depth, depth: depth, backH: M.h, frontH: fh, sloped: fh < M.h - 1e-9,
        cells: cells, cellW: cw, cellD: cd, dividerTop: p.dividerH > 0 ? Math.min(M.h, M.h - depth + p.dividerH) : M.h
      };
    },
    info: function (M, S) {
      var g = this.derive(M, S), n = g.cells.length;
      return (n > 1 ? n + ' pockets, each ' : 'Inside ') + r0(g.cellW) + ' × ' + r0(g.cellD) + ' × ' + r0(g.depth) + ' mm' +
        (g.sloped ? ', sloping to ' + r0(g.frontH) + ' mm at the front.' : '.');
    }
  };

  /* --- block: a solid block with a grid of holes or slots --- */
  TYPES.block = {
    label: 'Tool block', icon: 'block', directional: false,
    blurb: 'A block of holes or slots for pens, markers, brushes, SD cards.',
    min: { w: 25, d: 20, h: 12 }, max: { w: 320, d: 320, h: 200 },
    params: [
      { key: 'hole', label: 'Holes', type: 'select', default: 'round',
        options: [{ value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }, { value: 'slot', label: 'Slots' }] },
      { key: 'size', label: 'Hole size', type: 'range', min: 2, max: 60, step: 0.5, unit: 'mm', default: 12,
        hint: 'Diameter of a round hole, side of a square one, thickness of a slot.' },
      { key: 'slotL', label: 'Slot length', type: 'range', min: 8, max: 200, step: 1, unit: 'mm', default: 26, showIf: { hole: 'slot' } },
      { key: 'spacing', label: 'Spacing', type: 'range', min: 1.6, max: 20, step: 0.2, unit: 'mm', default: 3 },
      { key: 'holeDepth', label: 'Hole depth', type: 'range', min: 4, max: 200, step: 1, unit: 'mm', default: 0, auto: { label: 'Full' } },
      { key: 'stagger', label: 'Honeycomb', type: 'toggle', default: false, showIf: { hole: 'round' } },
      { key: 'frontH', label: 'Front height', type: 'range', min: 10, max: 200, step: 1, unit: 'mm', default: 0, auto: { label: 'Level' },
        hint: 'Lower than the back, the top slopes down to the front so every tool is easy to reach.' }
    ],
    resolve: function (m, S) {
      var edge = S.wall + S.ribDepth, innerW = m.wL - 2 * edge, innerD = m.dL - 2 * edge;
      var ranges = {
        size: { min: 2, max: Math.max(2, Math.floor(Math.min(innerW, innerD, 60))) },
        slotL: { min: 8, max: Math.max(8, Math.floor(innerW)) },
        holeDepth: { min: 4, max: Math.max(4, r1(m.h - S.floor)) }, frontH: { min: Math.min(10, m.h), max: m.h }
      };
      return { params: clampParams(this.params, m.params, ranges), ranges: ranges };
    },
    sides: function (m, S) { return TYPES.bin.sides(m, S); },
    derive: function (M, S) {
      var p = M.params, i = M.ins, fh = p.frontH > 0 ? Math.min(p.frontH, M.h) : M.h;
      var x0 = i.left, x1 = M.wL - i.right, y0 = i.front, y1 = M.dL - i.back;
      var sx = p.hole === 'slot' ? p.slotL : p.size, sy = p.size, gap = p.spacing, holes = [];
      sx = Math.min(sx, x1 - x0); sy = Math.min(sy, y1 - y0);
      var nx = Math.max(1, Math.floor((x1 - x0 + gap) / (sx + gap))), ny = Math.max(1, Math.floor((y1 - y0 + gap) / (sy + gap)));
      var stag = p.hole === 'round' && p.stagger && ny > 1, pitchX = sx + gap, pitchY = stag ? (sy + gap) * Math.sqrt(3) / 2 : sy + gap;
      if (stag) ny = Math.max(1, Math.floor((y1 - y0 - sy) / pitchY) + 1);
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (var r = 0; r < ny; r++) {
        var odd = stag && r % 2 === 1, n = odd ? nx - 1 : nx;
        for (var c = 0; c < n; c++) holes.push({ x: cx + (c - (n - 1) / 2) * pitchX, y: cy + (r - (ny - 1) / 2) * pitchY, sx: sx, sy: sy });
      }
      // a hole that would come closer than the wall to a rounded outer corner is left out
      var cl = M.cornersL || {}, corners = [[cl.fl, 0, 0, 1, 1, Math.min(i.front, i.left)], [cl.fr, M.wL, 0, -1, 1, Math.min(i.front, i.right)],
        [cl.br, M.wL, M.dL, -1, -1, Math.min(i.back, i.right)], [cl.bl, 0, M.dL, 1, -1, Math.min(i.back, i.left)]];
      function clearOfCorners(o) {
        var hx = o.sx / 2 + 0.6, hy = o.sy / 2 + 0.6, k, q;      // with the entry chamfer
        for (k = 0; k < 4; k++) {
          var rc = corners[k][0] || 0, sxk = corners[k][3], syk = corners[k][4];
          if (!(rc > 0)) continue;
          var ccx = corners[k][1] + sxk * rc, ccy = corners[k][2] + syk * rc, lim = rc - corners[k][5];
          if (sxk * (o.x - sxk * hx - ccx) >= 0 || syk * (o.y - syk * hy - ccy) >= 0) continue;     // nowhere near this corner
          for (q = 0; q < 64; q++) {
            var px, py, a = q / 64 * 2 * Math.PI;
            if (p.hole === 'round') { px = o.x + hx * Math.cos(a); py = o.y + hy * Math.sin(a); }
            else { var t = (q % 16) / 16, sd = Math.floor(q / 16); px = o.x + hx * [2 * t - 1, 1, 1 - 2 * t, -1][sd]; py = o.y + hy * [-1, 2 * t - 1, 1, 1 - 2 * t][sd]; }
            if (sxk * (px - ccx) < 0 && syk * (py - ccy) < 0 && Math.hypot(px - ccx, py - ccy) > lim + 1e-6) return false;
          }
        }
        return true;
      }
      holes = holes.filter(clearOfCorners);
      // a sloped top: every hole keeps the same depth below the surface right above its front edge
      return {
        inner: { x0: x0, x1: x1, y0: y0, y1: y1 }, backH: M.h, frontH: fh, sloped: fh < M.h - 1e-9,
        shape: p.hole, holes: holes, holeDepth: p.holeDepth > 0 ? p.holeDepth : 0, floor: S.floor
      };
    },
    info: function (M, S) {
      var g = this.derive(M, S), p = M.params, n = g.holes.length;
      if (!n) return 'No room for a hole of this size.';
      var what = p.hole === 'round' ? 'Ø' + r1(p.size) + ' mm hole' : p.hole === 'square' ? r1(p.size) + ' mm square hole' : r1(g.holes[0].sx) + ' × ' + r1(p.size) + ' mm slot';
      return n + ' ' + what + (n === 1 ? '' : 's') + '.';
    }
  };

  /* --- stand: a phone or tablet rest: front lip, groove, slanted back rest --- */
  TYPES.stand = {
    label: 'Device stand', icon: 'stand', directional: true,
    blurb: 'Holds a phone or tablet at a comfortable angle.',
    min: { w: 40, d: 50, h: 30 }, max: { w: 320, d: 200, h: 200 },
    params: [
      { key: 'slotW', label: 'Device thickness', type: 'range', min: 6, max: 30, step: 0.5, unit: 'mm', default: 13,
        hint: 'Width of the groove. Leave 1 to 2 mm for a case.' },
      { key: 'angle', label: 'Lean', type: 'range', min: 5, max: 35, step: 1, unit: '°', default: 18 },
      { key: 'lipH', label: 'Front lip', type: 'range', min: 6, max: 30, step: 1, unit: 'mm', default: 12 },
      { key: 'cable', label: 'Cable notch', type: 'toggle', default: true }
    ],
    resolve: function (m, S) {
      var ranges = { slotW: { min: 6, max: clamp(m.dL - 30, 6, 30) }, lipH: { min: 6, max: clamp(m.h - 8, 6, 30) } };
      return { params: clampParams(this.params, m.params, ranges), ranges: ranges };
    },
    // Side view (local y from the front): lip | groove | rest rising at `angle` from vertical | flat top to the back.
    profile: function (m, S) {
      var p = m.params, lipT = 5, floorZ = Math.max(S.floor, 2.4) + 0.6, y0 = lipT, y1 = lipT + p.slotW;
      var run = (m.h - floorZ) * Math.tan(p.angle * Math.PI / 180), yTop = Math.min(m.dL - 4, y1 + run);
      var topH = floorZ + (yTop - y1) / Math.tan(p.angle * Math.PI / 180);
      return { lipT: lipT, lipH: Math.min(p.lipH, m.h), floorZ: floorZ, grooveY0: y0, grooveY1: y1, restTopY: yTop, topH: Math.min(m.h, topH), cableW: 14 };
    },
    sides: function (m, S) {
      var g = this.profile(m, S);
      var side = [{ t0: 0, t1: g.grooveY0, h0: g.lipH, h1: g.lipH }, { t0: g.grooveY0, t1: g.grooveY1, h0: g.floorZ, h1: g.floorZ },
        { t0: g.grooveY1, t1: g.restTopY, h0: g.floorZ, h1: g.topH }, { t0: g.restTopY, t1: m.dL, h0: g.topH, h1: g.topH }];
      return { front: { profile: flat(m.wL, g.lipH) }, right: { profile: side }, back: { profile: flat(m.wL, g.topH) }, left: { profile: side } };
    },
    derive: function (M, S) { return this.profile(M, S); },
    info: function (M, S) {
      var p = M.params;
      return 'Groove ' + r1(p.slotW) + ' mm wide, leaning ' + r0(p.angle) + '° back' + (p.cable ? ', with a cable notch.' : '.');
    }
  };

  /* --- cabinet: a shell with stacked bays, each holding a drawer or left open as a shelf --- */
  TYPES.cabinet = {
    label: 'Drawers & shelves', icon: 'cabinet', directional: true,
    blurb: 'A cabinet with sliding drawers, or open shelves.',
    min: { w: 45, d: 45, h: 28 }, max: { w: 320, d: 320, h: 250 },
    params: [
      { key: 'bays', label: 'Levels', type: 'int', min: 1, max: 5, step: 1, default: 2 },
      { key: 'drawers', label: 'Drawers', type: 'toggle', default: true, hint: 'Off leaves the levels open, as shelves.' },
      { key: 'pull', label: 'Drawer pull', type: 'select', default: 'notch', showIf: { drawers: true },
        options: [{ value: 'notch', label: 'Finger notch' }, { value: 'handle', label: 'Handle' }] }
    ],
    resolve: function (m, S) {
      var ranges = { bays: { min: 1, max: clamp(Math.floor((m.h - S.floor - 2.4 + S.shelfT) / (16 + S.shelfT)), 1, 5) } };
      return { params: clampParams(this.params, m.params, ranges), ranges: ranges };
    },
    sides: function (m, S) {
      return { front: { profile: flat(m.wL, m.h), open: true, plain: true }, right: { profile: flat(m.dL, m.h) },
        back: { profile: flat(m.wL, m.h) }, left: { profile: flat(m.dL, m.h) } };
    },
    derive: function (M, S) {
      var p = M.params, i = M.ins, roof = Math.max(S.floor, 2.4), n = p.bays, g = S.drawerGap;
      var x0 = i.left, x1 = M.wL - i.right, y1 = M.dL - i.back;
      var bayH = (M.h - S.floor - roof - (n - 1) * S.shelfT) / n, bays = [];
      for (var k = 0; k < n; k++) {
        var z0 = S.floor + k * (bayH + S.shelfT);
        bays.push({ index: k, x0: x0, x1: x1, y0: 0, y1: y1, z0: z0, z1: z0 + bayH,
          drawer: p.drawers ? { x0: x0 + g, x1: x1 - g, y0: 0, y1: y1 - g, z0: z0 + 0.2, z1: z0 + bayH - g - 0.2 } : null });
      }
      var dw = p.drawers ? bays[0].drawer : null, cl = M.cornersL || {};
      // a rounded back corner of the shell rounds the back of each bay too, so the wall keeps its thickness
      var backR = { left: Math.max(0, (cl.bl || 0) - Math.min(i.back, i.left)), right: Math.max(0, (cl.br || 0) - Math.min(i.back, i.right)) };
      return { bays: bays, bayW: x1 - x0, bayD: y1, bayH: bayH, roof: roof, span: x1 - x0, backR: backR,
        drawerInner: dw ? { w: dw.x1 - dw.x0 - 2 * S.drawerWall, d: dw.y1 - dw.y0 - 2 * S.drawerWall, h: dw.z1 - dw.z0 - S.drawerWall } : null };
    },
    info: function (M, S) {
      var g = this.derive(M, S), n = g.bays.length;
      if (g.drawerInner) return n + ' drawer' + (n > 1 ? 's' : '') + ', each ' + r0(g.drawerInner.w) + ' × ' + r0(g.drawerInner.d) + ' × ' + r0(g.drawerInner.h) + ' mm inside.';
      return n + ' shel' + (n > 1 ? 'ves' : 'f') + ', each ' + r0(g.bayW) + ' × ' + r0(g.bayD) + ' × ' + r0(g.bayH) + ' mm.';
    }
  };

  /* Every type also takes its own corner rounding: `corners` 'own' uses `round` instead of the Style setting. */
  var ROUND = [
    { key: 'corners', label: 'Corners', type: 'select', default: 'style', options: [{ value: 'style', label: 'As style' }, { value: 'own', label: 'Own rounding' }] },
    { key: 'round', label: 'Corner rounding', type: 'range', min: 0, max: 80, step: 1, unit: 'mm', default: 8, showIf: { corners: 'own' },
      hint: 'The far end is fully round. Corners stay square where a neighbour touches them.' }
  ];
  Object.keys(TYPES).forEach(function (k) { TYPES[k].params = TYPES[k].params.concat(ROUND); });

  /* ---------- palette presets: what "Add" offers ---------- */
  var PRESETS = [
    { id: 'pen-cup', type: 'bin', label: 'Pen cup', name: 'Pens', w: 60, d: 60, h: 95, params: {}, blurb: 'Pens, pencils, scissors.' },
    { id: 'tray', type: 'bin', label: 'Tray', name: 'Tray', w: 120, d: 80, h: 25, params: {}, blurb: 'Clips, keys, loose bits.' },
    { id: 'notes', type: 'bin', label: 'Sticky notes', name: 'Post-its', w: 90, d: 90, h: 30, params: {}, blurb: 'Fits 76 mm sticky-note pads.' },
    { id: 'notebook', type: 'bin', label: 'Notebook slot', name: 'Notebooks', w: 180, d: 45, h: 95, params: {}, blurb: 'Stands notebooks and books upright.' },
    { id: 'sorter', type: 'bin', label: 'Letter sorter', name: 'Letters', w: 110, d: 100, h: 110, params: { rows: 3, frontH: 55 }, blurb: 'Three slots, stepped down to the front.' },
    { id: 'bits', type: 'bin', label: 'Divided tray', name: 'Bits', w: 120, d: 80, h: 30, params: { cols: 3, rows: 2 }, blurb: 'Six small pockets.' },
    { id: 'cards', type: 'bin', label: 'Card holder', name: 'Cards', w: 100, d: 35, h: 40, params: {}, blurb: 'Business cards, standing.' },
    { id: 'pen-block', type: 'block', label: 'Pen block', name: 'Pen block', w: 80, d: 50, h: 70, params: { hole: 'round', size: 12, spacing: 3.6, frontH: 45 }, blurb: 'One hole per pen.' },
    { id: 'marker-block', type: 'block', label: 'Marker block', name: 'Markers', w: 100, d: 55, h: 60, params: { hole: 'round', size: 20, spacing: 4 }, blurb: 'Wide holes for markers and brushes.' },
    { id: 'card-slots', type: 'block', label: 'SD / USB slots', name: 'Cards & sticks', w: 60, d: 45, h: 22, params: { hole: 'slot', size: 3, slotL: 26, spacing: 4 }, blurb: 'Thin slots for memory cards.' },
    { id: 'phone', type: 'stand', label: 'Phone stand', name: 'Phone', w: 85, d: 80, h: 55, params: { slotW: 13, angle: 18 }, blurb: 'A groove and a back rest.' },
    { id: 'tablet', type: 'stand', label: 'Tablet stand', name: 'Tablet', w: 170, d: 95, h: 70, params: { slotW: 14, angle: 20, lipH: 14 }, blurb: 'Wider and taller, same idea.' },
    { id: 'drawers', type: 'cabinet', label: 'Drawers', name: 'Drawers', w: 100, d: 100, h: 70, params: { bays: 2, drawers: true }, blurb: 'Two drawers that slide out.' },
    { id: 'shelf', type: 'cabinet', label: 'Open shelf', name: 'Shelf', w: 100, d: 100, h: 70, params: { bays: 2, drawers: false }, blurb: 'Open cubbies, no drawers.' }
  ];

  /* ---------- starter templates ---------- */
  function mod(id, preset, x, y, over) {
    var p = PRESETS.filter(function (q) { return q.id === preset; })[0], m = { id: id, type: p.type, preset: p.id, name: p.name, x: x, y: y, w: p.w, d: p.d, h: p.h, rot: 0, params: {} }, k;
    for (k in p.params) m.params[k] = p.params[k];
    for (k in (over || {})) { if (k === 'params') { for (var q in over.params) m.params[q] = over.params[q]; } else m[k] = over[k]; }
    return m;
  }
  var TEMPLATES = [
    { id: 'desk-set', label: 'Desk set', blurb: 'Drawers, pens, tools, a tray and a notebook slot.',
      modules: [
        mod('m1', 'drawers', 0, 0),
        mod('m2', 'tray', 100, 0, { w: 100, d: 40, h: 25 }),
        mod('m3', 'pen-cup', 100, 40, { w: 50, d: 60, h: 95 }),
        mod('m4', 'pen-block', 150, 40, { w: 50, d: 60, h: 70, params: { frontH: 0 } }),
        mod('m5', 'notebook', 0, 100, { w: 200, d: 40, h: 100 })
      ] },
    { id: 'classic', label: 'Classic trio', blurb: 'The original: pens, books and sticky notes.',
      modules: [
        mod('m1', 'notes', 0, 0, { w: 140, d: 55, h: 30 }),
        mod('m2', 'notebook', 0, 55, { w: 140, d: 45, h: 95, name: 'Books' }),
        mod('m3', 'pen-cup', 140, 0, { w: 60, d: 100, h: 90 })
      ] },
    { id: 'dock', label: 'Phone dock', blurb: 'A phone stand between a pen cup and a tray.',
      modules: [
        mod('m1', 'pen-cup', 0, 0, { w: 60, d: 80, h: 95 }),
        mod('m2', 'phone', 60, 0),
        mod('m3', 'tray', 145, 0, { w: 80, d: 80, h: 25 })
      ] },
    { id: 'mail', label: 'Mail station', blurb: 'A letter sorter, a side shelf, a cup and a card holder.',
      modules: [
        mod('m1', 'sorter', 0, 40, { w: 120, d: 100, h: 110 }),
        mod('m2', 'cards', 0, 0, { w: 120, d: 40, h: 40 }),
        mod('m3', 'shelf', 120, 40, { w: 90, d: 100, h: 80, rot: 1 }),
        mod('m4', 'pen-cup', 120, 0, { w: 90, d: 40, h: 60 })
      ] },
    { id: 'empty', label: 'Start empty', blurb: 'A single pen cup to build from.', modules: [mod('m1', 'pen-cup', 0, 0)] }
  ];
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function template(id) {
    var t = TEMPLATES.filter(function (q) { return q.id === id; })[0] || TEMPLATES[0];
    return { version: VERSION, name: t.label, settings: clone(DEFAULT_SETTINGS), modules: clone(t.modules) };
  }
  function fromPreset(presetId, id, x, y) { return mod(id, presetId, x || 0, y || 0); }

  /* ---------- design: validation and (de)serialisation ---------- */
  // Returns a clean copy: known types only, numeric fields, sizes inside the type's limits, unique ids.
  function normalizeDesign(design) {
    var d = design && typeof design === 'object' ? design : {}, out = { version: VERSION, name: String(d.name || 'My organizer').slice(0, 60), settings: {}, modules: [] };
    var S = resolveSettings(d.settings), seen = {};
    SETTINGS.forEach(function (s) { out.settings[s.key] = S[s.key]; });
    (Array.isArray(d.modules) ? d.modules : []).forEach(function (m, i) {
      if (!m || !TYPES[m.type]) return;
      var T = TYPES[m.type], id = String(m.id || ''), n = 1;
      if (!id || seen[id]) { do { id = 'm' + (n++); } while (seen[id]); }
      seen[id] = 1;
      var rot = ((Math.round(num(m.rot, 0)) % 4) + 4) % 4;
      out.modules.push({
        id: id, type: m.type, preset: m.preset ? String(m.preset) : undefined, name: String(m.name || T.label).slice(0, 30),
        x: r1(num(m.x, 0)), y: r1(num(m.y, 0)),
        w: r1(clamp(num(m.w, 60), rot % 2 ? T.min.d : T.min.w, rot % 2 ? T.max.d : T.max.w)),
        d: r1(clamp(num(m.d, 60), rot % 2 ? T.min.w : T.min.d, rot % 2 ? T.max.w : T.max.d)),
        h: r1(clamp(num(m.h, 60), T.min.h, T.max.h)), rot: rot,
        params: m.params && typeof m.params === 'object' ? clone(m.params) : {}
      });
    });
    return out;
  }
  function serialize(design) { return JSON.stringify(normalizeDesign(design), null, 1); }
  function parse(text) {
    var o = JSON.parse(text);
    if (!o || typeof o !== 'object' || !Array.isArray(o.modules)) throw new Error('This is not an organizer design.');
    return normalizeDesign(o);
  }

  return {
    VERSION: VERSION, SIDES: SIDES, CORNERS: CORNERS, SETTINGS: SETTINGS, PRINTERS: PRINTERS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    TYPES: TYPES, PRESETS: PRESETS, TEMPLATES: TEMPLATES,
    resolveSettings: resolveSettings, clampParams: clampParams, normalizeDesign: normalizeDesign,
    template: template, fromPreset: fromPreset, serialize: serialize, parse: parse, clone: clone
  };
});
