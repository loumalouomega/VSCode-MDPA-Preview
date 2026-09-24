import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialJson } from '../problemtype/materialJson';
import { convectionDiffusion } from '../problemtype/builtins/convectionDiffusion';

test('material real values retain JSON decimal tokens; IDs and strings do not change', () => {
  const value = { properties: [{ properties_id: 1, model_part_name: 'Domain 1000', Material: { Variables: {
    DENSITY: 1000, CONDUCTIVITY: 1, SPECIFIC_HEAT: 4184, CUSTOM_INTEGER: 2,
  } } }] };
  const text = materialJson(value, convectionDiffusion);
  assert.match(text, /"DENSITY": 1000\.0/);
  assert.match(text, /"CONDUCTIVITY": 1\.0/);
  assert.match(text, /"properties_id": 1,/);
  assert.match(text, /"CUSTOM_INTEGER": 2\n/);
  assert.deepEqual(JSON.parse(text), value);
});
