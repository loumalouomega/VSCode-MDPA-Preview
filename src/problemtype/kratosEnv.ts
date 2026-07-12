/**
 * Computes the environment variables a terminal needs to run a case against a
 * configured Kratos install. Pure and platform-parameterized (the platform is
 * an argument, not process.platform) so the per-OS matrix is unit-testable.
 *
 * Two modes:
 *  - no installPath: Kratos is pip-installed into the chosen python — no env needed.
 *  - installPath set: a compiled Kratos tree (contains KratosMultiphysics/ and libs/):
 *    prepend it to PYTHONPATH and its libs/ dir to the platform's shared-library
 *    path (LD_LIBRARY_PATH on linux, DYLD_LIBRARY_PATH on macOS — note SIP strips
 *    DYLD_* for protected binaries — and PATH on Windows).
 */

export interface KratosEnvOptions {
  /** process.platform value: "linux" | "darwin" | "win32" | … */
  platform: string;
  /** Root of a compiled Kratos install; empty/undefined = pip-installed Kratos. */
  installPath?: string;
  /** Extra variables merged in last (verbatim override). */
  extraEnv?: Record<string, string>;
  /** Existing values (usually process.env) that prepends chain onto. */
  base?: Record<string, string | undefined>;
}

/** Returns only the variables that need to be set for the run terminal. */
export function computeKratosEnv(opts: KratosEnvOptions): Record<string, string> {
  const { platform, installPath, extraEnv, base } = opts;
  const delim = platform === "win32" ? ";" : ":";
  const sep = platform === "win32" ? "\\" : "/";
  const env: Record<string, string> = {};

  const prepend = (name: string, value: string): void => {
    const existing = env[name] ?? base?.[name];
    env[name] = existing ? `${value}${delim}${existing}` : value;
  };

  if (installPath && installPath.length > 0) {
    const root = installPath.replace(/[\\/]+$/, "");
    prepend("PYTHONPATH", root);
    const libs = `${root}${sep}libs`;
    if (platform === "win32") prepend("PATH", libs);
    else if (platform === "darwin") prepend("DYLD_LIBRARY_PATH", libs);
    else prepend("LD_LIBRARY_PATH", libs);
  }

  for (const [k, v] of Object.entries(extraEnv ?? {})) env[k] = v;
  return env;
}

/** The python executable to use when the setting is left at its default. */
export function defaultPythonPath(platform: string): string {
  return platform === "win32" ? "python" : "python3";
}
