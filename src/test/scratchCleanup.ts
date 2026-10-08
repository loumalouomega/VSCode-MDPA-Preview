import * as fs from "node:fs/promises";

/** Best-effort removal of test scratch directories.
 *
 * Windows runners (Defender/indexer, delayed handle release after a worker
 * thread terminates) can briefly hold freshly-written files with EPERM/EBUSY/
 * ENOTEMPTY. Node's own `maxRetries` covers ~500 ms, which run 37803024100
 * proved is not enough under load (10 s test, EPERM lstat on a just-used
 * .vtk after 5x100 ms). Retry with linear backoff well beyond that, then warn
 * instead of throwing: scratch cleanup must never turn passing functional
 * assertions into a CI failure; the OS reclaims /tmp anyway. */
export async function removeScratchDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY") && attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      console.warn(`Warning: scratch cleanup of ${dir} failed (${code ?? error}); leaving for OS temp reclamation.`);
      return;
    }
  }
}
