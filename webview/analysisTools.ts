/** Controls shared by the preview providers; all computation stays in the host. */
type Post = (message: unknown) => void;
let renderAnalysisResult: (message: unknown) => void = () => {};
export function initAnalysisTools(post: Post): void {
  const host = document.getElementById('analysis-tools');
  if (!host) return;
  function text(label: string, value=''): HTMLInputElement {
    const row=document.createElement('label'); row.textContent=label+' ';
    const input=document.createElement('input'); input.value=value; row.append(input); host!.append(row,document.createElement('br')); return input;
  }
  function button(label: string, action: () => void) { const b=document.createElement('button'); b.textContent=label; b.onclick=action; host!.append(b); }
  const gate=text('Quality thresholds','scaled_jacobian >= 0.2');
  const inverted=text('Allowed inverted cells','0'), degenerate=text('Allowed degenerate cells','0');
  button('Check quality',()=>post({type:'meshAnalysis',kind:'qualityGate',require:gate.value,maxInverted:Number(inverted.value),maxDegenerate:Number(degenerate.value)}));
  const other=text('Comparison mesh path'), samples=text('Hausdorff face samples','0');
  button('Compare surfaces',()=>post({type:'meshAnalysis',kind:'hausdorff',path:other.value,faceSamples:Number(samples.value)}));
  const angle=text('Feature angle (degrees)','30');
  const categories = ['feature','boundary','nonManifold','inconsistent'].map(name => {const label=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.checked=true;label.append(input,name);host.append(label);return {name,input};});
  const edgeOptions=()=>({featureAngle:Number(angle.value),...Object.fromEntries(categories.map(c=>[c.name,c.input.checked]))});
  button('Preview feature edges',()=>post({type:'meshAnalysis',kind:'featureEdges',...edgeOptions()}));
  button('Export feature edges',()=>post({type:'menuExportDerived',derive:{kind:'featureEdges',...edgeOptions()}}));
  const slave=text('Slave SubModelPart'), master=text('Master SubModelPart');
  const transform=text('Transform JSON','{"translate":[1,0,0]}'), tolerance=text('Tolerance','1e-8');
  const complete=document.createElement('input');complete.type='checkbox';complete.checked=true;const completeLabel=document.createElement('label');completeLabel.append(complete,'Require complete pairing');host.append(completeLabel);
  button('Match periodic nodes',()=>{ try {post({type:'meshAnalysis',kind:'periodicNodes',...JSON.parse(transform.value),slave:slave.value,master:master.value,atol:Number(tolerance.value),requireComplete:complete.checked});} catch(e) { showAnalysisResult({message:String(e)}); } });
  const inputs=text('SubModelParts (comma-separated)'), output=text('New SubModelPart');
  for(const operation of ['union','intersection','difference']) button(operation,()=>post({type:'applyOp',op:'regionAlgebra',operation,inputs:inputs.value.split(',').map(s=>s.trim()),output:output.value}));
  const report=document.createElement('pre');report.id='analysis-tools-report';report.style.whiteSpace='pre-wrap';host.append(report);
  let latest: unknown;
  button('Export last report',()=>post({type:'menuExportAnalysis',csv:reportCsv(latest),suffix:'mesh-analysis'}));
  const periodicExport=document.createElement('button');periodicExport.textContent='Export periodic pairs CSV';periodicExport.hidden=true;
  periodicExport.onclick=()=>post({type:'menuExportAnalysis',csv:periodicCsv(latest),suffix:'periodic-pairs'});
  host.append(periodicExport);
  function acceptResult(message: unknown): void {
    latest=message;
    report.textContent=JSON.stringify(message,null,2);
    periodicExport.hidden=!(message && typeof message==='object' && (message as {kind?:string}).kind==='periodicNodes');
  }
  // The host and the local validation catch both use this same presentation path.
  renderAnalysisResult=acceptResult;
}
export function showAnalysisResult(message: unknown): void {
  renderAnalysisResult(message);
}

function csvCell(value: unknown): string {
  const text=typeof value==='string'?value:JSON.stringify(value);
  return `"${(text??'').replace(/"/g,'""')}"`;
}
function reportCsv(value: unknown): string {
  const rows:[string,unknown][]=[];
  const visit=(prefix:string,item:unknown):void=>{
    if(item&&typeof item==='object'&&!Array.isArray(item)) for(const [key,v] of Object.entries(item)) visit(prefix?`${prefix}.${key}`:key,v);
    else rows.push([prefix,item]);
  };
  visit('report',value);
  return [['field','value'],...rows].map(row=>row.map(csvCell).join(',')).join('\n');
}
function periodicCsv(value: unknown): string {
  const report=value&&typeof value==='object'?value as {pairs?:{slave:number;master:number}[];unmatched?:number[];maxResidual?:number}:{};
  const rows:unknown[][]=[['kind','slave_id','master_id','max_residual']];
  for(const pair of report.pairs??[]) rows.push(['pair',pair.slave,pair.master,'']);
  for(const id of report.unmatched??[]) rows.push(['unmatched',id,'','']);
  rows.push(['summary','','',report.maxResidual??'']);
  return rows.map(row=>row.map(csvCell).join(',')).join('\n');
}
