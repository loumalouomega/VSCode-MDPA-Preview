/**
 * The Link previews panel: which other open preview this one follows, which
 * settings are shared, and how time is matched.
 *
 * Pure DOM over the `.meshsize-*` chrome. It owns no link logic — the host hub
 * (src/parser/previewLinkHub.ts) joins the previews and relays their changes,
 * and src/parser/previewLink.ts holds the rules — so this only renders the
 * state the host last reported and posts the user's choices back.
 */

import { t } from "../src/parser/i18n/runtime";
import { glyph } from "../src/uiGlyphs";
import { LINK_KINDS, LinkKind, LinkSettings, PaneLinkScope, TimeMethod, describeLink } from "../src/parser/previewLink";
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
  title.textContent = t("Link previews");
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = t("Close");
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
    unlink.textContent = t("Unlink");
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

  container.appendChild(sectionLabel("Panes"));
  const scopeRow = document.createElement("div");
  scopeRow.className = "ui-segments";
  scopeRow.title = t("Which panes of a split layout an incoming linked change applies to. Reporting always reads the focused pane.");
  for (const [value, label] of [["focused", "Focused pane"], ["all", "All panes"]] as const) {
    const seg = document.createElement("button");
    seg.className = "ui-seg";
    seg.classList.toggle("active", state.settings.paneScope === value);
    seg.textContent = label;
    seg.disabled = !state.linked;
    seg.addEventListener("click", () => handlers.onSettings({ ...state.settings, paneScope: value as PaneLinkScope }));
    scopeRow.appendChild(seg);
  }
  container.appendChild(scopeRow);

  const timeRow = document.createElement("div");
  timeRow.className = "link-time";
  const method = document.createElement("select");
  method.className = "edit-sel";
  method.setAttribute("aria-label", t("Time matching"));
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
  tolerance.setAttribute("aria-label", t("Time tolerance"));
  tolerance.title = t("Largest time difference a nearest match may span, in the series' own time unit");
  tolerance.value = String(state.settings.timeTolerance);
  tolerance.disabled = !state.linked || !state.settings.time || state.settings.timeMethod !== "nearest";
  const offset = document.createElement("input");
  offset.type = "number";
  offset.step = "any";
  offset.className = "edit-num";
  offset.setAttribute("aria-label", t("Time offset"));
  offset.title = t("Added to this preview's time after scaling, in the peer's time unit (peer looks up t × scale + offset)");
  offset.value = String(state.settings.timeOffset);
  offset.disabled = !state.linked || !state.settings.time;
  const scale = document.createElement("input");
  scale.type = "number";
  scale.min = "0";
  scale.step = "any";
  scale.className = "edit-num";
  scale.setAttribute("aria-label", t("Time scale"));
  scale.title = t("Multiplied with this preview's time before the offset (seconds vs milliseconds: ×1000)");
  scale.value = String(state.settings.timeScale);
  scale.disabled = !state.linked || !state.settings.time;
  const commitTime = (): void => {
    const tol = Number(tolerance.value);
    const off = Number(offset.value);
    const scl = Number(scale.value);
    handlers.onSettings({
      ...state.settings,
      timeMethod: method.value as TimeMethod,
      timeTolerance: Number.isFinite(tol) && tol >= 0 ? tol : state.settings.timeTolerance,
      timeOffset: Number.isFinite(off) ? off : state.settings.timeOffset,
      timeScale: Number.isFinite(scl) && scl > 0 ? scl : state.settings.timeScale,
    });
  };
  method.addEventListener("change", commitTime);
  tolerance.addEventListener("change", commitTime);
  offset.addEventListener("change", commitTime);
  scale.addEventListener("change", commitTime);
  timeRow.append(method, tolerance);
  const mapRow = document.createElement("div");
  mapRow.className = "link-time";
  mapRow.title = t("Compare runs on different time bases: the peer looks up t × scale + offset for this preview's time t. Identity (×1 + 0) is plain physical-time matching.");
  mapRow.append(offset, scale);
  container.appendChild(timeRow);
  container.appendChild(mapRow);

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
