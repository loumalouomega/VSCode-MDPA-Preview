/**
 * Pure file-state helpers for the per-panel preview session (roadmap item 14).
 *
 * The vscode-facing `PreviewSession` (`src/previewSession.ts`) owns the live
 * history, controllers and disposables; what it decides about *which file* is
 * bound — and what survives a (re-)bind — lives here so it is Node-testable.
 * `webview/` is outside `tsconfig.test.json`, and `previewSession.ts` imports
 * `vscode`, so neither can carry these tests.
 */

/** An unbound session shows the empty chrome and owns no file. */
export interface UnboundSessionFileState {
  bound: false;
}

/** A bound session shows one mesh file in the same panel. */
export interface BoundSessionFileState {
  bound: true;
  /** Absolute filesystem path, as picked or as `document.uri.fsPath`. */
  fsPath: string;
  /** Basename for titles and the recent-meshes list. */
  fileName: string;
}

export type SessionFileState = UnboundSessionFileState | BoundSessionFileState;

/** View flags that live as long as the panel, not as long as one file. */
export interface SessionFileFlags {
  /** Sticky once the user presses "Open full mesh anyway". */
  userForcedFull: boolean;
  /** What the last load decided, so a reload cannot flip modes. */
  summaryShown: boolean;
}

/** The state of a panel that has never bound a file. */
export function initialSessionFileState(): UnboundSessionFileState {
  return { bound: false };
}

/** Basename without `node:path`, so the webview bundle could reuse this. */
export function sessionFileName(fsPath: string): string {
  const slash = fsPath.replace(/\\/g, "/");
  const base = slash.slice(slash.lastIndexOf("/") + 1);
  return base || fsPath;
}

/** Bind (or re-bind) a file, deriving the display name from the path. */
export function bindSessionFileState(fsPath: string): BoundSessionFileState {
  return { bound: true, fsPath, fileName: sessionFileName(fsPath) };
}

/**
 * What a (re-)bind keeps. The first bind starts clean; re-binding the *same*
 * file preserves the panel's view flags and keeps the edit stack; binding a
 * *different* file resets the flags and tells the caller to reset the history
 * (the new file's first parse must `setBase`, never `rebase`, or the old file's
 * ops would replay onto unrelated geometry).
 */
export function flagsForBind(
  prevFsPath: string | undefined,
  nextFsPath: string,
  prevFlags: SessionFileFlags
): { flags: SessionFileFlags; historyReset: boolean } {
  if (prevFsPath === undefined) {
    return { flags: { userForcedFull: false, summaryShown: false }, historyReset: false };
  }
  if (prevFsPath === nextFsPath) {
    return { flags: { ...prevFlags }, historyReset: false };
  }
  return { flags: { userForcedFull: false, summaryShown: false }, historyReset: true };
}

/** Tab title: the file once bound, the launcher title while empty. */
export function sessionTitleFor(state: SessionFileState, baseTitle: string): string {
  return state.bound ? state.fileName : baseTitle;
}

/**
 * WebviewPanel dirty simulation. A `CustomDocument` tab gets its dot from VS
 * Code; a reused empty `WebviewPanel` has no document, so the session suffixes
 * the title instead. The webview's own document chip (`documentInfo`) is still
 * the authority — this is only the tab title.
 */
export function dirtyPanelTitle(title: string, dirty: boolean): string {
  const clean = title.endsWith(" •") ? title.slice(0, -2) : title;
  return dirty ? `${clean} •` : clean;
}
