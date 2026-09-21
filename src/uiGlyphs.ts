/**
 * Hand-authored line icons for the sidebar, status bar, toolbar and dock chrome.
 *
 * NOT generated. The menu/op icon set comes from the TikZ pipeline
 * (icons/tikz-ui → toolbarIcons.ts); these are simple 24-unit stroke glyphs in
 * the lucide style, the same family CAD-Preview's chrome uses — the first block
 * below is copied verbatim from its `src/uiGlyphs.ts` so the two extensions stay
 * visually one product, and the trailing block is mesh's own additions. Kept in
 * a separate module so the generated file stays generated and its own test keeps
 * asserting exactly its own id list.
 *
 * Same contract as `toolbarIcons.ts`: `currentColor` only, a `viewBox`, and no
 * width/height on the root, so CSS sizes the glyph and the button's `color`
 * tints it in every VS Code theme. `vscode`-free and DOM-free, so both the static
 * markup (`webviewChrome.ts`) and the webview panels import it directly.
 */

const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const g = (body: string): string => `${OPEN}${body}</svg>`;

export const UI_GLYPHS = {
  chevronDown: g('<path d="m6 9 6 6 6-6"/>'),
  chevronRight: g('<path d="m9 6 6 6-6 6"/>'),
  search: g('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  eye: g('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: g(
    '<path d="M9.9 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9"/><path d="M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>'
  ),
  copy: g('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>'),
  trash: g(
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
  ),
  layers: g('<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>'),
  rotateCcw: g('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  move: g(
    '<path d="M12 2v20"/><path d="M2 12h20"/><path d="m9 5 3-3 3 3"/><path d="m9 19 3 3 3-3"/><path d="m5 9-3 3 3 3"/><path d="m19 9 3 3-3 3"/>'
  ),
  zoomIn: g('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M11 8v6"/><path d="M8 11h6"/>'),
  zoomOut: g('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M8 11h6"/>'),
  cube: g('<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>'),
  box: g('<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="M12 13v8"/><path d="m3 8 9 5 9-5"/>'),
  plus: g('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  play: g('<path d="M7 4v16l13-8Z" fill="currentColor"/>'),
  download: g('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  target: g('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  maximize: g('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  home: g('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9"/>'),
  gitFork: g(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10"/><path d="M6 12h6a4 4 0 0 0 4-4V7"/>'
  ),
  grid3: g('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>'),
  pointer: g('<path d="M4 3l7 17 2.5-7.5L21 10Z"/>'),
  ruler: g(
    '<path d="M21.3 15.3 8.7 2.7a1 1 0 0 0-1.4 0L2.7 7.3a1 1 0 0 0 0 1.4l12.6 12.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4Z"/><path d="m7.5 10.5 2-2"/><path d="m10.5 13.5 2-2"/><path d="m13.5 16.5 2-2"/>'
  ),
  pencil: g('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  // Sidebar section icons (one per section header — see viewerDom.ts).
  listTree: g('<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>'),
  tag: g(
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'
  ),
  sliders: g(
    '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>'
  ),
  scale: g(
    '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>'
  ),
  intersect: g('<rect x="3" y="3" width="13" height="13" rx="2"/><rect x="8" y="8" width="13" height="13" rx="2"/>'),
  activity: g('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  crosshair: g('<circle cx="12" cy="12" r="9"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>'),
  shapes: g(
    '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>'
  ),
  braces: g(
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'
  ),
  package: g(
    '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.27 9 5.15"/>'
  ),
  undo: g('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: g('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  // ---- mesh additions (not in CAD-Preview's set) --------------------------
  chevronUp: g('<path d="m18 15-6-6-6 6"/>'),
  x: g('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  check: g('<path d="M20 6 9 17l-5-5"/>'),
  more: g('<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>'),
  info: g('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  file: g('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  clock: g('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  wrench: g(
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'
  ),
  variable: g(
    '<path d="M8 21s-4-3-4-9 4-9 4-9"/><path d="M16 3s4 3 4 9-4 9-4 9"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/>'
  ),
  workflow: g('<rect x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/>'),
  camera: g(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>'
  ),
  sun: g(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'
  ),
  bookmark: g('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>'),
  table: g('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>'),
  scissors: g(
    '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88"/><path d="M14.47 14.48 20 20"/><path d="M8.12 8.12 12 12"/>'
  ),
  record: g('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  refresh: g('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  palette: g(
    '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-9-10-9Z"/>'
  ),
  flipHorizontal: g('<path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/>'),
  perspective: g('<path d="M4 20 8 6h8l4 14Z"/><path d="M8 6 4 20"/><path d="M12 6v14"/>'),
  waypoints: g('<circle cx="12" cy="4.5" r="2.5"/><path d="m10.2 6.3-3.9 3.9"/><circle cx="4.5" cy="12" r="2.5"/><path d="M7 12h10"/><circle cx="19.5" cy="12" r="2.5"/><path d="m13.8 17.7 3.9-3.9"/><circle cx="12" cy="19.5" r="2.5"/>'),
  // Timeline transport: `play` above is the filled triangle these three match.
  pause: g('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>'),
  skipBack: g('<path d="M19 20 9 12l10-8Z" fill="currentColor"/><path d="M5 19V5"/>'),
  skipForward: g('<path d="m5 4 10 8-10 8Z" fill="currentColor"/><path d="M19 5v14"/>'),
  panelLeft: g('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>'),
} as const;

export type UiGlyphId = keyof typeof UI_GLYPHS;

/** `<span class="ui-glyph">` wrapping one glyph — the markup every caller uses. */
export function glyph(id: UiGlyphId): string {
  return `<span class="ui-glyph">${UI_GLYPHS[id]}</span>`;
}
