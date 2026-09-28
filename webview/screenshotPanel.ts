import { CaptureSettings } from "../src/parser/capturePlan";

export interface ScreenshotPanelState {
  settings: CaptureSettings;
  image?: string;
  message?: string;
  busy: boolean;
}
export function renderScreenshotPanel(root: HTMLElement, state: ScreenshotPanelState, handlers: {
  change(settings: CaptureSettings): void; refresh(): void; save(): void; close(): void;
}): void {
  root.replaceChildren();
  const heading = document.createElement("div"); heading.className = "meshsize-header";
  const title = document.createElement("strong"); title.textContent = "Screenshot"; heading.append(title);
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label;
    b.addEventListener("click", action); return b;
  };
  heading.append(button("Close", handlers.close)); root.append(heading);
  const controls = document.createElement("fieldset"); controls.disabled = state.busy; root.append(controls);
  const row = (name: string, el: HTMLElement): void => {
    const label = document.createElement("label"); label.className = "screenshot-row";
    const text = document.createElement("span"); text.textContent = name; label.append(text, el); controls.append(label);
  };
  const set = (key: keyof CaptureSettings, value: unknown): void => handlers.change({ ...state.settings, [key]: value });
  const select = (name: string, key: keyof CaptureSettings, choices: [string, string][]): void => {
    const el = document.createElement("select"); el.dataset.setting = key;
    choices.forEach(([value, label]) => { const o = document.createElement("option"); o.value = value; o.textContent = label; el.append(o); });
    el.value = String(state.settings[key]); el.onchange = () => set(key, el.value); row(name, el);
  };
  const input = (name: string, key: keyof CaptureSettings, type: string): void => {
    const el = document.createElement("input"); el.type = type; el.dataset.setting = key; el.value = String(state.settings[key]);
    if (type === "number") { el.min = key === "fontSize" ? "8" : "1"; el.max = key === "fontSize" ? "96" : "8192"; el.step = "1"; }
    el.onchange = () => set(key, type === "number" ? Number(el.value) : el.value); row(name, el);
  };
  const checkbox = (name: string, key: "legends" | "labels"): void => {
    const el = document.createElement("input"); el.type = "checkbox"; el.dataset.setting = key; el.checked = state.settings[key];
    el.onchange = () => set(key, el.checked); row(name, el);
  };
  select("Capture", "scope", [["layout", "Whole layout"], ["focused", "Focused pane"]]);
  select("Resolution", "resolution", [["1", "Viewport (1×)"], ["2", "2×"], ["4", "4×"], ["custom", "Custom pixels"]]);
  if (state.settings.resolution === "custom") { input("Width", "width", "number"); input("Height", "height", "number"); }
  select("Background", "background", [["scene", "Current scene"], ["white", "White"], ["black", "Black"], ["custom", "Custom color"], ["transparent", "Transparent"]]);
  if (state.settings.background === "custom") input("Color", "color", "color");
  checkbox("Automatic legends", "legends");
  select("Legend corner", "corner", [["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"], ["top-right", "Top right"], ["top-left", "Top left"]]);
  input("Text size (pixels)", "fontSize", "number"); checkbox("Step/time label", "labels");
  input("Title", "title", "text");
  const caption = document.createElement("textarea"); caption.dataset.setting = "caption"; caption.value = state.settings.caption;
  caption.onchange = () => set("caption", caption.value); row("Caption", caption);
  select("Caption placement", "captionPosition", [["bottom", "Bottom"], ["top", "Top"]]);
  const preview = document.createElement("div"); preview.className = "screenshot-preview";
  if (state.image) { const img = document.createElement("img"); img.alt = "PNG export preview"; img.src = state.image; preview.append(img); }
  root.append(preview);
  const message = document.createElement("div"); message.setAttribute("role", "status"); message.textContent = state.message ?? ""; root.append(message);
  const refresh = button("Refresh Preview", handlers.refresh); refresh.disabled = state.busy;
  const save = button("Save PNG…", handlers.save); save.disabled = state.busy || !state.image; save.dataset.action = "saveScreenshot";
  root.append(refresh, save);
}
