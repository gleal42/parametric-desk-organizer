"""Checks that an STL is a single watertight, consistently wound solid.
Usage: python3 scripts/check_mesh.py out/*.stl   (needs: pip install trimesh)"""
import sys
import trimesh

ok = True
for f in sys.argv[1:]:
    m = trimesh.load(f, process=True)
    good = m.is_watertight and m.is_winding_consistent and len(m.split(only_watertight=False)) == 1
    ok &= good
    print(f"{f}: watertight={m.is_watertight} winding={m.is_winding_consistent} "
          f"volume={m.volume / 1000:.1f} cm3 bounds={m.bounds.round(2).tolist()} -> {'OK' if good else 'FAIL'}")
sys.exit(0 if ok else 1)
