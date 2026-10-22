// Floating panel for Advanced ▸ Lighting…: global specular/ambient/diffuse
// balance + backface culling, applied to every current and future actor.
// Pure DOM, mirrors qualityPanel.ts.

import { glyph } from "../src/uiGlyphs";
import { DEFAULT_LIGHT_SPEC, type LightMode, type LightSpec } from "../src/parser/render/lightMode";

export interface LightingState {
  specular: number; // 0..1
  ambient: number; // 0..1
  diffuse: number; // 0..1
  cullBackFace: boolean;
  /** Smooth shading from averaged point normals (display only). */
  smoothShading: boolean;
  /** Where the light sits (headlight = follows the camera). */
  light: LightSpec;
}

export const DEFAULT_LIGHTING_STATE: LightingState = {
  specular: 0,
  ambient: 0.3,
  diffuse: 0.7,
  cullBackFace: false,
  smoothShading: false,
  light: { ...DEFAULT_LIGHT_SPEC },
};

export interface LightingPanelOptions {
  /** The backend honours smoothShading (caps.displayFilters). */
  displayFilters: boolean;
  /** The backend honours light modes (caps.lightModes). */
  lightModes?: boolean;
}

export interface LightingPanelHandlers {
  onClose(): void;
  onChange(state: LightingState): void;
  onReset(): void;
  /** A light-angle slider moved: apply live without re-rendering the panel (keeps the drag). */
  onLightAngle?(light: LightSpec): void;
}

function slider(
  label: string,
  value: number,
  onInput: (v: number) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "field-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = label;
  row.appendChild(l);
  const input = document.createElement("input");
  input.type = "range";
  input.className = "field-slider";
  input.min = "0";
  input.max = "1";
  input.step = "0.05";
  input.value = String(value);
  const valEl = document.createElement("span");
  valEl.className = "field-slider-value";
  valEl.textContent = value.toFixed(2);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    valEl.textContent = v.toFixed(2);
    onInput(v);
  });
  row.appendChild(input);
  row.appendChild(valEl);
  return row;
}

export function renderLightingPanel(
  container: HTMLElement,
  state: LightingState,
  handlers: LightingPanelHandlers,
  options: LightingPanelOptions = { displayFilters: false }
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "field-header";
  const title = document.createElement("div");
  title.className = "field-title";
  title.textContent = "Lighting";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "field-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  container.appendChild(
    slider("Specular", state.specular, (v) => handlers.onChange({ ...state, specular: v }))
  );
  container.appendChild(
    slider("Ambient", state.ambient, (v) => handlers.onChange({ ...state, ambient: v }))
  );
  container.appendChild(
    slider("Diffuse", state.diffuse, (v) => handlers.onChange({ ...state, diffuse: v }))
  );

  const cullLabel = document.createElement("label");
  cullLabel.className = "edit-check";
  const cullCk = document.createElement("input");
  cullCk.type = "checkbox";
  cullCk.checked = state.cullBackFace;
  cullCk.addEventListener("change", () =>
    handlers.onChange({ ...state, cullBackFace: cullCk.checked })
  );
  cullLabel.appendChild(cullCk);
  cullLabel.appendChild(document.createTextNode("Cull back faces"));
  cullLabel.title = "Hide the inside surface of a shell — helps spot an inverted (flipped) element";
  container.appendChild(cullLabel);

  if (options.displayFilters) {
    const smoothLabel = document.createElement("label");
    smoothLabel.className = "edit-check";
    const smoothCk = document.createElement("input");
    smoothCk.type = "checkbox";
    smoothCk.checked = state.smoothShading;
    smoothCk.addEventListener("change", () => handlers.onChange({ ...state, smoothShading: smoothCk.checked }));
    smoothLabel.appendChild(smoothCk);
    smoothLabel.appendChild(document.createTextNode("Smooth shading"));
    smoothLabel.title =
      "Shade with averaged point normals. Suits curved surfaces (scans, spheres); it rounds the hard edges of a boxy mesh because there is no feature angle";
    container.appendChild(smoothLabel);
  }

  if (options.lightModes) {
    const row = document.createElement("div");
    row.className = "field-row";
    const l = document.createElement("label");
    l.className = "field-label";
    l.textContent = "Light";
    row.appendChild(l);
    const sel = document.createElement("select");
    sel.className = "field-select";
    const modes: [LightMode, string][] = [
      ["headlight", "Headlight (follows camera)"],
      ["scene", "Fixed in the scene"],
      ["positional", "Point light"],
    ];
    for (const [value, text] of modes) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      o.selected = state.light.mode === value;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () =>
      handlers.onChange({ ...state, light: { ...state.light, mode: sel.value as LightMode } })
    );
    row.appendChild(sel);
    container.appendChild(row);
    if (state.light.mode !== "headlight") {
      const angle = (label: string, value: number, min: number, max: number, set: (v: number) => LightSpec) => {
        const r = document.createElement("div");
        r.className = "field-row";
        const al = document.createElement("label");
        al.className = "field-label";
        al.textContent = label;
        r.appendChild(al);
        const input = document.createElement("input");
        input.type = "range";
        input.className = "field-slider";
        input.min = String(min);
        input.max = String(max);
        input.step = "5";
        input.value = String(value);
        const ve = document.createElement("span");
        ve.className = "field-slider-value";
        ve.textContent = `${value}°`;
        input.addEventListener("input", () => {
          ve.textContent = `${input.value}°`;
          handlers.onLightAngle?.(set(Number(input.value)));
        });
        r.appendChild(input);
        r.appendChild(ve);
        container.appendChild(r);
      };
      angle("Azimuth", Math.round(state.light.azimuth), 0, 360, (v) => ({ ...state.light, azimuth: v }));
      angle("Elevation", Math.round(state.light.elevation), -90, 90, (v) => ({ ...state.light, elevation: v }));
    }
  }

  const resetBtn = document.createElement("button");
  resetBtn.className = "inspect-frame-btn";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => handlers.onReset());
  container.appendChild(resetBtn);
}
