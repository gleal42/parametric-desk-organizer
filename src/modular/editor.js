/* Modular desk organizer: editing helpers.
   Everything the builder UI does to a design goes through here: snapping, placing
   a new module against the others, moving, resizing (pushing neighbours out of the
   way and pulling them along), turning, duplicating, deleting, and undo history.
   Pure functions, no DOM, no geometry library.

   Every edit takes a design and returns a result:
     { ok: true,  design: <new design>, ... }     the edit, applied to a clean copy
     { ok: false, design: <the design passed in>, reason: 'missing' | 'same' | 'limit' | 'blocked' | ... }
   The design passed in is never changed. An edit never leaves the module it touched
   overlapping another one: a module dropped on top of others settles in the nearest
   free spot, a module that grows pushes its neighbours away, and a nudge into a
   neighbour is refused. (Overlaps that were already in a loaded design stay until
   they are moved apart, or separate() is called.)

   Coordinates as in catalog.js: mm, (x, y) is the footprint's min corner, w along
   +x, d along +y. Sides are the GLOBAL ones: left (x), right (x + w), front (y),
   back (y + d).                                                                  */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog.js'), require('./layout.js'));
  else root.ModularEditor = factory(root.ModularCatalog, root.ModularLayout);
})(typeof self !== 'undefined' ? self : this, function (C, L) {
  'use strict';

  var TOL = L.TOL;
  function r1(x) { return Math.round(x * 10) / 10; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function norm(design) { return C.normalizeDesign(design); }
  function find(D, id) { for (var i = 0; i < D.modules.length; i++) if (D.modules[i].id === id) return D.modules[i]; return null; }
  function gridOf(D) { return C.resolveSettings(D.settings).grid; }
  function ok(D, extra) { var r = { ok: true, design: D }, k; for (k in (extra || {})) r[k] = extra[k]; return r; }
  function no(design, reason, extra) { var r = { ok: false, design: design, reason: reason }, k; for (k in (extra || {})) r[k] = extra[k]; return r; }

  /* ---------- small geometry ---------- */
  function snap(v, grid) { grid = grid > 0 ? grid : 1; return r1(Math.round(v / grid) * grid); }
  // size limits of a module on the plan: the type's limits, swapped when it is turned a quarter
  function limits(m) {
    var T = C.TYPES[m.type], odd = m.rot % 2 === 1;
    return { w: [odd ? T.min.d : T.min.w, odd ? T.max.d : T.max.w], d: [odd ? T.min.w : T.min.d, odd ? T.max.w : T.max.d], h: [T.min.h, T.max.h] };
  }
  function hit(a, b) { return L.overlapArea(a, b) > 0; }
  function hits(mods, rect, skipId) { return mods.filter(function (o) { return o.id !== skipId && hit(rect, o); }); }
  function isFree(mods, rect, skipId) {
    for (var i = 0; i < mods.length; i++) if (mods[i].id !== skipId && hit(rect, mods[i])) return false;
    return true;
  }
  // length along which two rectangles touch edge to edge (0 when apart or overlapping)
  function contactLength(a, b) {
    var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
    if (Math.abs(ox) <= TOL && oy > TOL) return oy;
    if (Math.abs(oy) <= TOL && ox > TOL) return ox;
    return 0;
  }
  function boundsOf(mods) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    mods.forEach(function (m) { b.x0 = Math.min(b.x0, m.x); b.y0 = Math.min(b.y0, m.y); b.x1 = Math.max(b.x1, m.x + m.w); b.y1 = Math.max(b.y1, m.y + m.d); });
    return mods.length ? b : { x0: 0, y0: 0, x1: 0, y1: 0 };
  }
  // every pair of modules that overlap, and every module whose size is outside its type's limits
  function check(design) {
    var D = norm(design), pairs = [], bad = [], i, j;
    for (i = 0; i < D.modules.length; i++) {
      var m = D.modules[i], lim = limits(m);
      if (m.w < lim.w[0] - TOL || m.w > lim.w[1] + TOL || m.d < lim.d[0] - TOL || m.d > lim.d[1] + TOL || m.h < lim.h[0] - TOL || m.h > lim.h[1] + TOL) bad.push(m.id);
      for (j = i + 1; j < D.modules.length; j++) if (hit(m, D.modules[j])) pairs.push([m.id, D.modules[j].id]);
    }
    return { ok: !pairs.length && !bad.length, overlaps: pairs, sizes: bad };
  }

  /* ---------- the nearest free spot ----------
     Where can a w x d rectangle go, as close as possible to (rect.x, rect.y), without overlapping any module?
     Each module forbids an open rectangle of positions; the nearest allowed point is the target itself, the foot
     of a perpendicular onto one of those rectangles' edges, or a corner where two edges cross. All of them have
     an x from { target, flush left of a module, flush right of a module } and a y from the matching set, so
     trying every pair is exact. The spots found are always flush against something.                            */
  function freeSpot(mods, rect, skipId, maxDist) {
    var others = mods.filter(function (o) { return o.id !== skipId; });
    var xs = [r1(rect.x)], ys = [r1(rect.y)], cands = [], i, j;
    others.forEach(function (o) { xs.push(r1(o.x - rect.w), r1(o.x + o.w)); ys.push(r1(o.y - rect.d), r1(o.y + o.d)); });
    for (i = 0; i < xs.length; i++) for (j = 0; j < ys.length; j++) cands.push({ x: xs[i], y: ys[j], dist: Math.hypot(xs[i] - rect.x, ys[j] - rect.y) });
    cands.sort(function (p, q) { return p.dist - q.dist; });
    for (i = 0; i < cands.length; i++) {
      if (maxDist !== undefined && cands[i].dist > maxDist) return null;
      if (isFree(others, { x: cands[i].x, y: cands[i].y, w: rect.w, d: rect.d })) return { x: cands[i].x, y: cands[i].y, dist: cands[i].dist };
    }
    return null;
  }

  /* ---------- snapping ----------
     While a module is dragged its position snaps, per axis, to (strongest first):
       flush   against the side of a module it would then touch,
       align   its edge with the same edge of a module just in front of or behind it,
       grid.
     Returns { x, y, kind: { x, y }, guides: [{ axis, at, from, to }] } (guides: where the snapped edges are, for the UI). */
  function snapMove(design, id, x, y, opts) {
    opts = opts || {};
    var D = norm(design), m = find(D, id);
    if (!m) return { x: x, y: y, kind: { x: null, y: null }, guides: [] };
    var grid = opts.grid || gridOf(D), tol = opts.tol === undefined ? Math.max(grid * 0.75, 4) : opts.tol;
    var others = D.modules.filter(function (o) { return o.id !== id; });
    function axis(horiz, pos, perp) {
      var size = horiz ? m.w : m.d, psize = horiz ? m.d : m.w, best = null;
      others.forEach(function (o) {
        var lo = horiz ? o.x : o.y, hi = lo + (horiz ? o.w : o.d), plo = horiz ? o.y : o.x, phi = plo + (horiz ? o.d : o.w);
        var apart = Math.max(plo - (perp + psize), perp - phi), list = [];      // > 0: clear of each other across the axis
        if (apart < -TOL) list.push([hi, 0, hi], [lo - size, 0, lo]);
        else if (apart < tol * 2) list.push([lo, 1, lo], [hi - size, 1, hi], [hi, 2, hi], [lo - size, 2, lo]);
        list.forEach(function (c) {
          var dist = Math.abs(c[0] - pos);
          if (dist > tol) return;
          if (!best || dist < best.dist - 1e-9 || (Math.abs(dist - best.dist) <= 1e-9 && c[1] < best.rank)) best = { v: r1(c[0]), dist: dist, rank: c[1], at: c[2], o: o };
        });
      });
      return best ? { v: best.v, kind: best.rank === 0 ? 'flush' : 'align', at: best.at, o: best.o } : { v: snap(pos, grid), kind: 'grid' };
    }
    var sx = opts.snap === false ? { v: r1(x), kind: null } : axis(true, x, y);
    var sy = opts.snap === false ? { v: r1(y), kind: null } : axis(false, y, sx.v);
    var guides = [];
    if (sx.o) guides.push({ axis: 'x', at: sx.at, from: Math.min(sy.v, sx.o.y), to: Math.max(sy.v + m.d, sx.o.y + sx.o.d) });
    if (sy.o) guides.push({ axis: 'y', at: sy.at, from: Math.min(sx.v, sy.o.x), to: Math.max(sx.v + m.w, sy.o.x + sy.o.w) });
    return { x: sx.v, y: sy.v, kind: { x: sx.kind, y: sy.kind }, guides: guides };
  }
  // where a dragged edge of module m lands: on another module's edge when one is within tol, otherwise on the grid
  function snapEdge(D, m, edge, coord, tol, grid) {
    var horiz = edge === 'left' || edge === 'right', best = null;
    D.modules.forEach(function (o) {
      if (o.id === m.id) return;
      [horiz ? o.x : o.y, horiz ? o.x + o.w : o.y + o.d].forEach(function (c) {
        var dist = Math.abs(c - coord);
        if (dist <= tol && (!best || dist < best.dist)) best = { v: c, dist: dist };
      });
    });
    return best ? r1(best.v) : snap(coord, grid);
  }

  /* ---------- ids and names ---------- */
  function newId(D) {
    var n = 0;
    D.modules.forEach(function (m) { var k = /^m(\d+)$/.exec(m.id); if (k) n = Math.max(n, +k[1]); });
    do { n++; } while (find(D, 'm' + n));
    return 'm' + n;
  }
  // "Pens" -> "Pens 2" -> "Pens 3": the first one that no module has yet
  function uniqueName(D, name, skipId) {
    var used = {}, base = String(name || 'Module').replace(/\s+\d+$/, '').trim().slice(0, 26) || 'Module', n = 2, out = String(name || base).trim().slice(0, 30) || base;
    D.modules.forEach(function (m) { if (m.id !== skipId) used[m.name.toLowerCase()] = 1; });
    while (used[out.toLowerCase()]) out = base + ' ' + (n++);
    return out;
  }

  /* ---------- placing a new module ----------
     A free spot for a w x d footprint, flush against the module `nearId` when there is room there, otherwise
     against any other module. Among the free spots it prefers, in this order: not blocking a cabinet's front,
     joined by a dovetail (not just touching at a corner), growing the overall outline the least, sharing the
     longest edge. Returns { x, y }.                                                                            */
  function findSpot(design, mod, nearId) {
    var D = norm(design), mods = D.modules, w = mod.w, d = mod.d;
    if (!mods.length) return { x: 0, y: 0 };
    var b0 = boundsOf(mods), area0 = (b0.x1 - b0.x0) * (b0.y1 - b0.y0), probeId = '~probe';
    function around(n) {
      var xs = [n.x, r1(n.x + n.w - w), r1(n.x + (n.w - w) / 2)], ys = [n.y, r1(n.y + n.d - d), r1(n.y + (n.d - d) / 2)], out = [];
      ys.forEach(function (y) { out.push({ x: r1(n.x + n.w), y: y, side: 0 }); });
      xs.forEach(function (x) { out.push({ x: x, y: r1(n.y + n.d), side: 1 }); });
      ys.forEach(function (y) { out.push({ x: r1(n.x - w), y: y, side: 2 }); });
      xs.forEach(function (x) { out.push({ x: x, y: r1(n.y - d), side: 3 }); });
      return out;
    }
    function best(bases) {
      var top = null;
      bases.forEach(function (n, bi) {
        around(n).forEach(function (c, ci) {
          var rect = { x: c.x, y: c.y, w: w, d: d };
          if (!isFree(mods, rect)) return;
          var probe = C.clone(mod); probe.id = probeId; probe.x = c.x; probe.y = c.y;
          var A = L.analyze({ version: D.version, name: D.name, settings: D.settings, modules: mods.concat([probe]) });
          var blocked = 0, tabs = 0, touch = 0;
          A.joints.forEach(function (J) {
            if (J.a !== probeId && J.b !== probeId) return;
            if (J.blocked) blocked++;
            tabs += J.tabs.length; touch += J.length;
          });
          var joined = A.settings.dovetail ? tabs > 0 : touch > 0;
          var bb = boundsOf(mods.concat([rect])), grow = (bb.x1 - bb.x0) * (bb.y1 - bb.y0) - area0;
          var cost = blocked * 1e9 + (joined ? 0 : 1e7) + grow - touch * 20 + c.side + bi * 5 + ci * 0.01;
          if (!top || cost < top.cost) top = { x: c.x, y: c.y, cost: cost };
        });
      });
      return top;
    }
    var near = nearId ? find(D, nearId) : null, spot = near ? best([near]) : null;
    if (!spot || spot.cost >= 1e7) {
      var wide = best(near ? [near].concat(mods.filter(function (m) { return m.id !== near.id; })) : mods.slice().reverse());
      if (wide && (!spot || wide.cost < spot.cost)) spot = wide;
    }
    if (!spot) spot = { x: r1(b0.x1), y: r1(b0.y0) };       // nothing free next to any module: start a new column on the right
    return { x: spot.x, y: spot.y };
  }
  // add a preset from the palette, attached to `opts.near` (a module id) or wherever it fits best; opts.at = { x, y } asks for a place
  function add(design, presetId, opts) {
    opts = opts || {};
    var D = norm(design), preset = C.PRESETS.filter(function (p) { return p.id === presetId; })[0];
    if (!preset) return no(design, 'missing');
    var m = C.fromPreset(presetId, newId(D), 0, 0);
    m.name = uniqueName(D, m.name);
    return place(D, m, opts);
  }
  function place(D, m, opts) {
    var spot = opts.at ? freeSpot(D.modules, { x: snap(opts.at.x, gridOf(D)), y: snap(opts.at.y, gridOf(D)), w: m.w, d: m.d }) : findSpot(D, m, opts.near);
    m.x = spot.x; m.y = spot.y;
    D.modules.push(m);
    return ok(norm(D), { id: m.id });
  }
  function duplicate(design, id) {
    var D = norm(design), src = find(D, id);
    if (!src) return no(design, 'missing');
    var m = C.clone(src);
    m.id = newId(D); m.name = uniqueName(D, src.name);
    return place(D, m, { near: id });
  }
  function remove(design, id) {
    var D = norm(design), n = D.modules.length;
    D.modules = D.modules.filter(function (m) { return m.id !== id; });
    return D.modules.length === n ? no(design, 'missing') : ok(D, { id: id });
  }

  /* ---------- moving ---------- */
  // Put a module at (x, y): snapped (unless opts.snap === false), and when that spot is taken, in the nearest
  // free spot within opts.maxDist mm (default: anywhere). settled = it could not go exactly where asked.
  function move(design, id, x, y, opts) {
    opts = opts || {};
    var D = norm(design), m = find(D, id);
    if (!m) return no(design, 'missing');
    var p = opts.snap === false ? { x: r1(x), y: r1(y) } : snapMove(D, id, x, y, opts);
    var spot = freeSpot(D.modules, { x: p.x, y: p.y, w: m.w, d: m.d }, id, opts.maxDist);
    if (!spot) return no(design, 'blocked');
    if (spot.x === m.x && spot.y === m.y) return no(design, 'same');
    m.x = spot.x; m.y = spot.y;
    return ok(D, { id: id, settled: spot.dist > TOL });
  }
  // One grid step in a direction (dx, dy in steps). A module that is off the grid lands on the next grid line.
  // Refused when a neighbour is in the way: reason 'blocked', by = their ids.
  function nudge(design, id, dx, dy) {
    var D = norm(design), m = find(D, id);
    if (!m) return no(design, 'missing');
    var g = gridOf(D);
    function step(v, n) {
      if (!n) return v;
      var k = v / g, on = Math.abs(k - Math.round(k)) < 1e-6;
      return r1((on ? Math.round(k) + n : (n > 0 ? Math.floor(k) + n : Math.ceil(k) + n)) * g);
    }
    var rect = { x: step(m.x, dx), y: step(m.y, dy), w: m.w, d: m.d }, by = hits(D.modules, rect, id);
    if (rect.x === m.x && rect.y === m.y) return no(design, 'same');
    if (by.length) return no(design, 'blocked', { by: by.map(function (o) { return o.id; }) });
    m.x = rect.x; m.y = rect.y;
    return ok(D, { id: id });
  }

  /* ---------- resizing ---------- */
  // After `root` grew: every module it now overlaps is moved flush past it, and so on down the line.
  function push(mods, root, horiz, sign) {
    var queue = [root], moved = {}, guard = 0;
    while (queue.length && guard++ < 4000) {
      var a = queue.shift();
      mods.forEach(function (b) {
        if (b === a || b === root || !hit(a, b)) return;
        if (horiz) b.x = r1(sign > 0 ? a.x + a.w : a.x - b.w); else b.y = r1(sign > 0 ? a.y + a.d : a.y - b.d);
        moved[b.id] = 1; queue.push(b);
      });
    }
    return Object.keys(moved);
  }
  // After `root` shrank by `amount` on one side: the modules that leaned on that side (and those leaning on
  // them) follow, so the layout stays together. A module that cannot follow without hitting one that stays
  // is left where it is.
  function pull(mods, root, horiz, sign, amount, oldEdge) {
    function lo(m) { return horiz ? m.x : m.y; }
    function hi(m) { return horiz ? m.x + m.w : m.y + m.d; }
    function span(m) { return horiz ? [m.y, m.y + m.d] : [m.x, m.x + m.w]; }
    function leans(b, edge, sp) {
      var s = span(b);
      return Math.abs((sign > 0 ? lo(b) : hi(b)) - edge) <= TOL && Math.min(s[1], sp[1]) - Math.max(s[0], sp[0]) > TOL;
    }
    var set = [], queue = [{ edge: oldEdge, span: span(root) }];
    while (queue.length) {
      var q = queue.shift();
      mods.forEach(function (b) {
        if (b === root || set.indexOf(b) >= 0 || !leans(b, q.edge, q.span)) return;
        set.push(b); queue.push({ edge: sign > 0 ? hi(b) : lo(b), span: span(b) });
      });
    }
    function at(b) { return horiz ? { x: r1(b.x - sign * amount), y: b.y, w: b.w, d: b.d } : { x: b.x, y: r1(b.y - sign * amount), w: b.w, d: b.d }; }
    for (var changed = true; changed;) {
      changed = false;
      set = set.filter(function (b) {
        var p = at(b), free = mods.every(function (o) { return o === b || set.indexOf(o) >= 0 || !hit(p, o); });
        if (!free) changed = true;
        return free;
      });
    }
    set.forEach(function (b) { var p = at(b); b.x = p.x; b.y = p.y; });
    return set.map(function (b) { return b.id; });
  }
  // Drag one side of a module to `coord` (the side's new x or y). The opposite side stays put. The size is kept
  // inside the type's limits; growing pushes neighbours away, shrinking pulls along the ones that leaned on that
  // side (opts.pull === false leaves them). opts.snap === false takes coord as it is, otherwise it snaps to a
  // neighbour's edge within opts.tol mm, or to the grid.
  function resize(design, id, edge, coord, opts) {
    opts = opts || {};
    var D = norm(design), m = find(D, id);
    if (!m || ['left', 'right', 'front', 'back'].indexOf(edge) < 0) return no(design, 'missing');
    var grid = gridOf(D), lim = limits(m), horiz = edge === 'left' || edge === 'right', far = edge === 'right' || edge === 'back';
    var lo = horiz ? m.x : m.y, size = horiz ? m.w : m.d, hi = r1(lo + size), range = horiz ? lim.w : lim.d;
    var c = +coord;
    if (!isFinite(c)) return no(design, 'missing');
    if (opts.snap !== false) c = snapEdge(D, m, edge, c, opts.tol === undefined ? Math.max(grid * 0.75, 4) : opts.tol, grid);
    var nlo = lo, nhi = hi;
    if (far) nhi = r1(clamp(c, lo + range[0], lo + range[1])); else nlo = r1(clamp(c, hi - range[1], hi - range[0]));
    var nsize = r1(nhi - nlo);
    if (nsize === size) return no(design, Math.abs((far ? nhi : nlo) - c) > TOL ? 'limit' : 'same');
    if (horiz) { m.x = nlo; m.w = nsize; } else { m.y = nlo; m.d = nsize; }
    var moved = nsize > size ? push(D.modules, m, horiz, far ? 1 : -1)
      : opts.pull === false ? [] : pull(D.modules, m, horiz, far ? 1 : -1, r1(size - nsize), far ? hi : lo);
    return ok(D, { id: id, moved: moved, size: nsize, limited: Math.abs((far ? nhi : nlo) - c) > TOL });
  }
  // Which side should move when a size slider changes: the free one when only one side has neighbours, so the
  // module grows into open space instead of shoving the others; otherwise right / back.
  function pickEdge(design, id, dim) {
    var D = norm(design), m = find(D, id);
    if (!m) return dim === 'w' ? 'right' : 'back';
    function leaning(edge) {
      var horiz = edge === 'left' || edge === 'right', at = edge === 'left' ? m.x : edge === 'right' ? m.x + m.w : edge === 'front' ? m.y : m.y + m.d;
      return D.modules.some(function (o) {
        if (o.id === m.id) return false;
        var face = edge === 'left' ? o.x + o.w : edge === 'right' ? o.x : edge === 'front' ? o.y + o.d : o.y;
        var ov = horiz ? Math.min(m.y + m.d, o.y + o.d) - Math.max(m.y, o.y) : Math.min(m.x + m.w, o.x + o.w) - Math.max(m.x, o.x);
        return Math.abs(face - at) <= TOL && ov > TOL;
      });
    }
    if (dim === 'w') return leaning('right') && !leaning('left') ? 'left' : 'right';
    return leaning('back') && !leaning('front') ? 'front' : 'back';
  }
  // Set one dimension ('w' | 'd' | 'h') to a value. For w and d, opts.edge says which side moves (default pickEdge).
  function setSize(design, id, dim, value, opts) {
    opts = opts || {};
    var D = norm(design), m = find(D, id);
    if (!m || ['w', 'd', 'h'].indexOf(dim) < 0 || !isFinite(+value)) return no(design, 'missing');
    var lim = limits(m), v = r1(clamp(+value, lim[dim][0], lim[dim][1]));
    if (v === m[dim]) return no(design, v !== r1(+value) ? 'limit' : 'same');
    if (dim === 'h') { m.h = v; return ok(D, { id: id, moved: [], size: v }); }
    var edge = opts.edge || pickEdge(D, id, dim), far = edge === 'right' || edge === 'back';
    var coord = dim === 'w' ? (far ? m.x + v : m.x + m.w - v) : (far ? m.y + v : m.y + m.d - v);
    var r = resize(D, id, edge, coord, { snap: false, pull: opts.pull });
    if (r.ok) r.edge = edge;
    return r.ok ? r : no(design, r.reason);
  }

  /* ---------- turning ----------
     A quarter turn counter-clockwise (dir = -1: clockwise) about the middle: width and depth swap and the module's
     own front turns with it. It stays where it was when it fits there, keeping as much contact with its neighbours
     as it can; otherwise it settles in the nearest free spot.                                                    */
  function rotate(design, id, dir) {
    var D = norm(design), m = find(D, id);
    if (!m) return no(design, 'missing');
    var g = gridOf(D), w = m.d, d = m.w, cx = m.x + m.w / 2, cy = m.y + m.d / 2;
    var cands = [{ x: snap(cx - w / 2, g), y: snap(cy - d / 2, g) }, { x: m.x, y: m.y }, { x: r1(m.x + m.w - w), y: m.y },
      { x: m.x, y: r1(m.y + m.d - d) }, { x: r1(m.x + m.w - w), y: r1(m.y + m.d - d) }], best = null;
    cands.forEach(function (c, i) {
      var rect = { x: c.x, y: c.y, w: w, d: d }, touch = 0;
      if (!isFree(D.modules, rect, id)) return;
      D.modules.forEach(function (o) { if (o.id !== id) touch += contactLength(rect, o); });
      if (!best || touch > best.touch + TOL) best = { x: c.x, y: c.y, touch: touch, i: i };
    });
    if (!best) best = freeSpot(D.modules, { x: cands[0].x, y: cands[0].y, w: w, d: d }, id);
    m.rot = (m.rot + (dir < 0 ? 3 : 1)) % 4; m.w = w; m.d = d; m.x = best.x; m.y = best.y;
    return ok(norm(D), { id: id });
  }

  /* ---------- fields ---------- */
  function rename(design, id, name) {
    var D = norm(design), m = find(D, id);
    if (!m) return no(design, 'missing');
    var n = String(name === undefined || name === null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 30) || C.TYPES[m.type].label;
    if (n === m.name) return no(design, 'same');
    m.name = n;
    return ok(D, { id: id });
  }
  function setParam(design, id, key, value) {
    var D = norm(design), m = find(D, id);
    if (!m) return no(design, 'missing');
    var def = C.TYPES[m.type].params.filter(function (p) { return p.key === key; })[0];
    if (!def) return no(design, 'missing');
    if (def.type === 'toggle') value = !!value;
    else if (def.type !== 'select') { value = +value; if (!isFinite(value)) return no(design, 'missing'); }
    if (m.params[key] === value) return no(design, 'same');
    m.params[key] = value;
    return ok(D, { id: id });
  }
  // patch: { key: value, ... } of global settings; values are clamped by the catalog
  function setSettings(design, patch) {
    var D = norm(design), before = JSON.stringify(D.settings), k;
    for (k in (patch || {})) if (k in C.DEFAULT_SETTINGS) D.settings[k] = patch[k];
    D = norm(D);
    return JSON.stringify(D.settings) === before ? no(design, 'same') : ok(D);
  }
  function setSetting(design, key, value) { var p = {}; p[key] = value; return setSettings(design, p); }
  function setName(design, name) {
    var D = norm(design), n = String(name === undefined || name === null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 60) || 'My organizer';
    if (n === D.name) return no(design, 'same');
    D.name = n;
    return ok(D);
  }
  // Move overlapping modules apart (a loaded design can have them): each one that sits on an earlier module
  // goes to the nearest free spot.
  function separate(design) {
    var D = norm(design), placed = [], moved = [];
    D.modules.forEach(function (m) {
      if (!isFree(placed, m)) {
        var spot = freeSpot(placed, m);
        m.x = spot.x; m.y = spot.y; moved.push(m.id);
      }
      placed.push(m);
    });
    return moved.length ? ok(D, { moved: moved }) : no(design, 'same');
  }

  /* ---------- undo history ----------
     An immutable value: { past: [designs], present, future: [designs], key }. push() with the same `key` as the
     previous push replaces the present instead of adding a step, so one slider drag is one undo step; seal()
     ends such a run. Designs are compared as JSON, so pushing an unchanged design does nothing.                */
  var LIMIT = 120;
  function same(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }
  var history = {
    create: function (design) { return { past: [], present: design, future: [], key: null }; },
    push: function (h, design, key) {
      if (key && h.key === key && h.past.length) {
        if (same(design, h.past[h.past.length - 1])) return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [], key: null };
        return { past: h.past, present: design, future: [], key: key };
      }
      if (same(design, h.present)) return h.key === (key || null) ? h : { past: h.past, present: h.present, future: h.future, key: null };
      return { past: h.past.concat([h.present]).slice(-LIMIT), present: design, future: [], key: key || null };
    },
    seal: function (h) { return h.key ? { past: h.past, present: h.present, future: h.future, key: null } : h; },
    undo: function (h) {
      if (!h.past.length) return h;
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present].concat(h.future), key: null };
    },
    redo: function (h) {
      if (!h.future.length) return h;
      return { past: h.past.concat([h.present]), present: h.future[0], future: h.future.slice(1), key: null };
    },
    canUndo: function (h) { return h.past.length > 0; },
    canRedo: function (h) { return h.future.length > 0; }
  };

  return {
    snap: snap, limits: limits, isFree: isFree, hits: hits, contactLength: contactLength, boundsOf: boundsOf, check: check,
    freeSpot: freeSpot, snapMove: snapMove, findSpot: findSpot, newId: newId, uniqueName: uniqueName,
    add: add, duplicate: duplicate, remove: remove, move: move, nudge: nudge, resize: resize, pickEdge: pickEdge, setSize: setSize,
    rotate: rotate, rename: rename, setParam: setParam, setSetting: setSetting, setSettings: setSettings, setName: setName,
    separate: separate, history: history
  };
});
