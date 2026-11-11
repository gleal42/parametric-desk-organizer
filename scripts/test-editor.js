// Tests for src/modular/editor.js: node scripts/test-editor.js [random steps] [seed]
// Exits 1 on the first failed expectation of the random run, or at the end when any named test failed.
const C = require('../src/modular/catalog.js');
const L = require('../src/modular/layout.js');
const E = require('../src/modular/editor.js');

let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + String(e && e.message || e).split('\n').join('\n     ')); }
}
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((what || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function yes(v, what) { if (!v) throw new Error(what || 'expected a truthy value'); }
const mod = (D, id) => D.modules.filter(m => m.id === id)[0];
const frozen = d => JSON.stringify(d);

// what "a valid design" means for every result of the editor
function valid(D, why) {
  const at = why ? ' after ' + why : '';
  if (frozen(C.normalizeDesign(D)) !== frozen(D)) throw new Error('not a normalised design' + at);
  const ids = {};
  D.modules.forEach(m => {
    if (ids[m.id]) throw new Error('duplicate id ' + m.id + at);
    ids[m.id] = 1;
    const T = C.TYPES[m.type], odd = m.rot % 2 === 1, lim = E.limits(m);
    eq(lim, { w: [odd ? T.min.d : T.min.w, odd ? T.max.d : T.max.w], d: [odd ? T.min.w : T.min.d, odd ? T.max.w : T.max.d], h: [T.min.h, T.max.h] }, 'limits');
    ['w', 'd', 'h'].forEach(k => { if (m[k] < lim[k][0] - 1e-9 || m[k] > lim[k][1] + 1e-9) throw new Error(m.id + '.' + k + ' = ' + m[k] + ' is outside ' + lim[k] + at); });
    ['x', 'y', 'w', 'd', 'h'].forEach(k => { if (!isFinite(m[k]) || Math.abs(m[k] * 10 - Math.round(m[k] * 10)) > 1e-6) throw new Error(m.id + '.' + k + ' = ' + m[k] + ' is not a clean number' + at); });
  });
  for (let i = 0; i < D.modules.length; i++) for (let j = i + 1; j < D.modules.length; j++) {
    if (L.overlapArea(D.modules[i], D.modules[j]) > 0) throw new Error(D.modules[i].id + ' and ' + D.modules[j].id + ' overlap' + at + '\n' + frozen(D.modules.map(m => [m.id, m.x, m.y, m.w, m.d])));
  }
  const A = L.analyze(D);
  if (!A.ok || A.warnings.some(w => w.code === 'overlap')) throw new Error('the layout analysis reports an overlap' + at);
  const chk = E.check(D);
  if (!chk.ok) throw new Error('check() disagrees' + at + ': ' + frozen(chk));
}
// run an edit; the input must come back untouched, the output must be valid
function run(name, D, fn) {
  const before = frozen(D), r = fn(D);
  if (frozen(D) !== before) throw new Error(name + ' changed the design it was given');
  yes(r && typeof r.ok === 'boolean' && r.design, name + ' returned no result');
  if (r.ok) valid(r.design, name); else { yes(r.reason, name + ' was refused without a reason'); yes(r.design === D, name + ' was refused but did not hand back the same design'); }
  return r;
}
const desk = () => C.template('desk-set');

/* ---------- snapping and free spots ---------- */
test('snap', () => {
  eq(E.snap(12.4, 5), 10); eq(E.snap(12.5, 5), 15); eq(E.snap(-7.6, 5), -10); eq(E.snap(3.26, 1), 3); eq(E.snap(14, 10), 10); eq(E.snap(3.33, 0), 3);
});
test('limits swap when a module is turned', () => {
  const m = { type: 'stand', rot: 0 }, t = { type: 'stand', rot: 1 };
  eq(E.limits(m), { w: [40, 320], d: [50, 200], h: [30, 200] });
  eq(E.limits(t), { w: [50, 200], d: [40, 320], h: [30, 200] });
});
test('freeSpot: the spot itself when free, otherwise the nearest flush one', () => {
  const D = desk();
  eq(E.freeSpot(D.modules, { x: 300, y: 0, w: 50, d: 50 }), { x: 300, y: 0, dist: 0 });
  const s = E.freeSpot(D.modules, { x: 190, y: 10, w: 50, d: 50 });     // overlaps the tray's right end by 10
  eq([s.x, s.y], [200, 10]);
  yes(E.isFree(D.modules, { x: s.x, y: s.y, w: 50, d: 50 }), 'the spot found is free');
  // brute force over a fine lattice never finds a nearer free place
  const rect = { x: 60, y: 50, w: 40, d: 30 }, got = E.freeSpot(D.modules, rect);
  let best = Infinity;
  for (let x = -60; x <= 260; x += 1) for (let y = -60; y <= 200; y += 1) if (E.isFree(D.modules, { x, y, w: 40, d: 30 })) best = Math.min(best, Math.hypot(x - rect.x, y - rect.y));
  yes(got.dist <= best + 1e-6, 'freeSpot found ' + got.dist + ' but ' + best + ' was possible');
  eq(E.freeSpot(D.modules, { x: 60, y: 50, w: 40, d: 30 }, undefined, 5), null, 'maxDist');
});
test('snapMove: grid, flush and aligned edges', () => {
  const D = desk();
  let p = E.snapMove(D, 'm4', 302.3, -41.2);                  // far from everything: the 5 mm grid
  eq([p.x, p.y, p.kind.x], [300, -40, 'grid']);
  p = E.snapMove(D, 'm4', 203.4, 38);                         // next to the tray's and pen block's right side: flush and level
  eq([p.x, p.kind.x], [200, 'flush']); yes(p.guides.length >= 1, 'a guide for the flush edge');
  const off = E.move(D, 'm2', 100, -43, { snap: false }).design;      // tray 3 mm clear of the others, off the grid
  p = E.snapMove(off, 'm4', 203, -44.6);                      // pen block beside it: flush in x, level with its off-grid front
  eq([p.x, p.y, p.kind.x], [200, -43, 'flush']);
  p = E.snapMove(off, 'm4', 203, -44.6, { snap: false });
  eq([p.x, p.y], [203, -44.6]);
  eq(E.snapMove(D, 'nope', 1.26, 2).x, 1.26);
});

/* ---------- ids and names ---------- */
test('ids and names stay unique', () => {
  let D = desk();
  eq(E.newId(D), 'm6');
  eq(E.uniqueName(D, 'Pens'), 'Pens 2');
  eq(E.uniqueName(D, 'Whatever'), 'Whatever');
  D = run('duplicate', D, d => E.duplicate(d, 'm3')).design;
  eq(mod(D, 'm6').name, 'Pens 2');
  D = run('duplicate', D, d => E.duplicate(d, 'm6')).design;
  eq(mod(D, 'm7').name, 'Pens 3');
  D = run('remove', D, d => E.remove(d, 'm6')).design;
  eq(E.newId(D), 'm8');
  eq(E.uniqueName(D, 'Pens', 'm3'), 'Pens');
});

/* ---------- add ---------- */
test('add: every preset lands attached, free and unblocked', () => {
  C.PRESETS.forEach(p => {
    const r = run('add ' + p.id, desk(), d => E.add(d, p.id, { near: 'm3' }));
    yes(r.ok && r.id === 'm6', 'added');
    const A = L.analyze(r.design), M = A.byId.m6;
    yes(A.joints.some(J => (J.a === 'm6' || J.b === 'm6') && J.tabs.length), p.id + ' is not dovetailed to anything');
    yes(!A.warnings.some(w => w.code === 'blocked'), p.id + ' blocks a cabinet (or is blocked)');
    yes(M.warnings.indexOf('loose') < 0, p.id + ' is loose');
    eq(M.type, p.type);
  });
});
test('add: prefers the selected module, an empty design starts at the origin', () => {
  let r = run('add', desk(), d => E.add(d, 'pen-cup', { near: 'm5' }));
  yes(E.contactLength(mod(r.design, 'm6'), mod(r.design, 'm5')) > 20, 'touches the notebook slot it was added to');
  r = run('add', { version: 1, name: 'x', settings: {}, modules: [] }, d => E.add(d, 'tray'));
  eq([mod(r.design, 'm1').x, mod(r.design, 'm1').y], [0, 0]);
  r = run('add', desk(), d => E.add(d, 'tray', { at: { x: 52, y: 48 } }));          // on top of the drawers: nearest free spot
  yes(r.ok);
  eq(run('add', desk(), d => E.add(d, 'no-such-preset')).ok, false);
});
test('add: never in front of a cabinet', () => {
  let D = { version: 1, name: 'x', settings: {}, modules: [C.fromPreset('drawers', 'm1', 0, 0)] };
  for (let i = 0; i < 6; i++) {
    D = run('add', D, d => E.add(d, i % 2 ? 'drawers' : 'tray', { near: 'm1' })).design;
    yes(!L.analyze(D).warnings.some(w => w.code === 'blocked'), 'step ' + i + ' blocked a cabinet');
  }
});

/* ---------- move, nudge ---------- */
test('move: snaps, settles when dropped on a module, reports no change', () => {
  const D = desk();
  let r = run('move', D, d => E.move(d, 'm4', 251.7, 38.2));
  eq([mod(r.design, 'm4').x, mod(r.design, 'm4').y, r.settled], [250, 40, false]);
  r = run('move', D, d => E.move(d, 'm4', 20, 20));                   // onto the drawers
  yes(r.ok && r.settled, 'settled');
  r = run('move', D, d => E.move(d, 'm4', 150, 40));
  eq([r.ok, r.reason], [false, 'same']);
  r = run('move', D, d => E.move(d, 'm4', 30, 30, { maxDist: 3 }));
  eq([r.ok, r.reason], [false, 'blocked']);
  eq(run('move', D, d => E.move(d, 'ghost', 0, 0)).reason, 'missing');
});
test('nudge: one grid step, refused into a neighbour, lands on the grid', () => {
  const D = desk();
  let r = run('nudge', D, d => E.nudge(d, 'm4', 1, 0));
  eq(mod(r.design, 'm4').x, 155);
  r = run('nudge', D, d => E.nudge(d, 'm4', -1, 0));
  eq([r.ok, r.reason, r.by], [false, 'blocked', ['m3']]);
  const off = E.move(D, 'm4', 252.3, 40, { snap: false }).design;
  eq(mod(E.nudge(off, 'm4', 1, 0).design, 'm4').x, 255);
  eq(mod(E.nudge(off, 'm4', -1, 0).design, 'm4').x, 250);
  const g10 = E.setSetting(D, 'grid', 10).design;
  eq(mod(E.nudge(g10, 'm5', 0, 1).design, 'm5').y, 110);
  eq(E.nudge(D, 'm4', 0, 0).reason, 'same');
});

/* ---------- resize ---------- */
test('resize: growing pushes the whole row, shrinking pulls it back', () => {
  const D = desk();
  let r = run('resize', D, d => E.resize(d, 'm1', 'right', 121));           // drawers 100 -> 120 wide
  eq([mod(r.design, 'm1').w, mod(r.design, 'm2').x, mod(r.design, 'm3').x, mod(r.design, 'm4').x, mod(r.design, 'm5').x], [120, 120, 120, 170, 0]);
  eq(r.moved.slice().sort(), ['m2', 'm3', 'm4']);
  const back = run('resize', r.design, d => E.resize(d, 'm1', 'right', 100));
  eq(back.design.modules, D.modules, 'shrinking again restores the layout');
  r = run('resize', D, d => E.resize(d, 'm1', 'right', 80));
  eq([mod(r.design, 'm1').w, mod(r.design, 'm2').x, mod(r.design, 'm4').x], [80, 80, 130]);
  r = run('resize', D, d => E.resize(d, 'm1', 'right', 80, { pull: false }));
  eq([mod(r.design, 'm2').x, r.moved], [100, []]);
});
test('resize: a module that cannot follow stays', () => {
  const D = desk();
  const r = run('resize', D, d => E.resize(d, 'm1', 'back', 80));           // drawers 100 -> 80 deep; the notebook slot also rests on the pen cup
  eq([mod(r.design, 'm1').d, mod(r.design, 'm5').y], [80, 100]);
});
test('resize: the near sides, limits, snapping to a neighbour', () => {
  const D = desk();
  let r = run('resize', D, d => E.resize(d, 'm1', 'left', -22));
  eq([mod(r.design, 'm1').x, mod(r.design, 'm1').w, r.moved], [-20, 120, []]);
  r = run('resize', D, d => E.resize(d, 'm3', 'front', 28));                // pen cup grows forwards into the tray
  eq([mod(r.design, 'm3').y, mod(r.design, 'm3').d], [30, 70]);
  yes(mod(r.design, 'm2').y + mod(r.design, 'm2').d <= 30 + 1e-9, 'the tray was pushed forwards');
  r = run('resize', D, d => E.resize(d, 'm1', 'right', 9999));
  eq([mod(r.design, 'm1').w, r.limited], [320, true]);
  r = run('resize', D, d => E.resize(d, 'm1', 'right', -50));
  eq(mod(r.design, 'm1').w, 45);
  eq(run('resize', r.design, d => E.resize(d, 'm1', 'right', -50)).reason, 'limit');
  eq(run('resize', D, d => E.resize(d, 'm1', 'right', 100)).reason, 'same');
  eq(run('resize', D, d => E.resize(d, 'm1', 'top', 100)).ok, false);
  const off = E.move(D, 'm4', 252.3, 40, { snap: false }).design;           // pen block away, off the grid: 252.3 .. 302.3
  r = run('resize', off, d => E.resize(d, 'm5', 'right', 253.5));           // the notebook slot's right end catches its left edge
  eq(mod(r.design, 'm5').w, 252.3);
  r = run('resize', off, d => E.resize(d, 'm5', 'right', 253.5, { snap: false }));
  eq(mod(r.design, 'm5').w, 253.5);
});
test('setSize: grows into open space, keeps height separate', () => {
  const D = desk();
  eq(E.pickEdge(D, 'm1', 'w'), 'left'); eq(E.pickEdge(D, 'm1', 'd'), 'front');
  eq(E.pickEdge(D, 'm4', 'w'), 'right'); eq(E.pickEdge(D, 'm3', 'w'), 'right'); eq(E.pickEdge(D, 'm5', 'd'), 'back');
  let r = run('setSize', D, d => E.setSize(d, 'm1', 'w', 130));
  eq([mod(r.design, 'm1').x, mod(r.design, 'm1').w, r.edge, r.moved], [-30, 130, 'left', []]);
  r = run('setSize', D, d => E.setSize(d, 'm3', 'w', 70));                  // neighbours on both sides: pushes the pen block
  eq([mod(r.design, 'm3').w, mod(r.design, 'm4').x], [70, 170]);
  r = run('setSize', D, d => E.setSize(d, 'm1', 'w', 130, { edge: 'right' }));
  eq([mod(r.design, 'm1').x, mod(r.design, 'm2').x], [0, 130]);
  r = run('setSize', D, d => E.setSize(d, 'm3', 'h', 400));
  eq([mod(r.design, 'm3').h, mod(r.design, 'm3').w], [250, 50]);
  eq(run('setSize', D, d => E.setSize(d, 'm3', 'h', 95)).reason, 'same');
  eq(run('setSize', r.design, d => E.setSize(d, 'm3', 'h', 400)).reason, 'limit');
});

/* ---------- rotate ---------- */
test('rotate: a quarter turn swaps width and depth, four turns come home', () => {
  let D = { version: 1, name: 'x', settings: {}, modules: [C.fromPreset('tablet', 'm1', 0, 0)] };
  D = run('rotate', D, d => E.rotate(d, 'm1')).design;
  eq([mod(D, 'm1').rot, mod(D, 'm1').w, mod(D, 'm1').d], [1, 95, 170]);
  for (let i = 0; i < 3; i++) D = run('rotate', D, d => E.rotate(d, 'm1')).design;
  eq([mod(D, 'm1').rot, mod(D, 'm1').w, mod(D, 'm1').d], [0, 170, 95]);
  D = run('rotate', D, d => E.rotate(d, 'm1', -1)).design;
  eq(mod(D, 'm1').rot, 3);
});
test('rotate: stays attached where it can, never overlaps', () => {
  const D = desk();
  C.TEMPLATES.forEach(t => {
    let T = C.template(t.id);
    T.modules.forEach(m => { T = run('rotate ' + t.id + '/' + m.id, T, d => E.rotate(d, m.id)).design; });
  });
  const r = run('rotate', D, d => E.rotate(d, 'm2'));                        // tray 100 x 40 -> 40 x 100 between its neighbours
  const t = mod(r.design, 'm2');
  yes(r.design.modules.some(o => o.id !== 'm2' && E.contactLength(t, o) > 0), 'the turned tray still touches something');
});

/* ---------- fields ---------- */
test('rename, setParam, settings, name', () => {
  const D = desk();
  eq(mod(run('rename', D, d => E.rename(d, 'm3', '  Felt   tips ')).design, 'm3').name, 'Felt tips');
  eq(mod(E.rename(D, 'm3', '').design, 'm3').name, 'Compartment');
  eq(E.rename(D, 'm3', 'Pens').reason, 'same');
  eq(mod(E.rename(D, 'm3', 'x'.repeat(80)).design, 'm3').name.length, 30);
  let r = run('setParam', D, d => E.setParam(d, 'm3', 'cols', 2));
  eq(L.analyze(r.design).byId.m3.params.cols, 2);
  eq(run('setParam', r.design, d => E.setParam(d, 'm3', 'cols', 2)).reason, 'same');
  eq(run('setParam', D, d => E.setParam(d, 'm3', 'bogus', 2)).ok, false);
  eq(run('setParam', D, d => E.setParam(d, 'm3', 'cols', 'abc')).ok, false);
  eq(mod(E.setParam(D, 'm1', 'drawers', 0).design, 'm1').params.drawers, false);
  eq(mod(E.setParam(D, 'm4', 'hole', 'slot').design, 'm4').params.hole, 'slot');
  r = run('setSettings', D, d => E.setSettings(d, { plate: 256, plateH: 256, nonsense: 3 }));
  eq([r.design.settings.plate, r.design.settings.plateH, 'nonsense' in r.design.settings], [256, 256, false]);
  eq(E.setSetting(D, 'wall', 99).design.settings.wall, 5);
  eq(E.setSetting(D, 'surface', 'smooth').design.settings.surface, 'smooth');
  eq(E.setSetting(D, 'surface', 'ribbed').reason, 'same');
  eq(E.setName(D, '  Desk   two ').design.name, 'Desk two');
  eq(E.setName(D, 'Desk set').reason, 'same');
});
test('separate: moves overlapping modules apart', () => {
  const D = desk();
  D.modules[2].x = 60; D.modules[3].x = 90; D.modules[3].y = 20;             // pile three modules up
  yes(!E.check(D).ok, 'the test layout overlaps');
  const r = E.separate(D);
  yes(r.ok && r.moved.length >= 1); valid(r.design, 'separate');
  eq(E.separate(r.design).reason, 'same');
  eq(E.check(D).overlaps.length > 0, true);
  const bad = C.normalizeDesign(desk()); bad.modules[0].w = 5;               // check() also reports sizes outside the limits
  eq(E.check({ version: 1, modules: [] }).ok, true);
});
test('every edit refuses an unknown module', () => {
  const D = desk();
  [d => E.duplicate(d, 'zz'), d => E.remove(d, 'zz'), d => E.move(d, 'zz', 0, 0), d => E.nudge(d, 'zz', 1, 0), d => E.resize(d, 'zz', 'left', 0),
    d => E.setSize(d, 'zz', 'w', 50), d => E.rotate(d, 'zz'), d => E.rename(d, 'zz', 'a'), d => E.setParam(d, 'zz', 'cols', 2)]
    .forEach((fn, i) => eq(run('edit ' + i, D, fn).reason, 'missing', 'edit ' + i));
});

/* ---------- history ---------- */
test('history: undo, redo, one step per slider drag', () => {
  const H = E.history, a = desk(), b = E.nudge(a, 'm4', 1, 0).design, c = E.nudge(b, 'm4', 1, 0).design, d = E.nudge(c, 'm4', 1, 0).design;
  let h = H.create(a);
  eq([H.canUndo(h), H.canRedo(h)], [false, false]);
  yes(H.undo(h) === h && H.redo(h) === h, 'nothing to undo or redo');
  h = H.push(h, b); h = H.push(h, c);
  eq([h.past.length, H.canUndo(h)], [2, true]);
  yes(H.push(h, C.clone(c)) === h, 'pushing an unchanged design does nothing');
  h = H.undo(h); yes(h.present === b && H.canRedo(h));
  h = H.redo(h); yes(h.present === c && !H.canRedo(h));
  h = H.undo(H.undo(h)); yes(h.present === a);
  h = H.push(h, d); eq([h.future.length, h.past.length], [0, 1], 'a new edit drops the redo steps');
  // a drag: many pushes with one key are one step
  h = H.create(a);
  h = H.push(h, b, 'drag'); h = H.push(h, c, 'drag'); h = H.push(h, d, 'drag');
  eq(h.past.length, 1); yes(H.undo(h).present === a);
  h = H.seal(h); h = H.push(h, c, 'drag');
  eq(h.past.length, 2, 'after seal() the same key starts a new step');
  h = H.push(H.create(a), b, 'drag'); h = H.push(h, C.clone(a), 'drag');
  eq([h.past.length, frozen(h.present) === frozen(a)], [0, true], 'a drag that ends where it began leaves no step');
  h = H.push(H.create(a), b, 'x'); h = H.push(h, c, 'y');
  eq(h.past.length, 2, 'a different key is a new step');
  h = H.create(a);
  for (let i = 0; i < 300; i++) h = H.push(h, E.setName(a, 'n' + i).design);
  yes(h.past.length <= 120, 'the history is capped');
});

/* ---------- random runs ----------
   Whatever sequence of edits is thrown at it, the editor never returns overlapping modules, a size outside the
   type's limits, or a design that is not normalised; and undo walks back through exactly the designs it made. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randomRun(steps, seed) {
  const R = rng(seed), pick = a => a[Math.floor(R() * a.length)], between = (a, b) => a + R() * (b - a);
  const templates = C.TEMPLATES.map(t => t.id), edges = ['left', 'right', 'front', 'back'];
  let D = C.template(pick(templates)), h = E.history.create(D), applied = 0, refused = 0, log = [];
  const counts = {};
  const ops = {
    add: () => E.add(D, pick(C.PRESETS).id, R() < 0.7 && D.modules.length ? { near: pick(D.modules).id } : R() < 0.5 ? { at: { x: between(-100, 400), y: between(-100, 400) } } : {}),
    duplicate: id => E.duplicate(D, id),
    remove: id => D.modules.length > 2 || R() < 0.1 ? E.remove(D, id) : E.nudge(D, id, 0, 0),
    move: id => { const b = E.boundsOf(D.modules); return E.move(D, id, between(b.x0 - 80, b.x1 + 40), between(b.y0 - 80, b.y1 + 40), R() < 0.2 ? { snap: false } : R() < 0.3 ? { tol: between(0, 15) } : {}); },
    nudge: id => E.nudge(D, id, pick([-1, 0, 1]), pick([-1, 0, 1])),
    resize: id => { const m = mod(D, id), e = pick(edges), at = e === 'left' ? m.x : e === 'right' ? m.x + m.w : e === 'front' ? m.y : m.y + m.d; return E.resize(D, id, e, at + between(-90, 90), R() < 0.2 ? { snap: false } : R() < 0.2 ? { pull: false } : {}); },
    resizeFar: id => E.resize(D, id, pick(edges), between(-600, 600)),
    setSize: id => E.setSize(D, id, pick(['w', 'd', 'h']), between(0, 340), R() < 0.3 ? { edge: pick(edges.slice(0, 2)) } : {}),
    rotate: id => E.rotate(D, id, R() < 0.3 ? -1 : 1),
    rename: id => E.rename(D, id, pick(['Pens', 'Tray', 'Stuff', 'Pens 2', ''])),
    setParam: id => { const p = pick(C.TYPES[mod(D, id).type].params); return E.setParam(D, id, p.key, p.type === 'toggle' ? R() < 0.5 : p.type === 'select' ? pick(p.options).value : between(p.min - 2, p.max + 2)); },
    setting: () => { const s = pick(C.SETTINGS); return E.setSetting(D, s.key, s.type === 'select' ? pick(s.options).value : between(s.min, s.max)); },
    separate: () => E.separate(D),
    template: () => R() < 0.15 ? { ok: true, design: C.template(pick(templates)) } : E.setName(D, 'Run ' + Math.floor(R() * 5))
  };
  const names = Object.keys(ops), weights = { add: 3, duplicate: 2, remove: 2, move: 4, nudge: 3, resize: 5, resizeFar: 1, setSize: 4, rotate: 3, rename: 1, setParam: 2, setting: 1, separate: 1, template: 1 };
  const bag = []; names.forEach(n => { for (let i = 0; i < weights[n]; i++) bag.push(n); });
  for (let i = 0; i < steps; i++) {
    const name = pick(bag), id = D.modules.length ? pick(D.modules).id : 'm1', before = frozen(D);
    let r;
    try {
      if (D.modules.length > 14 && (name === 'add' || name === 'duplicate')) r = E.remove(D, id);
      else if (!D.modules.length && ['add', 'setting', 'separate', 'template'].indexOf(name) < 0) r = ops.add();      // an emptied design: only edits that need no module
      else r = ops[name](id);
      if (frozen(D) !== before) throw new Error('the edit changed its input');
      if (!r || typeof r.ok !== 'boolean') throw new Error('no result');
      if (r.ok) valid(r.design, name); else if (r.design !== D || !r.reason) throw new Error('a refused edit must return the same design and a reason');
    } catch (e) {
      console.error('FAIL random run, seed ' + seed + ', step ' + i + ' (' + name + ' on ' + id + ')\n     ' + String(e.message).split('\n').join('\n     ') + '\n     before: ' + before);
      process.exit(1);
    }
    counts[name] = (counts[name] || 0) + (r.ok ? 1 : 0);
    if (r.ok) {
      applied++; D = r.design;
      const key = R() < 0.3 ? 'k' + Math.floor(R() * 2) : null;
      h = E.history.push(h, D, key); log.push(key);
      if (R() < 0.5) h = E.history.seal(h);
      if (h.present !== D && frozen(h.present) !== frozen(D)) { console.error('FAIL history lost the present, seed ' + seed + ', step ' + i); process.exit(1); }
    } else refused++;
    if (R() < 0.08) {                     // wander through the history: every stop is a valid design, and redo returns
      const n = 1 + Math.floor(R() * 4); let k = 0, top = h.present;
      while (k < n && E.history.canUndo(h)) { h = E.history.undo(h); valid(h.present, 'undo'); k++; }
      if (R() < 0.6) { while (k-- > 0) h = E.history.redo(h); if (frozen(h.present) !== frozen(top)) { console.error('FAIL redo did not return to where undo started, seed ' + seed + ', step ' + i); process.exit(1); } }
      D = h.present;
    }
  }
  while (E.history.canUndo(h)) { h = E.history.undo(h); try { valid(h.present, 'undo'); } catch (e) { console.error('FAIL ' + e.message); process.exit(1); } }
  return { applied, refused, counts };
}

const steps = +process.argv[2] || 4000, seed0 = +process.argv[3] || 20261109;
let total = { applied: 0, refused: 0 }, seen = {};
const t0 = Date.now(), runs = 8;
for (let k = 0; k < runs; k++) {
  const r = randomRun(Math.ceil(steps / runs), seed0 + k * 7919);
  total.applied += r.applied; total.refused += r.refused;
  Object.keys(r.counts).forEach(n => { seen[n] = (seen[n] || 0) + r.counts[n]; });
}
test('the random run exercised every kind of edit', () => {
  ['add', 'duplicate', 'remove', 'move', 'nudge', 'resize', 'setSize', 'rotate', 'setParam', 'setting'].forEach(n => yes(seen[n] > 0, n + ' never succeeded in the random run'));
});
console.log((failed ? failed + ' FAILED, ' : '') + passed + ' tests passed; random run: ' + total.applied + ' edits applied, ' + total.refused + ' refused, no overlaps or bad sizes (' +
  runs + ' runs, seed ' + seed0 + ', ' + (Date.now() - t0) + ' ms)');
process.exit(failed ? 1 : 0);
