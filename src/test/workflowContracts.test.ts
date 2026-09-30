import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { solverArgv } from '../problemtype/threadControl';
import { monitoredMainScript, CONVERGENCE_ADAPTERS } from '../problemtype/mainKratosTemplate';
import { parseCaseJson } from '../problemtype/caseFile';
import { defaultCaseState } from '../problemtype/api';
import { structural } from '../problemtype/builtins/structural';
import { generateCase } from '../problemtype/generate';
import { parseMdpa } from '../parser/mdpaParser';

test('thread launch contract preserves legacy argv and rejects malformed allocations', () => {
  assert.deepEqual(solverArgv('python', 'a file.py'), ['python', 'a file.py']);
  for (const threads of [0, -1, 1.5, NaN]) assert.throws(() => solverArgv('python', 'MainKratos.py', threads));
  const args = solverArgv('python', 'a file.py', 2);
  assert.equal(args[1], '-c'); assert.deepEqual(args.slice(-2), ['2', 'a file.py']);
});
test('every builtin adapter uses durable end framing and distinguishes warmup and linear outcomes', () => {
  for (const [id, adapter] of Object.entries(CONVERGENCE_ADAPTERS)) {
    const main = monitoredMainScript(id);
    assert.ok(main.includes(adapter)); assert.ok(main.includes('"event": "end", "completed": True'));
    assert.ok(main.includes('analysis_type == "non_linear"'));
  }
  assert.ok(monitoredMainScript('shallowWater').includes('_TimeBufferIsInitialized'));
  assert.ok(monitoredMainScript('potentialFlow').includes('_GetStrategyType'));
});
test('explicit output-process settings survive case serialization and generation', async () => {
  const state = defaultCaseState(structural.decl);
  state.outputProcesses = { gid_output: [{ python_module: 'gid_output_process', Parameters: { output_name: 'results/run' } }] };
  const parsed = parseCaseJson(JSON.stringify(state)).state!;
  assert.deepEqual(parsed.outputProcesses, state.outputProcesses);
  const model = parseMdpa('Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n');
  const generated = await generateCase(structural, model, parsed, 'mesh');
  assert.deepEqual(JSON.parse(generated.projectParameters).output_processes, state.outputProcesses);
});
