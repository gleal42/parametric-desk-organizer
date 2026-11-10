# Parametric Desk Organizer

A ribbed, oval desk organizer for 3D printing, with three sections: a pen cup, a book slot and a low post-it tray. Every section can be resized in an interactive Three.js viewer, which exports exactly what you see as STL files. Designs bigger than the print plate are split into parts that slide together with dovetails.

![Original sketch](docs/sketch.jpg)

The sketch shows the side view (top drawing, for the heights) and the plan (bottom drawing, for where each section sits).

## Modular builder

`dist/builder.html` is a second app: instead of one fixed layout, you assemble an organizer from modules on a plan. Modules that touch are joined with the same sliding dovetails, and each module is exported as its own STL.

| Module | Use |
|--------|-----|
| Compartment | Pen cup, tray, sticky notes, notebook slot, letter sorter. Dividers, sloped front. |
| Tool block | A grid of round or square holes, or slots (pens, markers, SD cards). |
| Device stand | Phone or tablet groove with a back rest and cable notch. |
| Drawers & shelves | A cabinet with sliding drawers or open cubbies. |

- **3D** view to look and select, **Plan** view to drag, resize and snap modules together.
- Ribs, corner rounding (overall and per module), wall and floor are set in **Style**; printer, joint gap and the parts list are in **Print**.
- The taller neighbour carries the dovetail tabs, the lower one the slots. Everything prints upright without supports.
- **Download STLs** saves a ZIP with one STL per part, `design.json` and a README. **Copy design** / **Load design** move a design between devices.

```
npm install
npm run build                                   # dist/index.html and dist/builder.html
npm test                                        # classic + modular geometry checks
node scripts/test-editor.js                     # editing rules
node scripts/export-modular.js desk-set out/    # STLs from a template or a design.json
```

Starter designs are in `examples/modular/`. How it works: [docs/modular-design.md](docs/modular-design.md).

## Layout

```
  Plan                              Side view
  +-----------+--------+            books     ███████
  |   books   |        |            pens      ██████
  +-----------+  pens  |            post-its  ██
  |  post-its |        |
  +-----------+--------+
```

Default size: 200 × 100 × 95 mm, 102 half-round ribs. It prints in one piece on a Bambu Lab A1 mini (180 mm plate) turned 45°.

| Section  | Parameters                            | Default                            |
|----------|---------------------------------------|------------------------------------|
| Pens     | length, height, depth                 | 55 mm long, 90 mm tall, full depth |
| Books    | width, height, depth, notebook to fit | 36 mm wide, 95 mm tall, full depth |
| Post-its | height, depth                         | 30 mm tall, full depth             |
| Shape    | length, width, rib width, shape, wall | 200 × 100 mm, 5 mm ribs, 3 mm wall |
| Print    | plate, parts, joint, gap              | 180 mm, auto, dovetails, 0.15 mm   |

"Depth" below full turns a section into a raised, shallow tray.

## Notebooks

The Books tab checks whether an A6, A5 or B5 notebook of a given thickness stands upright on the flat part of the slot floor (clear of the rounded cove). "Make it fit" widens the slot if the notebook is too thick, then lengthens the organizer until it fits.

| Notebook (15 mm thick) | Default pen cup (55 mm) | 40 mm pen cup |
|------------------------|-------------------------|---------------|
| A6                     | fits at 200 mm          | fits          |
| A5                     | 242 mm, 2 parts on the A1 mini | 226 mm, 2 parts |
| B5                     | 271 mm, 3 parts on the A1 mini | 255 mm, 3 parts |

## Splitting into parts

Lengths up to 300 mm are allowed. When a design is bigger than the plate, "Auto" splits it into 2 parts (pen cup | books + post-its) or 3 parts (pen cup | books | post-its), whichever is the fewest that fit. You can also pick the number of parts yourself.

- **Seams run inside the dividers**, so they are hidden in the finished organizer and give full-height glue faces.
- **Each divider wall stays whole in one part.** The part whose section is lower keeps a band at its own height that holds the slots; the tabs on the other part stop at that height. No part gets a thin strip of wall taller than its own section.
- **Sliding dovetails** are straight vertical extrusions: every part prints upright with no supports, and parts slide together from the top. With a 3 part split, slide the books part onto the post-its part first, then the pen cup onto both.
- **Gap** sets the clearance between mating faces: 0.10 mm holds by friction, 0.15 mm is normal, 0.20 mm or more is loose and should be glued. Run a thin line of CA glue or epoxy along the seam for a permanent joint.
- **Flat, glued** drops the dovetails for a plain butt joint.

Snap clips were left out on purpose: in PLA they fatigue and crack, and they need overhangs or supports.

## Files

- `src/organizer-geom.js` – the parametric geometry. Builds a watertight mesh per part (Z-up, millimetres), plans the split, checks notebook fit and writes binary STL and ZIP. Runs in the browser and in Node.
- `src/template.html` – the viewer UI. `/*__GEOM__*/` is replaced by the geometry module at build time.
- `dist/index.html` – the built, single-file viewer (loads Three.js r147 from jsDelivr).
- `scripts/build.js` – builds the viewer.
- `scripts/export-stl.js` – writes one STL per part, turned and centred for the plate.
- `scripts/test-geometry.js` – builds hundreds of random designs and checks that every part is a closed solid with no thin fins.
- `scripts/check_mesh.py` – checks STL files with trimesh.
- `examples/ribbed-organizer-200x100x95.stl` – the default design, turned 45° for the A1 mini.

## Usage

```sh
npm install
npm run build                                   # writes dist/index.html
node scripts/export-stl.js                      # default design into out/
node scripts/export-stl.js '{"L":242,"split":"auto","plate":180}'
node scripts/test-geometry.js 400               # random designs, exits 1 on any failure
pip install trimesh && python3 scripts/check_mesh.py out/*.stl
```

All parameters and their limits are in `DEFAULTS` and `resolveParams()` in `src/organizer-geom.js`.

## Printing

Print every part flat side down with no supports. Walls are 3 mm at the rib grooves, dividers 4.5 mm (about 9 mm where a dovetail seam runs) and floors 2.4 mm. Rims and pocket floors are rounded, and a 0.6 mm chamfer at the base helps against elephant's foot. Use the same filament and settings for all parts of one organizer.

## License

MIT
