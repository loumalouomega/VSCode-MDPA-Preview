export function resampleControls(post: (message: unknown) => void): HTMLElement {
  const details=document.createElement('details');details.style.position='relative';
  const summary=document.createElement('summary');summary.textContent='Resample';details.append(summary);
  const panel=document.createElement('div');panel.style.cssText='position:absolute;bottom:24px;left:0;background:var(--vscode-editor-background);padding:12px;width:320px;z-index:50';details.append(panel);
  const input=(label:string,value:string)=>{const l=document.createElement('label');l.textContent=label;const i=document.createElement('input');i.value=value;l.append(i);panel.append(l,document.createElement('br'));return i;};
  const times=input('Target times or start:stop:step','0:1:0.1');
  const source=input('Source times (optional comma-separated)','');
  const continuous=input('Continuous unknown fields (kind:variable)','');
  const select=(label:string,choices:string[])=>{const l=document.createElement('label');l.textContent=label;const s=document.createElement('select');for(const value of choices){const o=document.createElement('option');o.value=value;o.textContent=value;s.append(o);}l.append(s);panel.append(l);return s;};
  const method=select('Method',['linear','nearest','previous']),extrapolate=select('Outside range',['error','clamp']);
  const check=(label:string)=>{const l=document.createElement('label');const c=document.createElement('input');c.type='checkbox';l.append(c,label);panel.append(l,document.createElement('br'));return c;};
  const labels=check('Use numeric step labels as times'),blend=check('Blend coordinates');
  const status=document.createElement('div');panel.append(status);
  const config=()=>{
    const split=times.value.split(':').map(Number);
    const targets=split.length===3?{range:{start:split[0],stop:split[1],step:split[2]}}:{times:times.value.split(',').map(Number)};
    return {...targets,sourceTimes:source.value.trim()?source.value.split(',').map(Number):undefined,useStepLabels:labels.checked,method:method.value,extrapolate:extrapolate.value,blendPoints:blend.checked,continuousFields:continuous.value.split(',').map(s=>s.trim()).filter(Boolean)};
  };
  for(const [label,type] of [['Apply','resampleConfigure'],['Export PVD…','resampleExport'],['Original times','resampleOriginal']]) {
    const b=document.createElement('button');b.textContent=label;b.onclick=()=>{post({type,options:config()});status.textContent=label==='Original times'?'Original timeline requested.':'Request sent.';};panel.append(b);
  }
  return details;
}
