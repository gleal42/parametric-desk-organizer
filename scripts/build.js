// Builds the single-file pages in dist/:
//   dist/index.html    the classic ribbed organizer viewer (src/template.html + src/organizer-geom.js)
//   dist/builder.html  the modular builder (src/builder.html + src/modular/*.js + the Manifold geometry library)
// KERNEL=stub swaps the real geometry kernel for src/modular/kernel-stub.js (plain boxes), for UI work.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const exists = f => fs.existsSync(path.join(root, f));
const safe = js => js.replace(/<\/script/gi, '<\\/script');     // inlined code must not close its own <script>
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

function fill(tpl, marker, text, required) {
  if (!tpl.includes(marker)) { if (required) throw new Error('template is missing the ' + marker + ' marker'); return tpl; }
  return tpl.split(marker).join(text);
}

// classic viewer
{
  const tpl = read('src/template.html');
  fs.writeFileSync(path.join(root, 'dist/index.html'), fill(tpl, '/*__GEOM__*/', read('src/organizer-geom.js'), true));
  console.log('wrote dist/index.html');
}

// modular builder
if (exists('src/builder.html')) {
  const stub = process.env.KERNEL === 'stub' || !exists('src/modular/kernel.js');
  let html = read('src/builder.html');
  html = fill(html, '/*__CATALOG__*/', safe(read('src/modular/catalog.js')), true);
  html = fill(html, '/*__LAYOUT__*/', safe(read('src/modular/layout.js')), true);
  html = fill(html, '/*__EDITOR__*/', exists('src/modular/editor.js') ? safe(read('src/modular/editor.js')) : '');
  html = fill(html, '/*__KERNEL__*/', safe(read(stub ? 'src/modular/kernel-stub.js' : 'src/modular/kernel.js')), true);
  if (stub) {
    html = fill(html, '/*__MANIFOLD_GLUE__*/', '');
    html = fill(html, '__MANIFOLD_WASM_B64__', '');
  } else {
    // Manifold ships as an ES module plus a .wasm file. Inline both: the glue goes into a <script type="module">
    // (its default export becomes window.ManifoldModule) and the wasm travels as base64, so the page needs no fetch.
    const dir = path.dirname(require.resolve('manifold-3d/manifold.js'));
    const glue = fs.readFileSync(path.join(dir, 'manifold.js'), 'utf8');
    if (!/export default Module;?\s*$/.test(glue)) throw new Error('unexpected manifold.js: no trailing default export');
    html = fill(html, '/*__MANIFOLD_GLUE__*/', safe(glue.replace(/export default Module;?\s*$/, 'window.ManifoldModule = Module;')), true);
    html = fill(html, '__MANIFOLD_WASM_B64__', fs.readFileSync(path.join(dir, 'manifold.wasm')).toString('base64'), true);
  }
  fs.writeFileSync(path.join(root, 'dist/builder.html'), html);
  console.log('wrote dist/builder.html (' + (html.length / 1024).toFixed(0) + ' KB' + (stub ? ', STUB kernel' : '') + ')');
}
