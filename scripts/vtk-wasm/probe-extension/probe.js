// Webview half of the VTK-wasm probe (G0.6 + G1.5). Boots the glue named in
// data-cfg, renders one triangle through the native session with a
// synchronous Render (the measured-safe path on WebGL), counts lit pixels
// copied in the same task, and posts everything back to the extension host.
/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const violations = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample })
  );
  const cfg = JSON.parse(document.body.dataset.cfg);
  const r = {
    userAgent: navigator.userAgent,
    jspi: { Suspending: typeof WebAssembly.Suspending, promising: typeof WebAssembly.promising },
    crossOriginIsolated: self.crossOriginIsolated,
    origin: location.origin,
  };
  const done = () => {
    r.violations = violations;
    vscode.postMessage(r);
  };
  (async () => {
    try {
      const res = await fetch(`${cfg.base}/vtkWebAssembly.wasm`, { method: "HEAD" });
      r.wasmContentType = res.headers.get("content-type");
    } catch (e) {
      r.wasmFetchError = String((e && e.message) || e);
    }
    try {
      const t0 = performance.now();
      const mod = await import(cfg.glue);
      r.importMs = performance.now() - t0;
      const M = await mod.default({ locateFile: (f) => `${cfg.base}/${f}`, print: () => {}, printErr: () => {} });
      r.instantiateMs = performance.now() - t0 - r.importMs;
      M._setDefaultExpandVTKCanvasToContainer && M._setDefaultExpandVTKCanvasToContainer(0);
      M._setDefaultInstallHTMLResizeObserver && M._setDefaultInstallHTMLResizeObserver(0);
      const S = new M.vtkStandaloneSession();
      const call = (id, m, ...a) => S.invoke(id, m, a);
      const ref = (id) => ({ Id: id });
      const up = (ta, nComp) => {
        const p = M._malloc(ta.byteLength);
        M.HEAPU8.set(new Uint8Array(ta.buffer), p);
        const arr = S.create(ta instanceof Float32Array ? "vtkTypeFloat32Array" : "vtkTypeInt32Array");
        call(arr, "SetNumberOfComponents", nComp);
        call(arr, "SetArray", p, ta.length, 0);
        return arr;
      };
      const canvas = document.createElement("canvas");
      canvas.id = "probe";
      canvas.width = 200;
      canvas.height = 150;
      document.body.appendChild(canvas);
      M.specialHTMLTargets["!probe"] = canvas;
      const rw = S.create("vtkWebAssemblyOpenGLRenderWindow");
      call(rw, "SetCanvasSelector", "!probe");
      call(rw, "SetSize", 200, 150);
      const ren = S.create("vtkRenderer");
      call(ren, "SetBackground", 0, 0, 0);
      call(rw, "AddRenderer", ref(ren));
      const pts = S.create("vtkPoints");
      call(pts, "SetData", ref(up(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3)));
      const ca = S.create("vtkCellArray");
      call(ca, "SetData", ref(up(new Int32Array([0, 3]), 1)), ref(up(new Int32Array([0, 1, 2]), 1)));
      const pd = S.create("vtkPolyData");
      call(pd, "SetPoints", ref(pts));
      call(pd, "SetPolys", ref(ca));
      const mapper = S.create("vtkPolyDataMapper");
      call(mapper, "SetInputData", ref(pd));
      const actor = S.create("vtkActor");
      call(actor, "SetMapper", ref(mapper));
      call(ren, "AddActor", ref(actor));
      call(ren, "ResetCamera");
      call(rw, "Render");
      const c2 = document.createElement("canvas");
      c2.width = 200;
      c2.height = 150;
      const x = c2.getContext("2d", { willReadFrequently: true });
      x.drawImage(canvas, 0, 0);
      const d = x.getImageData(0, 0, 200, 150).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      r.litPixels = lit;
      r.cells = call(pd, "GetNumberOfCells");
      r.ok = lit > 500;
      r.totalMs = performance.now() - t0;
    } catch (e) {
      r.ok = false;
      r.error = String((e && e.message) || e);
    }
    done();
  })();
})();
