/**
 * Says WHY `opRecordFromMessage` refused a raw `applyOp` message.
 *
 * The validator returns only `undefined`, and rebuilding every case to return
 * a reason would fork 900 lines that are the single authority for what an op
 * accepts. This works from the outside instead: a missing required parameter
 * (from the command registry), then a one-key-at-a-time search for the value
 * whose removal makes the message valid, then the usage line. Pure and cheap —
 * it only runs on the failure path.
 */

import { COMMANDS } from "./commandSpec";
import { usageLine } from "./commandParse";
import { opRecordFromMessage } from "./operations";
import type { MdpaModel } from "./types";

const ENVELOPE = new Set(["type", "op", "cmdId"]);

export function explainOpMessage(msg: Record<string, unknown>, model?: MdpaModel): string {
  const op = typeof msg.op === "string" ? msg.op : "";
  if (!op) return "missing operation name";
  const spec = COMMANDS.find((c) => c.exec.kind === "op" && c.name === op);
  if (!spec) return `unknown operation "${op}"`;
  const missing = spec.params
    .filter((p) => p.required && (msg[p.name] === undefined || msg[p.name] === ""))
    .map((p) => `"${p.name}"`);
  if (missing.length) return `${op}: missing required parameter${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`;
  const culprits = Object.keys(msg)
    .filter((k) => !ENVELOPE.has(k))
    .filter((k) => {
      const copy = { ...msg };
      delete copy[k];
      return opRecordFromMessage(copy, model) !== undefined;
    });
  // Removing a REQUIRED parameter cannot make a message valid, so a bad
  // required value never shows up above: name those that were supplied.
  const suspects = culprits.length
    ? culprits
    : spec.params.filter((p) => p.required && msg[p.name] !== undefined).map((p) => p.name);
  if (suspects.length) {
    return `${op}: invalid value for ${suspects.map((k) => `${k}=${JSON.stringify(msg[k])}`).join(", ")}`;
  }
  return `${op}: parameters rejected — usage: ${usageLine(spec)}`;
}
