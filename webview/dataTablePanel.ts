/**
 * The data table panel — every node/element/condition/geometry as a row of
 * plain values, with the CSV/XLSX export of the same table.
 *
 * Pure DOM, like qualityPanel.ts / meshSizePanel.ts / integralPanel.ts, and it
 * reuses their `.meshsize-*` chrome so a fifth panel needs no fifth header
 * recipe. The rows themselves need their own `.dt-*` family: `.meshsize-table`
 * is a fixed-layout <table> with a hardcoded first-column width, and a <table>
 * cannot host the absolutely-positioned window this panel scrolls through.
 *
 * It is the first windowed list in the webview, and it PAGINATES before it
 * virtualizes. A single spacer sized `rowCount * ROW_H` runs into the browser's
 * maximum layout height (Chromium about 33.5M px, Firefox about 17.9M px): at
 * 24 px a row that is reached somewhere past a million rows, after which
 * scrollTop stops mapping to a row index and the tail of a large mesh becomes
 * silently unreachable — the worst failure available, since it looks like it
 * worked. A 100k-row page keeps the spacer two orders of magnitude inside every
 * engine's limit, and unlike main.ts's NODE_LABEL_LIMIT (which refuses,
 * because five million DOM labels cannot be drawn at all) the table stays
 * completely usable at any size.
 *
 * Export always writes the WHOLE table, never the visible page.
 */

import {
  CellValue,
  ColumnType,
  TableKind,
  TableOptions,
  TableView,
  TABLE_KINDS,
} from "../src/parser/dataTable";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { fmtPrecise } from "./panelWidgets";

/** Must match `.dt-row { height }` in style.css. */
export const ROW_H = 24;
/** Rows per page — see the module header for why this is not `rowCount`. */
export const PAGE_ROWS = 100_000;
const OVERSCAN = 8;

export interface DataTablePanelState {
  kind: TableKind;
  /** Undefined only before the first model arrives. */
  view?: TableView;
  opts: TableOptions;
  counts: Record<TableKind, number>;
  /** 0-based page index into `view`. */
  page: number;
  /** Row to scroll to once, e.g. after a "go to row" jump. */
  focusRow?: number;
  /** Entity id highlighted in the scene, echoed back as the selected row. */
  selectedId?: number;
  message?: string;
}

export interface DataTablePanelHandlers {
  onClose(): void;
  onKind(kind: TableKind): void;
  onOptions(opts: TableOptions): void;
  onPage(page: number): void;
  onGotoRow(row: number): void;
  onSelectRow(kind: TableKind, id: number): void;
  onFrameSelection(): void;
  onExport(format: ".csv" | ".xlsx"): void;
}

/** Column pixel widths: ids are short, coordinates and values need room, and
 *  a connectivity or SubModelPart cell is the one that really wants space. */
function columnWidth(name: string, type: string): number {
  if (name === "nodes") return 200;
  if (name === "SubModelParts") return 220;
  if (name === "block") return 210;
  if (type === "id") return 90;
  return Math.max(100, Math.min(180, name.length * 9 + 30));
}

/**
 * An id is an id, not a measurement: `toPrecision(6)` would render node 1 as
 * "1.00000". Integers print verbatim for the same reason — a partition index
 * or a node count reads as a whole number — and only a genuine fraction gets
 * the six-significant-digit treatment shared with the integrals panel.
 */
function cellText(v: CellValue, type: ColumnType): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (type === "id" || Number.isInteger(v)) return String(v);
  return fmtPrecise(v);
}

/** Scroll position survives a same-kind, same-page re-render (a selection or
 *  an option toggle); a kind or page change starts at the top. */
let lastScrollKey = "";
let lastScrollTop = 0;

export function renderDataTablePanel(
  container: HTMLElement,
  state: DataTablePanelState,
  handlers: DataTablePanelHandlers
): void {
  const key = `${state.kind}:${state.page}:${JSON.stringify(state.opts)}`;
  const prevScroll = container.querySelector<HTMLElement>(".dt-scroll");
  if (prevScroll && key === lastScrollKey) lastScrollTop = prevScroll.scrollTop;
  else if (key !== lastScrollKey) lastScrollTop = 0;
  lastScrollKey = key;

  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Data table";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  container.appendChild(buildToolbar(state, handlers));

  const summary = document.createElement("div");
  summary.className = "meshsize-summary";
  container.appendChild(summary);

  const view = state.view;
  if (state.message || !view) {
    summary.textContent = state.message ?? "No mesh loaded.";
    return;
  }
  if (view.rowCount === 0) {
    summary.textContent = state.opts.submodelpart
      ? `No ${state.kind.toLowerCase()} in "${state.opts.submodelpart}".`
      : `This mesh has no ${state.kind.toLowerCase()}.`;
    return;
  }

  const pages = Math.max(1, Math.ceil(view.rowCount / PAGE_ROWS));
  const page = Math.min(Math.max(0, state.page), pages - 1);
  const first = page * PAGE_ROWS;
  const pageRows = Math.min(PAGE_ROWS, view.rowCount - first);
  summary.textContent =
    `${view.rowCount.toLocaleString()} rows x ${view.columns.length} columns. ` +
    `Export writes the whole table, not just this page.`;

  const widths = view.columns.map((c, i) => columnWidth(c, view.columnTypes[i]));
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  const scroll = document.createElement("div");
  scroll.className = "dt-scroll";

  const head = document.createElement("div");
  head.className = "dt-head";
  head.style.minWidth = `${totalWidth}px`;
  for (let c = 0; c < view.columns.length; c++) {
    const cell = document.createElement("div");
    cell.className = view.columnTypes[c] === "text" ? "dt-cell dt-text" : "dt-cell";
    cell.style.width = `${widths[c]}px`;
    cell.textContent = view.columns[c];
    cell.title = view.columns[c];
    head.appendChild(cell);
  }
  scroll.appendChild(head);

  const body = document.createElement("div");
  body.className = "dt-body";
  body.style.height = `${pageRows * ROW_H}px`;
  body.style.minWidth = `${totalWidth}px`;
  const windowEl = document.createElement("div");
  windowEl.className = "dt-window";
  body.appendChild(windowEl);
  scroll.appendChild(body);
  container.appendChild(scroll);

  const buf = new Array<CellValue>(view.columns.length);
  let renderedStart = -1;

  const paint = (): void => {
    const visible = Math.ceil(scroll.clientHeight / ROW_H) + OVERSCAN * 2;
    const start = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - OVERSCAN);
    if (start === renderedStart) return;
    renderedStart = start;
    const end = Math.min(pageRows, start + visible);
    windowEl.style.top = `${start * ROW_H}px`;
    windowEl.textContent = "";
    for (let r = start; r < end; r++) {
      view.rowInto(first + r, buf);
      const row = document.createElement("div");
      row.className = "dt-row";
      const id = buf[0];
      if (typeof id === "number" && id === state.selectedId) row.classList.add("selected");
      for (let c = 0; c < buf.length; c++) {
        const cell = document.createElement("div");
        cell.className = view.columnTypes[c] === "text" ? "dt-cell dt-text" : "dt-cell";
        cell.style.width = `${widths[c]}px`;
        const text = cellText(buf[c], view.columnTypes[c]);
        cell.textContent = text;
        // The columns are fixed-width, so a connectivity list or a long part
        // path clips. The title makes that recoverable rather than lossy.
        if (text) cell.title = text;
        row.appendChild(cell);
      }
      if (typeof id === "number") {
        row.addEventListener("click", () => handlers.onSelectRow(state.kind, id));
      }
      windowEl.appendChild(row);
    }
  };

  // A trackpad fires scroll faster than a frame, so repaints are coalesced and
  // skipped entirely while the window's first row has not moved.
  let queued = false;
  scroll.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      paint();
    });
  });

  if (pages > 1) container.appendChild(buildPager(page, pages, view.rowCount, handlers));

  // clientHeight is 0 until the panel is in the layout, so the first paint has
  // to wait a frame — the same reason qualityPanel.ts sizes its canvas in one.
  requestAnimationFrame(() => {
    const target =
      state.focusRow !== undefined
        ? Math.max(0, (state.focusRow - first) * ROW_H - ROW_H * 3)
        : lastScrollTop;
    scroll.scrollTop = target;
    renderedStart = -1;
    paint();
  });
  paint();
}

function buildToolbar(
  state: DataTablePanelState,
  handlers: DataTablePanelHandlers
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "dt-toolbar";

  const kinds = document.createElement("div");
  kinds.className = "meshsize-modes";
  for (const kind of TABLE_KINDS) {
    const btn = document.createElement("button");
    btn.className = "meshsize-mode-btn";
    if (kind === state.kind) btn.classList.add("active");
    const n = state.counts[kind] ?? 0;
    btn.textContent = `${kind} (${n.toLocaleString()})`;
    btn.disabled = n === 0;
    btn.addEventListener("click", () => handlers.onKind(kind));
    kinds.appendChild(btn);
  }
  bar.appendChild(kinds);

  const row = document.createElement("div");
  row.className = "dt-options";

  const parts = document.createElement("label");
  parts.className = "edit-check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = Boolean(state.opts.membership);
  cb.addEventListener("change", () =>
    handlers.onOptions({ ...state.opts, membership: cb.checked })
  );
  parts.appendChild(cb);
  parts.appendChild(document.createTextNode("SubModelParts"));
  row.appendChild(parts);

  const split = document.createElement("label");
  split.className = "edit-check";
  const cb2 = document.createElement("input");
  cb2.type = "checkbox";
  cb2.checked = Boolean(state.opts.nodeColumns);
  cb2.addEventListener("change", () =>
    handlers.onOptions({ ...state.opts, nodeColumns: cb2.checked })
  );
  split.appendChild(cb2);
  split.appendChild(document.createTextNode("Split nodes"));
  split.title = "One column per connectivity slot instead of one joined cell";
  row.appendChild(split);

  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  row.appendChild(spacer);

  // Framing is a button rather than part of the row click, the same split the
  // Inspect panel makes: clicking down a column of rows would otherwise slam
  // the camera into each entity in turn, which is disorienting rather than
  // useful. The highlight alone is enough to say "this one".
  const frame = document.createElement("button");
  frame.className = "meshsize-mode-btn";
  frame.textContent = "Frame";
  frame.title = "Zoom the 3D view to the selected row";
  frame.disabled = state.selectedId === undefined;
  frame.addEventListener("click", () => handlers.onFrameSelection());
  row.appendChild(frame);

  for (const [label, format] of [
    ["CSV", ".csv"],
    ["XLSX", ".xlsx"],
  ] as [string, ".csv" | ".xlsx"][]) {
    const btn = document.createElement("button");
    btn.className = "meshsize-mode-btn";
    btn.textContent = label;
    btn.title = `Export the whole ${state.kind.toLowerCase()} table as ${label}`;
    btn.disabled = !state.view || state.view.rowCount === 0;
    btn.addEventListener("click", () => handlers.onExport(format));
    row.appendChild(btn);
  }
  bar.appendChild(row);
  return bar;
}

function buildPager(
  page: number,
  pages: number,
  rowCount: number,
  handlers: DataTablePanelHandlers
): HTMLElement {
  const pager = document.createElement("div");
  pager.className = "dt-pager";

  const step = (label: string, to: number, enabled: boolean): void => {
    const b = document.createElement("button");
    b.className = "meshsize-mode-btn";
    b.textContent = label;
    b.disabled = !enabled;
    b.addEventListener("click", () => handlers.onPage(to));
    pager.appendChild(b);
  };
  step("<<", 0, page > 0);
  step("<", page - 1, page > 0);

  const label = document.createElement("span");
  label.className = "dt-page-label";
  label.textContent = `page ${page + 1} / ${pages}`;
  pager.appendChild(label);

  step(">", page + 1, page < pages - 1);
  step(">>", pages - 1, page < pages - 1);

  const goto = document.createElement("input");
  goto.type = "number";
  goto.className = "dt-goto";
  goto.min = "1";
  goto.max = String(rowCount);
  goto.placeholder = "row #";
  goto.title = "Jump to a row number (1-based)";
  goto.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const n = Number(goto.value);
    if (Number.isFinite(n) && n >= 1) handlers.onGotoRow(Math.min(rowCount, Math.floor(n)) - 1);
  });
  pager.appendChild(goto);
  return pager;
}
