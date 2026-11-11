# Modular builder: design

The classic organizer is one fixed layout (pens, books, post-its) that can be split
into dovetailed parts. The modular builder turns that idea around: the organizer is
**assembled from modules** that the user picks, sizes and arranges on the desk plan,
and every pair of modules that share an edge is joined with the same sliding
dovetails. Each module is one printable part (a drawer cabinet adds its drawers).

## Principles

1. **Everything prints upright with no supports.** Dovetails are vertical prisms, so
   parts slide together from above. The only overhangs allowed are the flat bridges
   under a cabinet's shelves and roof.
2. **It looks like one object.** Outer faces are ribbed (or smooth), outer corners
   are rounded, faces between modules are flat and flush. Ribs, rounding and wall
   thickness are decided per side from what the module touches.
3. **The layout decides the joints.** The user never places a dovetail. Slide two
   modules together and they are joined; pull them apart and the faces heal.
4. **One source of truth.** The browser app, the command-line export and the tests
   all run the same catalog, layout analysis and geometry kernel.

## Files

| File | Role |
|------|------|
| `src/modular/catalog.js` | Settings, module types and their parameter schemas, presets, templates, design (de)serialisation. Pure. |
| `src/modular/layout.js` | `analyze(design)`: shared edges, dovetail positions and ownership, exposed stretches, corner radii, wall insets, warnings. Pure. |
| `src/modular/kernel.js` | Builds watertight meshes for every part with Manifold (WASM). STL and ZIP export. |
| `src/modular/kernel-stub.js` | Same API, plain boxes. Only for UI development (`KERNEL=stub npm run build`). |
| `src/modular/editor.js` | Pure editing helpers for the UI: snapping, placing, moving, resizing with push, rotate, duplicate, history. |
| `src/builder.html` | The builder UI template. `scripts/build.js` inlines the modules above and Manifold into `dist/builder.html`. |
| `scripts/export-modular.js` | Design JSON in, STLs out. |
| `scripts/test-modular.js` | Random layouts; checks solids, clearances, slide-ability, overhangs, plate fit. |

All `src/modular/*.js` files are UMD: `module.exports` in Node, a global in the page
(`ModularCatalog`, `ModularLayout`, `ModularEditor`, `ModularKernel`).

## The design object

```js
{ version: 1, name: 'My organizer',
  settings: { surface, ribPitch, cornerR, wall, floor, joint, gap, plate, plateH, grid, ...advanced },
  modules: [ { id: 'm1', type: 'bin', preset: 'pen-cup', name: 'Pens',
               x: 0, y: 0, w: 60, d: 60, h: 95, rot: 0, params: { depth: 0, cols: 1, rows: 1 } } ] }
```

Millimetres, Z up. `(x, y)` is the footprint's min corner, `w` along +x, `d` along +y.
The desk's front is -y. `rot` (0..3) turns a module's own front by quarter turns
counter-clockwise: 0 front, 1 right, 2 back, 3 left. `ModularLayout.toGlobal /
toLocal` convert between the module's local frame (front at local -y, footprint
`wL x dL` from the origin) and the plan.

## Module types

| Type | What it is | Parameters |
|------|------------|------------|
| `bin` | Open-top compartment. Pen cup, tray, notebook slot, letter sorter. | depth, cols, rows, dividerH, frontH (sloped top) |
| `block` | Solid block with a grid of holes or slots. | hole (round, square, slot), size, slotL, spacing, holeDepth, stagger, frontH |
| `stand` | Phone or tablet rest: front lip, groove, slanted back rest. | slotW, angle, lipH, cable |
| `cabinet` | Shell with stacked levels, each a sliding drawer or an open shelf. | bays, drawers, pull |

Each type in `ModularCatalog.TYPES` carries its schema plus four pure functions:
`resolve` (clamp parameters, dynamic limits), `sides` (height profile of each side,
open and plain sides), `derive` (dimensions shared by kernel and UI text) and `info`.

## Layout analysis

`ModularLayout.analyze(design)` returns

```js
{ design, settings: S,          // normalised design, resolved settings (+ ribDepth, band, tabHalfHead, tabMargin ...)
  modules: [M], byId, joints: [J], groups, bounds, size, warnings: [{ code, level, ids, message }], ok }

M = { id, type, name, x, y, w, d, h, rot, wL, dL, params, ranges,
      local,                    // TYPES[type].sides(): per LOCAL side { profile, open, plain }
      sides: { front|right|back|left: { along, at, from, to, len, localSide, open, plain,
               contacts: [{ from, to, other, joint }], exposed: [{ from, to }],
               tabs: [{ c, h, joint }], slots: [{ c, h, joint }], ribbed, inset } },   // GLOBAL sides, global coordinates
      ins: { front, right, back, left },       // wall thickness per LOCAL side
      corners: { fl, fr, br, bl }, cornersL,   // outer corner radius, global and local names; 0 = sharp
      fit: { fits, angle, size, wide, tall }, info, warnings: [codes] }

J = { index, axis, at, from, to, length, a, b, sideA, sideB, blocked,
      owner, other, dir,        // owner carries the tabs; dir = +1 when they point towards +axis
      tabs: [{ c, h }], height }
```

Rules it applies:

- **Joints.** Two modules whose footprints touch along more than a point share a
  joint. With dovetails on, a joint gets one tab per ~45 mm of shared edge (at least
  one if the edge is long enough), kept `tabMargin` clear of both ends.
- **Tab height.** Each tab rises to the lower of the two bodies at that spot (types
  report a height profile per side, so a sloped sorter or the groove of a stand is
  handled). Tabs lower than `tabMinH` are dropped.
- **Ownership.** The taller neighbour carries the tabs, the lower one the slots. Slots
  are cut through the full height of their module.
- **Walls.** A side's wall is `wall` (+ rib depth when ribbed), and at least `band`
  (tab depth + 1.6 mm) on a side that carries slots.
- **Ribs.** Only on exposed stretches of sides that are not `plain`.
- **Corners.** Rounded by `cornerR` where both sides are free; sharp where a
  neighbour reaches the corner; limited by the distance to the nearest neighbour.
- **Warnings.** `overlap` (error), `blocked` (something in front of a cabinet),
  `short` / `low` (touching but no dovetail fits), `loose` (not attached to the main
  group), `big` (does not fit the plate).

`ModularLayout.tabPolygon(S, J, c)` gives the nominal dovetail outline in plan
coordinates. The kernel shrinks it by `gap / 2` for the tab and grows it by `gap / 2`
for the slot, and pulls every contact face back `gap / 2` from the joint plane, so
`gap` is the clearance everywhere between two parts.

## Geometry kernel

```js
const kernel = await ModularKernel.load(opts);   // opts: { wasm } | { factory, wasmBinary }; defaults work in Node and in the built page
const result = kernel.build(design);             // cached per module: only modules whose inputs changed are rebuilt
// result = { analysis, parts: [Part], byModule: { id: [Part] }, warnings, stats: { parts, triangles, volume, ms, rebuilt, reused } }

Part = { id,                   // 'm1' for a body, 'm1:drawer1' for a drawer
         moduleId, role: 'body' | 'drawer', name,
         positions: Float32Array, indices: Uint32Array,   // assembled, global mm, Z up, outward-facing triangles
         triangles, volume, bbox: { min, max },
         explode: [dx, dy, dz],                // unit direction for the exploded view
         slide: null | { dir: [x, y, z], travel },   // drawers: how they pull out
         print: { angle, size: [x, y, z], fits, wide, tall, bridge },   // bridge = longest unsupported span in mm
         key }                                 // identical key = identical mesh

kernel.printMesh(part)        // { positions, indices } turned for the plate: sitting on Z = 0, centred, rotated by print.angle
kernel.toSTL(part, { print: true })   // binary STL (Uint8Array)
kernel.exportFiles(result, design)    // [{ name, data }]: one STL per part, design.json, README.txt
kernel.zip(files)                     // stored ZIP (Uint8Array)
kernel.dispose()
```

### What every body must satisfy

- A single closed solid (Manifold guarantees the mesh; the tests also check one
  connected piece and positive volume).
- Inside its footprint, except for its dovetail tabs.
- Contact faces flat, `gap / 2` behind the joint plane. Exposed stretches ribbed when
  `side.ribbed`: half-round ribs like the classic organizer (pitch adjusted so a whole
  number fits each run, crests on the footprint edge, grooves `ribDepth` deeper),
  running round rounded corners without a break.
- Base chamfer (`chamfer`) round the whole outline including tabs; slots flare by the
  same amount at the bottom. This is the elephant's-foot relief.
- Tabs from Z = 0 to their height; slots through the full height.
- No overhang steeper than 45 degrees anywhere, except cabinet ceilings (bridges).

### Per type

- **bin**: one pocket per cell, rounded in plan, `rimR` round-over at the rim, `coveR`
  cove at the floor (both reduced for shallow or narrow pockets), floor at
  `derive().floorZ`. Dividers `divider` thick, up to `dividerTop`. With `frontH` the
  whole top is cut by a plane from the back edge (h) down to the front edge (frontH).
- **block**: holes from `derive().holes`, round, square or slot, with a small entry
  chamfer. Depth `holeDepth` below the top surface at the hole (floor never thinner
  than `floor`), or down to `floor` when full.
- **stand**: side profile from `derive()`: lip, groove (open at both ends), rest rising
  at `angle` from vertical, flat top. Optional cable notch through the lip.
- **cabinet**: floor, roof, side and back walls from `ins`, shelves `shelfT` thick, open
  front. Drawers from `derive().bays[k].drawer`: `drawerWall` walls and floor, front
  flush with the shell, finger notch or supportless wedge handle, `drawerGap`
  clearance. Ceilings are flat bridges across `derive().span`; warn above 120 mm.

## Builder UI

One page, phone first (bottom sheet) with a sidebar on wide screens, in the same
visual language as the classic viewer.

- **3D view**: orbit, tap a module to select it, labels, exploded view, drawers open.
- **Plan view**: top-down editor. Drag to move (snaps to the grid and to neighbours),
  drag the handles to resize, joints drawn where modules will be dovetailed.
- **Module panel**: name, size, the type's parameters (rendered from the schema),
  rotate, duplicate, delete, nudge. Add from the preset palette; new modules land
  attached to the selection.
- **Style panel**: surface, rib width, corner rounding, wall, floor, filament colour.
- **Print panel**: printer, joints, gap, part list with plate fit, download (ZIP of
  STLs + design.json + README), copy and load a design.
- Undo and redo, autosave in the browser, starter templates, warnings that select
  the module they are about.

## Tests

`node scripts/test-modular.js [count] [seed]` builds every template plus random
layouts and checks, for each part and each pair of neighbours:

- closed solid, one piece, positive volume, inside its allowed envelope;
- neighbours never intersect, and still do not when one is nudged by 60% of the gap
  in any plan direction (the clearance is really there);
- a module can be lifted straight up out of the assembly, and a drawer pulled straight
  out of its bay, without touching anything;
- no unsupported overhangs except declared bridges;
- every part of every template fits the default plate.
