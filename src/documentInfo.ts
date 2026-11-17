/**
 * The two host → webview messages behind the menubar's document chip and the
 * status bar's engine line, and the small `vscode`-free reporter both preview
 * providers share.
 *
 * There is no central protocol file in this extension (each message is a plain
 * `{type}` object the webview narrows in its `switch`), so the shapes live here,
 * next to the code that posts them; `webview/main.ts` imports the types.
 *
 * Why a reporter and not a post per site: the op history changes in many places
 * (apply, batch, undo, redo, revert-to, clear, load, save, revert-file), and a
 * forgotten one would leave the chip lying about the document. Every site calls
 * `sync()`, which recomputes the whole message and posts it only when it
 * differs from the last one — so it is safe, and intended, to call it
 * generously without asking whether this particular call is redundant.
 */

import * as path from "node:path";
import type { OpRecord } from "./parser/operations";
import { meshExtname } from "./parser/meshioFormats";
import { EngineState, unsavedEditCount } from "./statusStats";

/**
 * `documentInfo` — which file this is and whether the source file holds what
 * the view shows. Sent on `ready` and whenever the applied-op list or the save
 * point moves.
 */
export interface DocumentInfoMessage {
  type: "documentInfo";
  /** Basename, e.g. "double_arch.mdpa". */
  name: string;
  /** Full filesystem path — the chip's hover title only. */
  path: string;
  /** The extension as the router reads it ("mdpa", "post.msh"), or null when there is none. */
  format: string | null;
  /**
   * True when the applied operations differ from the ones the source file
   * already contains — see `unsavedEditCount`. The menubar chip follows this
   * directly. VS Code's tab dot is its own content-change latch; the session
   * reconciles it to this same comparison (see `PreviewSession.markDirty`), so
   * undo back to the save point clears both.
   */
  dirty: boolean;
  /** How many operations differ (0 whenever `dirty` is false). */
  unsavedEdits: number;
}

/** `engineStatus` — which WASM engines this session has used. See `statusStats.ts`. */
export interface EngineStatusMessage {
  type: "engineStatus";
  state: EngineState;
}

/** The chip's format badge text: `.mdpa` → "mdpa", `.post.msh` → "post.msh", none → null. */
export function documentFormat(fsPath: string): string | null {
  const ext = meshExtname(fsPath);
  return ext.startsWith(".") && ext.length > 1 ? ext.slice(1) : null;
}

/** The slice of `OperationHistory` the reporter reads. */
export interface OpSource {
  appliedOps(): OpRecord[];
}

export class DocumentInfoReporter {
  /** The applied ops the source file is known to hold. Empty until a save. */
  private saved: readonly OpRecord[] = [];
  private last = "";

  constructor(
    private readonly fsPath: string,
    private readonly history: OpSource,
    private readonly post: (msg: DocumentInfoMessage) => void
  ) {}

  /** The message for the current state (exposed for tests). */
  build(): DocumentInfoMessage {
    const unsavedEdits = this.unsavedEdits();
    return {
      type: "documentInfo",
      name: path.basename(this.fsPath),
      path: this.fsPath,
      format: documentFormat(this.fsPath),
      dirty: unsavedEdits > 0,
      unsavedEdits,
    };
  }

  /**
   * True when the applied operations are exactly the ones the source file
   * already holds. The tab-marker reconciliation in `PreviewSession` asks this
   * before it runs VS Code's revert command, so it must use the same identity
   * comparison as `build()` rather than a count.
   */
  isClean(): boolean {
    return this.unsavedEdits() === 0;
  }

  private unsavedEdits(): number {
    return unsavedEditCount(this.history.appliedOps(), this.saved);
  }

  /**
   * Posts the current state if it changed. `force` re-posts regardless — used
   * on the webview's `ready`, because a reloaded page has forgotten everything
   * and a deduplicated no-op would leave its chip empty.
   */
  sync(force = false): void {
    const msg = this.build();
    const serialized = JSON.stringify(msg);
    if (!force && serialized === this.last) return;
    this.last = serialized;
    this.post(msg);
  }

  /** The source file now holds the applied ops (a successful in-place Save). */
  markSaved(): void {
    this.saved = this.history.appliedOps();
    this.sync();
  }

  /** The stack was dropped and the file re-read (File ▸ Revert File): nothing differs. */
  markReverted(): void {
    this.saved = [];
    this.sync();
  }
}
