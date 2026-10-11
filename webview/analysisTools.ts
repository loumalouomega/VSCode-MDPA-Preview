/** Controls shared by the preview providers; all computation stays in the host. */
type Post = (message: unknown) => void;
let renderAnalysisResult: (message: unknown) => void = () => {};

// The host runs these analyses in a cancellable worker (roadmap item 2): each
// request carries a sequence tag, the newest of a kind wins, and a reply that
// is stale (an older tag) or cancelled must not overwrite what is on screen.
const TOOL_KINDS = ['qualityGate','hausdorff','periodicNodes','featureEdges'] as const;
const latestSeq = new Map<string, number>();
let nextSeq = 0;
let rawPost: Post = () => {};
/** Post a `meshAnalysis` request tagged with a fresh sequence number. */
export function requestAnalysis(request: { kind: string } & Record<string, unknown>): void {
  const seq = ++nextSeq;
  latestSeq.set(request.kind, seq);
  const running = { message: 'Running…' };
  renderAnalysisResult(running);
  if (request.kind === 'qualityGate') {
    const gate = document.getElementById('quality-gate-result');
    if (gate) gate.textContent = running.message;
  }
  rawPost({ type: 'meshAnalysis', ...request, seq });
}
/** Cancel the in-flight worker run of every analysis this panel starts. */
export function cancelAnalyses(): void {
  for (const kind of TOOL_KINDS) {
    latestSeq.delete(kind);
    rawPost({ type: 'meshAnalysisCancel', kind });
  }
  renderAnalysisResult({ message: 'Cancelled.' });
}
/** True for a cancelled reply or one a newer request of its kind has superseded. */
export function isStaleAnalysisReply(reply: { kind?: string; seq?: number; cancelled?: boolean }): boolean {
  if (reply.cancelled) return true;
  // Every request is tagged, so a tagged reply with no outstanding request of
  // its kind (cancelled, or answered already) is as stale as an older tag.
  if (reply.seq === undefined || !reply.kind) return false;
  return reply.seq !== latestSeq.get(reply.kind);
}

export function initAnalysisTools(post: Post): void {
  rawPost = post;
  const host = document.getElementById('analysis-tools');
  if (!host) return;
  function text(label: string, value=''): HTMLInputElement {
    const row=document.createElement('label'); row.textContent=label+' ';
    const input=document.createElement('input'); input.value=value; row.append(input); host!.append(row,document.createElement('br')); return input;
  }
  function button(label: string, action: () => void) { const b=document.createElement('button'); b.textContent=label; b.onclick=action; host!.append(b); }
  const gate=text('Quality thresholds','scaled_jacobian >= 0.2');
  const inverted=text('Allowed inverted cells','0'), degenerate=text('Allowed degenerate cells','0');
  button('Check quality',()=>requestAnalysis({kind:'qualityGate',require:gate.value,maxInverted:Number(inverted.value),maxDegenerate:Number(degenerate.value)}));
  const other=text('Comparison mesh path'), samples=text('Hausdorff face samples','0');
  button('Compare surfaces',()=>requestAnalysis({kind:'hausdorff',path:other.value,faceSamples:Number(samples.value)}));
  const angle=text('Feature angle (degrees)','30');
  const categories = ['feature','boundary','nonManifold','inconsistent'].map(name => {const label=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.checked=true;label.append(input,name);host.append(label);return {name,input};});
  const edgeOptions=()=>({featureAngle:Number(angle.value),...Object.fromEntries(categories.map(c=>[c.name,c.input.checked]))});
  button('Preview feature edges',()=>requestAnalysis({kind:'featureEdges',...edgeOptions()}));
  button('Export feature edges',()=>post({type:'menuExportDerived',derive:{kind:'featureEdges',...edgeOptions()}}));
  const slave=text('Slave SubModelPart'), master=text('Master SubModelPart');
  const transform=text('Transform JSON','{"translate":[1,0,0]}'), tolerance=text('Tolerance','1e-8');
  const complete=document.createElement('input');complete.type='checkbox';complete.checked=true;const completeLabel=document.createElement('label');completeLabel.append(complete,'Require complete pairing');host.append(completeLabel);
  button('Match periodic nodes',()=>{ try {requestAnalysis({kind:'periodicNodes',...JSON.parse(transform.value),slave:slave.value,master:master.value,atol:Number(tolerance.value),requireComplete:complete.checked});} catch(e) { showAnalysisResult({message:String(e)}); } });
  const inputs=text('SubModelParts (comma-separated)'), output=text('New SubModelPart');
  for(const operation of ['union','intersection','difference']) button(operation,()=>post({type:'applyOp',op:'regionAlgebra',operation,inputs:inputs.value.split(',').map(s=>s.trim()),output:output.value}));
  button('Cancel running analysis',()=>cancelAnalyses());
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
