import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseMdpa } from '../parser/mdpaParser';
import { SequenceResampler, blendModels, targetTimes } from '../parser/resampleSequence';
import { exportResampled, sequenceSource } from '../parser/resampleFiles';
import { parseMeshFile } from '../parser/meshFileParser';
import { parseVtkXml } from '../parser/vtkXmlParser';
const frame=(v:number)=>{
 const m=parseMdpa('Begin Nodes\n10 0 0 0\n20 1 0 0\n30 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n7 3 10 20 30\nEnd Elements\n');
 m.fields=[{kind:'Nodal',variable:'T',components:1,ids:m.nodeIds,values:Float64Array.from([v,v+1,v+2]),numericType:'float'},{kind:'Elemental',variable:'LABEL',components:1,ids:new Int32Array([7]),values:new Float64Array([v]),numericType:'integer'},{kind:'Elemental',variable:'UNKNOWN',components:1,ids:new Int32Array([7]),values:new Float64Array([v])}];return m;
};
test('linear endpoints, discrete data and unknown-field opt-in',async()=>{
 const a=frame(0),b=frame(10);const sampler=new SequenceResampler({times:[0,1],load:async i=>i?b:a},{times:[0,0.25,0.75,1]});
 assert.strictEqual(await sampler.frame(0),a);assert.strictEqual(await sampler.frame(3),b);
 const mid=await sampler.frame(1);assert.equal(mid.fields[0].values[0],2.5);assert.equal(mid.fields[1].values[0],0);assert.equal(mid.fields[2].values[0],0);
 const later=await sampler.frame(2);assert.equal(later.fields[1].values[0],10);
 assert.equal(blendModels(a,b,0.25,{continuousFields:['Elemental:UNKNOWN','Elemental:LABEL']}).fields[2].values[0],2.5);
 assert.equal(blendModels(a,b,0.25,{continuousFields:['Elemental:LABEL']}).fields[1].values[0],0);
});
test('moving points are opt-in, incompatible topology, fields and metadata fail',()=>{
 const a=frame(0),b=frame(10);b.coords=Float32Array.from(b.coords,v=>v+2);
 assert.deepEqual(blendModels(a,b,0.5,{}).coords,a.coords);assert.equal(blendModels(a,b,0.5,{blendPoints:true}).coords[0],1);
 b.blocks[0].connectivity[0]=20;assert.throws(()=>blendModels(a,b,0.5,{}),/topology/);
 const c=frame(10);c.fields.pop();assert.throws(()=>blendModels(a,c,0.5,{}),/field layouts/);
 const d=frame(10);d.properties=[{id:9,entries:[]} as any];assert.throws(()=>blendModels(a,d,0.5,{}),/properties/);
});
test('nearest, previous, range validation and extrapolation',async()=>{
 const source={times:[0,1],load:async(i:number)=>frame(i*10)};
 assert.deepEqual(targetTimes({range:{start:0,stop:1,step:0.5}}),[0,0.5,1]);
 assert.throws(()=>targetTimes({times:[1,1]}));assert.throws(()=>new SequenceResampler({...source,times:[1,0]},{times:[0]}));
 assert.equal((await new SequenceResampler(source,{times:[0.75],method:'nearest'}).frame(0)).fields[0].values[0],10);
 assert.equal((await new SequenceResampler(source,{times:[0.75],method:'previous'}).frame(0)).fields[0].values[0],0);
 await assert.rejects(new SequenceResampler(source,{times:[2]}).frame(0),/outside/);
 assert.equal((await new SequenceResampler(source,{times:[2],extrapolate:'clamp'}).frame(0)).fields[0].values[0],10);
});
test('cache holds at most two frames, reuses brackets and invalidates',async()=>{
 const loads:number[]=[];const sampler=new SequenceResampler({times:[0,1,2],load:async i=>{loads.push(i);return frame(i*10);}},{times:[0.25,0.75,1.5]});
 await sampler.frame(0);await sampler.frame(1);assert.deepEqual(loads,[0,1]);await sampler.frame(2);assert.deepEqual(loads,[0,1,2]);
 sampler.clear();await sampler.frame(2);assert.deepEqual(loads,[0,1,2,1,2]);
});
test('PVD export reopens at target times; cancellation leaves no result',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'resample-test-'));
 try {const source={times:[0,1],load:async(i:number)=>frame(i*10)},file=path.join(dir,'resampled.pvd');
 const result=await exportResampled(source,{times:[0,0.5,1]},file);assert.equal(result.frames,3);
 assert.equal((await parseMeshFile(file,undefined,{timeStep:1})).fields[0].values[0],5);
 const reopened=await sequenceSource(file);assert.deepEqual(reopened.times,[0,0.5,1]);
 const abort=new AbortController();abort.abort();await assert.rejects(exportResampled(source,{times:[0,1]},path.join(dir,'cancelled.pvd'),abort.signal));
 await assert.rejects(fs.stat(path.join(dir,'cancelled.pvd')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('VTK field declarations retain integer provenance',()=>{
 const xml='<VTKFile type="UnstructuredGrid"><UnstructuredGrid><Piece NumberOfPoints="1" NumberOfCells="0"><Points><DataArray type="Float64" NumberOfComponents="3">0 0 0</DataArray></Points><PointData><DataArray type="Int32" Name="LABEL">1</DataArray><DataArray type="Float64" Name="T">2</DataArray></PointData><Cells><DataArray type="Int32" Name="connectivity"></DataArray><DataArray type="Int32" Name="offsets"></DataArray><DataArray type="UInt8" Name="types"></DataArray></Cells></Piece></UnstructuredGrid></VTKFile>';
 const model=parseVtkXml(Buffer.from(xml));assert.equal(model.fields.find(f=>f.variable==='LABEL')!.numericType,'integer');assert.equal(model.fields.find(f=>f.variable==='T')!.numericType,'float');
});
