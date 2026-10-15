/**
 * Asks the configured Python which of a case's Kratos applications it cannot
 * import, before a run is launched (roadmap item 16). The generated driver
 * performs the same check itself and exits with code 3, so this probe is the
 * friendlier front door, not the only guard: when it cannot run (no Python, a
 * timeout) it reports `unavailable` and the launch proceeds to the driver's check.
 *
 * `find_spec` on `KratosMultiphysics.<App>` imports `KratosMultiphysics` (the
 * banner goes to stdout), so the answer is printed on one line behind a marker
 * and only that line is read.
 */

import { spawn } from "node:child_process";

const MARKER = "KKSS_APP_PROBE ";

export const PROBE_SCRIPT = `import importlib.util, json, sys
apps = json.loads(sys.argv[1])
if importlib.util.find_spec("KratosMultiphysics") is None:
    missing = ["KratosMultiphysics"]
else:
    missing = []
    for name in apps:
        try:
            found = importlib.util.find_spec("KratosMultiphysics." + name) is not None
        except Exception:
            found = False
        if not found:
            missing.append(name)
sys.stdout.flush()
print(${JSON.stringify(MARKER)} + json.dumps({"missing": missing}))
`;

export interface ProbeResult {
  /** Applications (or "KratosMultiphysics" itself) the Python cannot import. */
  missing: string[];
  /** Set when the probe could not answer; `missing` is then empty. */
  unavailable?: string;
}

export interface ProbeOptions {
  python: string;
  /** Environment DELTA (computeKratosEnv's), spread over process.env. */
  envDelta?: Record<string, string>;
  applications: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

/** Reads the marker line out of the probe's stdout. */
export function parseProbeOutput(stdout: string): string[] | undefined {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(MARKER));
  if (!line) return undefined;
  try {
    const value = JSON.parse(line.slice(MARKER.length)) as { missing?: unknown };
    return Array.isArray(value.missing) && value.missing.every((m) => typeof m === "string") ? (value.missing as string[]) : undefined;
  } catch {
    return undefined;
  }
}

export function probeKratosApplications(opts: ProbeOptions): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.python, ["-c", PROBE_SCRIPT, JSON.stringify(opts.applications)], {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.envDelta ?? {}) },
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ missing: [], unavailable: `could not start ${opts.python}: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ missing: [], unavailable: `${opts.python} did not answer within ${Math.round((opts.timeoutMs ?? 30000) / 1000)} s` });
    }, opts.timeoutMs ?? 30000);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => done({ missing: [], unavailable: `could not start ${opts.python}: ${err.message}` }));
    child.on("close", (code) => {
      const missing = parseProbeOutput(stdout);
      if (missing) done({ missing });
      else done({ missing: [], unavailable: `${opts.python} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).pop()}` : ""}` });
    });
  });
}
