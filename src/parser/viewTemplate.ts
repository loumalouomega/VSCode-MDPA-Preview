// View templates (roadmap item 65): a saved view with its file-specific parts
// removed, applied to any other result.
//
// A view is saved per file in `<stem>.kratosview.json` (viewState.ts), so the
// same set-up (field, colormap, clip, camera, legend) is rebuilt by hand for
// every run of a sweep. A template keeps the presentation choices and drops
// what only means something for one file:
//   - selection sets and the compared-run link (identities of one file),
//   - each pane's compared peer,
//   - absolute colour ranges and threshold windows, unless `keepRanges` (a range
//     typed for one run is wrong for the next; the data range is used instead).
// Applying is "refresh by definition": whatever the target lacks (a field, a
// layer) is dropped and reported by `pruneViewState`, everything else applies.
//
// Pure: no fs, no vscode.

import {
  ViewState,
  ViewStateContext,
  pruneViewState,
  serializeViewState,
  validateViewState,
} from "./viewState";

export const VIEW_TEMPLATE_VERSION = 1;

export interface ViewTemplate {
  version: number;
  name: string;
  description?: string;
  /** The serialized view state (the `view` key of a sidecar). */
  view: Record<string, unknown>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

/** A template name becomes a file name, so it is restricted like one. */
export function isValidTemplateName(name: string): boolean {
  return NAME_RE.test(name);
}

export function templateFileName(name: string): string {
  return `${name.replace(/\s+/g, "_")}.json`;
}

export function toTemplate(
  view: ViewState,
  name: string,
  opts: { description?: string; keepRanges?: boolean } = {}
): ViewTemplate {
  if (!isValidTemplateName(name)) throw new Error(`"${name}" is not a valid template name (letters, digits, space, _ . -; at most 64).`);
  const panes = view.panes.map((p) => {
    const { comparePeer: _peer, ...rest } = p;
    void _peer;
    const field = { ...p.field, isoValues: [...p.field.isoValues], modes: [...p.field.modes] };
    if (!opts.keepRanges) {
      field.rangeOverride = undefined;
      field.thresholdRange = undefined;
    }
    return { ...rest, field };
  });
  const cleaned: ViewState = { ...view, panes, selections: [], link: undefined };
  const serial = serializeViewState(cleaned);
  delete serial.link;
  delete serial.selections;
  return {
    version: VIEW_TEMPLATE_VERSION,
    name,
    ...(opts.description ? { description: opts.description } : {}),
    view: serial,
  };
}

export interface ParsedTemplate {
  template?: ViewTemplate;
  warnings: string[];
}

/** Tolerant: a malformed file yields no template and a reason, never a throw. */
export function parseViewTemplate(text: string): ParsedTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { warnings: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const r = raw as Partial<ViewTemplate> | null;
  if (!r || typeof r !== "object" || typeof r.name !== "string" || !r.view || typeof r.view !== "object") {
    return { warnings: ["Not a view template (needs a name and a view)."] };
  }
  if (typeof r.version === "number" && r.version > VIEW_TEMPLATE_VERSION) {
    return { warnings: [`Written by a newer version (${r.version}); it is not applied so nothing is misread.`] };
  }
  return {
    template: {
      version: typeof r.version === "number" ? r.version : VIEW_TEMPLATE_VERSION,
      name: r.name,
      ...(typeof r.description === "string" ? { description: r.description } : {}),
      view: r.view as Record<string, unknown>,
    },
    warnings: [],
  };
}

export interface AppliedTemplate {
  view: ViewState;
  /** Everything the target lacks: a field or layer the template named. */
  unmatched: string[];
  warnings: string[];
}

export function applyViewTemplate(template: ViewTemplate, ctx: ViewStateContext, colormapFallback = "Rainbow"): AppliedTemplate {
  const parsed = validateViewState(template.view, colormapFallback);
  const pruned = pruneViewState(parsed.view, ctx);
  return { view: pruned.view, unmatched: pruned.dropped, warnings: parsed.warnings };
}
