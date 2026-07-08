// Draggable divider between the sidebar and the viewport. Pure DOM: dragging
// the `#sidebar-resizer` handle sets the sidebar's width; the viewport is a
// flex child that grows to fill the rest, and the existing ResizeObserver on
// the render root re-sizes the VTK canvas automatically.

const MIN_WIDTH = 160;
const MAX_WIDTH = 640;

/** Wires the sidebar resize handle. Safe to call once after the DOM is ready. */
export function initSidebarResize(): void {
  const sidebar = document.getElementById("sidebar");
  const handle = document.getElementById("sidebar-resizer");
  if (!sidebar || !handle) return;

  let dragging = false;

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const left = sidebar.getBoundingClientRect().left;
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - left));
    sidebar.style.width = `${width}px`;
  };

  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}
