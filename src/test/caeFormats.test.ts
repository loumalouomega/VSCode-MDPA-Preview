import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseMeshFile, statMeshSource } from '../parser/meshFileParser';
import { writeMeshioBytes } from '../parser/meshio';
import { meshExtname, MESHIO_READ_CANDIDATES } from '../parser/meshioFormats';
import { meshConvert, meshInfo } from '../mcp/tools';
const fixtures=path.resolve('src/test/fixtures/cae');
const formats: Record<string,string>={code_aster:'tetra.mail',elmer:'tetra.elmer',febio:'tetra.feb',femap:'tetra.neu',libmesh:'tetra.xda',marc:'tetra.dat',mfem:'tetra.mesh',mphbin:'tetra.mphbin',patran:'tetra.pat',radioss:'tetra.rad',z88:'z88i1.txt'};
for(const [format,name] of Object.entries(formats)) test(`CAE ${format}: committed fixture and live writer round trip`,async()=>{
  const model=await parseMeshFile(path.join(fixtures,format,name));
  assert.equal(model.nodeCount,4);assert.equal(model.blocks.reduce((n,b)=>n+b.count,0),1);
  assert.equal(model.blocks[0].vtkCellType,10);
  const ext=meshExtname(name), tmp=await fs.mkdtemp(path.join(os.tmpdir(),'cae-test-'));
  try {
    const result=await writeMeshioBytes(model,ext,{format,stem:'roundtrip'});
    const file=path.join(tmp,'roundtrip'+ext);await fs.writeFile(file,result.data);
    for(const c of result.companions) {await fs.mkdir(path.dirname(path.join(tmp,c.name)),{recursive:true});await fs.writeFile(path.join(tmp,c.name),c.data);}
    const back=await parseMeshFile(file,undefined,{meshioFormat:format});
    assert.equal(back.nodeCount,4);assert.deepEqual(back.coords,model.coords);assert.deepEqual(back.blocks[0].connectivity,model.blocks[0].connectivity);
  } finally {await fs.rm(tmp,{recursive:true,force:true});}
});
test('CAE routes retain primary formats and distinguish fixed names',()=>{
  assert.deepEqual(MESHIO_READ_CANDIDATES['.dat'],['tecplot','marc']);assert.deepEqual(MESHIO_READ_CANDIDATES['.mesh'],['medit','mfem']);
  assert.equal(meshExtname('ordinary.txt'),'.txt');assert.equal(meshExtname('z88structure.txt'),'.z88');assert.equal(meshExtname('mesh.header'),'.elmer');assert.equal(meshExtname('a.mesh.000003'),'.mfem-rank');
});
test('Elmer header and explicit MCP directory resolve the whole case',async()=>{
  const dir=path.join(fixtures,'elmer');
  assert.equal((await parseMeshFile(path.join(dir,'mesh.header'))).nodeCount,4);
  const info=await meshInfo({path:dir,inputFormat:'elmer'});assert.ok(info);
  const before=await statMeshSource(path.join(dir,'tetra.elmer'));assert.ok(before.bytes>0);assert.match(before.stamp,/mesh.nodes/);
});
test('Marc and Radioss named MCP writers do not require a UI export suffix',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'cae-mcp-'));
  try {for(const [format,ext] of [['marc','.dat'],['radioss','.rad']]) {
    const file=path.join(tmp,'out'+ext);await meshConvert({path:path.join(fixtures,'code_aster','tetra.mail'),outputPath:file,outputFormat:format});
    assert.equal((await parseMeshFile(file)).nodeCount,4);
  }} finally {await fs.rm(tmp,{recursive:true,force:true});}
});

for (const name of ['tetra.xda.gz','tetra.xda.bz2','tetra.xdr']) test(`libMesh ${name}`,async()=>{
  const model=await parseMeshFile(path.join(fixtures,'libmesh',name));assert.equal(model.nodeCount,4);assert.equal(model.blocks[0].vtkCellType,10);
});
test('Elmer binary and partitioned cases stage all required files',async()=>{
  const binary=await parseMeshFile(path.join(fixtures,'elmer-binary','mesh.header'));assert.equal(binary.nodeCount,4);
  const file=path.join(fixtures,'elmer-partitioned','parts.elmer');
  const all=await parseMeshFile(file);assert.equal(all.blocks.reduce((n,b)=>n+b.count,0),2);
  const piece=await parseMeshFile(file,undefined,{piece:0});assert.equal(piece.blocks.reduce((n,b)=>n+b.count,0),1);
});
test('MFEM rank entry loads its siblings and reports the merge',async()=>{
  const model=await parseMeshFile(path.join(fixtures,'mfem-ranks','rank.mesh.000000'));
  assert.equal(model.blocks.reduce((n,b)=>n+b.count,0),2);assert.match(model.diagnostics.map(d=>d.message).join(' '),/merged 2/);
});
for(const [format,name] of Object.entries(formats)) test(`CAE ${format}: quadratic tetra ordering`,async()=>{
  const extension=meshExtname(name);const model=await parseMeshFile(path.join(fixtures,'quadratic',format,'quadratic'+extension));
  assert.ok(model.blocks.some(b=>b.vtkCellType===24), 'tetra10 stays quadratic');
  const block=model.blocks.find(b=>b.vtkCellType===24)!;
  const lookup=new Map(Array.from(model.nodeIds,(id,i)=>[id,i]));
  const points=Array.from(block.connectivity.slice(0,10),id=>Array.from(model.coords.slice(lookup.get(id)!*3,lookup.get(id)!*3+3)));
  for(const [i,[a,b]] of [[0,1],[1,2],[2,0],[0,3],[1,3],[2,3]].entries()) assert.deepEqual(points[4+i],points[a].map((v,j)=>(v+points[b][j])/2));
});
