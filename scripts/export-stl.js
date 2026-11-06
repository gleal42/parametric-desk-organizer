// Exports an STL from the same geometry the viewer uses.
// Usage: node scripts/export-stl.js '{"pensH":100,"notesH":35}' [out.stl]
const fs = require('fs');
const path = require('path');
const THREE = require('three');
const G = require('../src/organizer-geom.js');
const params = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const model = G.build(THREE, params);
const r = Math.round;
const out = process.argv[3] || path.join('out', `ribbed-organizer-${r(model.size.L)}x${r(model.size.W)}x${r(model.size.H)}.stl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(G.toSTL(model)));
console.log(`wrote ${out} (${model.triangles} triangles, ${r(model.size.L)} x ${r(model.size.W)} x ${r(model.size.H)} mm)`);
for (const p of model.pockets) {
  console.log(`  ${p.name.padEnd(9)} inside ${r(p.ext.u1 - p.ext.u0)} x ${r(p.ext.v1 - p.ext.v0)} x ${r(p.depth)} mm`);
}
