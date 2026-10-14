/**
 * The bottom command line (CAD-Preview's command row), DOM half.
 *
 * What a command means lives in `src/parser/commandSpec.ts`; how a line becomes
 * an action in `src/parser/commandParse.ts`. This module owns only the input:
 * Tab completion, history, the echo/hint cell, an output popover for `help` and
 * `list`, and the sequential `;` runner that waits for the host's
 * `commandResult` after each mesh operation (so a later step is validated
 * against the model the earlier one produced — the semantics of MCP
 * `mesh_transform`, not of the queue's pre-validated batch).
 */

import {
  completions,
  helpLines,
  listLines,
  parseCommandLine,
  resolveCommand,
  usageLine,
  type CompletionContext,
} from "../src/parser/commandParse";
import { COMMANDS, type CommandAction } from "../src/parser/commandSpec";

export interface CommandLineHost {
  post(msg: Record<string, unknown>): void;
  /** Executes a non-op action. Returns an error message, or undefined on success. */
  run(action: Exclude<CommandAction, { kind: "op" }>): string | undefined;
  context(): CompletionContext;
  /** A reason the line cannot run now (e.g. a recording is active), else undefined. */
  blocked(): string | undefined;
}

export interface CommandLine {
  focus(): void;
  /** Feed a host `commandResult` message. */
  onResult(msg: { cmdId?: unknown; ok?: unknown; message?: unknown }): void;
}

const HISTORY_KEY = "kratos.commandHistory";
const HISTORY_MAX = 100;

function loadHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function saveHistory(h: string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-HISTORY_MAX)));
  } catch {
    /* storage can be unavailable (private window, blocked site data) */
  }
}

function commonPrefix(items: readonly string[]): string {
  if (!items.length) return "";
  let p = items[0];
  for (const s of items) {
    while (!s.toLowerCase().startsWith(p.toLowerCase())) p = p.slice(0, -1);
  }
  return p;
}

export function initCommandLine(host: CommandLineHost): CommandLine | undefined {
  const row = document.getElementById("commandline");
  const input = document.getElementById("cmd-input") as HTMLInputElement | null;
  const echo = document.getElementById("cmd-echo");
  if (!row || !input || !echo) return undefined;

  const output = document.createElement("div");
  output.id = "cmd-output";
  output.hidden = true;
  output.setAttribute("role", "log");
  row.appendChild(output);

  const history = loadHistory();
  let historyIdx = history.length; // == history.length means "the draft"
  let draft = "";
  let running = false;
  let abandoned = false;
  let cancelRequested = false;
  let cmdSeq = 0;
  let pending: { id: number; resolve: (r: { ok: boolean; message?: string }) => void } | undefined;
  let cycle: { text: string; from: number; candidates: string[]; idx: number } | undefined;

  const setEcho = (text: string, tone: "hint" | "ok" | "error" = "hint"): void => {
    echo.textContent = text;
    echo.title = text;
    echo.dataset.tone = tone;
  };

  const showOutput = (lines: string[]): void => {
    output.replaceChildren(
      ...lines.map((l) => {
        const d = document.createElement("div");
        d.textContent = l;
        return d;
      })
    );
    output.hidden = lines.length === 0;
  };

  const updateHint = (): void => {
    const text = input.value;
    cycle = undefined;
    if (!text.trim()) {
      setEcho("");
      showOutput([]);
      return;
    }
    const lastStep = text.split(";").pop()!.trim();
    const verb = lastStep.split(/\s+/)[0] ?? "";
    if (!verb) {
      setEcho("");
      return;
    }
    const r = resolveCommand(verb.startsWith("?") ? "help" : verb);
    if (r.ok && (lastStep.length > verb.length || r.spec.name.toLowerCase() === verb.toLowerCase())) {
      setEcho(usageLine(r.spec));
      return;
    }
    const c = completions(text, host.context());
    setEcho(c.candidates.length ? c.candidates.slice(0, 8).join("  ") : "no such command — type list", "hint");
  };

  const finish = (ok: boolean, message: string, hint?: string): void => {
    const full = hint && !ok ? `${message} — ${hint}` : message;
    setEcho(full, ok ? "ok" : "error");
  };

  const waitForResult = (id: number): Promise<{ ok: boolean; message?: string }> =>
    new Promise((resolve) => {
      pending = { id, resolve };
    });

  const runLine = async (text: string): Promise<void> => {
    const blocked = host.blocked();
    if (blocked) {
      finish(false, blocked);
      return;
    }
    const parsed = parseCommandLine(text);
    if (!parsed.ok) {
      finish(false, parsed.error, parsed.hint);
      return;
    }
    running = true;
    abandoned = false;
    cancelRequested = false;
    showOutput([]);
    try {
      let last = "";
      for (let i = 0; i < parsed.steps.length; i++) {
        const step = parsed.steps[i];
        const prefix = parsed.steps.length > 1 ? `step ${i + 1}/${parsed.steps.length}: ` : "";
        if (step.kind === "op") {
          const id = ++cmdSeq;
          setEcho(`${prefix}${step.op} running… (Esc cancels)`);
          const waiting = waitForResult(id);
          host.post({ ...step.message, cmdId: id });
          const r = await waiting;
          if (abandoned) {
            finish(false, `${prefix}stopped waiting for ${step.op} (it may still finish)`);
            return;
          }
          if (!r.ok) {
            finish(false, `${prefix}${r.message ?? `${step.op} failed`}`);
            return;
          }
          last = `${prefix}${r.message ?? `${step.op} applied.`}`;
        } else if (step.kind === "meta") {
          last = runMeta(step);
        } else {
          const err = host.run(step);
          if (err) {
            finish(false, `${prefix}${err}`);
            return;
          }
          last = step.kind === "post" ? `${prefix}sent to the host` : `${prefix}done`;
        }
      }
      finish(true, last);
    } finally {
      running = false;
      pending = undefined;
    }
  };

  const runMeta = (step: Extract<CommandAction, { kind: "meta" }>): string => {
    if (step.fn === "list") {
      const cat = typeof step.args.category === "string" ? step.args.category : undefined;
      const lines = listLines(cat);
      showOutput(lines.length ? lines : [`no category "${cat}"`]);
      return `${COMMANDS.length} commands — help <command> for usage`;
    }
    const name = typeof step.args.command === "string" ? step.args.command : undefined;
    if (!name) {
      showOutput([
        "Syntax:  verb key=value …   |   verb {json}   |   a ; b ; c",
        "Tab completes · ↑/↓ history · Esc cancels a running op · / focuses this line",
        "Operations are named exactly like the sidebar ops (translate, remesh, fieldCalc …).",
        "list            all commands by category",
        "help <command>  usage and an example",
      ]);
      return "help";
    }
    const r = resolveCommand(name);
    if (!r.ok) {
      showOutput([r.error, r.hint ?? ""]);
      return r.error;
    }
    showOutput(helpLines(r.spec));
    return r.spec.summary;
  };

  const applyCompletion = (backwards: boolean): void => {
    const text = input.value;
    if (cycle && cycle.text === text) {
      cycle.idx = (cycle.idx + (backwards ? -1 : 1) + cycle.candidates.length) % cycle.candidates.length;
    } else {
      const c = completions(text, host.context());
      if (!c.candidates.length) return;
      if (c.candidates.length === 1) {
        const only = c.candidates[0];
        const next = text.slice(0, c.from) + only + (only.endsWith("=") ? "" : " ");
        input.value = next;
        cycle = undefined;
        updateHint();
        return;
      }
      const typed = text.slice(c.from);
      const common = commonPrefix(c.candidates);
      if (common.length > typed.length) {
        input.value = text.slice(0, c.from) + common;
        setEcho(c.candidates.slice(0, 8).join("  "));
        cycle = undefined;
        return;
      }
      cycle = { text, from: c.from, candidates: c.candidates, idx: backwards ? c.candidates.length - 1 : 0 };
    }
    const c = cycle!;
    const pick = c.candidates[c.idx];
    input.value = c.text.slice(0, c.from) + pick;
    c.text = input.value;
    setEcho(c.candidates.map((x, i) => (i === c.idx ? `[${x}]` : x)).slice(0, 8).join("  "));
  };

  input.addEventListener("input", () => {
    historyIdx = history.length;
    updateHint();
  });

  input.addEventListener("keydown", (e) => {
    // Nothing typed here may reach the global shortcuts (1–6, i, Selection's
    // Enter/Escape lasso handling, the dropdown Escape handler).
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || running) return;
      if (history[history.length - 1] !== text) history.push(text);
      if (history.length > HISTORY_MAX) history.shift();
      saveHistory(history);
      historyIdx = history.length;
      draft = "";
      input.value = "";
      cycle = undefined;
      void runLine(text);
    } else if (e.key === "Tab") {
      e.preventDefault();
      applyCompletion(e.shiftKey);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyIdx === history.length) draft = input.value;
      if (historyIdx > 0) input.value = history[--historyIdx];
      updateHint();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx < history.length) {
        historyIdx++;
        input.value = historyIdx === history.length ? draft : history[historyIdx];
        updateHint();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (running) {
        if (!pending) return;
        if (!cancelRequested) {
          // First Escape asks the host to cancel; the op answers with a noop
          // result. A second one stops waiting even if the host never answers.
          cancelRequested = true;
          host.post({ type: "opCancel" });
          setEcho("cancelling… (press Esc again to stop waiting)");
        } else {
          abandoned = true;
          pending.resolve({ ok: false, message: "stopped waiting" });
        }
      } else if (!output.hidden) showOutput([]);
      else if (input.value) {
        input.value = "";
        updateHint();
      } else input.blur();
    }
  });

  return {
    focus(): void {
      input.focus();
      input.select();
    },
    onResult(msg): void {
      if (!pending || msg.cmdId !== pending.id) return;
      const p = pending;
      pending = undefined;
      p.resolve({ ok: msg.ok === true, message: typeof msg.message === "string" ? msg.message : undefined });
    },
  };
}
