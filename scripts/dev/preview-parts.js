// Dev tool: renders preview pages of kernel output for headless screenshots (see preview-parts.py).
// Usage: node scripts/dev/preview-parts.js <shots.json> <outDir>
//   shots.json: [{ name, design | template, edit: {moduleId: {field: value}}, settings: {...}, only: [ids], dir: [x,y,z],
//                  focus: [x0,y0,z0,x1,y1,z1], explode: mm, lift: {id: mm}, pull: 0..1, size: [w,h] }]
const fs = require('fs');
const path = require('path');
const C = require('../../src/modular/catalog.js');
const K = require('../../src/modular/kernel.js');
const three = path.join(__dirname, '..', '..', 'node_modules', 'three', 'build', 'three.min.js');
const COLORS = ['#d9d2c5', '#c9d6c3', '#c7d3e0', '#e3cdbf', '#d8c9dd', '#d6d6b8', '#bfd8d6', '#e0c7cf'];
const b64 = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

(async () => {
  const shots = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), out = process.argv[3] || '/tmp/preview';
  fs.mkdirSync(out, { recursive: true });
  const kernel = await K.load();
  for (const s of shots) {
    const d = s.design || C.template(s.template || 'desk-set');
    Object.assign(d.settings, s.settings || {});
    for (const id in (s.edit || {})) { const m = d.modules.find(q => q.id === id); for (const k in s.edit[id]) { if (k === 'params') Object.assign(m.params, s.edit[id].params); else m[k] = s.edit[id][k]; } }
    const r = kernel.build(d), ids = r.analysis.modules.map(m => m.id);
    const parts = r.parts.filter(p => !s.only || s.only.includes(p.moduleId) || s.only.includes(p.id)).map(p => {
      const off = [0, 0, 0], e = s.explode || 0;
      off[0] += p.explode[0] * e; off[1] += p.explode[1] * e;
      if (s.lift && s.lift[p.moduleId]) off[2] += s.lift[p.moduleId];
      if (p.slide && s.pull) { off[0] += p.slide.dir[0] * p.slide.travel * s.pull; off[1] += p.slide.dir[1] * p.slide.travel * s.pull; }
      return { pos: b64(p.positions), idx: b64(p.indices), off, color: p.role === 'drawer' ? '#b9c4cf' : COLORS[ids.indexOf(p.moduleId) % COLORS.length] };
    });
    const scene = { parts, dir: s.dir || [-0.55, -0.75, 0.6], focus: s.focus || null, size: s.size || [1400, 1000], edges: s.edges !== false };
    fs.writeFileSync(path.join(out, s.name + '.html'), `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}canvas{display:block}</style><body>
<script src="file://${three}"></script><script>
const S = ${JSON.stringify(scene)};
const dec = (s, T) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new T(u.buffer); };
const [W, H] = S.size, renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setPixelRatio(1); renderer.setClearColor(0xffffff); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(), box = new THREE.Box3();
for (const p of S.parts) {
  const g = new THREE.BufferGeometry(), pos = dec(p.pos, Float32Array), idx = dec(p.idx, Uint32Array);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeVertexNormals();
  const flat = g.toNonIndexed(); flat.computeVertexNormals();
  const m = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide }));
  m.position.set(p.off[0], p.off[1], p.off[2]); scene.add(m);
  if (S.edges) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), new THREE.LineBasicMaterial({ color: 0x4a4a4a, transparent: true, opacity: 0.35 })); e.position.copy(m.position); scene.add(e); }
  box.expandByObject(m);
}
if (S.focus) box.set(new THREE.Vector3(S.focus[0], S.focus[1], S.focus[2]), new THREE.Vector3(S.focus[3], S.focus[4], S.focus[5]));
const c = box.getCenter(new THREE.Vector3()), dir = new THREE.Vector3(S.dir[0], S.dir[1], S.dir[2]).normalize();
const up = Math.abs(dir.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
cam.up.copy(up); cam.position.copy(c).addScaledVector(dir, 1000); cam.lookAt(c); cam.updateMatrixWorld();
let hx = 0, hy = 0; const inv = cam.matrixWorldInverse;
for (let i = 0; i < 8; i++) { const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv); hx = Math.max(hx, Math.abs(v.x)); hy = Math.max(hy, Math.abs(v.y)); }
const k = Math.max(hx / (W / 2), hy / (H / 2)) * 1.06; cam.left = -W / 2 * k; cam.right = W / 2 * k; cam.top = H / 2 * k; cam.bottom = -H / 2 * k; cam.updateProjectionMatrix();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.62));
const l1 = new THREE.DirectionalLight(0xffffff, 0.75); l1.position.copy(dir).add(new THREE.Vector3(-0.6, 0.2, 0.9)); scene.add(l1);
const l2 = new THREE.DirectionalLight(0xffffff, 0.25); l2.position.set(0.7, -0.2, 0.3); scene.add(l2);
renderer.render(scene, cam); document.title = 'done';
</script>`);
    console.log(s.name + ': ' + r.parts.length + ' parts, ' + r.stats.triangles + ' triangles' + (r.warnings.length ? ', warnings: ' + r.warnings.map(w => w.code).join(' ') : ''));
  }
})().catch(e => { console.error(e); process.exit(1); });
