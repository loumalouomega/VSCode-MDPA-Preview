// Floating panel for Advanced ▸ Lighting…: global specular/ambient/diffuse
// balance + backface culling, applied to every current and future actor.
// Pure DOM, mirrors qualityPanel.ts.

import { TOOLBAR_ICONS } from "../src/toolbarIcons";

export interface LightingState {
  specular: number; // 0..1
  ambient: number; // 0..1
  diffuse: number; // 0..1
  cullBackFace: boolean;
}

export const DEFAULT_LIGHTING_STATE: LightingState = {
  specular: 0,
  ambient: 0.3,
  diffuse: 0.7,
  cullBackFace: false,
};

export interface LightingPanelHandlers {
  onClose(): void;
  onChange(state: LightingState): void;
  onReset(): void;
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
  handlers: LightingPanelHandlers
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
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
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

  const resetBtn = document.createElement("button");
  resetBtn.className = "inspect-frame-btn";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => handlers.onReset());
  container.appendChild(resetBtn);
}
