/**
 * The Field integrals panel — the cell-measure-weighted total and mean of every
 * per-cell field, for the whole mesh and per named region.
 *
 * Pure DOM, like qualityPanel.ts / meshSizePanel.ts / spherePanel.ts, and it
 * reuses their `.meshsize-*` chrome so a fourth analysis panel needs no fourth
 * set of styles.
 *
 * Unlike those three it does NOT compute: `dataIntegrate` is a meshio++ call
 * and the wasm is host-only, so main.ts asks the host and feeds the answer in
 * here. That is why the panel has a distinct "asking" state — the other three
 * are synchronous and have no such moment.
 */

import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { fmtPrecise as fmt } from "./panelWidgets";

export interface IntegralTotals {
  numCells: number;
  numSkipped: number;
  total: number[];
  mean: number[];
  measure: number[];
}

export interface FieldIntegral {
  variable: string;
  components: number;
  domain: IntegralTotals;
  regions: (IntegralTotals & { name: string })[];
}

export interface IntegralPanelState {
  /** Undefined while the host has not answered yet. */
  integrals?: FieldIntegral[];
  /** Set instead of `integrals` when the analysis could not run. */
  message?: string;
}

export interface IntegralPanelHandlers {
  onClose(): void;
  onRefresh(): void;
}

/** A component vector as one cell: scalars read plainly, vectors as a tuple. */
function vec(values: number[]): string {
  return values.length === 1 ? fmt(values[0]) : `(${values.map(fmt).join(", ")})`;
}

export function renderIntegralPanel(
  container: HTMLElement,
  state: IntegralPanelState,
  handlers: IntegralPanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Field integrals";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  const summary = document.createElement("div");
  summary.className = "meshsize-summary";

  if (state.message) {
    summary.textContent = state.message;
    container.appendChild(summary);
    return;
  }
  if (!state.integrals) {
    summary.textContent = "Integrating…";
    container.appendChild(summary);
    return;
  }
  if (state.integrals.length === 0) {
    summary.textContent =
      "No cell fields to integrate. Integration is measure-weighted, so a nodal " +
      "field must be moved to the cells first with Average field.";
    container.appendChild(summary);
    return;
  }

  summary.textContent =
    "Weighted by each cell's own measure. Regions overlap rather than " +
    "partition, so their totals need not sum to the whole-mesh row.";
  container.appendChild(summary);

  for (const it of state.integrals) {
    const card = document.createElement("div");
    card.className = "meshsize-card";

    const name = document.createElement("div");
    name.className = "meshsize-card-title";
    name.textContent =
      it.components > 1 ? `${it.variable} (${it.components} components)` : it.variable;
    card.appendChild(name);

    const table = document.createElement("table");
    table.className = "meshsize-table";
    const head = document.createElement("tr");
    for (const h of ["", "total", "mean", "measure", "cells"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    table.appendChild(head);

    const row = (label: string, t: IntegralTotals, strong: boolean): void => {
      const tr = document.createElement("tr");
      if (strong) tr.className = "meshsize-row-strong";
      const cells = [
        label,
        vec(t.total),
        vec(t.mean),
        vec(t.measure),
        // A skipped cell was excluded from BOTH numerator and denominator, so
        // saying so is what explains a measure smaller than the mesh's own.
        t.numSkipped > 0 ? `${t.numCells} (−${t.numSkipped})` : String(t.numCells),
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        // The columns are fixed-width, so a long region name or a vector tuple
        // clips. The title makes that recoverable rather than lossy.
        td.title = c;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    };

    row("whole mesh", it.domain, true);
    for (const g of it.regions) row(g.name, g, false);
    card.appendChild(table);
    container.appendChild(card);
  }

  const actions = document.createElement("div");
  actions.className = "meshsize-modes";
  const refresh = document.createElement("button");
  refresh.className = "meshsize-mode-btn";
  refresh.textContent = "Recompute";
  refresh.addEventListener("click", () => handlers.onRefresh());
  actions.appendChild(refresh);
  container.appendChild(actions);
}
