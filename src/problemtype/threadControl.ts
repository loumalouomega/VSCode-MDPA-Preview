/** Shared runner bootstrap. Omitted threads preserves standalone launch behavior. */
export const THREAD_RECEIPT = 'kkss-resources.json';
export function solverArgv(python: string, script: string, threads?: number): string[] {
  if (threads === undefined) return [python, script];
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error('threads must be a positive integer.');
  return [python, '-c', THREAD_BOOTSTRAP, String(threads), script];
}
export const THREAD_BOOTSTRAP = `import sys,os,json,runpy
try: os.remove('kkss-resources.json')
except FileNotFoundError: pass
import KratosMultiphysics as K
n=int(sys.argv[1]); script=sys.argv[2]
p=K.ParallelUtilities
p.SetNumThreads(n)
effective=int(p.GetNumThreads())
if effective != n: raise RuntimeError('Kratos did not apply requested thread allocation')
record={'version':1,'requestedThreads':n,'effectiveThreads':effective}
with open('kkss-resources.json.tmp','w') as f: json.dump(record,f)
os.replace('kkss-resources.json.tmp','kkss-resources.json')
sys.argv=[script]
runpy.run_path(script,run_name='__main__')
`;
