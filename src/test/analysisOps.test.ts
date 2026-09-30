import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMdpa } from '../parser/mdpaParser';
import { featureEdges, qualityGate, hausdorff, periodicNodes, periodicMatrix } from '../parser/analysisOps';
import { applyOp, parseOpsJson, serializeOps, replayOps, OpRecord } from '../parser/operations';
const square=()=>parseMdpa(`Begin Nodes
10 0 0 0
20 1 0 0
30 1 1 0
40 0 1 0
End Nodes
Begin Elements Element2D3N
7 2 10 20 30
8 2 10 30 40
End Elements
Begin SubModelPart left
Begin SubModelPartNodes
10
40
End SubModelPartNodes
End SubModelPart
Begin SubModelPart right
Begin SubModelPartNodes
20
30
End SubModelPartNodes
End SubModelPart
`);
test('feature edges classify the open square and leave the input intact',async()=>{
 const model=square(), before=JSON.stringify(model);const r=await featureEdges(model);
 assert.equal(r.counts.boundary,4);assert.equal(r.counts.feature,0);assert.equal(r.model.blocks[0].count,4);assert.equal(JSON.stringify(model),before);
 assert.ok(r.model.fields.some(f=>/kind/i.test(f.variable)));
 assert.equal((await featureEdges(model,{boundary:false})).model.blocks.reduce((n,b)=>n+b.count,0),0);
});
test('quality gate separates failure from invalid input',async()=>{
 assert.equal((await qualityGate(square(),'aspect_ratio <= 100')).passed,true);
 assert.equal((await qualityGate(square(),'aspect_ratio <= 0')).passed,false);
 await assert.rejects(qualityGate(square(),'not_a_metric >= 0'));
});
test('Hausdorff reports known offset and sampled status',async()=>{
 const a=square(),b=square();b.coords=Float32Array.from(b.coords,(v,i)=>i%3===2?v+2:v);
 const r=await hausdorff(a,b,1);assert.equal(r.distance,2);assert.equal(r.sampled,true);assert.equal(r.aToB,2);
});
test('periodic matching returns original IDs and rejects unmatched slaves',async()=>{
 const model=square();const r=await periodicNodes(model,{slave:'left',master:'right',translate:[1,0,0]});
 assert.deepEqual(r.pairs,[{slave:10,master:20},{slave:40,master:30}]);
 await assert.rejects(periodicNodes(model,{slave:'left',master:'right',translate:[2,0,0]}));
 const partial=await periodicNodes(model,{slave:'left',master:'right',translate:[2,0,0],requireComplete:false});assert.deepEqual(partial.unmatched,[10,40]);
 assert.throws(()=>periodicMatrix({slave:'left',master:'right',rotate:{axis:[0,0,0],angle:30}}));
});
test('region algebra replays without touching mesh IDs, fields or properties',()=>{
 const model=square();
 const ops: OpRecord[]=[{op:'regionAlgebra',operation:'union',inputs:['left','right'],output:'all'},{op:'regionAlgebra',operation:'difference',inputs:['all','right'],output:'onlyLeft'},{op:'regionAlgebra',operation:'intersection',inputs:['left','right'],output:'empty'}];
 const loaded=parseOpsJson(serializeOps(ops,'square.mdpa'));assert.deepEqual(loaded.operations,ops);assert.deepEqual(loaded.warnings,[]);
 const result=replayOps(model,ops).model;assert.deepEqual(result.nodeIds,model.nodeIds);assert.strictEqual(result.blocks,model.blocks);
 assert.deepEqual(Array.from(result.subModelParts.find(p=>p.path==='all')!.nodeIds),[10,20,30,40]);
 assert.deepEqual(Array.from(result.subModelParts.find(p=>p.path==='onlyLeft')!.nodeIds),[10,40]);
 assert.equal(result.subModelParts.find(p=>p.path==='empty')!.nodeIds.length,0);
 assert.throws(()=>applyOp(model,{op:'regionAlgebra',operation:'union',inputs:['left','right'],output:'left'}));
});
