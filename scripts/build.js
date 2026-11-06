// Builds dist/index.html: the viewer template with the geometry module inlined.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
const geom = fs.readFileSync(path.join(root, 'src/organizer-geom.js'), 'utf8');
if (!tpl.includes('/*__GEOM__*/')) throw new Error('template is missing the /*__GEOM__*/ marker');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), tpl.replace('/*__GEOM__*/', () => geom));
console.log('wrote dist/index.html');
