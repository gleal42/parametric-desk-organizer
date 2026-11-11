// Exports a modular design as print-ready files: one STL per part (already turned for the plate), design.json
// and README.txt. The same kernel as the builder page, so the files match what the page downloads.
// Usage: node scripts/export-modular.js [design.json | templateId] [outDir]      (default: desk-set -> out/modular)
//        node scripts/export-modular.js --examples [dir]    writes every template's design.json (no STLs)
const fs = require('fs');
const path = require('path');
const C = require('../src/modular/catalog.js');
const K = require('../src/modular/kernel.js');

function loadDesign(arg) {
  if (!arg) return C.template('desk-set');
  if (C.TEMPLATES.some(t => t.id === arg)) return C.template(arg);
  if (!fs.existsSync(arg)) throw new Error('"' + arg + '" is neither a design file nor a template (' + C.TEMPLATES.map(t => t.id).join(', ') + ').');
  return C.parse(fs.readFileSync(arg, 'utf8'));
}

(async () => {
  if (process.argv[2] === '--examples') {
    const dir = process.argv[3] || path.join(__dirname, '..', 'examples', 'modular');
    fs.mkdirSync(dir, { recursive: true });
    C.TEMPLATES.forEach(t => { fs.writeFileSync(path.join(dir, t.id + '.json'), C.serialize(C.template(t.id)) + '\n'); console.log('wrote ' + path.join(dir, t.id + '.json')); });
    return;
  }
  const design = loadDesign(process.argv[2]), dir = process.argv[3] || path.join('out', 'modular');
  const kernel = await K.load(), result = kernel.build(design), files = kernel.exportFiles(result, design), r = Math.round;
  fs.mkdirSync(dir, { recursive: true });
  const A = result.analysis;
  console.log(`${A.design.name}: ${r(A.size.w)} x ${r(A.size.d)} x ${r(A.size.h)} mm, ${result.parts.length} parts for a ${A.settings.plate} mm plate`);
  files.forEach((f, i) => {
    fs.writeFileSync(path.join(dir, f.name), typeof f.data === 'string' ? f.data : Buffer.from(f.data));
    const p = result.parts[i];
    if (!p) { console.log('  wrote ' + path.join(dir, f.name)); return; }
    const s = p.print.size, fit = p.print.fits ? 'fits' + (p.print.angle ? ' at 45°' : '') : p.print.tall ? 'TOO TALL' : 'TOO BIG';
    console.log(`  wrote ${path.join(dir, f.name)}  ${s[0].toFixed(1)} x ${s[1].toFixed(1)} x ${s[2].toFixed(1)} mm, ${p.triangles} triangles, ${fit}` + (p.print.bridge ? `, bridges ${r(p.print.bridge)} mm` : ''));
  });
  result.warnings.forEach(w => console.log('  ' + (w.level === 'error' ? 'ERROR' : 'note') + ': ' + w.message));
  kernel.dispose();
  if (!A.ok) process.exitCode = 1;
})().catch(e => { console.error(e.message || e); process.exit(1); });
