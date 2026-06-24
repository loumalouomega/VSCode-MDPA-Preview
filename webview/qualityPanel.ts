// Renders the mesh-quality report as a floating panel: a verdict header plus one
// card per metric, each with a min/mean/max line, a stacked band bar and a
// canvas histogram. Pure DOM + Canvas 2D — no charting library (none is bundled
// and the webview CSP forbids loading one from a CDN).

import { MetricResult, QualityBand, QualityReport } from "../src/parser/meshQuality";

export interface QualityPanelHandlers {
  onClose(): void;
  onHighlight(metricKey: string): void;
  onClearHighlight(): void;
  onFrame(metricKey: string): void;
}

const BAND_COLOR: Record<QualityBand, string> = {
  good: "#2ea043",
  acceptable: "#d4a72c",
  bad: "#db6d28",
  unacceptable: "#cf222e",
};

const BAND_LABEL: Record<QualityBand, string> = {
  good: "Good",
  acceptable: "Acceptable",
  bad: "Bad",
  unacceptable: "Unacceptable",
};

const BANDS: QualityBand[] = ["good", "acceptable", "bad", "unacceptable"];

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.01) return v.toExponential(2);
  return v.toFixed(2);
}

export function renderQualityPanel(
  container: HTMLElement,
  report: QualityReport,
  handlers: QualityPanelHandlers
): void {
  container.textContent = "";
  // Track which metric currently drives the highlight overlay.
  let activeHighlight: string | null = null;

  // --- header ---
  const header = document.createElement("div");
  header.className = "quality-header";

  const title = document.createElement("div");
  title.className = "quality-title";
  title.textContent = "Mesh Quality";
  header.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.className = "quality-close";
  closeBtn.title = "Close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);

  container.appendChild(header);

  const verdict = document.createElement("div");
  verdict.className = `quality-verdict ${report.overallOk ? "ok" : "fail"}`;
  verdict.textContent = report.overallOk
    ? "✓ Mesh quality criteria satisfied"
    : "⚠ Quality criteria not satisfied";
  container.appendChild(verdict);

  const summary = document.createElement("div");
  summary.className = "quality-summary";
  const typeStr = report.elementTypes.join(", ") || "—";
  summary.textContent = `${report.analyzedCount.toLocaleString()} / ${report.elementCount.toLocaleString()} elements analysed · ${typeStr}`;
  container.appendChild(summary);

  if (report.analyzedCount === 0) {
    const empty = document.createElement("div");
    empty.className = "quality-summary";
    empty.textContent =
      "No surface or volume elements to analyse (lines/points carry no quality metrics).";
    container.appendChild(empty);
    return;
  }

  // --- one card per metric ---
  for (const m of report.metrics) {
    container.appendChild(buildCard(m, handlers, () => activeHighlight, (k) => (activeHighlight = k)));
  }
}

function buildCard(
  m: MetricResult,
  handlers: QualityPanelHandlers,
  getActive: () => string | null,
  setActive: (k: string | null) => void
): HTMLElement {
  const card = document.createElement("div");
  card.className = "quality-card";

  const name = document.createElement("div");
  name.className = "quality-card-name";
  name.textContent = m.label + (m.unit ? ` (${m.unit})` : "");
  card.appendChild(name);

  const range = document.createElement("div");
  range.className = "quality-range";
  range.textContent = `min ${fmt(m.min)} · mean ${fmt(m.mean)} · max ${fmt(m.max)}`;
  card.appendChild(range);

  // Stacked band bar.
  const bar = document.createElement("div");
  bar.className = "quality-bandbar";
  for (const band of BANDS) {
    const pct = m.bandPct[band];
    if (pct <= 0) continue;
    const seg = document.createElement("div");
    seg.className = "quality-bandseg";
    seg.style.width = `${pct}%`;
    seg.style.background = BAND_COLOR[band];
    seg.title = `${BAND_LABEL[band]}: ${m.bands[band].toLocaleString()} (${pct.toFixed(1)}%)`;
    bar.appendChild(seg);
  }
  card.appendChild(bar);

  // Legend with counts.
  const legend = document.createElement("div");
  legend.className = "quality-legend";
  for (const band of BANDS) {
    if (m.bands[band] === 0) continue;
    const item = document.createElement("span");
    item.className = "quality-legend-item";
    const dot = document.createElement("span");
    dot.className = "quality-dot";
    dot.style.background = BAND_COLOR[band];
    item.appendChild(dot);
    item.appendChild(
      document.createTextNode(`${BAND_LABEL[band]} ${m.bandPct[band].toFixed(1)}%`)
    );
    legend.appendChild(item);
  }
  card.appendChild(legend);

  // Histogram canvas.
  const canvas = document.createElement("canvas");
  canvas.className = "quality-hist";
  card.appendChild(canvas);
  // Defer draw until in the DOM so clientWidth is known.
  requestAnimationFrame(() => drawHistogram(canvas, m));

  // Highlight / frame actions for per-element metrics with bad entities.
  if (m.perElement && m.badEntityIds.length > 0) {
    const actions = document.createElement("div");
    actions.className = "quality-actions";
    actions.dataset.metric = m.key;

    const hl = document.createElement("button");
    hl.className = "quality-highlight-btn";
    hl.textContent = `Highlight bad (${m.badEntityIds.length})`;
    hl.classList.toggle("active", getActive() === m.key);
    hl.addEventListener("click", () => {
      if (getActive() === m.key) {
        handlers.onClearHighlight();
        setActive(null);
      } else {
        handlers.onHighlight(m.key);
        setActive(m.key);
      }
      syncHighlightButtons(getActive());
    });
    actions.appendChild(hl);

    const frame = document.createElement("button");
    frame.textContent = "Frame";
    frame.title = "Zoom to bad elements";
    frame.addEventListener("click", () => {
      handlers.onHighlight(m.key);
      setActive(m.key);
      handlers.onFrame(m.key);
      syncHighlightButtons(getActive());
    });
    actions.appendChild(frame);

    card.appendChild(actions);
  }

  return card;
}

// Reflects the single active highlight across every metric's toggle button.
function syncHighlightButtons(activeKey: string | null): void {
  document.querySelectorAll<HTMLElement>(".quality-actions").forEach((el) => {
    const btn = el.querySelector(".quality-highlight-btn");
    btn?.classList.toggle("active", el.dataset.metric === activeKey);
  });
}

function drawHistogram(canvas: HTMLCanvasElement, m: MetricResult): void {
  const cssW = canvas.clientWidth || 300;
  const cssH = 90;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const { counts, bandOfBin, edges } = m.histogram;
  const n = counts.length;
  const maxCount = Math.max(1, ...counts);
  const padL = 4;
  const padR = 4;
  const padTop = 4;
  const axisH = 14;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padTop - axisH;
  const barW = plotW / n;

  for (let i = 0; i < n; i++) {
    const h = (counts[i] / maxCount) * plotH;
    const x = padL + i * barW;
    const y = padTop + (plotH - h);
    ctx.fillStyle = BAND_COLOR[bandOfBin[i]];
    ctx.fillRect(x, y, Math.max(1, barW - 0.5), h);
  }

  // Min / max axis labels.
  ctx.fillStyle = "rgba(150,150,150,0.9)";
  ctx.font = "9px var(--vscode-font-family, sans-serif)";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText(fmt(edges[0]), padL, cssH);
  ctx.textAlign = "right";
  ctx.fillText(fmt(edges[edges.length - 1]), cssW - padR, cssH);
}
