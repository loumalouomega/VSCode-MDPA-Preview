// Draggable divider between the sidebar and the viewport. Pure DOM: dragging
// the `#sidebar-resizer` sash sets the sidebar's width; the viewport is a flex
// child that grows to fill the rest, and the existing ResizeObserver on the
// render root re-sizes the VTK canvas automatically.
//
// The sash is invisible at rest and shows a hover/focus border (CAD-Preview's
// `#sidebar-resize`). It is a focusable `role="separator"`, so the resize is
// keyboard-operable too: ArrowLeft/Right step, Home/End jump to the clamps.

/** Minimum usable width — below this the Edit forms' field rows wrap badly. */
export const SIDEBAR_MIN_PX = 176;
/**
 * CAD-Preview stops at 420, but mesh's Remesh / Level-set / Problemtype forms
 * carry up to five fields per row, so a user who wants them on one line needs
 * the older, wider ceiling.
 */
export const SIDEBAR_MAX_PX = 640;
/** The width `#sidebar` starts at in style.css. */
export const SIDEBAR_DEFAULT_PX = 272;
/** How far a keyboard step moves the edge. */
export const SIDEBAR_KEYBOARD_STEP_PX = 16;

/** Clamps a width into `[SIDEBAR_MIN_PX, SIDEBAR_MAX_PX]`. */
export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, Math.round(width)));
}

/** Wires the sidebar resize sash. Safe to call once after the DOM is ready. */
export function initSidebarResize(): void {
  const sidebar = document.getElementById("sidebar");
  const handle = document.getElementById("sidebar-resizer");
  if (!sidebar || !handle) return;

  let dragging = false;
  let current = SIDEBAR_DEFAULT_PX;

  handle.setAttribute("aria-valuemin", String(SIDEBAR_MIN_PX));
  handle.setAttribute("aria-valuemax", String(SIDEBAR_MAX_PX));

  const apply = (width: number): void => {
    current = clampSidebarWidth(width);
    sidebar.style.width = `${current}px`;
    handle.setAttribute("aria-valuenow", String(current));
  };
  // Honour a width already set inline (the screenshot harness pins one).
  const inline = parseFloat(sidebar.style.width);
  apply(Number.isFinite(inline) ? inline : SIDEBAR_DEFAULT_PX);

  handle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") apply(current - SIDEBAR_KEYBOARD_STEP_PX);
    else if (e.key === "ArrowRight") apply(current + SIDEBAR_KEYBOARD_STEP_PX);
    else if (e.key === "Home") apply(SIDEBAR_MIN_PX);
    else if (e.key === "End") apply(SIDEBAR_MAX_PX);
    else return;
    e.preventDefault();
  });

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const left = sidebar.getBoundingClientRect().left;
    apply(e.clientX - left);
  };

  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}
