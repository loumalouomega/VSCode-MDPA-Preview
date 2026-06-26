/**
 * On-screen navigation control panel for the 3D viewport.
 *
 * Orbit (azimuth/elevation), pan (4-way), zoom (dolly), fit (reset camera),
 * and center (re-center focal point) buttons rendered as a compact DOM overlay.
 * Rotate and zoom support press-and-hold auto-repeat.
 *
 * Pattern follows TimelineControl: lazy DOM build, self-contained event wiring.
 */

/** Compute the right-hand vector perpendicular to `dir` and `up`. Pure, testable. */
export function computeRightVector(
  dir: [number, number, number],
  up: [number, number, number]
): [number, number, number] {
  const rx = dir[1] * up[2] - dir[2] * up[1];
  const ry = dir[2] * up[0] - dir[0] * up[2];
  const rz = dir[0] * up[1] - dir[1] * up[0];
  const len = Math.hypot(rx, ry, rz);
  if (len < 1e-10) return [1, 0, 0];
  return [rx / len, ry / len, rz / len];
}

/** Pan step in world units: 15% of the half-height of the visible frustum. */
export function computePanStep(distance: number, viewAngleDeg: number): number {
  return distance * Math.tan((viewAngleDeg * Math.PI) / 360) * 0.15;
}

const ROTATE_STEPS = [15, 45, 90] as const;
type RotateStep = (typeof ROTATE_STEPS)[number];

const ZOOM_IN_FACTOR = 1.25;
const ZOOM_OUT_FACTOR = 0.8;
const REPEAT_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 80;

export class NavControls {
  private el: HTMLDivElement | null = null;
  private repeatTimeout: ReturnType<typeof setTimeout> | undefined;
  private repeatInterval: ReturnType<typeof setInterval> | undefined;
  private bottomPx = 8;
  private rotateStep: RotateStep = 45;
  private stepBtns: Map<RotateStep, HTMLButtonElement> = new Map();

  constructor(
    private readonly container: HTMLElement,
    private readonly renderer: any,
    private readonly renderWindow: any
  ) {}

  show(): void {
    if (!this.el) this.build();
    this.el!.style.display = "flex";
  }

  hide(): void {
    if (this.el) this.el.style.display = "none";
    this.stopRepeat();
  }

  /** Shift the panel up when the timeline bar is visible (pass 8 to reset). */
  setBottomOffset(px: number): void {
    this.bottomPx = px;
    if (this.el) this.el.style.bottom = `${px}px`;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateTheme(_theme: string): void {
    // DOM buttons use VSCode CSS variables and adapt automatically.
  }

  destroy(): void {
    this.stopRepeat();
    this.el?.remove();
    this.el = null;
  }

  // ---- Private: DOM construction -----------------------------------------

  private build(): void {
    const el = document.createElement("div");
    el.id = "nav-controls";
    el.style.bottom = `${this.bottomPx}px`;
    el.style.display = "none";

    el.appendChild(this.buildRotateGroup());
    el.appendChild(this.buildGroup("Pan",  this.buildPanCross()));
    el.appendChild(this.buildGroup("Zoom", this.buildZoomRow()));
    el.appendChild(this.buildGroup("View", this.buildViewRow()));

    window.addEventListener("mouseup",    () => this.stopRepeat(), { passive: true });
    window.addEventListener("mouseleave", () => this.stopRepeat(), { passive: true });

    this.container.appendChild(el);
    this.el = el;
  }

  private buildGroup(label: string, content: HTMLElement): HTMLDivElement {
    const g = document.createElement("div");
    g.className = "nav-group";
    const lbl = document.createElement("span");
    lbl.className = "nav-group-label";
    lbl.textContent = label;
    g.appendChild(lbl);
    g.appendChild(content);
    return g;
  }

  private buildRotateGroup(): HTMLDivElement {
    const g = document.createElement("div");
    g.className = "nav-group";

    // Label row with inline step picker: ROTATE  [15°][45°][90°]
    const header = document.createElement("div");
    header.className = "nav-rotate-header";

    const lbl = document.createElement("span");
    lbl.className = "nav-group-label";
    lbl.textContent = "Rotate";

    const stepRow = document.createElement("div");
    stepRow.className = "nav-step-picker";

    for (const step of ROTATE_STEPS) {
      const btn = document.createElement("button");
      btn.className = "nav-btn nav-step-btn" + (step === this.rotateStep ? " active" : "");
      btn.textContent = `${step}°`;
      btn.title = `Rotate by ${step}°`;
      btn.setAttribute("aria-label", `Rotate step ${step} degrees`);
      btn.addEventListener("click", () => this.setRotateStep(step));
      this.stepBtns.set(step, btn);
      stepRow.appendChild(btn);
    }

    header.appendChild(lbl);
    header.appendChild(stepRow);
    g.appendChild(header);
    g.appendChild(this.buildRotateCross());
    return g;
  }

  private setRotateStep(step: RotateStep): void {
    this.rotateStep = step;
    for (const [s, btn] of this.stepBtns) {
      btn.classList.toggle("active", s === step);
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

  private buildZoomRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "nav-row";
    row.appendChild(this.repeatBtn("+", "Zoom in",  () => this.zoomIn()));
    row.appendChild(this.repeatBtn("−", "Zoom out", () => this.zoomOut()));
    return row;
  }

  private buildViewRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "nav-row";
    row.appendChild(this.clickBtn("Fit", "Fit all",         () => this.fit()));
    row.appendChild(this.clickBtn("Ctr", "Center on model", () => this.center()));
    return row;
  }

  private repeatBtn(text: string, title: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
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
    return btn;
  }

  private clickBtn(text: string, title: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
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
