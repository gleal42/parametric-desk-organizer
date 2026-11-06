// Builds many random designs and checks every part is a closed, consistently wound solid.
// Usage: node scripts/test-geometry.js [count] [seed]
const THREE = require('three');
const G = require(process.env.GEOM || '../src/organizer-geom.js');

const count = +(process.argv[2] || 150);
let seed = +(process.argv[3] || 42);
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function range(lo, hi) { return lo + (hi - lo) * rnd(); }

function checkPart(part) {
  const ix = part.indices, p = part.positions, edges = new Map();
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + (e + 1) % 3];
      if (a === b) return 'degenerate triangle';
      const k = a + ',' + b;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  for (const [k, c] of edges) {
    const [a, b] = k.split(',');
    if (c !== 1) return 'edge used ' + c + ' times';
    if (edges.get(b + ',' + a) !== 1) return 'open edge';
  }
  let vol = 0, minArea = Infinity;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    minArea = Math.min(minArea, Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2);
  }
  if (!(vol > 0)) return 'negative volume';
  part.volume = vol; part.minArea = minArea;
  return null;
}

// Printability: thin faces (2*area/perimeter is the width of a long strip) that stand above all the
// solid material they touch are fins that would wobble or snap. Connected thin faces are judged as one
// piece, and specks under 1 mm2 are ignored (no slicer prints them).
function finCheck(plan) {
  const P = plan.pts, faces = plan.faces, byEdge = new Map(), key = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  faces.forEach((f, i) => f.ring.forEach((a, k) => {
    const kk = key(a, f.ring[(k + 1) % f.ring.length]);
    if (!byEdge.has(kk)) byEdge.set(kk, []);
    byEdge.get(kk).push(i);
  }));
  const info = faces.map((f, i) => {
    let A = 0, per = 0;
    const nb = new Set();
    f.ring.forEach((id, k) => {
      const q = P[f.ring[(k + 1) % f.ring.length]], p = P[id];
      A += p[0] * q[1] - q[0] * p[1]; per += Math.hypot(q[0] - p[0], q[1] - p[1]);
      const sh = byEdge.get(key(id, f.ring[(k + 1) % f.ring.length]));
      if (sh.length === 1) nb.add(-1); else sh.forEach(j => { if (j !== i) nb.add(j); });
    });
    const area = Math.abs(A) / 2, w = 2 * area / per;
    return { area, w, nb, thin: !f.pocket && w < 1.2 };
  });
  const seen = new Set();
  for (let i = 0; i < faces.length; i++) {
    if (!info[i].thin || seen.has(i)) continue;
    const comp = [], stack = [i]; seen.add(i);
    while (stack.length) {
      const j = stack.pop(); comp.push(j);
      info[j].nb.forEach(k => { if (k >= 0 && info[k].thin && !seen.has(k)) { seen.add(k); stack.push(k); } });
    }
    let top = 0, support = 0, area = 0;
    comp.forEach(j => {
      area += info[j].area; top = Math.max(top, faces[j].h);
      info[j].nb.forEach(k => { if (k >= 0 && !info[k].thin) support = Math.max(support, faces[k].h); });
    });
    if (area >= 1 && top > support + 2) return `thin fin, ${area.toFixed(1)} mm2, ${(top - support).toFixed(0)} mm above the solid part`;
  }
  return null;
}

const cases = [
  {}, { split: '2' }, { split: '3' }, { split: '3', joint: 'flat' }, { L: 230, plate: 180 },
  { L: 300, W: 160, split: '3' }, { L: 140, W: 70, split: '3', pitch: 3 }, { pensH: 140, booksH: 25, notesH: 140, split: '3' },
];
for (let i = 0; i < count; i++) {
  cases.push({
    L: range(140, 300), W: range(70, 160), pitch: range(3, 9), n: range(2.2, 6), wall: range(2, 5),
    pensLen: range(25, 100), booksW: range(16, 80),
    pensH: range(25, 140), booksH: range(25, 140), notesH: range(16, 140),
    pensDepth: rnd() < 0.3 ? range(8, 60) : 0, booksDepth: rnd() < 0.2 ? range(8, 60) : 0, notesDepth: rnd() < 0.3 ? range(8, 40) : 0,
    split: pick(['auto', '1', '2', '3']), joint: pick(['dovetail', 'dovetail', 'flat']), gap: range(0, 0.5), plate: pick([180, 256])
  });
}

let fails = 0, parts = 0, minArea = Infinity, ms = 0;
cases.forEach((c, i) => {
  let m;
  const t0 = Date.now();
  try { m = G.build(THREE, Object.assign({ debug: true }, c)); } catch (e) { fails++; console.log('BUILD FAIL', i, e.message, JSON.stringify(c)); return; }
  ms += Date.now() - t0;
  m.parts.forEach(pt => {
    parts++;
    const err = checkPart(pt) || finCheck(pt.plan);
    if (err) { fails++; console.log('PART FAIL', i, pt.name, err, JSON.stringify(c)); }
    else minArea = Math.min(minArea, pt.minArea);
  });
});
console.log(`${cases.length} designs, ${parts} parts, ${fails} failures, avg build ${(ms / cases.length).toFixed(0)} ms, smallest triangle ${minArea.toExponential(2)} mm²`);
process.exit(fails ? 1 : 0);
