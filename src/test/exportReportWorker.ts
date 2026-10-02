import { measureWriter, writerJobs } from "./exportReportMatrix";

async function main(): Promise<void> {
  const key = process.argv[2];
  const job = writerJobs().find((candidate) => candidate.key === key);
  if (!job || !process.send) throw new Error(`Invalid export fidelity worker request: ${key}`);
  const result = await measureWriter(job);
  process.send(result, (error) => {
    if (error) console.error(error);
    // Native wasm threads may still be live. This batch is finished; exiting
    // releases all its instances before the coordinator launches another one.
    process.exit(error ? 1 : 0);
  });
}

// Node 20's `node --test out/test/` also executes helper .js files. Only
// forked measurement workers have an IPC channel; discovery must be a noop.
if (require.main === module && process.send) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
