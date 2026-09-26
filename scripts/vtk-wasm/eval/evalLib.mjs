// VTK-wasm evaluation gates (roadmap item 18, Phase 0/1) — browser module,
// served by scripts/vtk-wasm/serve.mjs and driven by run.mjs.
//
// Everything here talks to the NATIVE session (Module.vtkStandaloneSession:
// create/invoke/destroy) rather than @kitware/vtk-wasm's Proxy layer, except
// the gates that explicitly compare the two. The native API is what the
// loader itself sits on; measuring it separately is how the 2026-09-18
// spike's "every call is a Promise" finding was traced to the loader running
// without a method table rather than to the binary.
//
// Conventions measured in `probe`: object arguments are `{Id}`; booleans are
// REJECTED by the invoker ("No suitable overload") so every flag is an
// integer; an unknown method returns null and logs, it never throws; an
// object-returning getter returns the object's WHOLE serialised state (so
// the backend caches ids instead of calling getters on hot paths).

const log = (s) => {
  const el = document.getElementById("log");
  if (el) el.textContent += s + "\n";
};

export async function boot(cfg) {
  const t0 = performance.now();
  const factory = (await import(`${cfg.base}/${cfg.build}.mjs`)).default;
  const tImport = performance.now();
  const printed = [];
  const Module = await factory({
    locateFile: (f) => `${cfg.base}/${f}`,
    print: (s) => printed.push(String(s)),
    printErr: (s) => printed.push(String(s)),
  });
  const tModule = performance.now();
  // The standalone session must not resize or restyle our canvas behind our
  // back (the remote session disables the same two defaults).
  Module._setDefaultExpandVTKCanvasToContainer?.(0);
  Module._setDefaultInstallHTMLResizeObserver?.(0);
  const session = new Module.vtkStandaloneSession();
  const tSession = performance.now();
  return {
    Module,
    session,
    printed,
    timing: { importMs: tImport - t0, instantiateMs: tModule - tImport, sessionMs: tSession - tModule, totalMs: tSession - t0 },
  };
}

/** Thin raw-session helper: ids in, `{Id}` for object arguments. */
export function rawApi(session) {
  const ref = (id) => ({ Id: id });
  return {
    ref,
    create: (cls) => session.create(cls),
    call: (id, m, ...args) => session.invoke(id, m, args),
    callAsync: (id, m, ...args) => session.invokeAsync(id, m, args),
    del: (id) => session.destroy(id),
    idOf: (v) => (v && typeof v === "object" && "Id" in v ? v.Id : v),
  };
}

const ARRAY_CLASS = new Map([
  ["Int8Array", "vtkTypeInt8Array"],
  ["Uint8Array", "vtkTypeUInt8Array"],
  ["Int16Array", "vtkTypeInt16Array"],
  ["Uint16Array", "vtkTypeUInt16Array"],
  ["Int32Array", "vtkTypeInt32Array"],
  ["Uint32Array", "vtkTypeUInt32Array"],
  ["BigInt64Array", "vtkTypeInt64Array"],
  ["BigUint64Array", "vtkTypeUInt64Array"],
  ["Float32Array", "vtkTypeFloat32Array"],
  ["Float64Array", "vtkTypeFloat64Array"],
]);

/** Copy a typed array into the wasm heap and wrap it (VTK takes ownership, frees with free()). */
function upload(M, R, ta, nComp = 1, name = "", cls = ARRAY_CLASS.get(ta.constructor.name)) {
  const bytes = ta.byteLength;
  const ptr = M._malloc(Math.max(bytes, 1));
  if (!ptr) throw new Error(`malloc(${bytes}) failed`);
  M.HEAPU8.set(new Uint8Array(ta.buffer, ta.byteOffset, bytes), ptr);
  const arr = R.create(cls);
  R.call(arr, "SetNumberOfComponents", nComp);
  if (name) R.call(arr, "SetName", name);
  R.call(arr, "SetArray", ptr, ta.length, 0);
  return arr;
}

const CTOR_BY_TYPE = {
  signed: { 1: Int8Array, 2: Int16Array, 4: Int32Array, 8: BigInt64Array },
  unsigned: { 1: Uint8Array, 2: Uint16Array, 4: Uint32Array, 8: BigUint64Array },
  float: { 4: Float32Array, 8: Float64Array },
};
const VTK_TYPE_KIND = { 2: "signed", 15: "signed", 3: "unsigned", 4: "signed", 5: "unsigned", 6: "signed", 7: "unsigned", 8: "signed", 9: "unsigned", 10: "float", 11: "float", 12: "signed", 16: "signed", 17: "unsigned" };

/** Read a VTK array back into a JS copy (immediately — a heap view detaches on growth). */
function readBack(M, R, arr) {
  const t = Number(R.call(arr, "GetDataType"));
  const size = Number(R.call(arr, "GetDataTypeSize"));
  const n = Number(R.call(arr, "GetNumberOfValues"));
  const Ctor = CTOR_BY_TYPE[VTK_TYPE_KIND[t]]?.[size];
  if (!Ctor) throw new Error(`no TypedArray for VTK type ${t}/${size}`);
  const ptr = Number(R.call(arr, "GetPointer", 0));
  return { type: t, size, n, values: n ? new Ctor(M.HEAPU8.buffer, ptr, n).slice() : new Ctor(0) };
}

function mkCanvas(w, h, key) {
  const c = document.createElement("canvas");
  c.id = key.replace(/^!/, "");
  c.width = w;
  c.height = h;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  document.body.appendChild(c);
  return c;
}

function makeRenderWindow(M, R, canvas, key, w, h) {
  M.specialHTMLTargets[key] = canvas;
  const rw = R.create("vtkWebAssemblyOpenGLRenderWindow");
  R.call(rw, "SetCanvasSelector", key);
  R.call(rw, "SetSize", w, h);
  return rw;
}

/** Offsets/connectivity polydata from plain JS arrays. `cells` = {verts?, lines?, polys?}: arrays of index arrays. */
function makePolyData(M, R, points, cells = {}, scalars) {
  const pd = R.create("vtkPolyData");
  const pts = R.create("vtkPoints");
  const pa = upload(M, R, new Float32Array(points), 3, "Points");
  R.call(pts, "SetData", R.ref(pa));
  R.call(pd, "SetPoints", R.ref(pts));
  const made = [pts, pa];
  for (const [kind, method] of [["verts", "SetVerts"], ["lines", "SetLines"], ["polys", "SetPolys"]]) {
    const list = cells[kind];
    if (!list || !list.length) continue;
    const off = new Int32Array(list.length + 1);
    const conn = [];
    list.forEach((c, i) => {
      conn.push(...c);
      off[i + 1] = conn.length;
    });
    const o = upload(M, R, off, 1);
    const k = upload(M, R, new Int32Array(conn), 1);
    const ca = R.create("vtkCellArray");
    R.call(ca, "SetData", R.ref(o), R.ref(k));
    R.call(pd, method, R.ref(ca));
    made.push(o, k, ca);
  }
  if (scalars) {
    const s = upload(M, R, new Float32Array(scalars), 1, "s");
    const ptData = R.idOf(R.call(pd, "GetPointData"));
    R.call(ptData, "SetScalars", R.ref(s));
    made.push(s);
  }
  return { pd, made };
}

function addActor(R, ren, pd, rgb) {
  const mapper = R.create("vtkPolyDataMapper");
  R.call(mapper, "SetInputData", R.ref(pd));
  const actor = R.create("vtkActor");
  R.call(actor, "SetMapper", R.ref(mapper));
  const prop = R.create("vtkProperty");
  R.call(prop, "SetColor", ...rgb);
  R.call(prop, "SetAmbient", 1);
  R.call(prop, "SetDiffuse", 0);
  R.call(actor, "SetProperty", R.ref(prop));
  R.call(ren, "AddActor", R.ref(actor));
  return { mapper, actor, prop };
}

/** Copy the WebGL canvas into a 2D context in the SAME task, then read pixels. */
function grab(canvas) {
  const c = document.createElement("canvas");
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  return ctx;
}
function px(ctx, x, yTop) {
  const d = ctx.getImageData(x, yTop, 1, 1).data;
  return [d[0], d[1], d[2]];
}
function near(a, b, tol = 12) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}
function litPixels(ctx, w, h, bg = [0, 0, 0]) {
  const d = ctx.getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) n++;
  return n;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
/** Median-of-batches per-call time in microseconds. */
function bench(fn, iters = 10000, batches = 5) {
  for (let i = 0; i < Math.min(500, iters); i++) fn(i); // warm-up
  const per = [];
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn(i);
    per.push(((performance.now() - t0) * 1000) / iters);
  }
  return { medianUs: +median(per).toFixed(3), batchesUs: per.map((x) => +x.toFixed(3)) };
}
async function benchAsync(fn, iters = 200, batches = 3) {
  for (let i = 0; i < 10; i++) await fn(i);
  const per = [];
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) await fn(i);
    per.push((performance.now() - t0) / iters);
  }
  return { medianMs: +median(per).toFixed(3), batchesMs: per.map((x) => +x.toFixed(3)) };
}

function describe(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (v instanceof Promise) return "Promise";
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v === "object" ? `object{${Object.keys(v).slice(0, 8).join(",")}}` : typeof v;
}

/** The invoker logs (never throws) on a bad call: count logged errors around fn. */
function errorsDuring(printed, fn) {
  const before = printed.length;
  const r = fn();
  return { result: r, errors: printed.slice(before).filter((l) => /ERR\|/.test(l)) };
}

// --- gates -------------------------------------------------------------------

const GATES = {
  async probe(cfg) {
    const b = await boot(cfg);
    const { session, Module } = b;
    const R = rawApi(session);
    const sessionMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(session)).filter((n) => n !== "constructor");
    const out = { timing: b.timing, sessionMethods, jspi: { Suspending: typeof WebAssembly.Suspending, promising: typeof WebAssembly.promising } };
    const actor = R.create("vtkActor");
    out.createReturns = describe(actor);
    out.getVisibility = describe(R.call(actor, "GetVisibility"));
    out.setVisibilityBool = errorsDuring(b.printed, () => R.call(actor, "SetVisibility", false)).errors.length ? "rejected" : "accepted";
    R.call(actor, "SetVisibility", 0);
    out.setVisibilityIntAfter = R.call(actor, "GetVisibility");
    out.unknownMethod = describe(R.call(actor, "NoSuchMethod"));
    out.stateClassName = session.get(actor)?.ClassName;
    out.heap = { HEAPU8: typeof Module.HEAPU8, malloc: typeof Module._malloc, free: typeof Module._free };
    return out;
  },

  // G0.2 — the loader classifies sync/async correctly WITH a method table,
  // and wraps everything async WITHOUT one (the spike's condition).
  async methodtable(cfg) {
    const { loadAsync } = await import("/out/vtk-wasm/loader/package/dist/esm/index.mjs");
    const withTable = await loadAsync({ url: cfg.base, urlIsGzip: false });
    const s1 = withTable.createStandaloneSession();
    const probe = async (vtk) => {
      const actor = vtk.vtkActor();
      const r = {};
      const g = actor.getVisibility();
      r.getVisibility = describe(g);
      r.setVisibility = describe(actor.setVisibility(0));
      r.getBounds = describe(actor.getBounds());
      const cam = vtk.vtkCamera();
      r.cameraGetPosition = describe(cam.getPosition());
      r.cameraAzimuth = describe(cam.azimuth(10));
      const rw = vtk.vtkWebAssemblyOpenGLRenderWindow();
      const canvas = mkCanvas(64, 64, `!mt${Math.random().toString(36).slice(2)}`);
      rw.setCanvasSelector(`#${canvas.id}`);
      rw.setSize(64, 64);
      const ren = vtk.vtkRenderer();
      rw.addRenderer(ren);
      const rr = rw.render();
      r.render = describe(rr);
      if (rr instanceof Promise) await rr;
      for (const v of Object.values(r)) if (v instanceof Promise) await v;
      return r;
    };
    const directory = await probe(s1.vtk);
    // Without a table: a copy of the same binary served from a directory with
    // no vtk-methods.json (the spike's condition).
    const noTable = await loadAsync({ url: cfg.baseNoTable, urlIsGzip: false });
    const noTableResult = await probe(noTable.createStandaloneSession().vtk);
    let gzip;
    try {
      const gz = await loadAsync({ url: cfg.tarball, urlIsGzip: true });
      gz; // key differs, a fresh runtime
      gzip = await probe(gz.createStandaloneSession().vtk);
    } catch (e) {
      gzip = { error: String(e.message || e) };
    }
    return { directory, noTable: noTableResult, gzip };
  },

  // G0.4 — per-call cost of SUCCESSFUL calls (integer arguments, results checked).
  async overhead(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const actor = R.create("vtkActor");
    const prop = R.create("vtkProperty");
    R.call(actor, "SetProperty", R.ref(prop));
    const cam = R.create("vtkCamera");
    const mapper = R.create("vtkPolyDataMapper");
    const { pd } = makePolyData(M, R, [0, 0, 0, 1, 0, 0, 0, 1, 0], { polys: [[0, 1, 2]] });
    const errBefore = b.printed.filter((l) => /ERR\|/.test(l)).length;
    const raw = {
      getVisibility: bench(() => {
        if (R.call(actor, "GetVisibility") !== 1 && R.call(actor, "GetVisibility") !== 0) throw new Error("bad");
      }),
      setVisibility: bench((i) => R.call(actor, "SetVisibility", i & 1)),
      propSetColor: bench((i) => R.call(prop, "SetColor", (i % 7) / 7, 0.5, 0.25)),
      propSetOpacity: bench((i) => R.call(prop, "SetOpacity", (i % 10) / 10)),
      cameraGetPosition: bench(() => {
        if (R.call(cam, "GetPosition").length !== 3) throw new Error("bad");
      }),
      cameraSetPosition: bench((i) => R.call(cam, "SetPosition", i, 1, 2)),
      mapperSetInputData: bench(() => R.call(mapper, "SetInputData", R.ref(pd))),
      createDestroyActor: bench(() => R.del(R.create("vtkActor")), 2000),
      getPropertyStateReturn: bench(() => R.call(actor, "GetProperty"), 2000),
    };
    const errAfter = b.printed.filter((l) => /ERR\|/.test(l)).length;
    // Same calls through the loader Proxy WITH the method table.
    const { loadAsync } = await import("/out/vtk-wasm/loader/package/dist/esm/index.mjs");
    const rt = await loadAsync({ url: cfg.base, urlIsGzip: false });
    const vtk = rt.createStandaloneSession().vtk;
    const pa = vtk.vtkActor();
    const pp = vtk.vtkProperty();
    pa.setProperty(pp);
    const pc = vtk.vtkCamera();
    const proxy = {
      getVisibility: bench(() => pa.getVisibility()),
      setVisibility: bench((i) => pa.setVisibility(i & 1)),
      propSetColor: bench((i) => pp.setColor((i % 7) / 7, 0.5, 0.25)),
      cameraGetPosition: bench(() => pc.getPosition()),
      createDestroyActor: bench(() => vtk.vtkActor().$delete(), 2000),
    };
    // Upload throughput: malloc + copy + SetArray (the only path for bulk data).
    const upload_ = [];
    for (const n of [1e4, 1e5, 1e6, 5e6]) {
      const ta = new Float32Array(3 * n);
      for (let i = 0; i < ta.length; i++) ta[i] = i * 0.001;
      const t0 = performance.now();
      const arr = upload(M, R, ta, 3);
      const pts = R.create("vtkPoints");
      R.call(pts, "SetData", R.ref(arr));
      const ms = performance.now() - t0;
      const ok = R.call(pts, "GetNumberOfPoints") === n;
      upload_.push({ points: n, bytes: ta.byteLength, ms: +ms.toFixed(2), MBps: +((ta.byteLength / 1048576) / (ms / 1000)).toFixed(0), ok });
      R.del(pts);
      R.del(arr);
    }
    // Projected real operations.
    const canvas = mkCanvas(400, 300, "!ovh");
    const rw = makeRenderWindow(M, R, canvas, "!ovh", 400, 300);
    const rens = [0, 1, 2, 3].map((q) => {
      const ren = R.create("vtkRenderer");
      R.call(ren, "SetViewport", (q % 2) * 0.5, Math.floor(q / 2) * 0.5, (q % 2) * 0.5 + 0.5, Math.floor(q / 2) * 0.5 + 0.5);
      R.call(rw, "AddRenderer", R.ref(ren));
      return ren;
    });
    // 50 layers x 4 panes, 1000-triangle strips, ids cached (no getters).
    const layerPts = [];
    const layerTris = [];
    for (let i = 0; i < 1002; i++) layerPts.push(i, (i & 1) * 1, 0);
    for (let i = 0; i < 1000; i++) layerTris.push([i, i + 1, i + 2]);
    const tRebuild0 = performance.now();
    let uploadMs = 0;
    const layers = [];
    for (let l = 0; l < 50; l++) {
      const tu = performance.now();
      const { pd: lpd } = makePolyData(M, R, layerPts, { polys: layerTris });
      uploadMs += performance.now() - tu;
      const props = rens.map((ren) => addActor(R, ren, lpd, [l / 50, 0.5, 0.5]));
      for (const p of props) {
        R.call(p.prop, "SetEdgeVisibility", 1);
        R.call(p.prop, "SetEdgeColor", 0.2, 0.2, 0.2);
        R.call(p.prop, "SetPointSize", 6);
        R.call(p.prop, "SetLineWidth", 1.5);
        R.call(p.prop, "SetOpacity", 1);
        R.call(p.prop, "SetSpecular", 0.1);
        R.call(p.actor, "SetPickable", 1);
      }
      layers.push(props);
    }
    const rebuildMs = performance.now() - tRebuild0;
    rens.forEach((ren) => R.call(ren, "ResetCamera"));
    const firstRender = await benchAsync(() => R.callAsync(rw, "Render"), 1, 1);
    const tToggle = performance.now();
    for (const p of layers[7]) R.call(p.actor, "SetVisibility", 0);
    const toggleCallsMs = performance.now() - tToggle;
    const render4 = await benchAsync(() => R.callAsync(rw, "Render"), 20, 3);
    return {
      timing: b.timing,
      failedCallsDuringRawBench: errAfter - errBefore,
      raw,
      proxy,
      upload: upload_,
      projected: {
        rebuild50x4: { totalMs: +rebuildMs.toFixed(1), uploadMs: +uploadMs.toFixed(1), excludingUploadMs: +(rebuildMs - uploadMs).toFixed(1) },
        toggleLayerIn4PanesCallsMs: +toggleCallsMs.toFixed(3),
        firstRenderMs: firstRender.medianMs,
        render4Panes50Layers: render4,
      },
    };
  },

  // G0.5 — exact typed-array round trips; heap-growth detachment; id width;
  // offsets/connectivity cell arrays; the two spike pitfalls.
  async typedarrays(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const out = { roundTrips: [], pitfalls: {} };
    if (!M.HEAPU8 || !M._malloc) return { error: "build exports no heap/allocator (unpatched sync glue?)" };
    const mk = {
      Int8Array: (i) => ((i * 37) % 255) - 127,
      Uint8Array: (i) => (i * 37) % 256,
      Int16Array: (i) => ((i * 7919) % 65535) - 32767,
      Uint16Array: (i) => (i * 7919) % 65536,
      Int32Array: (i) => (i * 2654435761) | 0,
      Uint32Array: (i) => (i * 2654435761) >>> 0,
      BigInt64Array: (i) => BigInt(i) * 123456789123n - 9876543210n,
      BigUint64Array: (i) => BigInt(i) * 123456789123n,
      Float32Array: (i) => Math.fround(Math.sin(i) * 1e3),
      Float64Array: (i) => Math.sin(i) * 1e300,
    };
    for (const [name, gen] of Object.entries(mk)) {
      const Ctor = globalThis[name];
      for (const n of [0, 1, 1_000_000]) {
        for (const nComp of [1, 3]) {
          const len = n * nComp;
          const ta = new Ctor(len);
          for (let i = 0; i < len; i++) ta[i] = gen(i);
          const errs = errorsDuring(b.printed, () => {
            const arr = upload(M, R, ta, nComp);
            const back = readBack(M, R, arr);
            R.del(arr);
            return back;
          });
          const back = errs.result;
          let equal = back.values.length === ta.length && back.values.constructor === ta.constructor;
          for (let i = 0; equal && i < len; i++) if (!Object.is(back.values[i], ta[i])) equal = false;
          out.roundTrips.push({ type: name, tuples: n, nComp, equal, vtkType: back.type, errors: errs.errors.length });
        }
      }
    }
    // A heap view detaches when the heap grows: the copy-immediately rule.
    const a = upload(M, R, new Float32Array([1, 2, 3]), 3);
    const ptr = Number(R.call(a, "GetPointer", 0));
    const view = new Float32Array(M.HEAPU8.buffer, ptr, 3);
    const before = M.HEAPU8.length;
    const big = M._malloc(256 * 1048576);
    out.heapGrowth = { before, after: M.HEAPU8.length, oldViewDetached: view.byteLength === 0, freshViewOk: new Float32Array(M.HEAPU8.buffer, ptr, 3)[2] === 3 };
    M._free(big);
    // vtkIdType width on this build.
    const ids = R.create("vtkIdTypeArray");
    out.idTypeSize = R.call(ids, "GetDataTypeSize");
    // offsets + connectivity round trip.
    const off = upload(M, R, new Int32Array([0, 3, 7, 9]));
    const conn = upload(M, R, new Int32Array([0, 1, 2, 2, 3, 4, 5, 6, 7]));
    const ca = R.create("vtkCellArray");
    const setData = errorsDuring(b.printed, () => R.call(ca, "SetData", R.ref(off), R.ref(conn)));
    out.cellArrayOffsets = {
      setDataReturn: setData.result,
      errors: setData.errors,
      cells: R.call(ca, "GetNumberOfCells"),
      offsetsBack: Array.from(readBack(M, R, R.idOf(R.call(ca, "GetOffsetsArray"))).values),
      connectivityBack: Array.from(readBack(M, R, R.idOf(R.call(ca, "GetConnectivityArray"))).values),
    };
    // Pitfall 1: a single legacy [n,i0,...] array given to SetData.
    const legacy = upload(M, R, new Int32Array([3, 0, 1, 2]));
    const ca2 = R.create("vtkCellArray");
    const p1 = errorsDuring(b.printed, () => R.call(ca2, "SetData", R.ref(legacy)));
    out.pitfalls.legacySetData = { cells: R.call(ca2, "GetNumberOfCells"), loggedErrors: p1.errors.length };
    // Pitfall 2: vtkPoints.SetData with a stray second argument.
    const pts = R.create("vtkPoints");
    const pa = upload(M, R, new Float32Array([0, 0, 0, 1, 1, 1]), 3);
    const p2 = errorsDuring(b.printed, () => R.call(pts, "SetData", R.ref(pa), 3));
    out.pitfalls.pointsSetDataTwoArgs = { points: R.call(pts, "GetNumberOfPoints"), loggedErrors: p2.errors.length };
    R.call(pts, "SetData", R.ref(pa));
    out.pitfalls.pointsSetDataOneArg = { points: R.call(pts, "GetNumberOfPoints") };
    return out;
  },

  // G0.6 — JSPI in this browser, and whether the module instantiates.
  async jspi(cfg) {
    const out = { Suspending: typeof WebAssembly.Suspending, promising: typeof WebAssembly.promising, userAgent: navigator.userAgent };
    try {
      const b = await boot(cfg);
      out.boot = b.timing;
    } catch (e) {
      out.bootError = String(e.message || e);
    }
    return out;
  },

  // G0.7 — can a frame be copied reliably after Render?
  async capture(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const W = 160,
      H = 120;
    const methods = {};
    const setup = (key, preserve) => {
      const canvas = mkCanvas(W, H, key);
      if (preserve) {
        const orig = canvas.getContext.bind(canvas);
        canvas.getContext = (type, attrs) => orig(type, { ...(attrs || {}), preserveDrawingBuffer: true });
      }
      const rw = makeRenderWindow(M, R, canvas, key, W, H);
      const ren = R.create("vtkRenderer");
      R.call(ren, "SetBackground", 0, 0, 0);
      R.call(rw, "AddRenderer", R.ref(ren));
      const { pd } = makePolyData(M, R, [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], { polys: [[0, 1, 2], [0, 2, 3]] });
      const a = addActor(R, ren, pd, [1, 0, 0]);
      R.call(ren, "ResetCamera");
      R.call(R.idOf(R.call(ren, "GetActiveCamera")), "Zoom", 3);
      return { canvas, rw, prop: a.prop };
    };
    const colors = (i) => (i % 3 === 0 ? [1, 0, 0] : i % 3 === 1 ? [0, 1, 0] : [0, 0, 1]);
    const expect = (i) => colors(i).map((c) => c * 255);
    // (A) await invokeAsync(Render), then drawImage in the continuation.
    {
      const s = setup("!capA", false);
      let ok = 0,
        blank = 0,
        macrotaskBoundary = 0;
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) {
        R.call(s.prop, "SetColor", ...colors(i));
        let timerFired = false;
        const tm = setTimeout(() => (timerFired = true), 0);
        await R.callAsync(s.rw, "Render");
        if (timerFired) macrotaskBoundary++;
        clearTimeout(tm);
        const c = px(grab(s.canvas), W / 2, H / 2);
        if (near(c, expect(i))) ok++;
        else if (near(c, [0, 0, 0])) blank++;
      }
      methods.awaitInvokeAsync = { correct: ok, blank, macrotaskBoundary, msPerFrame: +((performance.now() - t0) / 100).toFixed(3) };
    }
    // (B) synchronous invoke(Render) then drawImage in the same task.
    {
      const s = setup("!capB", false);
      let ok = 0,
        blank = 0,
        threw = 0,
        firstError;
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) {
        R.call(s.prop, "SetColor", ...colors(i));
        try {
          R.call(s.rw, "Render");
        } catch (e) {
          threw++;
          firstError ??= String(e.message || e);
          continue;
        }
        const c = px(grab(s.canvas), W / 2, H / 2);
        if (near(c, expect(i))) ok++;
        else if (near(c, [0, 0, 0])) blank++;
      }
      methods.syncInvoke = { correct: ok, blank, threw, firstError, msPerFrame: +((performance.now() - t0) / 100).toFixed(3) };
    }
    // (C) preserveDrawingBuffer, copy after a macrotask.
    {
      const s = setup("!capC", true);
      let ok = 0,
        blank = 0;
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) {
        R.call(s.prop, "SetColor", ...colors(i));
        await R.callAsync(s.rw, "Render");
        await new Promise((r) => setTimeout(r, 0));
        const c = px(grab(s.canvas), W / 2, H / 2);
        if (near(c, expect(i))) ok++;
        else if (near(c, [0, 0, 0])) blank++;
      }
      methods.preserveDrawingBufferAfterMacrotask = { correct: ok, blank, msPerFrame: +((performance.now() - t0) / 100).toFixed(3) };
    }
    // Negative control: without preserveDrawingBuffer, a copy after a macrotask should NOT be reliable.
    {
      const s = setup("!capD", false);
      let ok = 0,
        blank = 0;
      for (let i = 0; i < 30; i++) {
        R.call(s.prop, "SetColor", ...colors(i));
        await R.callAsync(s.rw, "Render");
        await new Promise((r) => setTimeout(r, 0));
        const c = px(grab(s.canvas), W / 2, H / 2);
        if (near(c, expect(i))) ok++;
        else if (near(c, [0, 0, 0])) blank++;
      }
      methods.negativeControlNoPreserveAfterMacrotask = { of: 30, correct: ok, blank };
    }
    return { methods };
  },

  // G0.8 — picking identity across actors and viewports.
  async picking(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const W = 400,
      H = 200;
    const canvas = mkCanvas(W, H, "!pick");
    const rw = makeRenderWindow(M, R, canvas, "!pick", W, H);
    const panes = [0, 1].map((p) => {
      const ren = R.create("vtkRenderer");
      R.call(ren, "SetViewport", p * 0.5, 0, p * 0.5 + 0.5, 1);
      R.call(ren, "SetBackground", 0.1, 0.1, 0.1);
      R.call(rw, "AddRenderer", R.ref(ren));
      // Mixed polydata: 2 verts, 1 line, 2 triangles — cell ids must follow verts->lines->polys.
      const { pd } = makePolyData(
        M,
        R,
        [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, -0.5, 0.8, 0.5, 0.5, 0.8, 0.5, -1, 0, 0.2, 1, 0, 0.2],
        { verts: [[4], [5]], lines: [[6, 7]], polys: [[0, 1, 2], [0, 2, 3]] }
      );
      const a = addActor(R, ren, pd, [0.8, 0.8, 0.2]);
      // A second actor behind, in pane 1 only, to test actor identity.
      let back;
      if (p === 1) {
        const { pd: pd2 } = makePolyData(M, R, [-3, -3, -1, 3, -3, -1, 3, 3, -1, -3, 3, -1], { polys: [[0, 1, 2], [0, 2, 3]] });
        back = addActor(R, ren, pd2, [0.2, 0.2, 0.8]);
      }
      const cam = R.idOf(R.call(ren, "GetActiveCamera"));
      R.call(cam, "SetPosition", 0, 0, 10);
      R.call(cam, "SetFocalPoint", 0, 0, 0);
      R.call(cam, "SetViewUp", 0, 1, 0);
      R.call(cam, "SetParallelProjection", 1);
      R.call(cam, "SetParallelScale", 1.5);
      R.call(ren, "ResetCameraClippingRange");
      return { ren, actor: a.actor, mapper: a.mapper, back };
    });
    await R.callAsync(rw, "Render");
    const picker = R.create("vtkCellPicker");
    R.call(picker, "SetTolerance", 0.005);
    const pick = (x, y, ren) => {
      const hit = R.call(picker, "Pick", x, y, 0, R.ref(ren));
      const actorState = R.call(picker, "GetActor");
      return { hit, actorId: actorState ? actorState.Id : null, cellId: R.call(picker, "GetCellId"), pos: R.call(picker, "GetPickPosition") };
    };
    // Display coords: bottom-left origin, canvas pixels. Pane p spans x in [p*200, p*200+200).
    // With parallel scale 1.5 over 200 px height, 1 world unit = 200/3 px.
    const toDisp = (p, wx, wy) => [p * 200 + 100 + (wx * 200) / 3, 100 + (wy * 200) / 3];
    const cases = [];
    for (const p of [0, 1]) {
      const pane = panes[p];
      const t1 = pick(...toDisp(p, 0.5, -0.5), pane.ren); // lower-right triangle -> poly 0 -> cell 3
      cases.push({ p, what: "triangle0", ok: t1.actorId === pane.actor && t1.cellId === 3, got: t1 });
      const t2 = pick(...toDisp(p, -0.5, 0.5), pane.ren); // upper-left triangle -> poly 1 -> cell 4
      cases.push({ p, what: "triangle1", ok: t2.actorId === pane.actor && t2.cellId === 4, got: t2 });
    }
    // Outside the front quad in pane 1: must hit the BACK actor.
    const tb = pick(...toDisp(1, 1.3, 1.3), panes[1].ren);
    cases.push({ p: 1, what: "backActor", ok: tb.actorId === panes[1].back.actor, got: tb });
    // Same pixel in pane 0 has nothing behind: miss.
    const tm = pick(...toDisp(0, 1.3, 1.3), panes[0].ren);
    cases.push({ p: 0, what: "miss", ok: !tm.hit || tm.actorId === null, got: tm });
    // Clipping plane removes the left half of pane 0's actor; with
    // PickClippingPlanes the clipped region is not pickable.
    const plane = R.create("vtkPlane");
    R.call(plane, "SetOrigin", 0, 0, 0);
    R.call(plane, "SetNormal", 1, 0, 0);
    R.call(panes[0].mapper, "AddClippingPlane", R.ref(plane));
    await R.callAsync(rw, "Render");
    R.call(picker, "SetPickClippingPlanes", 1);
    const tc = pick(...toDisp(0, -0.5, 0.5), panes[0].ren);
    cases.push({ p: 0, what: "clippedAway", ok: !tc.hit || tc.actorId !== panes[0].actor, got: tc });
    const tk = pick(...toDisp(0, 0.5, -0.5), panes[0].ren);
    cases.push({ p: 0, what: "keptHalf", ok: tk.actorId === panes[0].actor && tk.cellId === 3, got: tk });
    return { correct: cases.filter((c) => c.ok).length, total: cases.length, cases, actorIds: panes.map((p) => ({ actor: p.actor, back: p.back?.actor })) };
  },

  // G0.9 — 1/2/4 viewports, an overlay layer, a resize.
  async viewports(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    let W = 400,
      H = 300;
    const canvas = mkCanvas(W, H, "!vp");
    const rw = makeRenderWindow(M, R, canvas, "!vp", W, H);
    R.call(rw, "SetNumberOfLayers", 2);
    const bgs = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
    ];
    const rens = bgs.map((bg, q) => {
      const ren = R.create("vtkRenderer");
      R.call(ren, "SetViewport", (q % 2) * 0.5, Math.floor(q / 2) * 0.5, (q % 2) * 0.5 + 0.5, Math.floor(q / 2) * 0.5 + 0.5);
      R.call(ren, "SetBackground", ...bg);
      R.call(rw, "AddRenderer", R.ref(ren));
      return ren;
    });
    // Overlay renderer on layer 1 in the top-left corner, non-interactive.
    const overlay = R.create("vtkRenderer");
    R.call(overlay, "SetLayer", 1);
    R.call(overlay, "SetInteractive", 0);
    R.call(overlay, "SetViewport", 0, 0.8, 0.2, 1);
    R.call(rw, "AddRenderer", R.ref(overlay));
    const { pd } = makePolyData(M, R, [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], { polys: [[0, 1, 2], [0, 2, 3]] });
    addActor(R, overlay, pd, [1, 1, 1]);
    R.call(overlay, "ResetCamera");
    R.call(R.idOf(R.call(overlay, "GetActiveCamera")), "Zoom", 3);
    const sample = async () => {
      await R.callAsync(rw, "Render");
      const ctx = grab(canvas);
      // y from the top; renderer q=0 is bottom-left.
      const q = [px(ctx, W * 0.25, H * 0.75), px(ctx, W * 0.75, H * 0.75), px(ctx, W * 0.25, H * 0.25 + 10), px(ctx, W * 0.75, H * 0.25)];
      return { quadrants: q.map((c, i) => near(c, bgs[i].map((v) => v * 255))), overlay: near(px(ctx, W * 0.1, H * 0.1), [255, 255, 255]), canvas: [canvas.width, canvas.height] };
    };
    const first = await sample();
    W = 600;
    H = 200;
    R.call(rw, "SetSize", W, H);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const resized = await sample();
    // Picking in pane 3 (top-right) hits nothing but reports that renderer.
    return { first, resized };
  },

  // G0.10 — disposal: heap and VTK data-object memory plateau; leak detected.
  async disposal(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const canvas = mkCanvas(200, 150, "!disp");
    const rw = makeRenderWindow(M, R, canvas, "!disp", 200, 150);
    const pts = [];
    const tris = [];
    for (let i = 0; i < 5002; i++) pts.push(i, (i & 1) * 1, 0);
    for (let i = 0; i < 5000; i++) tris.push([i, i + 1, i + 2]);
    const cycle = async (leak, getterVariant) => {
      const created = [];
      const rens = [0, 1, 2, 3].map((q) => {
        const ren = R.create("vtkRenderer");
        R.call(ren, "SetViewport", (q % 2) * 0.5, Math.floor(q / 2) * 0.5, (q % 2) * 0.5 + 0.5, Math.floor(q / 2) * 0.5 + 0.5);
        R.call(rw, "AddRenderer", R.ref(ren));
        return ren;
      });
      const ctf = R.create("vtkColorTransferFunction");
      R.call(ctf, "AddRGBPoint", 0, 0, 0, 1);
      R.call(ctf, "AddRGBPoint", 1, 1, 0, 0);
      const plane = R.create("vtkPlane");
      created.push(ctf, plane);
      const getterIds = [];
      for (let l = 0; l < 20; l++) {
        const { pd, made } = makePolyData(M, R, pts, { polys: tris });
        if (!leak) created.push(pd, ...made);
        for (const ren of rens) {
          const a = addActor(R, ren, pd, [0.5, 0.5, 0.5]);
          R.call(a.mapper, "SetLookupTable", R.ref(ctf));
          R.call(a.mapper, "AddClippingPlane", R.ref(plane));
          created.push(a.mapper, a.actor, a.prop);
          if (getterVariant) getterIds.push(R.idOf(R.call(a.actor, "GetProperty")), R.idOf(R.call(ren, "GetActiveCamera")));
        }
      }
      await R.callAsync(rw, "Render");
      for (const ren of rens) {
        R.call(ren, "RemoveAllViewProps");
        R.call(rw, "RemoveRenderer", R.ref(ren));
        created.push(ren);
      }
      for (const id of created.reverse()) R.del(id);
      return getterIds;
    };
    const sampleMem = () => ({ heap: M.HEAPU8.length, dataObjects: S.getTotalVTKDataObjectMemoryUsage(), blobs: S.getTotalBlobMemoryUsage() });
    const clean = [];
    for (let c = 0; c < 50; c++) {
      await cycle(false, false);
      clean.push(sampleMem());
    }
    const getterRun = [];
    let lastGetterIds = [];
    for (let c = 0; c < 10; c++) {
      lastGetterIds = await cycle(false, true);
      getterRun.push(sampleMem());
    }
    // Are getter-registered objects still alive in the object manager after their owners died?
    let getterAlive = 0;
    for (const id of lastGetterIds.slice(0, 20)) {
      const st = S.get(id);
      if (st && st.ClassName) getterAlive++;
    }
    const leak = [];
    for (let c = 0; c < 5; c++) {
      await cycle(true, false);
      leak.push(sampleMem());
    }
    const growth = (arr, a, b2) => (arr[b2].dataObjects - arr[a].dataObjects) / Math.max(1, arr[a].dataObjects);
    return {
      clean: { first: clean[0], c10: clean[9], c50: clean[49], dataObjectGrowth10to50: +growth(clean, 9, 49).toFixed(4), heapGrowth10to50: +((clean[49].heap - clean[9].heap) / clean[9].heap).toFixed(4) },
      getterVariant: { first: getterRun[0], last: getterRun[9], getterObjectsAliveAfterOwnersDeleted: `${getterAlive}/${Math.min(20, lastGetterIds.length)}` },
      leakVariant: { first: leak[0], last: leak[4], detected: leak[4].dataObjects > clean[49].dataObjects * 1.5 },
    };
  },

  // G1.4 — a deterministic transcript + pixel hashes, compared between the
  // original glue (permissive CSP) and the patched glue (strict CSP).
  async equivalence(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const t = [];
    const rec = (label, v) => t.push([label, Array.isArray(v) ? v.map((x) => (typeof x === "number" ? +x.toFixed(9) : x)) : v && typeof v === "object" ? (v.Id !== undefined ? `obj:${v.ClassName}` : "obj") : v]);
    // ~30 classes x getters/setters across return kinds (number, int, array, object, null, bool-ish).
    const classes = ["vtkActor", "vtkProperty", "vtkCamera", "vtkRenderer", "vtkPolyDataMapper", "vtkPlane", "vtkColorTransferFunction", "vtkPolyData", "vtkPoints", "vtkCellArray", "vtkGlyph3DMapper", "vtkArrowSource", "vtkSphereSource", "vtkCylinderSource", "vtkCellPicker", "vtkScalarBarActor", "vtkCubeAxesActor", "vtkAnnotatedCubeActor", "vtkAxesActor", "vtkTextActor", "vtkTextProperty", "vtkLight", "vtkFloatArray", "vtkTypeInt32Array", "vtkIdTypeArray", "vtkLookupTable", "vtkTransform", "vtkMatrix4x4", "vtkPlanes", "vtkDoubleArray"];
    const ids = Object.fromEntries(classes.map((c) => [c, R.create(c)]));
    for (const c of classes) rec(`${c}.class`, S.get(ids[c])?.ClassName);
    const cam = ids.vtkCamera;
    R.call(cam, "SetPosition", 1, 2, 3);
    R.call(cam, "SetFocalPoint", 0, 0, 0);
    R.call(cam, "SetViewUp", 0, 0, 1);
    for (const m of ["GetPosition", "GetFocalPoint", "GetViewUp", "GetDistance", "GetViewAngle", "GetParallelProjection", "GetDirectionOfProjection"]) rec(`cam.${m}`, R.call(cam, m));
    R.call(cam, "Azimuth", 30);
    R.call(cam, "Elevation", 20);
    R.call(cam, "OrthogonalizeViewUp");
    rec("cam.afterAzEl", R.call(cam, "GetPosition"));
    const p = ids.vtkProperty;
    for (let i = 0; i < 20; i++) {
      R.call(p, "SetColor", i / 20, 1 - i / 20, 0.5);
      R.call(p, "SetOpacity", i / 20);
      R.call(p, "SetRepresentation", i % 3);
      R.call(p, "SetPointSize", i + 1);
      R.call(p, "SetEdgeVisibility", i & 1);
      rec(`prop.${i}`, [R.call(p, "GetColor"), R.call(p, "GetOpacity"), R.call(p, "GetRepresentation"), R.call(p, "GetPointSize"), R.call(p, "GetEdgeVisibility")]);
    }
    const ctf = ids.vtkColorTransferFunction;
    for (let i = 0; i <= 10; i++) R.call(ctf, "AddRGBPoint", i / 10, i / 10, 0, 1 - i / 10);
    for (let i = 0; i <= 20; i++) rec(`ctf.${i}`, R.call(ctf, "GetColor", i / 20));
    const pl = ids.vtkPlane;
    R.call(pl, "SetNormal", 1, 1, 0);
    rec("plane.normal", R.call(pl, "GetNormal"));
    rec("plane.eval", R.call(pl, "EvaluateFunction", 1, 2, 3));
    const tf = ids.vtkTransform;
    R.call(tf, "RotateZ", 30);
    R.call(tf, "Translate", 1, 2, 3);
    rec("transform.point", R.call(tf, "TransformPoint", 1, 0, 0));
    rec("actor.getProperty", R.call(ids.vtkActor, "GetProperty"));
    rec("actor.getMapper.null", R.call(ids.vtkActor, "GetMapper"));
    rec("unknown.method", R.call(ids.vtkActor, "NoSuchMethod"));
    // Typed arrays both directions.
    const ta = new Float32Array(3000).map((_, i) => Math.sin(i));
    const arr = upload(M, R, ta, 3);
    const back = readBack(M, R, arr);
    rec("array.equal", back.values.every((v, i) => v === ta[i]));
    rec("array.range", R.call(arr, "GetRange", 0));
    // Three rendered scenes, RGBA hashed.
    const hashes = [];
    for (const scene of [0, 1, 2]) {
      const canvas = mkCanvas(200, 150, `!eq${scene}`);
      const rw = makeRenderWindow(M, R, canvas, `!eq${scene}`, 200, 150);
      const ren = R.create("vtkRenderer");
      R.call(ren, "SetBackground", 0.1, 0.1, 0.1);
      R.call(rw, "AddRenderer", R.ref(ren));
      if (scene === 0) {
        const { pd } = makePolyData(M, R, [-1, -1, 0, 1, -1, 0, 0, 1, 0], { polys: [[0, 1, 2]] }, [0, 0.5, 1]);
        const a = addActor(R, ren, pd, [1, 1, 1]);
        R.call(a.mapper, "SetLookupTable", R.ref(ctf));
        R.call(a.mapper, "SetScalarRange", 0, 1);
        R.call(a.mapper, "SetScalarVisibility", 1);
      } else if (scene === 1) {
        const src = ids.vtkSphereSource;
        R.call(src, "SetThetaResolution", 16);
        R.call(src, "SetPhiResolution", 16);
        R.call(src, "Update");
        const out = R.idOf(R.call(src, "GetOutput"));
        addActor(R, ren, out, [0.3, 0.7, 0.9]);
      } else {
        const t2 = R.create("vtkTextActor");
        R.call(t2, "SetInput", "Equivalence");
        R.call(ren, "AddActor", R.ref(t2));
      }
      R.call(ren, "ResetCamera");
      R.call(rw, "Render");
      const d = grab(canvas).getImageData(0, 0, 200, 150).data;
      const h = await crypto.subtle.digest("SHA-256", d);
      hashes.push([...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join(""));
    }
    const errors = b.printed.filter((l) => /ERR\|/.test(l)).length;
    return { transcript: t, hashes, loggedErrors: errors, calls: t.length };
  },

  // G0.11 diagnostics — which text paths draw anything.
  async textdebug(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const out = {};
    const attempt = async (name, build) => {
      const canvas = mkCanvas(300, 150, `!td${name}`);
      const rw = makeRenderWindow(M, R, canvas, `!td${name}`, 300, 150);
      const ren = R.create("vtkRenderer");
      R.call(ren, "SetBackground", 0, 0, 0);
      R.call(rw, "AddRenderer", R.ref(ren));
      const before = b.printed.length;
      try {
        build(ren);
        R.call(ren, "ResetCamera");
        await R.callAsync(rw, "Render");
        out[name] = { lit: litPixels(grab(canvas), 300, 150), log: b.printed.slice(before).slice(-6) };
      } catch (e) {
        out[name] = { error: String(e.message || e), log: b.printed.slice(before).slice(-6) };
      }
    };
    await attempt("textActorAddActor", (ren) => {
      const t = R.create("vtkTextActor");
      R.call(t, "SetInput", "Kratos 123");
      const tp = R.idOf(R.call(t, "GetTextProperty"));
      R.call(tp, "SetFontSize", 32);
      R.call(tp, "SetColor", 1, 1, 1);
      R.call(t, "SetPosition", 10, 30);
      R.call(ren, "AddActor", R.ref(t));
    });
    await attempt("textActorAddViewProp", (ren) => {
      const t = R.create("vtkTextActor");
      R.call(t, "SetInput", "Kratos 123");
      R.call(ren, "AddViewProp", R.ref(t));
    });
    await attempt("scalarBar", (ren) => {
      const ctf = R.create("vtkColorTransferFunction");
      R.call(ctf, "AddRGBPoint", 0, 0, 0, 1);
      R.call(ctf, "AddRGBPoint", 1, 1, 0, 0);
      const sb = R.create("vtkScalarBarActor");
      R.call(sb, "SetLookupTable", R.ref(ctf));
      R.call(sb, "SetTitle", "Temp");
      R.call(ren, "AddActor", R.ref(sb));
    });
    await attempt("vectorText", (ren) => {
      const vt = R.create("vtkVectorText");
      R.call(vt, "SetText", "ABC");
      R.call(vt, "Update");
      const m = R.create("vtkPolyDataMapper");
      R.call(m, "SetInputConnection", R.ref(R.idOf(R.call(vt, "GetOutputPort"))));
      const a = R.create("vtkActor");
      R.call(a, "SetMapper", R.ref(m));
      R.call(ren, "AddActor", R.ref(a));
    });
    await attempt("annotatedCube", (ren) => {
      const c = R.create("vtkAnnotatedCubeActor");
      R.call(ren, "AddActor", R.ref(c));
    });
    await attempt("cubeAxes", (ren) => {
      const ax = R.create("vtkCubeAxesActor");
      R.call(ax, "SetBounds", -1, 1, -1, 1, -1, 1);
      R.call(ax, "SetCamera", R.ref(R.idOf(R.call(ren, "GetActiveCamera"))));
      R.call(ren, "AddActor", R.ref(ax));
    });
    return out;
  },

  // G0.11 — text renders (fonts are embedded).
  async text(cfg) {
    const b = await boot(cfg);
    const { session: S, Module: M } = b;
    const R = rawApi(S);
    const canvas = mkCanvas(300, 100, "!text");
    const rw = makeRenderWindow(M, R, canvas, "!text", 300, 100);
    const ren = R.create("vtkRenderer");
    R.call(ren, "SetBackground", 0, 0, 0);
    R.call(rw, "AddRenderer", R.ref(ren));
    await R.callAsync(rw, "Render");
    const emptyLit = litPixels(grab(canvas), 300, 100);
    const t = R.create("vtkTextActor");
    R.call(t, "SetInput", "Kratos VTK-wasm 123");
    const tp = R.idOf(R.call(t, "GetTextProperty"));
    R.call(tp, "SetFontSize", 24);
    R.call(tp, "SetColor", 1, 1, 1);
    R.call(t, "SetPosition", 10, 30);
    R.call(ren, "AddActor", R.ref(t)); // AddActor2D is not in the invoker registry (logged null, measured)
    await R.callAsync(rw, "Render");
    const lit = litPixels(grab(canvas), 300, 100);
    return { emptyLit, textLit: lit, ok: lit > 200 && emptyLit === 0 };
  },
};

export async function run(cfg) {
  const g = GATES[cfg.gate];
  if (!g) throw new Error(`unknown gate ${cfg.gate}; known: ${Object.keys(GATES).join(", ")}`);
  log(`gate ${cfg.gate} on ${cfg.candidate}/${cfg.build}`);
  return g(cfg);
}
