/** Timeline playback control for VTK time-series previews. */

export interface TimelineCallbacks {
  /** Called when the user requests a specific frame (scrub, step, play tick). */
  onFrameRequest: (frameIndex: number) => void;
}

export class TimelineControl {
  private bar: HTMLDivElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private scrub: HTMLInputElement | null = null;
  private label: HTMLSpanElement | null = null;
  private fpsInput: HTMLInputElement | null = null;

  private totalFrames = 0;
  private currentIndex = 0;
  private playing = false;
  private playTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: TimelineCallbacks
  ) {}

  /** Show the timeline bar sized for `total` frames. */
  show(total: number, steps: string[]): void {
    this.totalFrames = total;

    if (total <= 1) {
      this.hide();
      return;
    }

    if (!this.bar) this.build();

    const bar = this.bar!;
    bar.style.display = "flex";

    const scrub = this.scrub!;
    scrub.max = String(total - 1);
    scrub.value = "0";

    this.label!.textContent = this.makeLabel(0, steps[0] ?? "0", total);
  }

  /** Update the displayed step after a frame arrives. */
  update(frameIndex: number, stepLabel: string, total: number): void {
    this.currentIndex = frameIndex;
    this.totalFrames = total;

    if (!this.bar || this.bar.style.display === "none") return;

    if (this.scrub) this.scrub.value = String(frameIndex);
    if (this.label) this.label.textContent = this.makeLabel(frameIndex, stepLabel, total);

    if (frameIndex >= total - 1 && this.playing) {
      this.stopPlay();
    }
  }

  /** Hide the timeline bar and stop playback. */
  hide(): void {
    this.stopPlay();
    if (this.bar) this.bar.style.display = "none";
  }

  // ---- Private ----------------------------------------------------------------

  private build(): void {
    const bar = document.createElement("div");
    bar.id = "timeline-bar";
    bar.style.display = "none";

    const prev = document.createElement("button");
    prev.id = "tl-prev";
    prev.title = "Previous frame";
    prev.textContent = "◀";
    prev.addEventListener("click", () => this.step(-1));

    const play = document.createElement("button");
    play.id = "tl-play";
    play.title = "Play / Pause";
    play.textContent = "▶";
    play.addEventListener("click", () => this.togglePlay());

    const next = document.createElement("button");
    next.id = "tl-next";
    next.title = "Next frame";
    next.textContent = "▶▶";
    next.addEventListener("click", () => this.step(1));

    const scrub = document.createElement("input");
    scrub.id = "tl-scrub";
    scrub.type = "range";
    scrub.min = "0";
    scrub.step = "1";
    scrub.value = "0";
    let scrubTimer: ReturnType<typeof setTimeout> | undefined;
    scrub.addEventListener("input", () => {
      const idx = parseInt(scrub.value, 10);
      clearTimeout(scrubTimer);
      scrubTimer = setTimeout(() => this.requestFrame(idx), 80);
    });

    const label = document.createElement("span");
    label.id = "tl-label";

    const fpsLabel = document.createElement("label");
    fpsLabel.id = "tl-fps-label";
    const fpsInput = document.createElement("input");
    fpsInput.id = "tl-fps";
    fpsInput.type = "number";
    fpsInput.value = "2";
    fpsInput.min = "1";
    fpsInput.max = "30";
    fpsLabel.append(fpsInput, " fps");

    bar.append(prev, play, next, scrub, label, fpsLabel);
    this.container.appendChild(bar);

    this.bar = bar;
    this.prevBtn = prev;
    this.playBtn = play;
    this.nextBtn = next;
    this.scrub = scrub;
    this.label = label;
    this.fpsInput = fpsInput;
  }

  private step(delta: number): void {
    const next = Math.max(0, Math.min(this.totalFrames - 1, this.currentIndex + delta));
    this.requestFrame(next);
  }

  private requestFrame(idx: number): void {
    this.callbacks.onFrameRequest(idx);
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
    } else {
      this.startPlay();
    }
  }

  private startPlay(): void {
    if (this.playing) return;
    this.playing = true;
    if (this.playBtn) this.playBtn.textContent = "⏸";
    const fps = Math.max(1, parseInt(this.fpsInput?.value ?? "2", 10));
    this.playTimer = setInterval(() => {
      const next = this.currentIndex + 1;
      if (next >= this.totalFrames) {
        this.stopPlay();
        return;
      }
      this.requestFrame(next);
    }, 1000 / fps);
  }

  private stopPlay(): void {
    this.playing = false;
    if (this.playBtn) this.playBtn.textContent = "▶";
    if (this.playTimer !== undefined) {
      clearInterval(this.playTimer);
      this.playTimer = undefined;
    }
  }

  private makeLabel(index: number, stepLabel: string, total: number): string {
    const stepPart = stepLabel ? `Step ${stepLabel}` : `Frame ${index + 1}`;
    return `${stepPart}  (${index + 1}/${total})`;
  }
}
