/**
 * Reopenable view state: what the viewer showed, persisted in the `view` key of
 * the `<stem>.kratosview.json` sidecar so closing and reopening a preview does
 * not reset it.
 *
 * Pure (no vscode / DOM / vtk / node:fs), bundled by BOTH runtimes: the host
 * validates the key on load and save, the webview captures and applies it.
 *
 * It is view presentation only. Nothing here enters the operation history, a
 * recipe or MCP, and restoring it never marks a document dirty or touches the
 * mesh bytes. The scope is exactly: camera bookmarks, pane layout, each pane's
 * camera, field/range settings and clip plane, per-layer visibility, opacity
 * and pane scope, the compared-run link, named selection sets, and which
 * analysis/overlay panels were open.
 *
 * **Panel state is open/closed only, never computed results.** A restored
 * panel re-opens through the same show function the toolbar calls, so it
 * recomputes against the mesh that opened rather than trusting numbers saved
 * against another one. Panels that need a picked entity (Inspect, Probe, Plot
 * over time) are deliberately NOT persisted: they are transient two-click
 * flows, not state, and their subjects may not exist on the next open.
 *
 * **The survival rule is "refresh by definition"**, the one selection sets and
 * user layers already follow: a field key or layer id the new model no longer
 * has is dropped and REPORTED (`pruneViewState`), never applied to a mesh it
 * was not saved against. A usable default replaces it.
 *
 * **Reads are tolerant**, like `parseCaseJson`: a malformed entry is dropped
 * with a warning and the rest survives, so a hand-edited or newer-writer file
 * degrades instead of failing an open.
 */

import { CameraState, isCameraState } from "./cameraState";
import { FieldComponent } from "./fieldScalars";
import { PaneLayoutId, isPaneLayout, paneCount } from "./paneLayout";
import { validatePaneHidden } from "./paneVisibility";
import { SavedLink, validateSavedLink } from "./previewLink";
import { SelectionSet, serializeSelectionSets, validateSelectionSets } from "./selectionCore";
import {
  ClipAxis,
  FieldMode,
  PaneClipState,
  PaneFieldState,
  ScalarBarOrientation,
  clonePaneClipState,
  clonePaneFieldState,
  defaultPaneClipState,
  defaultPaneFieldState,
} from "./paneView";
import { ThresholdRule } from "./thresholdCells";

/** A named camera view. Structurally identical to the Camera Bookmarks panel's `CameraBookmark`. */
export interface SavedBookmark {
  name: string;
  state: CameraState;
}

/** `PaneFieldState` with `modes` as a plain array: JSON has no `Set`. */
export type SavedFieldState = Omit<PaneFieldState, "modes"> & { modes: FieldMode[] };

export interface SavedPane {
  field: SavedFieldState;
  clip: PaneClipState;
  /** Omitted when the pane's camera was never captured. */
  camera?: CameraState;
  /**
   * In-preview comparison peer for THIS pane (roadmap item 3): the peer path
   * relative to the mesh folder, forward slashes (the `view.link` convention).
   * The host re-loads it on restore; a peer that no longer resolves is
   * reported and the pane stays single-model.
   */
  comparePeer?: string;
}

export interface ViewState {
  bookmarks: SavedBookmark[];
  /** Omitted: keep the layout the preview opens with. */
  paneLayout?: PaneLayoutId;
  /** One entry per pane of `paneLayout` (at most `MAX_PANES`). */
  panes: SavedPane[];
  /** Curved display of quadratic cells, 1..3 (segments per edge 2^n). Omitted = off. */
  curvedLevel?: number;
  /** The Field panel was open (so the saved field overlays are drawn on restore). Omitted = closed. */
  fieldPanel?: boolean;
  /**
   * Analysis/overlay panels that were open, in `PANEL_IDS` order. Restored by
   * re-opening each through its show function (left-dock exclusivity resolves
   * exactly as manual use: the last one opened stays visible). Absent/empty =
   * none open. Open/closed only — computed results are never carried.
   */
  panels: PanelId[];
  /** `layerId -> visible`. Only layers the user's intent is known for. */
  layerVisibility: Record<string, boolean>;
  /** `layerId -> opacity in 0..1`. */
  layerOpacity: Record<string, number>;
  /**
   * `layerId -> pane indices the layer is hidden in` (see `paneVisibility.ts`).
   * An absent layer is shown in every pane, so a sidecar written before this key
   * existed restores exactly as it did. The `layerVisibility` master switch is
   * unaffected: it still means "show this layer", and this is a filter on top.
   */
  layerPaneHidden: Record<string, number[]>;
  /**
   * The compared runs this view was linked with (peer paths relative to this
   * mesh's folder, plus which settings were shared). Identity only: opening it
   * re-links when those previews are open, and never opens or reads a peer.
   */
  link?: SavedLink;
  /**
   * Named selection sets (see `selectionCore.ts`). A predicate set stores its
   * seed and re-resolves on open; an explicit one also stores its id snapshot.
   *
   * Deliberately NOT pruned by `pruneViewState`: `refreshSelection` is the one
   * refresh-by-definition path for selections and the webview runs it as it
   * installs them, so a second prune here would be the same rule in two places.
   */
  selections: SelectionSet[];
}

export const MAX_PANES = 4;
export const MAX_BOOKMARKS = 100;
/** A pathological sidecar must not make every open build a million-entry map. */
export const MAX_LAYER_ENTRIES = 5000;

/**
 * Floating analysis/overlay panels whose open state persists. Fixed order, so
 * a save is deterministic and a restore replays opens in a stable sequence.
 * The Field panel is NOT here (it has its own `fieldPanel` key); Inspect,
 * Probe and Plot-over-time are NOT here (they need a picked entity and are
 * transient flows, not state — see the module header).
 */
export const PANEL_IDS = [
  "quality",
  "meshSize",
  "spheres",
  "beams",
  "normals",
  "integrals",
  "flow",
  "streamlines",
  "dataTable",
  "selection",
  "properties",
  "lighting",
  "bookmarks",
  "record",
  "link",
  "optimization",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

const FIELD_MODES: readonly FieldMode[] = ["contour", "quiver", "iso", "deformed", "threshold"];
const MAX_ISO_VALUES = 64;

export function emptyViewState(): ViewState {
  return { bookmarks: [], panes: [], layerVisibility: {}, layerOpacity: {}, layerPaneHidden: {}, selections: [], panels: [] };
}

/** True when the state carries nothing worth writing. */
export function isEmptyViewState(v: ViewState): boolean {
  return (
    v.bookmarks.length === 0 &&
    v.paneLayout === undefined &&
    v.curvedLevel === undefined &&
    v.panes.length === 0 &&
    !v.fieldPanel &&
    v.panels.length === 0 &&
    Object.keys(v.layerVisibility).length === 0 &&
    Object.keys(v.layerOpacity).length === 0 &&
    Object.keys(v.layerPaneHidden).length === 0 &&
    v.selections.length === 0 &&
    v.link === undefined
  );
}

export function fieldToSaved(s: PaneFieldState): SavedFieldState {
  const c = clonePaneFieldState(s);
  return { ...c, modes: [...c.modes] };
}

/** Rebuilds a live field state from a validated saved one (fresh `Set`/arrays). */
export function savedToField(s: SavedFieldState): PaneFieldState {
  return clonePaneFieldState({ ...s, modes: new Set(s.modes) });
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function pair(v: unknown): [number, number] | undefined {
  return Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1])
    ? [v[0], v[1]]
    : undefined;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/**
 * Tolerant read of one pane's field state: starts from the defaults and
 * overrides only the keys that parse, warning for each that does not.
 */
function validateFieldState(raw: unknown, colormapFallback: string, label: string, warnings: string[]): SavedFieldState {
  const out = fieldToSaved(defaultPaneFieldState(colormapFallback));
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`${label}: field settings are malformed — defaults used.`);
    return out;
  }
  const r = raw as Record<string, unknown>;
  const bad = (key: string): void => {
    warnings.push(`${label}: field.${key} is invalid — default used.`);
  };
  if (r.selectedKey !== undefined) typeof r.selectedKey === "string" ? (out.selectedKey = r.selectedKey) : bad("selectedKey");
  if (r.modes !== undefined) {
    if (Array.isArray(r.modes)) {
      const modes = r.modes.filter((m): m is FieldMode => FIELD_MODES.includes(m as FieldMode));
      if (modes.length !== r.modes.length) bad("modes");
      out.modes = [...new Set(modes)];
    } else bad("modes");
  }
  if (r.colormap !== undefined) typeof r.colormap === "string" && r.colormap ? (out.colormap = r.colormap) : bad("colormap");
  if (r.component !== undefined) {
    const c = r.component;
    if (c === "mag" || (typeof c === "number" && Number.isInteger(c) && c >= 0 && c < 16)) out.component = c as FieldComponent;
    else bad("component");
  }
  if (r.rangeOverride !== undefined) {
    const p = pair(r.rangeOverride);
    p ? (out.rangeOverride = p) : bad("rangeOverride");
  }
  if (r.log !== undefined) typeof r.log === "boolean" ? (out.log = r.log) : bad("log");
  if (r.bands !== undefined) isFiniteNumber(r.bands) ? (out.bands = clampInt(r.bands, 0, 256)) : bad("bands");
  if (r.displayUnit !== undefined) typeof r.displayUnit === "string" ? (out.displayUnit = r.displayUnit) : bad("displayUnit");
  if (r.scalarBar !== undefined) typeof r.scalarBar === "boolean" ? (out.scalarBar = r.scalarBar) : bad("scalarBar");
  if (r.scalarBarOrientation !== undefined) {
    r.scalarBarOrientation === "vertical" || r.scalarBarOrientation === "horizontal"
      ? (out.scalarBarOrientation = r.scalarBarOrientation as ScalarBarOrientation)
      : bad("scalarBarOrientation");
  }
  if (r.isoValues !== undefined) {
    if (Array.isArray(r.isoValues) && r.isoValues.every(isFiniteNumber)) out.isoValues = r.isoValues.slice(0, MAX_ISO_VALUES);
    else bad("isoValues");
  }
  if (r.scale !== undefined) isFiniteNumber(r.scale) && r.scale > 0 ? (out.scale = r.scale) : bad("scale");
  if (r.deformKey !== undefined) typeof r.deformKey === "string" ? (out.deformKey = r.deformKey) : bad("deformKey");
  if (r.deformScale !== undefined) isFiniteNumber(r.deformScale) ? (out.deformScale = r.deformScale) : bad("deformScale");
  if (r.thresholdRange !== undefined) {
    const p = pair(r.thresholdRange);
    p ? (out.thresholdRange = p) : bad("thresholdRange");
  }
  if (r.thresholdRule !== undefined) {
    r.thresholdRule === "all" || r.thresholdRule === "any"
      ? (out.thresholdRule = r.thresholdRule as ThresholdRule)
      : bad("thresholdRule");
  }
  return out;
}

function validateClipState(raw: unknown, label: string, warnings: string[]): PaneClipState {
  const out = defaultPaneClipState();
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`${label}: clip settings are malformed — defaults used.`);
    return out;
  }
  const r = raw as Record<string, unknown>;
  const bad = (key: string): void => {
    warnings.push(`${label}: clip.${key} is invalid — default used.`);
  };
  if (r.active !== undefined) typeof r.active === "boolean" ? (out.active = r.active) : bad("active");
  if (r.axis !== undefined) {
    r.axis === 0 || r.axis === 1 || r.axis === 2 || r.axis === "free" ? (out.axis = r.axis as ClipAxis) : bad("axis");
  }
  if (r.flipped !== undefined) typeof r.flipped === "boolean" ? (out.flipped = r.flipped) : bad("flipped");
  if (r.freeNormal !== undefined) {
    const n = r.freeNormal;
    if (Array.isArray(n) && n.length === 3 && n.every(isFiniteNumber) && (n[0] !== 0 || n[1] !== 0 || n[2] !== 0)) {
      out.freeNormal = [n[0], n[1], n[2]];
    } else bad("freeNormal");
  }
  if (r.t !== undefined) isFiniteNumber(r.t) ? (out.t = Math.min(1, Math.max(0, r.t))) : bad("t");
  return out;
}

/**
 * Tolerant read of the sidecar's `view` value. An absent key is the ordinary
 * case (older sidecars) and yields an empty state silently; anything malformed
 * degrades per entry with a warning, never a failed open.
 */
export function validateViewState(raw: unknown, colormapFallback = "Rainbow"): { view: ViewState; warnings: string[] } {
  const warnings: string[] = [];
  const view = emptyViewState();
  if (raw === undefined) return { view, warnings };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { view, warnings: ["View sidecar view state is malformed — ignored."] };
  }
  const r = raw as Record<string, unknown>;

  if (r.bookmarks !== undefined) {
    if (!Array.isArray(r.bookmarks)) warnings.push("View sidecar bookmarks are not an array — ignored.");
    else {
      const seen = new Set<string>();
      r.bookmarks.slice(0, MAX_BOOKMARKS).forEach((b, i) => {
        const e = b as Record<string, unknown> | null;
        if (!e || typeof e !== "object" || typeof e.name !== "string" || !e.name.trim() || !isCameraState(e.state)) {
          warnings.push(`View sidecar bookmark ${i + 1} is malformed — dropped.`);
          return;
        }
        // The panel keys bookmarks by name; a repeat would be unreachable.
        if (seen.has(e.name)) {
          warnings.push(`View sidecar bookmark "${e.name}" is duplicated — later copy dropped.`);
          return;
        }
        seen.add(e.name);
        const s = e.state;
        view.bookmarks.push({
          name: e.name,
          state: {
            position: [...s.position] as CameraState["position"],
            focalPoint: [...s.focalPoint] as CameraState["focalPoint"],
            viewUp: [...s.viewUp] as CameraState["viewUp"],
            parallelScale: s.parallelScale,
          },
        });
      });
      if (r.bookmarks.length > MAX_BOOKMARKS) warnings.push(`View sidecar keeps at most ${MAX_BOOKMARKS} bookmarks — the rest were dropped.`);
    }
  }

  if (r.paneLayout !== undefined) {
    if (isPaneLayout(r.paneLayout)) view.paneLayout = r.paneLayout;
    else warnings.push("View sidecar paneLayout is unknown — layout left as opened.");
  }

  if (r.curvedLevel !== undefined) {
    if (typeof r.curvedLevel === "number" && Number.isFinite(r.curvedLevel)) {
      const lvl = Math.max(0, Math.min(3, Math.floor(r.curvedLevel)));
      if (lvl > 0) view.curvedLevel = lvl;
    } else warnings.push("View sidecar curvedLevel is not a number — ignored.");
  }

  if (r.panes !== undefined) {
    if (!Array.isArray(r.panes)) warnings.push("View sidecar panes are not an array — ignored.");
    else {
      r.panes.slice(0, MAX_PANES).forEach((p, i) => {
        const label = `Pane ${i + 1}`;
        if (!p || typeof p !== "object" || Array.isArray(p)) {
          warnings.push(`${label}: settings are malformed — defaults used.`);
          view.panes.push({ field: fieldToSaved(defaultPaneFieldState(colormapFallback)), clip: defaultPaneClipState() });
          return;
        }
        const e = p as Record<string, unknown>;
        const pane: SavedPane = {
          field: validateFieldState(e.field, colormapFallback, label, warnings),
          clip: validateClipState(e.clip, label, warnings),
        };
        if (e.camera !== undefined) {
          if (isCameraState(e.camera)) {
            const c = e.camera;
            pane.camera = {
              position: [...c.position] as CameraState["position"],
              focalPoint: [...c.focalPoint] as CameraState["focalPoint"],
              viewUp: [...c.viewUp] as CameraState["viewUp"],
              parallelScale: c.parallelScale,
            };
          } else warnings.push(`${label}: camera is invalid — current camera kept.`);
        }
        if (e.comparePeer !== undefined) {
          if (typeof e.comparePeer === "string" && e.comparePeer.length > 0 && e.comparePeer.length < 1024) {
            pane.comparePeer = e.comparePeer;
          } else warnings.push(`${label}: comparePeer is not a usable path — dropped.`);
        }
        view.panes.push(pane);
      });
    }
  }

  if (r.fieldPanel !== undefined) {
    if (typeof r.fieldPanel === "boolean") {
      if (r.fieldPanel) view.fieldPanel = true;
    } else warnings.push("View sidecar fieldPanel is not a boolean — ignored.");
  }

  if (r.panels !== undefined) {
    if (!Array.isArray(r.panels)) warnings.push("View sidecar panels are not an array — ignored.");
    else {
      const seen = new Set<string>();
      for (const p of r.panels) {
        if (typeof p !== "string" || !(PANEL_IDS as readonly string[]).includes(p)) {
          warnings.push(`View sidecar panel "${String(p)}" is unknown — dropped.`);
        } else if (seen.has(p)) {
          warnings.push(`View sidecar panel "${p}" is repeated — opened once.`);
        } else seen.add(p);
      }
      // In PANEL_IDS order, deduplicated: a restore replays opens in a
      // stable sequence and a hand-written repeat opens once, not twice.
      view.panels = PANEL_IDS.filter((id) => seen.has(id));
    }
  }

  if (r.layerVisibility !== undefined) {
    if (typeof r.layerVisibility !== "object" || r.layerVisibility === null || Array.isArray(r.layerVisibility)) {
      warnings.push("View sidecar layerVisibility is malformed — ignored.");
    } else {
      let n = 0;
      for (const [id, v] of Object.entries(r.layerVisibility as Record<string, unknown>)) {
        if (typeof v !== "boolean") {
          warnings.push(`View sidecar layerVisibility["${id}"] is not a boolean — dropped.`);
          continue;
        }
        if (n++ >= MAX_LAYER_ENTRIES) {
          warnings.push(`View sidecar keeps at most ${MAX_LAYER_ENTRIES} visibility entries — the rest were dropped.`);
          break;
        }
        view.layerVisibility[id] = v;
      }
    }
  }

  if (r.layerOpacity !== undefined) {
    if (typeof r.layerOpacity !== "object" || r.layerOpacity === null || Array.isArray(r.layerOpacity)) {
      warnings.push("View sidecar layerOpacity is malformed — ignored.");
    } else {
      let n = 0;
      for (const [id, v] of Object.entries(r.layerOpacity as Record<string, unknown>)) {
        if (!isFiniteNumber(v)) {
          warnings.push(`View sidecar layerOpacity["${id}"] is not a number — dropped.`);
          continue;
        }
        if (n++ >= MAX_LAYER_ENTRIES) {
          warnings.push(`View sidecar keeps at most ${MAX_LAYER_ENTRIES} opacity entries — the rest were dropped.`);
          break;
        }
        view.layerOpacity[id] = Math.min(1, Math.max(0, v));
      }
    }
  }

  if (r.layerPaneHidden !== undefined) {
    if (typeof r.layerPaneHidden !== "object" || r.layerPaneHidden === null || Array.isArray(r.layerPaneHidden)) {
      warnings.push("View sidecar layerPaneHidden is malformed — ignored.");
    } else {
      let n = 0;
      for (const [id, raw] of Object.entries(r.layerPaneHidden as Record<string, unknown>)) {
        const { hidden, dropped } = validatePaneHidden(raw, MAX_PANES);
        if (dropped > 0) warnings.push(`View sidecar layerPaneHidden["${id}"] had ${dropped} invalid pane ${dropped === 1 ? "entry" : "entries"} — dropped.`);
        if (!hidden) continue;
        if (n++ >= MAX_LAYER_ENTRIES) {
          warnings.push(`View sidecar keeps at most ${MAX_LAYER_ENTRIES} pane-scope entries — the rest were dropped.`);
          break;
        }
        view.layerPaneHidden[id] = hidden;
      }
    }
  }

  if (r.link !== undefined) {
    const parsed = validateSavedLink(r.link);
    if (parsed.link) view.link = parsed.link;
    warnings.push(...parsed.warnings);
  }

  if (r.selections !== undefined) {
    const parsed = validateSelectionSets(r.selections);
    view.selections = parsed.sets;
    warnings.push(...parsed.warnings);
  }

  return { view, warnings };
}

/** The plain-JSON form written under the sidecar's `view` key (fresh copies, no shared references). */
export function serializeViewState(v: ViewState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    bookmarks: v.bookmarks.map((b) => ({
      name: b.name,
      state: {
        position: [...b.state.position],
        focalPoint: [...b.state.focalPoint],
        viewUp: [...b.state.viewUp],
        parallelScale: b.state.parallelScale,
      },
    })),
    panes: v.panes.slice(0, MAX_PANES).map((p) => {
      const pane: Record<string, unknown> = {
        field: fieldToSaved(savedToField(p.field)),
        clip: clonePaneClipState(p.clip),
      };
      if (p.camera) {
        pane.camera = {
          position: [...p.camera.position],
          focalPoint: [...p.camera.focalPoint],
          viewUp: [...p.camera.viewUp],
          parallelScale: p.camera.parallelScale,
        };
      }
      if (p.comparePeer) pane.comparePeer = p.comparePeer;
      return pane;
    }),
    layerVisibility: { ...v.layerVisibility },
    layerOpacity: { ...v.layerOpacity },
  };
  // Additive keys: written only when something is scoped, linked, selected or
  // open, so a sidecar nobody used the feature on stays byte-identical to what
  // older versions wrote.
  const scoped = Object.entries(v.layerPaneHidden).filter(([, hidden]) => hidden.length > 0);
  if (scoped.length > 0) out.layerPaneHidden = Object.fromEntries(scoped.map(([id, hidden]) => [id, [...hidden]]));
  if (v.link && v.link.peers.length > 0) out.link = { peers: [...v.link.peers], settings: { ...v.link.settings } };
  if (v.selections.length > 0) out.selections = serializeSelectionSets(v.selections);
  if (v.panels.length > 0) out.panels = [...v.panels];
  if (v.paneLayout) out.paneLayout = v.paneLayout;
  if (v.curvedLevel) out.curvedLevel = v.curvedLevel;
  if (v.fieldPanel) out.fieldPanel = true;
  return out;
}

/** What the loaded model offers a restored view to refer to. */
export interface ViewStateContext {
  /** `kind:variable` keys of every field in the model (`fieldInventoryKey`). */
  fieldKeys: ReadonlySet<string>;
  /** Layer ids in the built scene. Omit to skip layer pruning (scene not built yet). */
  layerIds?: ReadonlySet<string>;
}

/**
 * Refresh by definition: drops what the model no longer has and returns a
 * human-readable report of every drop. Never mutates its input.
 *
 * **Selection sets are carried through untouched, and that is deliberate.**
 * `refreshSelection` (selectionCore.ts) is the one refresh-by-definition path
 * for selections — the webview already runs it on every new model and as it
 * installs a restored set list — so pruning here as well would be the same
 * rule implemented twice, which is how the two copies drift apart.
 *
 * A pane whose selected field vanished loses the settings that only made
 * sense for that field (range, iso values, threshold window, display unit) but
 * keeps colormap, bands and the like — they are presentation choices, not
 * references.
 */
export function pruneViewState(view: ViewState, ctx: ViewStateContext): { view: ViewState; dropped: string[] } {
  const dropped: string[] = [];
  const panes = view.panes.map((p, i) => {
    const f = { ...p.field, isoValues: [...p.field.isoValues], modes: [...p.field.modes] };
    const label = `Pane ${i + 1}`;
    if (f.selectedKey && !ctx.fieldKeys.has(f.selectedKey)) {
      dropped.push(`${label}: field "${f.selectedKey}" is not in this mesh.`);
      f.selectedKey = "";
      f.rangeOverride = undefined;
      f.thresholdRange = undefined;
      f.displayUnit = undefined;
      f.isoValues = [];
      f.component = "mag";
    }
    if (f.deformKey && !ctx.fieldKeys.has(f.deformKey)) {
      dropped.push(`${label}: deformation field "${f.deformKey}" is not in this mesh.`);
      f.deformKey = "";
    }
    return { ...p, field: f, clip: clonePaneClipState(p.clip) };
  });
  let layerVisibility = { ...view.layerVisibility };
  let layerOpacity = { ...view.layerOpacity };
  // Pane scopes refer to panes of the saved layout; an index the layout does not have is meaningless.
  const paneLimit = view.paneLayout ? paneCount(view.paneLayout) : MAX_PANES;
  let layerPaneHidden: Record<string, number[]> = {};
  for (const [id, hidden] of Object.entries(view.layerPaneHidden)) {
    const kept = hidden.filter((i) => i < paneLimit);
    if (kept.length > 0) layerPaneHidden[id] = kept;
  }
  if (ctx.layerIds) {
    const ids = ctx.layerIds;
    const missing = new Set<string>();
    const keep = <T>(rec: Record<string, T>): Record<string, T> => {
      const out: Record<string, T> = {};
      for (const [id, v] of Object.entries(rec)) {
        if (ids.has(id)) out[id] = v;
        else missing.add(id);
      }
      return out;
    };
    layerVisibility = keep(layerVisibility);
    layerOpacity = keep(layerOpacity);
    layerPaneHidden = keep(layerPaneHidden);
    if (missing.size > 0) dropped.push(`${missing.size} saved layer setting${missing.size === 1 ? "" : "s"} no longer match a layer in this mesh.`);
  }
  return { view: { ...view, panes, layerVisibility, layerOpacity, layerPaneHidden }, dropped };
}
