/** Read-only regional FEM quantities. No viewport, mutations or implicit association conversion. */
import { boundaryQuadrature } from "../flowBalance";
import { dimensionsEqual, exponentsForUnitName, fieldUnitLabel, KINEMATIC_PRESSURE, PRESSURE } from "../fieldDimensions";
import { findSubModelPart } from "../subModelPartExtract";
import { nodeIndexMap } from "../writers/writerCommon";
import type { MdpaModel, SubModelPart } from "../types";
import type { PlotColumn, PlotOrigin, PlotRegionSource } from "./types";

export interface RegionSample { values: (number|null)[]; columns: PlotColumn[]; origin: PlotOrigin; diagnostics: string[]; partial: boolean; covered: number; measure: number }
const cross = (a:number[],b:number[]) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function regionEntityIds(model: MdpaModel, spec: Pick<PlotRegionSource,"kind"|"submodelpart">): Set<number> {
  const ids = new Set<number>(), key = spec.kind === "Nodal" ? "nodeIds" : spec.kind === "Elemental" ? "elementIds" : "conditionIds";
  if (spec.submodelpart) {
    const part = findSubModelPart(model,spec.submodelpart); if (!part) throw new Error(`No SubModelPart "${spec.submodelpart}".`);
    const walk = (p:SubModelPart) => { for (const id of p[key]) ids.add(id); for (const child of p.children) walk(child); }; walk(part);
  } else if (spec.kind === "Nodal") { for (const id of model.nodeIds) ids.add(id); }
  else for (const block of model.blocks) if (block.kind === (spec.kind === "Elemental" ? "Elements" : "Conditions")) for (const id of block.entityIds) ids.add(id);
  return ids;
}

export function sampleRegion(model: MdpaModel, spec: PlotRegionSource): RegionSample {
  const field = model.fields.find(f=>f.kind===spec.kind && f.variable===spec.variable);
  if (!field) throw new Error(`No ${spec.kind} field "${spec.variable}"; associations are not converted implicitly.`);
  const rows = new Map<number,number>(); for (let i=0;i<field.ids.length;i++) rows.set(field.ids[i],i);
  const read = (id:number): number[]|undefined => { const row=rows.get(id); if(row===undefined)return; const tuple=Array.from({length:field.components},(_,i)=>field.values[row*field.components+i]); return tuple.every(Number.isFinite)?tuple:undefined; };
  const origin: PlotOrigin = {source:spec.id,...(spec.submodelpart?{submodelpart:spec.submodelpart}:{}),...(spec.runId?{runId:spec.runId}:{})};
  const diagnostics = ["Regional quantity uses source coordinates, not viewport deformation or display sampling.",`Region extraction parameters: ${JSON.stringify(spec)}`];
  let unit = model.source?.units?.fields?.[field.variable] ?? fieldUnitLabel(field);
  let dimensions = field.dimensions?.exponents.slice() ?? (unit?exponentsForUnitName(unit):undefined);
  const lengthUnit = model.source?.units?.coords, lengthDimensions = lengthUnit?exponentsForUnitName(lengthUnit):undefined;
  if(!lengthUnit&&["pressureForce","pressureMoment","reactionMoment","boundaryIntegral","flux"].includes(spec.operation))diagnostics.push("Coordinate units are unknown; integrated units cannot be verified. Coordinate scales are not inferred.");
  const column = (label:string,i:number):PlotColumn => ({id:`v${i}`,label,type:"number",...(unit?{unit}:{}),...(dimensions?{dimensions:[...dimensions]}:{})});
  const multiplyMeasure = (power:number) => {
    unit = unit && lengthUnit ? `(${unit})·(${lengthUnit})${power===1?"":power===2?"²":"³"}` : undefined;
    dimensions = dimensions && lengthDimensions ? dimensions.map((v,i)=>v+power*lengthDimensions[i]) : undefined;
  };
  const ids=regionEntityIds(model,spec);
  if (["min","max","mean","sum","reactionMoment"].includes(spec.operation)) {
    if (spec.operation === "reactionMoment" && (spec.kind!=="Nodal" || field.components<2 || field.components>3)) throw new Error("Reaction moments need supplied 2/3-component Nodal forces, not distributed tractions.");
    if(spec.operation==="reactionMoment"&&dimensions&&!dimensionsEqual(dimensions,[1,1,-2,0,0,0,0]))throw new Error("Reaction moments require supplied force dimensions, not a displacement/traction field.");
    if(spec.operation==="reactionMoment"&&!dimensions)diagnostics.push("Force units/dimensions are unknown: the caller must identify the supplied nodal values as forces, not tractions.");
    const component=spec.component??(field.components>1?"magnitude":0);
    if (typeof component === "number" && component>=field.components) throw new Error("Selected component is not present in this field.");
    let covered=0, sum=0, best:number|null=null, bestId:number|undefined;
    const vector=new Array(spec.operation==="reactionMoment"?3:field.components).fill(0) as number[], index=spec.operation==="reactionMoment"?nodeIndexMap(model):undefined;
    for(const id of ids){
      const tuple=read(id); if(!tuple)continue;
      if(spec.operation==="reactionMoment") {
        const at=index!.get(id);if(at===undefined)continue;
        const r=[0,1,2].map(d=>model.coords[3*at+d]-spec.referencePoint![d]);
        const moment=cross(r,[tuple[0],tuple[1],tuple[2]??0]);for(let d=0;d<3;d++)vector[d]+=moment[d];covered++;continue;
      }
      const value=component==="magnitude"?Math.hypot(...tuple):tuple[component]; covered++;sum+=value;
      if(best===null || (spec.operation==="min"?value<best:value>best)){best=value;bestId=id;}
      if(spec.operation==="sum")for(let d=0;d<tuple.length;d++)vector[d]+=tuple[d];
    }
    diagnostics.push(`${covered}/${ids.size} unique ${spec.kind} entities covered; subtree memberships are deduplicated. Mean is an unweighted entity mean; sums retain supplied signs.`);
    const moment=spec.operation==="reactionMoment", vectorSum=spec.operation==="sum"&&field.components>1;
    if(moment)multiplyMeasure(1);
    if(moment||vectorSum) return {values:vector.map(v=>covered&&Number.isFinite(v)?v:null),columns:vector.map((_,i)=>column(`${spec.variable} ${moment?"moment":"sum"} ${"XYZ"[i]??i}`,i)),origin,diagnostics,partial:!covered||covered<ids.size||vector.some(v=>!Number.isFinite(v)),covered,measure:ids.size};
    const value=covered?(spec.operation==="mean"?sum/covered:spec.operation==="sum"?sum:best):null;
    if (["min","max"].includes(spec.operation) && bestId!==undefined) {origin.entityKind=spec.kind==="Nodal"?"Nodes":spec.kind==="Elemental"?"Elements":"Conditions";origin.entityId=bestId;}
    return {values:[value!==null&&Number.isFinite(value)?value:null],columns:[column(`${spec.operation} ${spec.variable}${component==="magnitude"?" magnitude":field.components>1?` ${"XYZ"[component]??component}`:""}`,0)],origin,diagnostics,partial:!covered||covered<ids.size||value!==null&&!Number.isFinite(value),covered,measure:ids.size};
  }
  if(!spec.submodelpart)throw new Error("Choose a boundary SubModelPart for integration.");
  if(spec.kind!=="Nodal" && spec.kind!=="Conditional")throw new Error("Boundary integration accepts Nodal or Conditional fields; Elemental values are not silently moved to the boundary.");
  const pressure=["pressureForce","pressureMoment"].includes(spec.operation), flux=spec.operation==="flux";
  if(pressure&&dimensions&&!dimensionsEqual(dimensions,PRESSURE)&&!dimensionsEqual(dimensions,KINEMATIC_PRESSURE))throw new Error("Pressure load requires pressure dimensions, not this field's recorded physical quantity.");
  if(pressure&&!dimensions)diagnostics.push("Pressure units/dimensions are unknown: this is a symbolic pressure × measure load, not a verified force in N.");
  if(!flux&&field.components!==1)throw new Error("Pressure/mean/integral requires a scalar field.");
  if(flux&&(field.components<2||field.components>3))throw new Error("Flux requires a supplied 2/3-component vector field.");
  if(spec.pressureDensity!==undefined&&!pressure)throw new Error("Pressure density conversion applies only to pressure loads.");
  let scale=1;
  if(pressure && dimensions && dimensionsEqual(dimensions,KINEMATIC_PRESSURE)) {
    if(!spec.pressureDensity || unit!=="m²/s²")throw new Error("Kinematic pressure loads require explicit kg/m³ density and an SI m²/s² source (convert other scales explicitly).");
    scale=spec.pressureDensity;unit="Pa";dimensions=[1,-1,-2,0,0,0,0];diagnostics.push(`Kinematic pressure multiplied by supplied density ${scale} kg/m³.`);
  } else if(spec.pressureDensity!==undefined)throw new Error("Pressure density is only valid for recorded SI kinematic pressure, not an unknown or physical-pressure field.");
  const quadrature=boundaryQuadrature(model,spec.submodelpart,pressure||flux?spec.orientation??"outward":undefined);
  if(spec.thickness!==undefined && quadrature.dimension!==2)throw new Error("Thickness is only used for 2D line boundaries.");
  diagnostics.push(...quadrature.warnings);
  const thickness=spec.thickness??1, vector=[0,0,0];let total=0,covered=0;
  for(const q of quadrature.samples) {
    const tuples=spec.kind==="Conditional"?[read(q.conditionId)]:q.nodeIds.map(read);if(tuples.some(v=>!v))continue;
    const tuple=Array.from({length:field.components},(_,d)=>spec.kind==="Conditional"?tuples[0]![d]:tuples.reduce((sum,v,i)=>sum+v![d]*q.shape[i],0));
    const weight=q.weight*thickness; covered+=q.weight;
    if(pressure) {
      const p=(tuple[0]-(spec.pressureOffset??0))*scale,force=q.normal.map(n=>-p*n*weight);
      const values=spec.operation==="pressureMoment"?cross(q.position.map((v,d)=>v-spec.referencePoint![d]),force):force;
      for(let d=0;d<3;d++)vector[d]+=values[d];
    } else total+=(flux?tuple.reduce((sum,v,d)=>sum+v*q.normal[d],0):tuple[0])*weight;
  }
  const measure=quadrature.measure;
  diagnostics.push(`Covered ${covered} of ${measure} source-coordinate ${quadrature.dimension===3?"area":"length"}; missing values and unorientable facets are excluded, never zero.`,quadrature.dimension===2?(spec.thickness?`2D thickness ${spec.thickness} in coordinate units.`:"2D integral is per unit depth; no thickness inferred."):"3D surface integral.");
  if(pressure)diagnostics.push(`Pressure traction = −(p − ${spec.pressureOffset??0}) n; ${spec.orientation??"outward"} normals. Pressure reference is not inferred.`);
  if(spec.operation!=="boundaryMean")multiplyMeasure((quadrature.dimension===3||spec.thickness!==undefined?2:1)+(spec.operation==="pressureMoment"?1:0));
  const values=pressure?vector:[spec.operation==="boundaryMean"?total/(covered*thickness):total];
  return {values:values.map(v=>covered>0&&Number.isFinite(v)?v:null),columns:values.map((_,i)=>column(`${spec.variable} ${spec.operation}${pressure?` ${"XYZ"[i]}`:""}`,i)),origin,diagnostics,partial:quadrature.incomplete||!covered||values.some(v=>!Number.isFinite(v))||covered<measure-1e-10*Math.max(1,measure),covered,measure};
}
