import type { ExportReport, ReportStatus } from "../src/parser/exportReport";
import { serializeReport, summarizeReport } from "../src/parser/exportReport";
import { glyph } from "../src/uiGlyphs";

/** Data is rendered as text, never HTML: filenames/warnings come from files. */
export function renderExportReportPanel(container: HTMLElement, reports: readonly ExportReport[], onClose: () => void): void {
  container.replaceChildren();
  const text = (tag: string, value: string, parent = container, cls?: string) => {
    const el = document.createElement(tag); el.textContent = value;
    if (cls) el.className = cls;
    parent.appendChild(el); return el;
  };
  const header = text("div", "", container, "meshsize-header");
  text("div", "Export report", header, "meshsize-title");
  const close = document.createElement("button"); close.className = "meshsize-close"; close.title = "Close export report"; close.setAttribute("aria-label", close.title); close.innerHTML = glyph("x"); close.onclick = onClose; header.appendChild(close);
  if (!reports.length) { text("p", "No export yet. Save or export a mesh to see its report here."); return; }
  const picker = document.createElement("select"); picker.className = "edit-sel"; picker.setAttribute("aria-label", "Exported file");
  reports.forEach((r, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = r.target.file; picker.appendChild(o); });
  container.appendChild(picker);
  const body = text("div", "");
  const render = () => {
    body.replaceChildren();
    const r = reports[Number(picker.value)];
    text("p", summarizeReport(r), body);
    text("p", `Source: ${r.source.file ?? "not recorded"} → ${r.target.file} (${r.target.writer})`, body);
    text("p", `Kernel: ${r.kernel.name} ${r.kernel.version ?? "not loaded"}`, body);
    if (r.operations.length) text("p", `Operations: ${r.operations.map((o) => o.label ?? o.op).join(" → ")}`, body);
    if (r.target.companions.length) text("p", `Companions: ${r.target.companions.join(", ")}`, body);
    text("p", `Provenance: ${r.provenance.embedded ? "embedded" : "not embedded"}${r.provenance.sidecar ? `; ${r.provenance.sidecar}` : ""}${r.provenance.note ? `; ${r.provenance.note}` : ""}`, body);
    for (const issue of r.unexpected ?? []) text("p", issue, body, "export-report-error");
    for (const status of ["retained", "transformed", "omitted", "unverified"] as ReportStatus[]) {
      const rows = r.categories.filter((c) => c.status === status);
      if (!rows.length) continue;
      const group = text("section", "", body, `export-report-group export-report-${status}`);
      text("h4", `${status} (${rows.length})`, group);
      for (const c of rows) {
        const row = text("div", c.label + (c.count === undefined ? "" : ` — ${c.count}`) + (c.verified === true ? " ✓ checked" : c.verified === false ? " — CONTRADICTED" : ""), group);
        if (c.detail) text("small", c.detail, row);
      }
    }
    for (const warning of r.warnings) text("p", `Warning: ${warning}`, body);
    const copy = document.createElement("button"); copy.className = "panel-btn"; copy.textContent = "Copy JSON";
    copy.onclick = () => { void navigator.clipboard.writeText(serializeReport(r)).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Select JSON below to copy"; }); };
    body.appendChild(copy);
    const details = document.createElement("details"); text("summary", "JSON", details);
    text("pre", serializeReport(r), details); body.appendChild(details);
  };
  picker.onchange = render; render();
}
