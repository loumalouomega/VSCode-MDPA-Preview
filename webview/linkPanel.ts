/**
 * The Link previews panel: which other open preview this one follows, which
 * settings are shared, and how time is matched.
 *
 * Pure DOM over the `.meshsize-*` chrome. It owns no link logic — the host hub
 * (src/parser/previewLinkHub.ts) joins the previews and relays their changes,
 * and src/parser/previewLink.ts holds the rules — so this only renders the
 * state the host last reported and posts the user's choices back.
 */

import { glyph } from "../src/uiGlyphs";
import { LINK_KINDS, LinkKind, LinkSettings, TimeMethod, describeLink } from "../src/parser/previewLink";
import { sectionLabel } from "./panelWidgets";

export interface LinkPanelState {
  linked: boolean;
  peers: { name: string; path: string }[];
  settings: LinkSettings;
  /** How many other bound previews could still be linked. */
  candidates: number;
  /** Latest disclosures from the host (unmatched times, missing fields), newest last. */
  notes: string[];
}

export interface LinkPanelHandlers {
  onClose(): void;
  onPick(): void;
  onUnlink(): void;
  onSettings(next: LinkSettings): void;
}

const LABELS: Record<LinkKind, [string, string]> = {
  camera: ["Camera", "The viewpoint of the focused pane"],
  field: ["Field", "The coloured field, its component and display modes (when the other mesh has that field)"],
  range: ["Colour map and range", "Colormap, fixed range, log scale and bands"],
  clip: ["Clip plane", "Axis, position and flip of the clipping plane"],
  time: ["Physical time", "Move to the frame at the same physical time — matched by time, never by frame number"],
};

export function renderLinkPanel(container: HTMLElement, state: LinkPanelState, handlers: LinkPanelHandlers): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Link previews";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  const status = document.createElement("div");
  status.className = "meshsize-note link-status";
  status.textContent = describeLink(
    state.peers.map((p) => p.name),
    state.settings
  );
  container.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "meshsize-actions";
  const pick = document.createElement("button");
  pick.className = "panel-btn";
  pick.textContent = state.linked ? "Link another…" : "Link with…";
  pick.title = state.candidates === 0 ? "Open a second mesh or run in another preview first" : "Choose another open preview to link with";
  pick.addEventListener("click", () => handlers.onPick());
  actions.appendChild(pick);
  if (state.linked) {
    const unlink = document.createElement("button");
    unlink.className = "panel-btn";
    unlink.textContent = "Unlink";
    unlink.addEventListener("click", () => handlers.onUnlink());
    actions.appendChild(unlink);
  }
  container.appendChild(actions);

  container.appendChild(sectionLabel("Shared between linked previews"));
  for (const kind of LINK_KINDS) {
    const row = document.createElement("label");
    row.className = "link-row";
    row.title = LABELS[kind][1];
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.settings[kind];
    box.disabled = !state.linked;
    box.addEventListener("change", () => handlers.onSettings({ ...state.settings, [kind]: box.checked }));
    row.append(box, document.createTextNode(` ${LABELS[kind][0]}`));
    container.appendChild(row);
  }

  const timeRow = document.createElement("div");
  timeRow.className = "link-time";
  const method = document.createElement("select");
  method.className = "edit-sel";
  method.setAttribute("aria-label", "Time matching");
  for (const [value, label] of [["exact", "Exact time"], ["nearest", "Nearest within tolerance"]] as const) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    method.appendChild(o);
  }
  method.value = state.settings.timeMethod;
  method.disabled = !state.linked || !state.settings.time;
  const tolerance = document.createElement("input");
  tolerance.type = "number";
  tolerance.min = "0";
  tolerance.step = "any";
  tolerance.className = "edit-num";
  tolerance.setAttribute("aria-label", "Time tolerance");
  tolerance.title = "Largest time difference a nearest match may span, in the series' own time unit";
  tolerance.value = String(state.settings.timeTolerance);
  tolerance.disabled = !state.linked || !state.settings.time || state.settings.timeMethod !== "nearest";
  const commitTime = (): void => {
    const tol = Number(tolerance.value);
    handlers.onSettings({
      ...state.settings,
      timeMethod: method.value as TimeMethod,
      timeTolerance: Number.isFinite(tol) && tol >= 0 ? tol : state.settings.timeTolerance,
    });
  };
  method.addEventListener("change", commitTime);
  tolerance.addEventListener("change", commitTime);
  timeRow.append(method, tolerance);
  container.appendChild(timeRow);

  if (state.notes.length > 0) {
    container.appendChild(sectionLabel("Not synchronised"));
    const list = document.createElement("ul");
    list.className = "link-notes";
    for (const n of state.notes) {
      const li = document.createElement("li");
      li.textContent = n;
      list.appendChild(li);
    }
    container.appendChild(list);
  }
}
