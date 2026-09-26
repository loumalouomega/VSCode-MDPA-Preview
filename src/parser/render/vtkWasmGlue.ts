// Deterministic rewrite of the VTK-wasm Emscripten glue (roadmap item 18,
// Phase 1) so the webview can run it under a CSP WITHOUT 'unsafe-eval'.
//
// The published glue builds every Embind trampoline with `new Function(...)`
// in exactly two factories — `createJsInvoker` (C++ methods called from JS)
// and `__emval_create_invoker` (JS called from C++ through emscripten::val).
// Both generated bodies are mechanical: wire each argument, call the C++
// invoker, run destructors, convert the return value. They are replaced here
// with closures that do the same work in the same order, which is what
// Emscripten's own -sDYNAMIC_EXECUTION=0 path amounts to. Nothing else in the
// glue is touched.
//
// Pure (no fs / DOM / vscode): the build script (scripts/vtk-wasm/patch-glue.mjs)
// reads and writes the files; src/test/vtkWasmGlue.test.ts runs a differential
// test of each replacement against the ORIGINAL generated code, which Node is
// free to evaluate with `new Function`.
//
// Matching is by EXACT text (vtkWasmGlueNeedles.ts, generated from the pinned
// glue). A re-pin whose glue differs anywhere inside these functions fails
// here, loudly, instead of being patched on a guess.
//
// Known, unreachable deviation: the original emval factory with kind 3 and
// ZERO arguments generates an empty parenthesised expression `()`, which is a
// SyntaxError when the invoker is created; the replacement returns undefined
// instead. Kind 3 always carries at least one argument upstream.

import {
  NEEDLE_CREATE_JS_INVOKER_ASYNC,
  NEEDLE_CREATE_JS_INVOKER_SYNC,
  NEEDLE_EMVAL_CREATE_INVOKER,
  NEEDLE_EXPORTS_ANCHOR,
} from "./vtkWasmGlueNeedles";

/** Marker embedded in every replacement; its presence means "already patched". */
export const GLUE_PATCH_MARKER = "vtkWasmGlue.ts:";

export class GluePatchError extends Error {
  constructor(
    readonly patchId: string,
    readonly occurrences: number,
    message: string
  ) {
    super(message);
    this.name = "GluePatchError";
  }
}

// Shared body of the createJsInvoker replacement up to the C++ call. `this` is
// the embind handle for class methods; the invoker is called with an
// undefined receiver exactly as the generated code's bare `invoker(...)`.
const INVOKER_PROLOGUE =
  "function createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync){" +
  "/* " + GLUE_PATCH_MARKER + " closure replacement for Emscripten's new Function invoker factory (no dynamic code, so no 'unsafe-eval'). */" +
  "var needsDestructorStack=usesDestructorStack(argTypes);var argCount=argTypes.length-2;var dtorSlots=[];" +
  "if(!needsDestructorStack){for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){dtorSlots.push(i===1?-1:i-2)}}}" +
  "return function(humanName,throwBindingError,invoker,fn,runDestructors,fromRetWire,toClassParamWire){" +
  "var toArgWire=[];for(var a=0;a<argCount;++a){toArgWire.push(arguments[7+a])}" +
  "var dtorFns=[];for(var d=0;d<dtorSlots.length;++d){dtorFns.push(arguments[7+argCount+d])}" +
  "var invokerFn=function(){var destructors=needsDestructorStack?[]:null;var callArgs=[fn];var thisWired;" +
  "if(isClassMethodFunc){thisWired=toClassParamWire(destructors,this);callArgs.push(thisWired)}" +
  "var wired=[];for(var k=0;k<argCount;++k){var w=toArgWire[k](destructors,arguments[k]);wired.push(w);callArgs.push(w)}" +
  "var rv=invoker.apply(undefined,callArgs);";

// Destructors then the return conversion — the generated code's tail.
const INVOKER_DONE =
  "if(needsDestructorStack){runDestructors(destructors)}else{for(var m=0;m<dtorSlots.length;++m){var s=dtorSlots[m];dtorFns[m](s===-1?thisWired:wired[s])}}" +
  "if(returns){var ret=fromRetWire(rv);return ret}";

const INVOKER_EPILOGUE =
  "};Object.defineProperty(invokerFn,\"length\",{value:argCount});return invokerFn}}";

/** Replacement for the SYNC build's createJsInvoker (no onDone/isAsync tail). */
export const REPLACEMENT_CREATE_JS_INVOKER_SYNC = INVOKER_PROLOGUE + INVOKER_DONE + INVOKER_EPILOGUE;

/** Replacement for the JSPI/unified build's createJsInvoker (onDone + rv.then). */
export const REPLACEMENT_CREATE_JS_INVOKER_ASYNC =
  INVOKER_PROLOGUE +
  "var onDone=function(rv){" + INVOKER_DONE + "};" +
  "return isAsync?rv.then(onDone):onDone(rv);" +
  INVOKER_EPILOGUE;

/**
 * Replacement for `__emval_create_invoker`. Evaluation order matches the
 * generated source: the callee (and, for a method, the property lookup) is
 * resolved BEFORE the arguments are read, as `a[b](c)` does in JavaScript.
 */
export const REPLACEMENT_EMVAL_CREATE_INVOKER =
  "var __emval_create_invoker=function(argCount,argTypesPtr,kind){" +
  "/* " + GLUE_PATCH_MARKER + " closure replacement for the new Function emval method caller. */" +
  "argTypesPtr>>>=0;var GenericWireTypeSize=8;var[retType,...argTypes]=emval_lookupTypes(argCount,argTypesPtr);" +
  "var toReturnWire=retType.toWireType.bind(retType);var argFromPtr=argTypes.map(type=>type.readValueFromPointer.bind(type));argCount--;" +
  "var toValue=Emval.toValue;var nArgs=argFromPtr.length;var isVoid=retType.isVoid;" +
  "var readArgs=function(args){var out=[];for(var i=0;i<nArgs;++i){out.push(argFromPtr[i](i?args+i*GenericWireTypeSize:args))}return out};" +
  "var invokerFunction=function(handle,methodName,destructorsRef,args){var rv;" +
  "if(kind===0){var callee=toValue(handle);rv=callee.apply(undefined,readArgs(args))}" +
  "else if(kind===1){var obj=toValue(handle);var meth=obj[getStringOrSymbol(methodName)];rv=meth.apply(obj,readArgs(args))}" +
  "else if(kind===2){var ctor=toValue(handle);rv=Reflect.construct(ctor,readArgs(args))}" +
  "else if(kind===3){var all=readArgs(args);rv=all.length?all[all.length-1]:undefined}" +
  "else{throw new TypeError(\"emval invoker: unsupported kind \"+kind)}" +
  "if(!isVoid){return emval_returnValue(toReturnWire,destructorsRef,rv)}};" +
  "var functionName=\"methodCaller<(\"+argTypes.map(t=>t.name)+\") => \"+retType.name+\">\";" +
  "return emval_addMethodCaller(createNamedFunction(functionName,invokerFunction))}";

/**
 * Live accessors for the heap and allocator, inserted after the export
 * anchor in builds that do not export them (the stable 9.7.0 SYNC build
 * exports neither HEAPU8 nor _malloc/_free). Getters rather than snapshots:
 * HEAPU8 is REASSIGNED on every memory growth, and _malloc/_free are only
 * bound once the wasm is instantiated, after this line runs.
 */
export const REPLACEMENT_EXPORT_HEAP =
  NEEDLE_EXPORTS_ANCHOR +
  "/* " + GLUE_PATCH_MARKER + " heap/allocator accessors for bulk array upload. */" +
  "Object.defineProperties(Module,{" +
  "HEAPU8:{get:function(){return HEAPU8},configurable:true}," +
  "_malloc:{get:function(){return _malloc},configurable:true}," +
  "_free:{get:function(){return _free},configurable:true}});";

export type GlueVariant = "sync" | "async";

export interface GluePatchResult {
  output: string;
  variant: GlueVariant;
  /** Stable ids of the patches applied, in order. */
  applied: string[];
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function replaceOnce(src: string, needle: string, replacement: string): string {
  const i = src.indexOf(needle);
  return src.slice(0, i) + replacement + src.slice(i + needle.length);
}

/**
 * Apply every patch the glue needs. Throws `GluePatchError` if a needle is
 * missing or ambiguous, if the source is already patched, or if any dynamic
 * code survives the rewrite.
 */
export function patchGlue(src: string): GluePatchResult {
  if (src.includes(GLUE_PATCH_MARKER)) {
    throw new GluePatchError("already-patched", 1, "glue is already patched (marker present)");
  }
  const applied: string[] = [];
  let out = src;

  const nSync = occurrences(out, NEEDLE_CREATE_JS_INVOKER_SYNC);
  const nAsync = occurrences(out, NEEDLE_CREATE_JS_INVOKER_ASYNC);
  let variant: GlueVariant;
  if (nSync === 1 && nAsync === 0) {
    variant = "sync";
    out = replaceOnce(out, NEEDLE_CREATE_JS_INVOKER_SYNC, REPLACEMENT_CREATE_JS_INVOKER_SYNC);
  } else if (nAsync === 1 && nSync === 0) {
    variant = "async";
    out = replaceOnce(out, NEEDLE_CREATE_JS_INVOKER_ASYNC, REPLACEMENT_CREATE_JS_INVOKER_ASYNC);
  } else {
    const hasFn = out.includes("function createJsInvoker(");
    throw new GluePatchError(
      "embind-createJsInvoker",
      nSync + nAsync,
      hasFn
        ? `createJsInvoker is present but matches no pinned text (sync ${nSync}, async ${nAsync}) — the glue changed; regenerate the needles and re-review`
        : "createJsInvoker not found in the glue"
    );
  }
  applied.push(`embind-createJsInvoker-${variant}@1`);

  const nEmval = occurrences(out, NEEDLE_EMVAL_CREATE_INVOKER);
  if (nEmval !== 1) {
    throw new GluePatchError("emval-create-invoker", nEmval, `__emval_create_invoker: ${nEmval} exact matches, expected 1`);
  }
  out = replaceOnce(out, NEEDLE_EMVAL_CREATE_INVOKER, REPLACEMENT_EMVAL_CREATE_INVOKER);
  applied.push("emval-create-invoker@1");

  if (!out.includes('Module["HEAPU8"]=')) {
    const nAnchor = occurrences(out, NEEDLE_EXPORTS_ANCHOR);
    if (nAnchor !== 1) {
      throw new GluePatchError("export-heap", nAnchor, `export anchor: ${nAnchor} matches, expected 1`);
    }
    out = replaceOnce(out, NEEDLE_EXPORTS_ANCHOR, REPLACEMENT_EXPORT_HEAP);
    applied.push("export-heap@1");
  }

  const leftovers = scanDynamicCode(out);
  if (leftovers.length) {
    throw new GluePatchError(
      "dynamic-code",
      leftovers.length,
      `dynamic code survives the rewrite: ${leftovers.map((l) => `${l.kind}@${l.index}`).join(", ")}`
    );
  }
  return { output: out, variant, applied };
}

export interface DynamicCodeSite {
  kind: "Function" | "eval" | "string-timer";
  index: number;
  excerpt: string;
}

// `(?<![\w$.])` keeps `x.eval(`, `myFunction(` and `obj.Function(` out; the
// timer pattern only fires on a STRING first argument (the eval-like form).
const DYNAMIC_CODE_PATTERNS: Array<[DynamicCodeSite["kind"], RegExp]> = [
  ["Function", /(?<![\w$.])(?:new\s+)?Function\s*\(/g],
  ["eval", /(?<![\w$.])eval\s*\(/g],
  ["string-timer", /(?<![\w$.])set(?:Timeout|Interval)\s*\(\s*["'`]/g],
];

/** Every site that needs `'unsafe-eval'` under CSP (empty = none). */
export function scanDynamicCode(src: string): DynamicCodeSite[] {
  const sites: DynamicCodeSite[] = [];
  for (const [kind, re] of DYNAMIC_CODE_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      sites.push({ kind, index: m.index, excerpt: src.slice(Math.max(0, m.index - 40), m.index + 60) });
    }
  }
  return sites.sort((a, b) => a.index - b.index);
}
