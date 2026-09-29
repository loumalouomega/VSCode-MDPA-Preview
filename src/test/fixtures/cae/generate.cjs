const fs=require('fs'),path=require('path');
const {parseMdpa}=require(process.cwd()+'/out/parser/mdpaParser.js');
const {writeMeshioBytes}=require(process.cwd()+'/out/parser/meshio.js');
const model=parseMdpa(`Begin Nodes
10 0 0 0
20 1 0 0
30 0 1 0
40 0 0 1
End Nodes
Begin Elements Element3D4N
5 1 10 20 30 40
End Elements
Begin SubModelPart body
Begin SubModelPartNodes
10
20
30
40
End SubModelPartNodes
Begin SubModelPartElements
5
End SubModelPartElements
End SubModelPart
`);
(async()=>{for(const [fmt,ext] of Object.entries({code_aster:'.mail',elmer:'.elmer',febio:'.feb',femap:'.neu',libmesh:'.xda',marc:'.dat',mfem:'.mesh',mphbin:'.mphbin',patran:'.pat',radioss:'.rad',z88:'.z88'})) {try {
const dir=path.join(process.cwd(),'src/test/fixtures/cae',fmt);fs.mkdirSync(dir,{recursive:true});
const r=await writeMeshioBytes(model,ext,{format:fmt,stem:'tetra'});fs.writeFileSync(path.join(dir,fmt==='z88'?'z88i1.txt':'tetra'+ext),r.data);
for(const c of r.companions){fs.mkdirSync(path.dirname(path.join(dir,c.name)),{recursive:true});fs.writeFileSync(path.join(dir,c.name),c.data);}console.log(fmt,r.data.length,r.companions.length);
} catch(e){console.log(fmt,String(e));}}})();
