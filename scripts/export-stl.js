// Exports STLs from the same geometry the viewer uses: one file per printable part, each turned and
// centred the way it fits the plate (the viewer's zip contains the same files).
// Usage: node scripts/export-stl.js '{"pensH":100,"split":"2"}' [outDir]
const fs = require('fs');
const path = require('path');
const THREE = require('three');
const G = require('../src/organizer-geom.js');
const params = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const model = G.build(THREE, params);
const r = Math.round;
const dir = process.argv[3] || 'out';
const base = `ribbed-organizer-${r(model.size.L)}x${r(model.size.W)}x${r(model.size.H)}`;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
fs.mkdirSync(dir, { recursive: true });
console.log(`${base}: ${model.count} part${model.count > 1 ? 's' : ''} for a ${model.params.plate} mm plate`);
model.parts.forEach((p, i) => {
  const file = path.join(dir, base + (model.count > 1 ? `-part${i + 1}-${slug(p.name)}` : '') + '.stl');
  fs.writeFileSync(file, Buffer.from(G.toSTL(p, { place: true })));
  const f = p.fit;
  console.log(`  wrote ${file}  ${r(p.size.L)} x ${r(p.size.W)} x ${r(p.size.H)} mm, ${p.triangles} triangles, ` +
    (f.fits ? `fits${f.angle ? ' at ' + f.angle + '°' : ''}` : `TOO BIG (${r(f.size)} mm)`));
});
for (const p of model.pockets) {
  console.log(`  ${p.name.padEnd(9)} inside ${r(p.ext.u1 - p.ext.u0)} x ${r(p.ext.v1 - p.ext.v0)} x ${r(p.depth)} mm`);
}
