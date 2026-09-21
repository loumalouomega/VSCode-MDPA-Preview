/**
 * The bottom-centre navigation DOCK for the 3D viewport — CAD-Preview's
 * `#view-controls`: ONE wrapping row of the everyday controls
 *
 *   [reset · fit · zoom out · zoom in] │ [Shaded | Wire] │ CLIP [Off] [X Y Z Free] ──o── │ [Persp] [⋯] [⌄]
 *
 * and a popover behind `⋯` (opening UPWARD, anchored to the dock) holding the
 * rest: the rotate step picker + D-pad, the pan D-pad, the clip Flip / free
 * normal inputs, the theme picker + model opacity, Edges and Center on model.
 * Every control keeps its id; the dock only re-houses them.
 *
 * Camera work (orbit, pan, dolly, fit, reset, centre) lives here; the Clip,
 * Display and Appearance controls are wired by `main.ts` (they touch scene
 * state) and adopted into named slots with {@link NavControls.addDockItem}, so
 * an element wired elsewhere keeps its listeners. Rotate and zoom support
 * press-and-hold auto-repeat (and a plain click from the keyboard).
 *
 * Pattern follows TimelineControl: lazy DOM build, self-contained event wiring.
 * The popover is the shared `setupDropdown` (single-open, outside-click and
 * Escape dismissal that never leaks to the canvas) — clicks *inside* it leave it
 * open, so D-pad repeats, the opacity slider and the normal inputs are usable.
 */

import { glyph } from "../src/uiGlyphs";
import {
  DEFAULT_ROTATE_STEP,
  ROTATE_STEPS,
  RotateStep,
  computePanStep,
  computeRightVector,
  defaultViewCamera,
} from "../src/parser/navMath";
import { DropdownHandle, setupDropdown } from "./dropdownMenu";

// Kept exported from here: the pure helpers moved to `src/parser/navMath.ts`
// (Node-testable) but this was their historic home.
export { computePanStep, computeRightVector };

/**
 * Where a caller-owned control is adopted. `display` / `clip` / `projection`
 * are segments of the dock row; the `more*` slots are labelled sections of the
 * ⋯ popover.
 */
export type NavSlot = "display" | "clip" | "projection" | "moreClip" | "moreAppearance" | "moreView";

const ZOOM_IN_FACTOR = 1.25;
const ZOOM_OUT_FACTOR = 0.8;
const REPEAT_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 80;
/** Resting gap between the dock and the bottom of the canvas, in CSS px. */
const DEFAULT_BOTTOM_PX = 8;

export class NavControls {
  private el: HTMLDivElement | null = null;
  private repeatTimeout: ReturnType<typeof setTimeout> | undefined;
  private repeatInterval: ReturnType<typeof setInterval> | undefined;
  private bottomPx = DEFAULT_BOTTOM_PX;
  private rotateStep: RotateStep = DEFAULT_ROTATE_STEP;
  private stepBtns: Map<RotateStep, HTMLButtonElement> = new Map();
  private collapsed = false;
  private collapseBtn: HTMLButtonElement | null = null;
  private more: DropdownHandle | null = null;
  private heightObserver: ResizeObserver | null = null;
  /** Slot containers, filled by build(); adopted elements wait in `pending` until then. */
  private slots = new Map<NavSlot, HTMLElement>();
  private pending: { slot: NavSlot; el: HTMLElement }[] = [];

  /**
   * `getRenderer` rather than a renderer: a split view has one per pane, and
   * these buttons must drive the pane the user is working in. There is exactly
   * one dock whatever the layout — it builds document-unique ids
   * (#nav-ortho, #nav-display-*), so a second instance would collide.
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly getRenderer: () => any,
    private readonly renderWindow: any
  ) {}

  private get renderer(): any {
    return this.getRenderer();
  }

  show(): void {
    if (!this.el) this.build();
    this.el!.style.display = "flex";
    this.publishHeight();
  }

  hide(): void {
    if (this.el) this.el.style.display = "none";
    this.more?.close();
    this.stopRepeat();
    this.publishHeight();
  }

  /**
   * Lift the dock above whatever is docked to the bottom of the canvas (the
   * timeline bar, the data table, the series chart). Pass 8 to reset. The
   * status bar needs no allowance: it is a layout sibling of the viewport.
   */
  setBottomOffset(px: number): void {
    this.bottomPx = px;
    if (this.el) this.el.style.bottom = `${px}px`;
  }

  /**
   * Adopt a caller-owned control into a slot. The element is reparented, so a
   * node wired elsewhere keeps its listeners. Safe before the lazy DOM build.
   */
  addDockItem(slot: NavSlot, el: HTMLElement): void {
    const target = this.slots.get(slot);
    if (target) target.appendChild(el);
    else this.pending.push({ slot, el });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateTheme(_theme: string): void {
    // DOM buttons use VSCode CSS variables and adapt automatically.
  }

  destroy(): void {
    this.stopRepeat();
    this.heightObserver?.disconnect();
    this.heightObserver = null;
    this.el?.remove();
    this.el = null;
    this.more = null;
    this.slots.clear();
  }

  // ---- Private: DOM construction -----------------------------------------

  private build(): void {
    const el = document.createElement("div");
    el.id = "nav-controls";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "View controls");
    el.style.bottom = `${this.bottomPx}px`;
    el.style.display = "none";

    // The collapse chevron is a direct child that CSS moves to the END of the
    // dock (`order`), so it survives the body being hidden — CAD's arrangement.
    el.appendChild(this.buildCollapseToggle());

    const body = document.createElement("div");
    body.id = "nav-body";
    body.className = "nav-dock-row";
    body.appendChild(this.buildNavIcons());
    body.appendChild(this.divider());
    body.appendChild(this.slot("display", "nav-segments"));
    body.appendChild(this.divider());
    body.appendChild(this.buildClipGroup());
    body.appendChild(this.divider());
    body.appendChild(this.slot("projection", "nav-projection"));
    body.appendChild(this.buildMore());
    el.appendChild(body);

    for (const { slot, el: node } of this.pending) this.slots.get(slot)?.appendChild(node);
    this.pending = [];

    window.addEventListener("mouseup",    () => this.stopRepeat(), { passive: true });
    window.addEventListener("mouseleave", () => this.stopRepeat(), { passive: true });

    this.container.appendChild(el);
    this.el = el;

    // The toast (#message) stacks above the dock, and the dock's height depends
    // on how many rows it wraps to — so publish the real height instead of
    // guessing one. Observed on the element, so a resize, a collapse and the
    // display toggle in show()/hide() all re-publish it.
    if (typeof ResizeObserver !== "undefined") {
      this.heightObserver = new ResizeObserver(() => this.publishHeight());
      this.heightObserver.observe(el);
    }
  }

  /** Sets `--nav-height` on the container: the dock's current height (0 while hidden). */
  private publishHeight(): void {
    const el = this.el;
    const h = el && el.style.display !== "none" ? Math.ceil(el.getBoundingClientRect().height) : 0;
    this.container.style.setProperty("--nav-height", `${h}px`);
  }

  /** A named, initially empty container that {@link addDockItem} fills. */
  private slot(name: NavSlot, className: string): HTMLDivElement {
    const d = document.createElement("div");
    d.className = className;
    d.dataset.navSlot = name;
    this.slots.set(name, d);
    return d;
  }

  private divider(): HTMLSpanElement {
    const d = document.createElement("span");
    d.className = "nav-div";
    d.setAttribute("aria-hidden", "true");
    return d;
  }

  private label(text: string): HTMLSpanElement {
    const l = document.createElement("span");
    l.className = "nav-label";
    l.textContent = text;
    return l;
  }

  private buildCollapseToggle(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "nav-collapse";
    btn.className = "nav-collapse-btn";
    btn.innerHTML = glyph("chevronDown");
    btn.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.collapseBtn = btn;
    this.syncCollapseBtn();
    return btn;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    if (this.el) this.el.classList.toggle("collapsed", collapsed);
    // The popover lives in the body that just got display:none — close it, or
    // its trigger keeps a stale aria-expanded="true".
    if (collapsed) this.more?.close();
    this.syncCollapseBtn();
  }

  private syncCollapseBtn(): void {
    if (!this.collapseBtn) return;
    // One chevron glyph; CSS rotates it off `#nav-controls.collapsed`.
    const title = this.collapsed ? "Show navigation controls" : "Hide navigation controls";
    this.collapseBtn.title = title;
    this.collapseBtn.setAttribute("aria-label", title);
    this.collapseBtn.setAttribute("aria-expanded", String(!this.collapsed));
  }

  /** Reset view · Fit · Zoom out · Zoom in — 26px icon buttons. */
  private buildNavIcons(): HTMLDivElement {
    const g = document.createElement("div");
    g.className = "nav-icons";
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", "Navigate");
    g.appendChild(this.iconBtn("nav-reset",    "rotateCcw", "Reset view",       () => this.resetView()));
    g.appendChild(this.iconBtn("nav-fit",      "maximize",  "Fit all",          () => this.fit()));
    g.appendChild(this.iconBtn("nav-zoom-out", "zoomOut",   "Zoom out",         () => this.zoomOut(), true));
    g.appendChild(this.iconBtn("nav-zoom-in",  "zoomIn",    "Zoom in",          () => this.zoomIn(),  true));
    return g;
  }

  /** `CLIP` caption + the slot main.ts fills with the toggle, axes, slider and readout. */
  private buildClipGroup(): HTMLDivElement {
    const g = document.createElement("div");
    g.className = "nav-inline-group";
    g.appendChild(this.label("Clip"));
    g.appendChild(this.slot("clip", "nav-clip-slot"));
    return g;
  }

  private buildMore(): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.id = "nav-more-wrap";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.id = "nav-more";
    trigger.title = "More view controls";
    trigger.setAttribute("aria-label", "More view controls");
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = glyph("more");
    wrap.appendChild(trigger);

    const pop = document.createElement("div");
    pop.id = "nav-more-popup";
    pop.className = "hidden";
    pop.setAttribute("role", "group");
    pop.setAttribute("aria-label", "More view controls");

    // Rotate and Pan side by side — two 3x3 crosses stacked would double the height.
    const pair = document.createElement("div");
    pair.className = "nav-more-pair";
    pair.appendChild(this.buildRotateGroup());
    pair.appendChild(this.moreGroup("Pan", this.buildPanCross()));
    pop.appendChild(pair);

    pop.appendChild(this.moreSlot("moreClip", "Clip"));
    pop.appendChild(this.moreSlot("moreAppearance", "Appearance"));

    const view = this.moreSlot("moreView", "View");
    view.querySelector(".nav-more-row")!.appendChild(this.pillBtn("nav-center", "Center on model", () => this.center(), "crosshair"));
    pop.appendChild(view);

    wrap.appendChild(pop);
    this.more = setupDropdown(trigger, pop);
    return wrap;
  }

  private moreGroup(label: string, content: HTMLElement): HTMLDivElement {
    const g = document.createElement("div");
    g.className = "nav-more-group";
    g.appendChild(this.label(label));
    g.appendChild(content);
    return g;
  }

  /** A labelled popover section whose row {@link addDockItem} fills. */
  private moreSlot(name: NavSlot, label: string): HTMLDivElement {
    const row = this.slot(name, "nav-more-row");
    return this.moreGroup(label, row);
  }

  private buildRotateGroup(): HTMLDivElement {
    // Step segments, then the D-pad — stacked like the reference rotate group.
    const stepRow = document.createElement("div");
    stepRow.className = "nav-segments nav-step-picker";
    stepRow.setAttribute("role", "group");
    stepRow.setAttribute("aria-label", "Rotate step");

    for (const step of ROTATE_STEPS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-seg nav-step-btn" + (step === this.rotateStep ? " active" : "");
      btn.textContent = `${step}°`;
      btn.title = `Rotate by ${step}°`;
      btn.setAttribute("aria-label", `Rotate step ${step} degrees`);
      btn.setAttribute("aria-pressed", String(step === this.rotateStep));
      btn.addEventListener("click", () => this.setRotateStep(step));
      this.stepBtns.set(step, btn);
      stepRow.appendChild(btn);
    }

    const holder = document.createElement("div");
    holder.className = "nav-rotate-stack";
    holder.appendChild(stepRow);
    holder.appendChild(this.buildRotateCross());
    return this.moreGroup("Rotate", holder);
  }

  private setRotateStep(step: RotateStep): void {
    this.rotateStep = step;
    for (const [s, btn] of this.stepBtns) {
      btn.classList.toggle("active", s === step);
      btn.setAttribute("aria-pressed", String(s === step));
    }
  }

  private buildRotateCross(): HTMLDivElement {
    const cross = document.createElement("div");
    cross.className = "nav-cross";
    cross.appendChild(this.placeholder());
    cross.appendChild(this.repeatBtn("↑", "Rotate up",    () => this.rotateUp()));
    cross.appendChild(this.placeholder());
    cross.appendChild(this.repeatBtn("←", "Rotate left",  () => this.rotateLeft()));
    cross.appendChild(this.placeholder());
    cross.appendChild(this.repeatBtn("→", "Rotate right", () => this.rotateRight()));
    cross.appendChild(this.placeholder());
    cross.appendChild(this.repeatBtn("↓", "Rotate down",  () => this.rotateDown()));
    cross.appendChild(this.placeholder());
    return cross;
  }

  private buildPanCross(): HTMLDivElement {
    const cross = document.createElement("div");
    cross.className = "nav-cross";
    cross.appendChild(this.placeholder());
    cross.appendChild(this.clickBtn("↑", "Pan up",    () => this.panUp()));
    cross.appendChild(this.placeholder());
    cross.appendChild(this.clickBtn("←", "Pan left",  () => this.panLeft()));
    cross.appendChild(this.placeholder());
    cross.appendChild(this.clickBtn("→", "Pan right", () => this.panRight()));
    cross.appendChild(this.placeholder());
    cross.appendChild(this.clickBtn("↓", "Pan down",  () => this.panDown()));
    cross.appendChild(this.placeholder());
    return cross;
  }

  /**
   * A 26px ghost icon button. `repeat` buttons auto-repeat while held (zoom);
   * both kinds stay operable from the keyboard.
   */
  private iconBtn(
    id: string,
    glyphId: "rotateCcw" | "maximize" | "zoomOut" | "zoomIn",
    title: string,
    action: () => void,
    repeat = false
  ): HTMLButtonElement {
    const btn = repeat ? this.repeatBtn("", title, action) : this.clickBtn("", title, action);
    btn.id = id;
    btn.className = "nav-icon-btn";
    btn.innerHTML = glyph(glyphId);
    return btn;
  }

  /** A bordered ghost button with an optional leading glyph (Center on model). */
  private pillBtn(id: string, text: string, action: () => void, glyphId?: "crosshair"): HTMLButtonElement {
    const btn = this.clickBtn("", text, action);
    btn.id = id;
    btn.className = "nav-pill";
    btn.innerHTML = (glyphId ? glyph(glyphId) + " " : "") + text;
    return btn;
  }

  private repeatBtn(text: string, title: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.textContent = text;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.startRepeat(action);
    });
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.startRepeat(action);
    }, { passive: false });
    btn.addEventListener("touchend",    () => this.stopRepeat(), { passive: true });
    btn.addEventListener("touchcancel", () => this.stopRepeat(), { passive: true });
    // Enter / Space fire a click with `detail === 0` and no mousedown; a real
    // pointer click (detail >= 1) already ran through startRepeat above.
    btn.addEventListener("click", (e) => {
      if (e.detail === 0) action();
    });
    return btn;
  }

  private clickBtn(text: string, title: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.textContent = text;
    btn.addEventListener("click", action);
    return btn;
  }

  private placeholder(): HTMLDivElement {
    const ph = document.createElement("div");
    ph.className = "nav-btn nav-placeholder";
    return ph;
  }

  // ---- Private: auto-repeat ----------------------------------------------

  private startRepeat(action: () => void): void {
    this.stopRepeat();
    action();
    this.repeatTimeout = setTimeout(() => {
      this.repeatInterval = setInterval(action, REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }

  private stopRepeat(): void {
    if (this.repeatTimeout !== undefined) {
      clearTimeout(this.repeatTimeout);
      this.repeatTimeout = undefined;
    }
    if (this.repeatInterval !== undefined) {
      clearInterval(this.repeatInterval);
      this.repeatInterval = undefined;
    }
  }

  // ---- Private: camera operations ----------------------------------------

  private commit(): void {
    this.renderer.resetCameraClippingRange();
    this.renderWindow.render();
  }

  private rotateLeft(): void {
    this.renderer.getActiveCamera().azimuth(-this.rotateStep);
    this.renderer.getActiveCamera().orthogonalizeViewUp();
    this.commit();
  }

  private rotateRight(): void {
    this.renderer.getActiveCamera().azimuth(this.rotateStep);
    this.renderer.getActiveCamera().orthogonalizeViewUp();
    this.commit();
  }

  private rotateUp(): void {
    this.renderer.getActiveCamera().elevation(this.rotateStep);
    this.renderer.getActiveCamera().orthogonalizeViewUp();
    this.commit();
  }

  private rotateDown(): void {
    this.renderer.getActiveCamera().elevation(-this.rotateStep);
    this.renderer.getActiveCamera().orthogonalizeViewUp();
    this.commit();
  }

  private zoomIn(): void {
    this.renderer.getActiveCamera().dolly(ZOOM_IN_FACTOR);
    this.commit();
  }

  private zoomOut(): void {
    this.renderer.getActiveCamera().dolly(ZOOM_OUT_FACTOR);
    this.commit();
  }

  private panLeft(): void  { this.pan(-1,  0); }
  private panRight(): void { this.pan( 1,  0); }
  private panUp(): void    { this.pan( 0,  1); }
  private panDown(): void  { this.pan( 0, -1); }

  private pan(rightSign: number, upSign: number): void {
    const cam = this.renderer.getActiveCamera();
    const dist = cam.getDistance();
    const vAngle = cam.getViewAngle() as number;
    const step = computePanStep(dist, vAngle);

    const dir   = cam.getDirectionOfProjection() as [number, number, number];
    const up    = cam.getViewUp()                as [number, number, number];
    const right = computeRightVector(dir, up);

    const dx = right[0] * rightSign * step + up[0] * upSign * step;
    const dy = right[1] * rightSign * step + up[1] * upSign * step;
    const dz = right[2] * rightSign * step + up[2] * upSign * step;

    const pos   = cam.getPosition()   as [number, number, number];
    const focal = cam.getFocalPoint() as [number, number, number];
    cam.setPosition(  pos[0]   + dx, pos[1]   + dy, pos[2]   + dz);
    cam.setFocalPoint(focal[0] + dx, focal[1] + dy, focal[2] + dz);

    this.commit();
  }

  private fit(): void {
    this.renderer.resetCamera();
    this.renderWindow.render();
  }

  /** Back to the default (front, +Y up) orientation, then frame everything. */
  private resetView(): void {
    const cam = this.renderer.getActiveCamera();
    const { position, viewUp } = defaultViewCamera(cam.getFocalPoint() as [number, number, number]);
    cam.setPosition(position[0], position[1], position[2]);
    cam.setViewUp(viewUp[0], viewUp[1], viewUp[2]);
    this.fit();
  }

  private center(): void {
    const bounds: number[] | null = this.renderer.computeVisiblePropBounds?.();
    if (!bounds || !isFinite(bounds[0]) || bounds[0] > bounds[1]) return;

    const cx = (bounds[0] + bounds[1]) / 2;
    const cy = (bounds[2] + bounds[3]) / 2;
    const cz = (bounds[4] + bounds[5]) / 2;

    const cam   = this.renderer.getActiveCamera();
    const focal = cam.getFocalPoint() as [number, number, number];
    const pos   = cam.getPosition()   as [number, number, number];

    const dx = cx - focal[0];
    const dy = cy - focal[1];
    const dz = cz - focal[2];

    cam.setFocalPoint(cx, cy, cz);
    cam.setPosition(pos[0] + dx, pos[1] + dy, pos[2] + dz);

    this.commit();
  }
}
