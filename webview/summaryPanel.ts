/**
 * The header-summary surface: what is in a file the preview did not load.
 *
 * Pure DOM reusing the `.meshsize-*` chrome, like qualityPanel / meshSizePanel /
 * integralPanel / dataTablePanel — a sixth panel needs no sixth header recipe.
 *
 * Two surfaces on purpose. The `#stats` rows are the durable record: they sit in
 * the sidebar's Information section where the parsed mesh's stats would be, and
 * they stay after the overlay is dismissed. The overlay is the thing that says
 * "this is not your mesh" and carries the one action that changes it.
 *
 * Everything is built with DOM nodes rather than `innerHTML` (which is how
 * `renderStats` does it): block names and data-array names come straight off an
 * untrusted file, and this module is the one that renders the most of them.
 */

import { t } from "../src/parser/i18n/runtime";
import type { MeshSummary } from "../src/parser/meshSummary";

/** Bytes as a short human string — a summary is about orders of magnitude. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function num(n: number | undefined): string {
  return n === undefined ? "—" : n.toLocaleString();
}

function statRow(key: string, value: string, warn = false): HTMLElement {
  const row = document.createElement("div");
  row.className = warn ? "stat-row warn" : "stat-row";
  const k = document.createElement("span");
  k.className = "stat-key";
  k.textContent = key;
  const v = document.createElement("span");
  v.textContent = value;
  row.append(k, v);
  return row;
}

/**
 * What the summary cost, in one phrase. The UI must never imply "instant" for a
 * `"scan"` or a `"read"` — see the cost model in `src/parser/meshSummary.ts`.
 */
export function costPhrase(s: MeshSummary): string {
  switch (s.cost) {
    case "header":
      return `read ${bytes(s.bytesRead)} of ${bytes(s.fileSize)}`;
    case "scan":
      return `streamed the whole file (${bytes(s.fileSize)}) without building a mesh`;
    case "buffered":
      return `read the whole file (${bytes(s.fileSize)}) — this format has no header-only reader`;
    case "read":
      return `parsed the whole file (${bytes(s.fileSize)}) — this format has no header-only reader`;
  }
}

/** Fills the sidebar's Information section for a file that was not loaded. */
export function renderSummaryStats(statsEl: HTMLElement, s: MeshSummary): void {
  statsEl.textContent = "";
  statsEl.append(
    statRow("File", s.fileName),
    statRow("Size", bytes(s.fileSize)),
    statRow("Format", s.ext || "—"),
    statRow("Nodes", num(s.nodeCount)),
    statRow("Cells", num(s.cellCount))
  );
  if (s.datasetType) statsEl.append(statRow("Dataset", s.datasetType));
  if (!s.exact) statsEl.append(statRow("Counts", "partial", true));
  statsEl.append(statRow("Header summary", "mesh not loaded", true));
}

function card(title: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "meshsize-card";
  const t = document.createElement("div");
  t.className = "meshsize-card-title";
  t.textContent = title;
  el.appendChild(t);
  return el;
}

function nameList(title: string, names: string[]): HTMLElement | undefined {
  if (names.length === 0) return undefined;
  const el = card(`${title} (${names.length})`);
  const p = document.createElement("div");
  p.className = "meshsize-summary";
  p.textContent = names.join(", ");
  p.title = names.join(", ");
  el.appendChild(p);
  return el;
}

/** The in-viewport card, with the one action that loads the mesh for real. */
export function renderSummaryOverlay(
  container: HTMLElement,
  s: MeshSummary,
  handlers: { onOpenFull: (fields?: string[]) => void }
): void {
  container.textContent = "";
  container.hidden = false;

  const cardEl = document.createElement("div");
  cardEl.id = "summary-card";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = t("Header summary");
  header.appendChild(title);
  cardEl.appendChild(header);

  const why = document.createElement("div");
  why.className = "meshsize-summary";
  why.textContent =
    `${s.fileName} is ${bytes(s.fileSize)}, so it was summarized instead of loaded. ` +
    `${s.method} — ${costPhrase(s)}.`;
  cardEl.appendChild(why);

  const counts = card("Counts");
  counts.append(
    statRow("Nodes", num(s.nodeCount)),
    statRow("Cells", num(s.cellCount))
  );
  cardEl.appendChild(counts);

  if (s.blocks.length > 0) {
    const blocks = card(`Blocks (${s.blocks.length})`);
    const table = document.createElement("table");
    table.className = "meshsize-table";
    const head = document.createElement("tr");
    for (const h of ["block", "kind", "count", "nodes"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const b of s.blocks) {
      const tr = document.createElement("tr");
      for (const c of [b.type, b.kind ?? "—", b.count.toLocaleString(), b.nodesPerCell?.toString() ?? "—"]) {
        const td = document.createElement("td");
        td.textContent = c;
        // Fixed-layout table, so a long block name clips; the title makes that
        // recoverable rather than lossy (the integralPanel convention).
        td.title = c;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    blocks.appendChild(table);
    cardEl.appendChild(blocks);
  }

  // Selective read: only for readers that honour `arrays` (XDMF, Gmsh); MED and
  // Exodus ignore it, so offering it there would promise what the reader skips.
  const selectable = /^\.(xdmf|xmf|msh)$/i.test(s.ext);
  const chosen = new Set<string>();
  const NAME_LIMIT = 40;
  const picker = (title: string, names: string[]): HTMLElement | undefined => {
    if (names.length === 0) return undefined;
    const el = card(`${title} (${names.length})`);
    for (const name of names.slice(0, NAME_LIMIT)) {
      const label = document.createElement("label");
      label.className = "edit-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(name);
        else chosen.delete(name);
      });
      const text = document.createElement("span");
      text.textContent = name;
      text.title = name;
      label.append(box, text);
      el.appendChild(label);
    }
    if (names.length > NAME_LIMIT) {
      const more = document.createElement("div");
      more.className = "meshsize-summary summary-unknown";
      more.textContent = t("+{n} more not listed — use \"Open full mesh anyway\" to load every array.", { n: names.length - NAME_LIMIT });
      el.appendChild(more);
    }
    return el;
  };
  for (const el of selectable
    ? [
        picker("Nodal data", s.pointDataNames),
        picker("Cell data", s.cellDataNames),
        nameList("Field data", s.fieldDataNames),
      ]
    : [
        nameList("Nodal data", s.pointDataNames),
        nameList("Cell data", s.cellDataNames),
        nameList("Field data", s.fieldDataNames),
      ]) {
    if (el) cardEl.appendChild(el);
  }

  if (s.regions.length > 0) {
    const el = card(`Regions (${s.regions.length})`);
    const p = document.createElement("div");
    p.className = "meshsize-summary";
    const text = s.regions.map((r) => r.name).join(", ");
    p.textContent = text;
    p.title = text;
    el.appendChild(p);
    cardEl.appendChild(el);
  }

  if (s.timeValues.length > 0) {
    cardEl.appendChild(card(`Time steps: ${s.timeValues.length}`));
  }

  if (s.unknown.length > 0) {
    const p = document.createElement("div");
    p.className = "meshsize-summary summary-unknown";
    // Not "none": an absent value here is a fact about the FORMAT, and saying
    // so is what stops a blank reading as a zero.
    p.textContent = t("Not reported by this format: {list}.", { list: s.unknown.join(", ") });
    cardEl.appendChild(p);
  }
  for (const n of s.notes) {
    const p = document.createElement("div");
    p.className = "meshsize-summary summary-unknown";
    p.textContent = n;
    cardEl.appendChild(p);
  }

  const actions = document.createElement("div");
  actions.className = "meshsize-actions";
  const btn = document.createElement("button");
  btn.id = "summary-open-full";
  btn.type = "button";
  btn.textContent = t("Open full mesh anyway");
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = t("Loading…");
    handlers.onOpenFull();
  });
  actions.appendChild(btn);
  if (selectable && s.pointDataNames.length + s.cellDataNames.length > 0) {
    const sel = document.createElement("button");
    sel.id = "summary-open-selected";
    sel.type = "button";
    sel.textContent = t("Open with selected fields");
    sel.title = t("Load the mesh reading only the ticked arrays (none ticked = all).");
    sel.addEventListener("click", () => {
      sel.disabled = true;
      btn.disabled = true;
      sel.textContent = t("Loading…");
      handlers.onOpenFull([...chosen]);
    });
    actions.appendChild(sel);
  }
  cardEl.appendChild(actions);

  container.appendChild(cardEl);
}

export function hideSummaryOverlay(container: HTMLElement): void {
  container.hidden = true;
  container.textContent = "";
}
