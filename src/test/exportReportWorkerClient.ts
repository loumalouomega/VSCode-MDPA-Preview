import { fork } from "node:child_process";

/** Await process exit, not just its reply, before starting another wasm batch. */
export function runMeasurementWorker(
  workerPath: string,
  writer: string,
  timeoutMs = 120_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [writer], {
      // Do not pass node --test's context or an inspector port to the worker.
      execArgv: [],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let result: unknown;
    let received = false;
    let failure: string | undefined;
    let diagnostic = "";
    const capture = (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("message", (message) => {
      if (received) failure = "sent more than one result";
      received = true;
      result = message;
    });
    child.on("error", (error) => { failure = error.message; });
    const timer = setTimeout(() => {
      failure = `timed out after ${timeoutMs} ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0 || !received) {
        const reason = failure ?? (signal ? `terminated by ${signal}` : code !== 0 ? `exited with code ${code}` : "exited without a result");
        reject(new Error(`Export fidelity worker ${writer}: ${reason}${diagnostic ? `\n${diagnostic}` : ""}`));
      } else {
        resolve(result);
      }
    });
  });
}
