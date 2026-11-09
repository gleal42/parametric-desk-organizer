/* Stand-in for kernel.js with the same API, used only while developing the UI
   (KERNEL=stub node scripts/build.js). Every module becomes a plain box. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog.js'), require('./layout.js'));
  else root.ModularKernel = factory(root.ModularCatalog, root.ModularLayout);
})(typeof self !== 'undefined' ? self : this, function (C, L) {
  'use strict';
  function box(x0, y0, z0, x1, y1, z1) {
    var p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
    var i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    return { positions: Float32Array.from(p), indices: Uint32Array.from(i) };
  }
  function load() {
    var kernel = {
      stub: true,
      build: function (design) {
        var A = L.analyze(design), S = A.settings, parts = [], byModule = {}, t0 = Date.now(), b = A.bounds;
        var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        A.modules.forEach(function (M) {
          var g = S.gap / 2, m = box(M.x + g, M.y + g, 0, M.x + M.w - g, M.y + M.d - g, M.h);
          var ex = [M.x + M.w / 2 - cx, M.y + M.d / 2 - cy, 0], l = Math.hypot(ex[0], ex[1]) || 1;
          var part = { id: M.id, moduleId: M.id, role: 'body', name: M.name, positions: m.positions, indices: m.indices, triangles: 12,
            volume: M.w * M.d * M.h, bbox: { min: [M.x, M.y, 0], max: [M.x + M.w, M.y + M.d, M.h] },
            explode: A.modules.length > 1 ? [ex[0] / l, ex[1] / l, 0] : [0, 0, 0], slide: null,
            print: { angle: M.fit.angle, size: [M.w, M.d, M.h], fits: M.fit.fits, wide: M.fit.wide, tall: M.fit.tall, bridge: 0 },
            key: JSON.stringify([M.x, M.y, M.w, M.d, M.h, S.gap]) };
          parts.push(part); byModule[M.id] = [part];
        });
        return { analysis: A, parts: parts, byModule: byModule, warnings: A.warnings.slice(),
          stats: { parts: parts.length, triangles: parts.length * 12, volume: 0, ms: Date.now() - t0, rebuilt: A.modules.map(function (M) { return M.id; }), reused: 0 } };
      },
      printMesh: function (part) { return { positions: part.positions, indices: part.indices }; },
      toSTL: function () { return new Uint8Array(84); },
      zip: function () { return new Uint8Array(22); },
      exportFiles: function (result, design) { return [{ name: 'design.json', data: C.serialize(design) }]; },
      dispose: function () {}
    };
    return Promise.resolve(kernel);
  }
  return { load: load, stub: true };
});
