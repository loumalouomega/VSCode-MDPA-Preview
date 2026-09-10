"""Regenerate tiny HDF5 temporal fixtures; requires h5py and numpy.

Run `npm run build:tests`, then python src/test/fixtures/transient/generate.py.
Base geometry is written by the installed WASM, temporal structure by h5py.
These are synthetic fixtures authored for this repository, not solver exports.
The assertions verify temporal structure independently of the WASM reader.
"""
from pathlib import Path
import subprocess
import tempfile
import shutil
import h5py
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
with tempfile.TemporaryDirectory(prefix="timeline-fixtures-") as tmp:
    subprocess.run(["node", "-e", r'''
const fs = require('node:fs');
const {readMeshioModel, writeMeshioBytes} = require('./out/parser/meshio');
(async () => {
  const model = await readMeshioModel('a.off', [{name:'a.off', data:Buffer.from('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n')}], '.off');
  model.fields.push({kind:'Nodal', variable:'TEMP', components:1, ids:Int32Array.from([1,2,3]), values:Float64Array.from([10,20,30])});
  for (const ext of ['med','cgns','h5m']) {
    const r = await writeMeshioBytes(model, '.'+ext);
    fs.writeFileSync(process.argv[1]+'/two-step.'+ext, r.data);
  }
})().catch(e => { console.error(e); process.exitCode=1; });
''', tmp], cwd=ROOT, check=True)
    for ext in ["med", "cgns", "h5m"]:
        shutil.copyfile(Path(tmp) / f"two-step.{ext}", HERE / f"two-step.{ext}")

with h5py.File(HERE / "two-step.med", "r+") as f:
    field = f["CHA/TEMP"]
    first = next(iter(field))
    second = f"{2:020d}{-1:020d}"
    field.copy(first, second)
    field[second].attrs.modify("NDT", 2)
    field[second].attrs.modify("PDT", 1.0)
    field[second]["NOE/MED_NO_PROFILE_INTERNAL/CO"][:] = [40, 50, 60]
    assert [field[k].attrs["PDT"] for k in sorted(field)] == [0, 1]
    assert [field[k]["NOE/MED_NO_PROFILE_INTERNAL/CO"][0] for k in sorted(field)] == [10, 40]

# CGNS SIDS time-dependent flow: NumberOfSteps/TimeValues on the base and
# 32-character FlowSolutionPointers on the zone, stored with reversed HDF5
# dimensions (CGNS [32,2] becomes HDF5 [2,32]).
def node(parent, name, label, code="MT", data=None):
    g = parent.create_group(name, track_order=True)
    for key, value in [("name", name), ("label", label), ("type", code)]:
        g.attrs[key] = np.bytes_(value)
    g.attrs["flags"] = np.array([1], dtype=np.int32)
    if data is not None:
        g.create_dataset(" data", data=data)
    return g

with h5py.File(HERE / "two-step.cgns", "r+") as f:
    base, zone = f["Base"], f["Base/Zone1"]
    zone.move("FlowSolution", "Solution0")
    zone["Solution0"].attrs["name"] = np.bytes_("Solution0")
    zone.copy("Solution0", "Solution1")
    zone["Solution1"].attrs["name"] = np.bytes_("Solution1")
    zone["Solution1/TEMP/ data"][:] = [40, 50, 60]
    node(base, "SimulationType", "SimulationType_t", "C1", np.frombuffer(b"TimeAccurate", dtype="i1"))
    it = node(base, "TimeIterativeValues", "BaseIterativeData_t", "I4", np.array([2], dtype="i4"))
    node(it, "TimeValues", "DataArray_t", "R8", np.array([0, 1], dtype="f8"))
    zit = node(zone, "ZoneIterativeData", "ZoneIterativeData_t")
    pointers = np.array([np.frombuffer(s.ljust(32).encode(), dtype="i1") for s in ["Solution0", "Solution1"]])
    node(zit, "FlowSolutionPointers", "DataArray_t", "C1", pointers)
    assert it["TimeValues/ data"][:].tolist() == [0, 1]
    for i, p in enumerate(zit["FlowSolutionPointers/ data"][:]):
        name = p.tobytes().decode().strip()
        assert zone[name + "/TEMP/ data"][0] == [10, 40][i]

# MOAB's time-indexed tag convention, not a portable time axis: two dense
# scalar tags named TEMP_T0 / TEMP_T1. Preserve each tag's committed HDF5 type.
with h5py.File(HERE / "two-step.h5m", "r+") as f:
    tags, dense = f["tstt/tags"], f["tstt/nodes/tags"]
    for i, values in enumerate([[10, 20, 30], [40, 50, 60]]):
        name = f"TEMP_T{i}"
        g = tags.create_group(name)
        g.attrs["class"] = np.int64(2)
        g["type"] = np.dtype("f8")
        dense.create_dataset(name, data=values, dtype=g["type"])
    del tags["TEMP"]
    del dense["TEMP"]
    # Avoid a wall-clock value making regeneration needlessly different.
    f["tstt/history"][2] = b"2026-09-10 00:00:00"
    assert [dense[f"TEMP_T{i}"][0] for i in range(2)] == [10, 40]
