// Tests the modular builder's geometry kernel: every template, a set of awkward hand-made cases and many
// random layouts. For each design it checks, on the meshes the kernel returns (with its own Manifold instance):
//   - every part is one closed, consistently wound solid with positive volume and no handles (genus 0);
//   - every body stays inside its footprint and height, except for its dovetail tabs (drawers: inside their bay,
//     except a handle); every tab is really there;
//   - parts of different modules never intersect, and still do not when one is nudged by 60% of the joint gap in
//     eight plan directions (so the gap really is there all round); a dovetail does hold when pulled sideways;
//   - every module (with its drawers) can be lifted straight up, and every drawer pulled out along its slide,
//     without touching anything;
//   - no overhang steeper than 45 degrees above the plate, except the declared cabinet ceilings;
//   - the cache: an unchanged design reuses every mesh, a moved design is not rebuilt, one changed parameter
//     rebuilds one module;
//   - templates fit the default plate; exported files parse back.
// Usage: node scripts/test-modular.js [count] [seed]      exits 1 on any failure
const C = require('../src/modular/catalog.js');
const L = require('../src/modular/layout.js');
const K = require('../src/modular/kernel.js');

const count = +(process.argv[2] || 60);
let seed = +(process.argv[3] || 7);
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function step(lo, hi, st) { return Math.round((lo + Math.floor(rnd() * (Math.floor((hi - lo) / st + 1e-9) + 1)) * st) * 1000) / 1000; }

/* ---------- mesh checks in plain JS ---------- */
function closedMesh(part) {
  const ix = part.indices, edges = new Map();
  if (!ix.length) return 'empty mesh';
  for (let t = 0; t < ix.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = ix[t + e], b = ix[t + (e + 1) % 3];
    if (a === b) return 'degenerate triangle';
    const k = a * 4194304 + b;
    edges.set(k, (edges.get(k) || 0) + 1);
  }
  for (const [k, c] of edges) {
    const a = Math.floor(k / 4194304), b = k % 4194304;
    if (c !== 1) return 'edge used ' + c + ' times';
    if (edges.get(b * 4194304 + a) !== 1) return 'open edge';
  }
  return null;
}
// area of faces that look down more steeply than 45 degrees (with 1 degree of slack) above the first layer
function overhangArea(part, allowedZ) {
  const p = part.positions, ix = part.indices;
  let area = 0, worst = null;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (l < 1e-9 || nz / l > -0.72) continue;
    const zc = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    if (zc < 0.02) continue;                                        // the face on the plate
    if (nz / l < -0.999 && allowedZ.some(z => Math.abs(zc - z) < 0.02)) continue;   // a declared bridge
    area += l / 2;
    if (!worst || l / 2 > worst.a) worst = { a: l / 2, z: zc, n: nz / l };
  }
  return { area, worst };
}

/* ---------- random designs ---------- */
function randomParams(type) {
  const out = {};
  C.TYPES[type].params.forEach(d => {
    if (d.type === 'toggle') out[d.key] = rnd() < 0.5;
    else if (d.type === 'select') out[d.key] = pick(d.options).value;
    else if (d.auto && rnd() < 0.5) out[d.key] = 0;
    else if (d.type === 'int') out[d.key] = d.min + Math.floor(rnd() * Math.min(4, d.max - d.min + 1));
    else out[d.key] = Math.round((d.min + (Math.min(d.max, d.min + 90) - d.min) * rnd() * rnd()) / (d.step || 1)) * (d.step || 1);
  });
  return out;
}
function randomModule(id) {
  const type = pick(['bin', 'bin', 'bin', 'block', 'stand', 'cabinet']), T = C.TYPES[type], rot = Math.floor(rnd() * 4), g5 = x => Math.ceil(x / 5) * 5;
  const wL = step(g5(T.min.w), Math.min(T.max.w, 150), 5), dL = step(g5(T.min.d), Math.min(T.max.d, 130), 5), h = step(g5(T.min.h), Math.min(T.max.h, 140), 5);
  return { id, type, name: T.label + ' ' + id, x: 0, y: 0, w: rot % 2 ? dL : wL, d: rot % 2 ? wL : dL, h, rot, params: randomParams(type) };
}
function randomSettings() {
  const s = { surface: pick(['ribbed', 'ribbed', 'smooth']), ribPitch: step(3, 9, 0.5), cornerR: pick([0, 1, 3, 8, 8, 8, 12, 20]), wall: step(1.6, 5, 0.2), floor: step(1.2, 5, 0.2),
    joint: pick(['dovetail', 'dovetail', 'dovetail', 'flat']), gap: pick([0, 0.05, 0.1, 0.15, 0.15, 0.2, 0.3, 0.5]), plate: pick([180, 256]), plateH: pick([180, 256]) };
  if (rnd() < 0.5) return s;                    // half the designs keep the default profile and finishing radii
  C.SETTINGS.forEach(d => { if (!d.label && rnd() < 0.5) s[d.key] = Math.round((d.min + (d.max - d.min) * rnd()) * 100) / 100; });
  return s;
}
// modules packed edge to edge on a 5 mm grid: each new one is pushed against a side of one already placed
function randomDesign(i) {
  const n = 1 + Math.floor(rnd() * 6), mods = [randomModule('m1')];
  for (let k = 2; k <= n; k++) {
    for (let tries = 0; tries < 30; tries++) {
      const m = randomModule('m' + k), e = pick(mods), side = Math.floor(rnd() * 4), mode = rnd();
      const along = side % 2 === 0 ? ['x', 'w'] : ['y', 'd'], span = e[along[1]], own = m[along[1]];
      const off = mode < 0.35 ? 0 : mode < 0.5 ? span - own : step(-own + 15, span - 15, 5);     // flush with an end, or anywhere along the side
      if (side === 0) { m.x = e.x + off; m.y = e.y - m.d; } else if (side === 2) { m.x = e.x + off; m.y = e.y + e.d; }
      else if (side === 1) { m.x = e.x + e.w; m.y = e.y + off; } else { m.x = e.x - m.w; m.y = e.y + off; }
      if (mods.every(o => L.overlapArea(o, m) === 0)) { mods.push(m); break; }
    }
  }
  return { version: 1, name: 'Random ' + i, settings: randomSettings(), modules: mods };
}
function awkwardDesigns() {
  const base = id => C.template(id), out = [];
  const one = (m, s) => ({ version: 1, name: 'case', settings: Object.assign({}, s || {}), modules: [Object.assign({ id: 'm1', name: 'A', x: 0, y: 0, rot: 0, params: {} }, m)] });
  let d;
  out.push(['smallest bin', one({ type: 'bin', w: 25, d: 25, h: 12 })]);
  out.push(['smallest bin, thick walls', one({ type: 'bin', w: 25, d: 25, h: 12 }, { wall: 5, floor: 5, ribPitch: 9, cornerR: 20 })]);
  out.push(['biggest bin, most cells', one({ type: 'bin', w: 320, d: 320, h: 250, params: { cols: 8, rows: 8, dividerH: 20, frontH: 10 } }, { plate: 400, plateH: 400 })]);
  out.push(['shallow sloped tray', one({ type: 'bin', w: 110, d: 100, h: 110, params: { depth: 8, rows: 3, frontH: 12 } })]);
  out.push(['low dividers on a slope', one({ type: 'bin', w: 120, d: 90, h: 60, rot: 1, params: { cols: 3, rows: 2, dividerH: 12, frontH: 20 } })]);
  out.push(['smallest block', one({ type: 'block', w: 25, d: 20, h: 12, params: { size: 60, holeDepth: 4 } })]);
  out.push(['honeycomb block, tiny holes', one({ type: 'block', w: 120, d: 90, h: 40, params: { size: 2, spacing: 1.6, stagger: true, frontH: 15 } })]);
  out.push(['slot block, long slots', one({ type: 'block', w: 150, d: 60, h: 30, rot: 2, params: { hole: 'slot', size: 2, slotL: 200, spacing: 1.6, holeDepth: 200 } })]);
  out.push(['square holes on a slope', one({ type: 'block', w: 80, d: 80, h: 90, rot: 3, params: { hole: 'square', size: 14, frontH: 30, holeDepth: 25 } })]);
  out.push(['smallest stand', one({ type: 'stand', w: 40, d: 50, h: 30, params: { slotW: 30, angle: 35, lipH: 30 } })]);
  out.push(['big stand, upright', one({ type: 'stand', w: 320, d: 200, h: 200, params: { slotW: 6, angle: 5, lipH: 6 } }, { plate: 400, plateH: 400 })]);
  out.push(['smallest cabinet', one({ type: 'cabinet', w: 45, d: 45, h: 28, params: { bays: 5 } })]);
  out.push(['tall cabinet, handles', one({ type: 'cabinet', w: 60, d: 150, h: 250, rot: 1, params: { bays: 5, pull: 'handle' } }, { plateH: 400 })]);
  out.push(['wide cabinet', one({ type: 'cabinet', w: 200, d: 80, h: 40, params: { bays: 1, pull: 'handle' } }, { plate: 256 })]);
  d = base('desk-set'); Object.assign(d.settings, { gap: 0, cornerR: 0 }); out.push(['desk set, no gap, sharp corners', d]);
  d = base('desk-set'); Object.assign(d.settings, { gap: 0.5, surface: 'smooth', cornerR: 20 }); out.push(['desk set, loose, smooth', d]);
  d = base('desk-set'); Object.assign(d.settings, { joint: 'flat', ribPitch: 3 }); out.push(['desk set, flat joints, fine ribs', d]);
  d = base('desk-set'); Object.assign(d.settings, { ribPitch: 9, wall: 1.6, floor: 1.2, chamfer: 1.2, tabDepth: 6, tabNeck: 14, tabAngle: 25 }); out.push(['desk set, coarse ribs, thin walls, big dovetails', d]);
  d = base('desk-set'); Object.assign(d.settings, { tabDepth: 1.5, tabNeck: 3, tabAngle: 5, tabChamfer: 0, chamfer: 0, rimR: 0, coveR: 0 }); out.push(['desk set, tiny dovetails, no finishing', d]);
  d = base('dock'); d.modules[1].rot = 2; out.push(['dock, stand turned to the back', d]);
  d = base('dock'); d.modules[1].rot = 1; d.modules[1].w = 80; d.modules[1].d = 85; d.modules[2].x = 140; out.push(['dock, stand turned sideways', d]);
  d = base('mail'); d.modules[2].rot = 3; out.push(['mail, shelf blocked by the sorter', d]);
  d = base('mail'); d.modules.forEach(m => { m.rot = (m.rot + 2) % 4; }); out.push(['mail, everything turned round', d]);
  // a staircase: partial contacts, T junctions and a contact that ends 1 mm from a corner
  out.push(['staircase', { version: 1, name: 'stairs', settings: { grid: 1 }, modules: [
    { id: 'a', type: 'bin', name: 'A', x: 0, y: 0, w: 60, d: 60, h: 80, rot: 0, params: {} },
    { id: 'b', type: 'bin', name: 'B', x: 60, y: 30, w: 60, d: 60, h: 50, rot: 0, params: { frontH: 20 } },
    { id: 'c', type: 'block', name: 'C', x: 120, y: 59, w: 50, d: 40, h: 50, rot: 0, params: {} },
    { id: 'd', type: 'bin', name: 'D', x: 20, y: 60, w: 40, d: 81, h: 30, rot: 0, params: {} },
    { id: 'e', type: 'cabinet', name: 'E', x: 60, y: 90, w: 70, d: 51, h: 60, rot: 2, params: {} }] }]);
  return out;
}

(async () => {
  const kernel = await K.load();
  const wasm = await (await import('manifold-3d')).default();
  wasm.setup();
  let fails = 0, designs = 0, parts = 0, pairs = 0, tris = 0, ms = 0, maxMs = 0, maxTris = 0, maxOver = 0;
  const log = [];
  function fail(name, msg) { fails++; log.push('FAIL  ' + name + ': ' + msg); }

  function checkDesign(name, design, opts) {
    opts = opts || {};
    const live = [], own = m => { live.push(m); return m; };
    const bad = msg => fail(name, msg);
    try {
      kernel.dispose();                                       // every design starts cold, so timings are honest
      const t0 = performance.now(), R = kernel.build(design), dt = performance.now() - t0, A = R.analysis, S = A.settings;
      designs++; ms += dt; maxMs = Math.max(maxMs, dt);
      if (!opts.overlapping && !A.ok) bad('layout not valid: ' + A.warnings.map(w => w.code).join(','));
      R.warnings.forEach(w => { if (w.code === 'geometry') bad('fallback block: ' + w.message); if (!w.message || !w.level || !Array.isArray(w.ids)) bad('malformed warning ' + JSON.stringify(w)); });
      if (R.stats.parts !== R.parts.length || R.stats.rebuilt.length !== A.modules.length) bad('stats do not add up');
      const g2 = S.gap / 2, tol = S.gap >= 0.04 ? 1e-4 : null, man = {};
      // --- every part on its own
      R.parts.forEach(p => {
        parts++; tris += p.triangles; maxTris = Math.max(maxTris, p.triangles);
        const M = A.byId[p.moduleId], T = C.TYPES[M.type], g = T.derive(M, S), tag = p.id + ' (' + M.type + ')';
        const err = closedMesh(p);
        if (err) { bad(tag + ' ' + err); return; }
        if (p.triangles !== p.indices.length / 3) bad(tag + ' triangle count');
        let m;
        try { m = man[p.id] = own(new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: p.positions, triVerts: p.indices }))); } catch (e) { bad(tag + ' not a manifold: ' + e.message); return; }
        if (m.status() !== 'NoError') bad(tag + ' status ' + m.status());
        const vol = m.volume(), pieces = own(m.decompose());
        if (!(vol > 1)) bad(tag + ' volume ' + vol);
        if (Math.abs(vol - p.volume) > 1e-3 * Math.max(1, vol)) bad(tag + ' reported volume ' + p.volume + ' but mesh has ' + vol);
        if (pieces.length !== 1) bad(tag + ' is ' + pieces.length + ' pieces');
        else if (m.genus() !== 0) bad(tag + ' genus ' + m.genus());
        // envelope
        const P = p.positions, e = 2e-3, x0 = M.x, x1 = M.x + M.w, y0 = M.y, y1 = M.y + M.d;
        let out = 0, reach = { front: 0, right: 0, back: 0, left: 0 }, worstOut = 0;
        const front = L.globalSideOf(M, 'front'), handle = p.role === 'drawer' && M.params.pull === 'handle' && !M.sides[front].contacts.length;
        for (let i = 0; i < P.length; i += 3) {
          const x = P[i], y = P[i + 1], z = P[i + 2];
          if (z < -e || z > M.h + e) { out++; continue; }
          const ex = { front: y0 - y, right: x - x1, back: y - y1, left: x0 - x };
          for (const sd of C.SIDES) {
            if (ex[sd] <= e) continue;
            const s = M.sides[sd], c = s.along === 'x' ? x : y;
            const inTab = p.role === 'body' && s.tabs.some(t => Math.abs(c - t.c) <= S.tabHalfHead + e && ex[sd] <= S.tabDepth - g2 + e && z <= t.h + e);
            const inHandle = handle && sd === front && ex[sd] <= 7.2 && z > p.bbox.min[2] + 0.4;
            if (inTab) reach[sd] = Math.max(reach[sd], ex[sd]);
            else if (!inHandle) { out++; worstOut = Math.max(worstOut, ex[sd]); }
          }
        }
        if (out) bad(tag + ' ' + out + ' vertices outside the footprint (by up to ' + worstOut.toFixed(3) + ' mm)');
        if (p.role === 'body') C.SIDES.forEach(sd => { if (M.sides[sd].tabs.length && reach[sd] < S.tabDepth - g2 - 0.05) bad(tag + ' tabs on the ' + sd + ' reach only ' + reach[sd].toFixed(2) + ' mm'); });
        if (p.role === 'drawer') {            // inside its bay, with the clearance asked for
          const k = +p.id.split(':drawer')[1] - 1, b = g.bays[k], lo = L.toGlobal(M, b.x0, b.y0), hi = L.toGlobal(M, b.x1, b.y1), q = S.drawerGap - 2e-3;
          const bx0 = Math.min(lo[0], hi[0]) + q, bx1 = Math.max(lo[0], hi[0]) - q, by0 = Math.min(lo[1], hi[1]) + q, by1 = Math.max(lo[1], hi[1]) - q;
          let n = 0;
          for (let i = 0; i < P.length; i += 3) {
            const sideways = front === 'front' || front === 'back' ? (P[i] < bx0 || P[i] > bx1) : (P[i + 1] < by0 || P[i + 1] > by1);
            if (sideways || P[i + 2] < b.z0 + 0.19 || P[i + 2] > b.z1 - q) n++;
          }
          if (n) bad(tag + ' ' + n + ' vertices closer than drawerGap to its bay');
          if (!p.slide || !(p.slide.travel > 0) || Math.abs(Math.hypot.apply(null, p.slide.dir) - 1) > 1e-9) bad(tag + ' slide ' + JSON.stringify(p.slide));
          else { const w = { front: [0, -1], right: [1, 0], back: [0, 1], left: [-1, 0] }[front]; if (p.slide.dir[0] !== w[0] || p.slide.dir[1] !== w[1]) bad(tag + ' slides the wrong way'); }
        } else if (p.slide !== null) bad(tag + ' body with a slide');
        // overhangs
        // print orientation: on the plate, centred
        const pm = kernel.printMesh(p), q = pm.positions;
        let zmin = Infinity, a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (let i = 0; i < q.length; i += 3) { a0 = Math.min(a0, q[i]); a1 = Math.max(a1, q[i]); b0 = Math.min(b0, q[i + 1]); b1 = Math.max(b1, q[i + 1]); zmin = Math.min(zmin, q[i + 2]); }
        if (Math.abs(zmin) > 1e-4 || Math.abs(a0 + a1) > 1e-3 || Math.abs(b0 + b1) > 1e-3) bad(tag + ' print mesh not centred on the plate');
        if (p.print.fits && (a1 - a0 > S.plate - 2 + 0.01 || b1 - b0 > S.plate - 2 + 0.01)) bad(tag + ' print mesh is ' + (a1 - a0).toFixed(1) + ' x ' + (b1 - b0).toFixed(1) + ' on a ' + S.plate + ' plate');
        // overhangs, as printed
        const bridges = M.type === 'cabinet' && p.role === 'body' ? g.bays.map(b => b.z1) : [];
        const oh = overhangArea(pm, bridges);
        maxOver = Math.max(maxOver, oh.area);
        if (oh.area > 0.5) bad(tag + ' overhang ' + oh.area.toFixed(2) + ' mm2 (worst at z ' + oh.worst.z.toFixed(2) + ', nz ' + oh.worst.n.toFixed(3) + ')');
        if (p.print.bridge !== (M.type === 'cabinet' && p.role === 'body' ? g.span : 0)) bad(tag + ' bridge ' + p.print.bridge);
        const f = L.fitRect(p.bbox.max[0] - p.bbox.min[0], p.bbox.max[1] - p.bbox.min[1], S.plate, p.bbox.max[2] - p.bbox.min[2], S.plateH);
        if (f.fits !== p.print.fits || f.angle !== p.print.angle) bad(tag + ' print fit');
        if (opts.mustFit && !p.print.fits) bad(tag + ' does not fit the plate');
      });
      if (opts.overlapping) return R;
      // --- parts against each other
      const inter = (a, b) => { const r = own(a.intersect(b)); return r.isEmpty() ? 0 : r.volume(); };
      const near = (p, q, m) => p.bbox.min[0] < q.bbox.max[0] + m && q.bbox.min[0] < p.bbox.max[0] + m && p.bbox.min[1] < q.bbox.max[1] + m && q.bbox.min[1] < p.bbox.max[1] + m;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
      for (let i = 0; i < R.parts.length; i++) for (let j = i + 1; j < R.parts.length; j++) {
        const p = R.parts[i], q = R.parts[j];
        if (!man[p.id] || !man[q.id] || !near(p, q, 1)) continue;
        const what = p.id + ' / ' + q.id;
        if (p.moduleId === q.moduleId) { const v0 = inter(man[p.id], man[q.id]); if (v0 > 1e-6) bad(what + ' intersect by ' + v0.toFixed(4) + ' mm3'); continue; }
        pairs++;
        // with no gap at all the faces coincide, and float32 coordinates may disagree by a hair
        const cap = tol !== null ? tol : 4e-5 * (p.bbox.max[2] + q.bbox.max[2]) * (A.size.w + A.size.d) + 0.01;
        const v = inter(man[p.id], man[q.id]);
        if (v > cap) bad(what + ' intersect by ' + v.toFixed(4) + ' mm3');
        if (tol !== null) for (const d of dirs) {
          const vs = inter(own(man[p.id].translate([d[0] * 0.6 * S.gap, d[1] * 0.6 * S.gap, 0])), man[q.id]);
          if (vs > tol) { bad(what + ' intersect by ' + vs.toFixed(4) + ' mm3 when nudged ' + d + ' by 60% of the gap'); break; }
        }
      }
      // --- dovetails hold: pulled apart across the joint, tab and slot collide
      A.joints.forEach(J => {
        if (!J.tabs.length || !man[J.owner] || !man[J.other]) return;
        const under = S.tabDepth * Math.tan(S.tabAngle * Math.PI / 180) - S.gap / Math.cos(S.tabAngle * Math.PI / 180);
        if (under < 0.08) return;                              // this profile and gap cannot lock; nothing to check
        const d = -J.dir * 0.8 * S.tabDepth, v = inter(own(man[J.owner].translate(J.axis === 'x' ? [d, 0, 0] : [0, d, 0])), man[J.other]);
        if (!(v > 1e-3)) bad('joint ' + J.a + '/' + J.b + ' pulls straight apart');
      });
      // --- lift each module straight up
      A.modules.forEach(M => {
        const mine = R.byModule[M.id].filter(p => man[p.id]);
        for (const dz of [0.7, 4, 19, 55, 140]) {
          let hit = null;
          mine.forEach(p => {
            const up = own(man[p.id].translate([0, 0, dz]));
            R.parts.forEach(q => {
              if (hit || q.moduleId === M.id || !man[q.id] || !near(p, q, 1)) return;
              const v = inter(up, man[q.id]);
              if (v > (tol !== null ? tol : 4e-5 * (p.bbox.max[2] + q.bbox.max[2]) * (A.size.w + A.size.d) + 0.01)) hit = q.id + ' by ' + v.toFixed(4) + ' mm3';
            });
          });
          if (hit) { bad(M.id + ' lifted ' + dz + ' mm hits ' + hit); break; }
        }
      });
      // --- pull each drawer out
      R.parts.forEach(p => {
        if (p.role !== 'drawer' || !man[p.id] || !man[p.moduleId] || !p.slide) return;
        for (let k = 1; k <= 8; k++) {
          const t = p.slide.travel * k / 6, v = inter(own(man[p.id].translate([p.slide.dir[0] * t, p.slide.dir[1] * t, 0])), man[p.moduleId]);
          if (v > 1e-6) { bad(p.id + ' pulled out ' + t.toFixed(0) + ' mm hits its cabinet by ' + v.toFixed(4) + ' mm3'); break; }
        }
      });
      return R;
    } catch (e) { bad('threw ' + (e && e.stack || e)); return null; } finally { live.forEach(m => { try { m.delete(); } catch (e) { /* freed twice */ } }); }
  }

  // templates: everything above, and every part fits the default plate
  C.TEMPLATES.forEach(t => checkDesign('template ' + t.id, C.template(t.id), { mustFit: true }));
  awkwardDesigns().forEach(c => checkDesign(c[0], c[1]));
  for (let i = 0; i < count; i++) { const d = randomDesign(i); checkDesign('random ' + i + ' ' + JSON.stringify(d), d); }

  // overlapping modules: reported by the analysis, still built one by one
  {
    const d = C.template('desk-set'); d.modules[2].x -= 20; d.modules[3].y -= 15;
    const R = checkDesign('overlapping modules', d, { overlapping: true });
    if (R && R.analysis.ok) fail('overlapping modules', 'analysis did not notice');
    if (R && R.parts.length !== 7) fail('overlapping modules', R.parts.length + ' parts');
  }
  // warnings: a wide cabinet gets the bridge warning
  {
    const R = kernel.build({ version: 1, settings: { plate: 256 }, modules: [{ id: 'm1', type: 'cabinet', name: 'Wide', x: 0, y: 0, w: 200, d: 80, h: 60, rot: 0, params: {} }] });
    if (!R.warnings.some(w => w.code === 'bridge' && w.ids[0] === 'm1' && /Wide/.test(w.message))) fail('bridge warning', 'missing');
    const R2 = kernel.build(C.template('desk-set'));
    if (R2.warnings.length) fail('desk-set warnings', JSON.stringify(R2.warnings));
  }
  // cache
  {
    kernel.dispose();
    const d = C.template('desk-set'), a = kernel.build(d), b = kernel.build(C.clone(d));
    if (a.stats.rebuilt.length !== 5 || a.stats.reused !== 0) fail('cache', 'cold build ' + JSON.stringify(a.stats.rebuilt));
    if (b.stats.rebuilt.length !== 0 || b.stats.reused !== 5) fail('cache', 'unchanged design rebuilt ' + JSON.stringify(b.stats.rebuilt));
    a.parts.forEach((p, i) => { const q = b.parts[i]; if (p.key !== q.key || p.positions !== q.positions || p.indices !== q.indices) fail('cache', p.id + ' is not the same mesh on the second build'); });
    const e = C.clone(d); e.modules[3].params.size = 10;                       // the pen block's hole size: nobody else cares
    const c = kernel.build(e);
    if (c.stats.rebuilt.join() !== 'm4' || c.stats.reused !== 4) fail('cache', 'one parameter rebuilt ' + JSON.stringify(c.stats.rebuilt));
    c.parts.forEach((p, i) => { const same = p.positions === a.parts[i].positions && p.key === a.parts[i].key; if (same !== (p.moduleId !== 'm4')) fail('cache', p.id + (same ? ' was not rebuilt' : ' was rebuilt')); });
    const f = C.clone(d); f.modules[1].h = 40;                                 // a taller tray: its neighbours' dovetails change with it
    const g = kernel.build(f);
    if (g.stats.rebuilt.indexOf('m2') < 0 || g.stats.rebuilt.indexOf('m5') >= 0) fail('cache', 'height change rebuilt ' + JSON.stringify(g.stats.rebuilt));
    const h = C.clone(d); h.modules.forEach(m => { m.x += 35; m.y -= 20; });   // the whole design moved: same meshes, shifted
    const m = kernel.build(h);
    if (m.stats.rebuilt.length !== 0) fail('cache', 'moving the design rebuilt ' + JSON.stringify(m.stats.rebuilt));
    m.parts.forEach((p, i) => { if (p.key === a.parts[i].key || Math.abs(p.bbox.min[0] - a.parts[i].bbox.min[0] - 35) > 1e-3 || Math.abs(p.positions[1] - a.parts[i].positions[1] + 20) > 1e-3) fail('cache', p.id + ' moved wrongly'); });
    const s = C.clone(d); s.settings.plate = 256;                              // the plate only changes the print advice
    if (kernel.build(s).stats.rebuilt.length !== 0) fail('cache', 'plate size rebuilt geometry');
    for (let i = 0; i < 300; i++) { const t = C.clone(d); t.modules[0].h = 60 + i * 0.1; kernel.build(t); }   // a long slider drag stays bounded (and must not crash)
  }
  // export
  {
    const d = C.template('desk-set'), R = kernel.build(d), files = kernel.exportFiles(R, d), names = files.map(f => f.name);
    const want = ['01-drawers-100x100x70.stl', '01-drawers-drawer-1.stl', '01-drawers-drawer-2.stl', '02-tray-100x40x25.stl', '03-pens-50x60x95.stl', '04-pen-block-50x60x70.stl', '05-notebooks-200x40x100.stl', 'design.json', 'README.txt'];
    if (names.join() !== want.join()) fail('export', 'file names ' + names.join(' '));
    files.forEach((f, i) => {
      if (!/\.stl$/.test(f.name)) return;
      const dv = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength), n = dv.getUint32(80, true), p = R.parts[i];
      if (n !== p.triangles || f.data.length !== 84 + 50 * n) fail('export', f.name + ' has ' + n + ' triangles, part has ' + p.triangles);
      let zmin = Infinity, zmax = -Infinity, vol = 0;
      for (let t = 0; t < n; t++) {
        const o = 84 + 50 * t + 12, v = [];
        for (let k = 0; k < 9; k++) v.push(dv.getFloat32(o + 4 * k, true));
        zmin = Math.min(zmin, v[2], v[5], v[8]); zmax = Math.max(zmax, v[2], v[5], v[8]);
        vol += (v[0] * (v[4] * v[8] - v[5] * v[7]) - v[1] * (v[3] * v[8] - v[5] * v[6]) + v[2] * (v[3] * v[7] - v[4] * v[6])) / 6;
      }
      if (Math.abs(zmin) > 1e-4 || Math.abs(zmax - p.print.size[2]) > 1e-3) fail('export', f.name + ' is not sitting on the plate');
      if (Math.abs(vol - p.volume) > 1e-3 * p.volume) fail('export', f.name + ' volume ' + vol + ' vs ' + p.volume);
    });
    const back = C.parse(files[files.length - 2].data);
    if (JSON.stringify(back) !== JSON.stringify(C.normalizeDesign(d))) fail('export', 'design.json does not parse back to the design');
    const txt = files[files.length - 1].data;
    if (typeof txt !== 'string' || names.slice(0, -2).some(n => txt.indexOf(n) < 0) || !/dovetail/i.test(txt) || !/support/i.test(txt)) fail('export', 'README is missing parts or advice');
    const z = kernel.zip(files), zv = new DataView(z.buffer);
    if (zv.getUint32(0, true) !== 0x04034b50 || zv.getUint16(z.length - 22 + 10, true) !== files.length) fail('export', 'zip is malformed');
    if (kernel.toSTL(R.parts[0]).length !== kernel.toSTL(R.parts[0], { print: true }).length) fail('export', 'toSTL');
  }
  // speed (Node, cold cache; the first build above already warmed the JIT)
  let cold = Infinity, warm = Infinity;
  for (let i = 0; i < 5; i++) {
    kernel.dispose();
    const d = C.template('desk-set'); let t = performance.now(); kernel.build(d); cold = Math.min(cold, performance.now() - t);
    d.modules[2].params.depth = 40 + i; t = performance.now(); kernel.build(d); warm = Math.min(warm, performance.now() - t);
  }
  if (cold > 400) fail('speed', 'desk-set takes ' + cold.toFixed(0) + ' ms cold');
  if (warm > 80) fail('speed', 'one changed module takes ' + warm.toFixed(0) + ' ms');

  log.slice(0, 40).forEach(l => console.log(l.length > 900 ? l.slice(0, 900) + ' ...' : l));
  if (log.length > 40) console.log('... and ' + (log.length - 40) + ' more');
  console.log(`${designs} designs, ${parts} parts, ${pairs} neighbour pairs, ${fails} failures; avg build ${(ms / designs).toFixed(0)} ms (max ${maxMs.toFixed(0)}), ` +
    `largest part ${maxTris} triangles, worst overhang ${maxOver.toFixed(3)} mm2; desk-set ${cold.toFixed(0)} ms cold, ${warm.toFixed(0)} ms after one change`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
