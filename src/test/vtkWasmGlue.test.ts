import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GLUE_PATCH_MARKER,
  GluePatchError,
  REPLACEMENT_CREATE_JS_INVOKER_ASYNC,
  REPLACEMENT_CREATE_JS_INVOKER_SYNC,
  REPLACEMENT_EMVAL_CREATE_INVOKER,
  REPLACEMENT_EXPORT_HEAP,
  patchGlue,
  scanDynamicCode,
} from "../parser/render/vtkWasmGlue";
import {
  NEEDLE_CREATE_JS_INVOKER_ASYNC,
  NEEDLE_CREATE_JS_INVOKER_SYNC,
  NEEDLE_EMVAL_CREATE_INVOKER,
  NEEDLE_EXPORTS_ANCHOR,
} from "../parser/render/vtkWasmGlueNeedles";

// The differential test evaluates the ORIGINAL upstream factory text (which
// builds invokers with `new Function`, perfectly legal in Node) side by side
// with the replacement, drives both through the same mock wire types, and
// requires identical traces, results, errors, arity and names.

// Verbatim from the pinned glue: the helper both factories call.
const USES_DESTRUCTOR_STACK =
  "function usesDestructorStack(argTypes){for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){return true}}return false}";

type Factory = (argTypes: unknown[], isClassMethodFunc: boolean, returns: boolean, isAsync?: boolean) => (...closureArgs: unknown[]) => Function;

function loadFactory(source: string): Factory {
  // eslint-disable-next-line no-new-func
  return new Function(`${USES_DESTRUCTOR_STACK}\n${source}\nreturn createJsInvoker;`)() as Factory;
}

interface Scenario {
  arity: number;
  classMethod: boolean;
  returns: boolean;
  isAsync: boolean;
  /** "stack": some arg has destructorFunction undefined. Otherwise a per-slot null/non-null pattern. */
  dtorMode: "stack" | number;
  throwAt?: "toArg" | "invoker" | "dtor" | "fromRet" | "this";
}

/** Runs one invoker built by `factory` and returns a full observable transcript. */
async function transcript(factory: Factory, s: Scenario): Promise<unknown> {
  const trace: string[] = [];
  // argTypes[0] = return type, [1] = this (or null), [2..] = parameters.
  const mkType = (label: string, slot: number) => {
    let destructorFunction: unknown;
    if (s.dtorMode === "stack") destructorFunction = slot === 2 ? undefined : null;
    else destructorFunction = (s.dtorMode >> slot) & 1 ? (p: unknown) => trace.push(`dtor ${label}(${String(p)})`) : null;
    return {
      label,
      destructorFunction,
      toWireType: (stack: unknown[] | null, v: unknown) => {
        trace.push(`wire ${label} stack=${stack === null ? "null" : Array.isArray(stack) ? "array" : typeof stack} v=${String(v)}`);
        if (s.throwAt === "toArg" && label === `a${Math.min(1, s.arity - 1)}`) throw new Error(`boom-${label}`);
        if (s.throwAt === "this" && label === "this") throw new Error("boom-this");
        if (Array.isArray(stack)) stack.push((p: unknown) => trace.push(`stackdtor ${label}(${String(p)})`), `W${label}`);
        return `W${label}:${String(v)}`;
      },
    };
  };
  const retType = {
    isVoid: !s.returns,
    destructorFunction: null,
    fromWireType: (rv: unknown) => {
      trace.push(`fromRet ${String(rv)}`);
      if (s.throwAt === "fromRet") throw new Error("boom-fromRet");
      return `R(${String(rv)})`;
    },
  };
  const argTypes: unknown[] = [retType, s.classMethod ? mkType("this", 1) : null];
  for (let i = 0; i < s.arity; i++) argTypes.push(mkType(`a${i}`, i + 2));
  if (s.dtorMode === "stack" && s.arity === 0 && !s.classMethod) {
    // No parameter to carry the undefined destructor: stack mode needs one.
    return "skip";
  }

  const isClassMethodFunc = argTypes[1] !== null;
  const closureArgs: unknown[] = [
    "humanName",
    () => trace.push("throwBindingError"),
    function (this: unknown, ...a: unknown[]) {
      // The receiver is recorded too: the generated code calls the C++
      // invoker bare (`invoker(...)`), never as a method.
      trace.push(`invoker this=${this === undefined ? "undefined" : typeof this}(${a.map(String).join(",")})`);
      if (s.throwAt === "invoker") throw new Error("boom-invoker");
      return s.isAsync ? Promise.resolve("RV") : "RV";
    },
    "FN",
    (d: unknown[]) => {
      trace.push(`runDestructors(${d.length})`);
      while (d.length) {
        const ptr = d.pop();
        const del = d.pop() as (p: unknown) => void;
        del(ptr);
      }
    },
    (retType.fromWireType as Function).bind(retType),
    isClassMethodFunc ? (argTypes[1] as { toWireType: Function }).toWireType : undefined,
  ];
  for (let i = 2; i < argTypes.length; i++) closureArgs.push((argTypes[i] as { toWireType: Function }).toWireType);
  const needsStack = s.dtorMode === "stack";
  if (!needsStack) {
    for (let i = isClassMethodFunc ? 1 : 2; i < argTypes.length; i++) {
      const df = (argTypes[i] as { destructorFunction: unknown }).destructorFunction;
      if (df !== null) {
        closureArgs.push((p: unknown) => {
          if (s.throwAt === "dtor") throw new Error("boom-dtor");
          (df as Function)(p);
        });
      }
    }
  }

  const invoker = factory(argTypes, isClassMethodFunc, s.returns, s.isAsync)(...closureArgs);
  const self = { tag: "SELF" };
  // One extra argument beyond the declared arity: it must be ignored by both.
  const callArgs = Array.from({ length: s.arity + 1 }, (_, i) => `x${i}`);
  let result: unknown;
  let error: string | undefined;
  try {
    result = await Promise.resolve(invoker.apply(self, callArgs));
  } catch (e) {
    error = (e as Error).message;
  }
  // Missing arguments: undefined reaches the wire function, identically.
  let shortResult: unknown;
  let shortError: string | undefined;
  if (!s.throwAt && s.arity > 0) {
    try {
      shortResult = await Promise.resolve(invoker.apply(self, []));
    } catch (e) {
      shortError = (e as Error).message;
    }
  }
  return { trace, result, error, shortResult, shortError, length: invoker.length };
}

function* scenarios(allowAsync: boolean): Generator<Scenario> {
  const throws: Array<Scenario["throwAt"]> = [undefined, "toArg", "invoker", "dtor", "fromRet", "this"];
  for (let arity = 0; arity <= 6; arity++)
    for (const classMethod of [false, true])
      for (const returns of [false, true])
        for (const isAsync of allowAsync ? [false, true] : [false])
          for (const dtorMode of ["stack", 0, 0b0110, 0b1111111] as Array<Scenario["dtorMode"]>)
            for (const throwAt of throws) yield { arity, classMethod, returns, isAsync, dtorMode, throwAt };
}

test("createJsInvoker (sync build): replacement matches the generated invoker across the full matrix", async () => {
  const original = loadFactory(NEEDLE_CREATE_JS_INVOKER_SYNC);
  const replacement = loadFactory(REPLACEMENT_CREATE_JS_INVOKER_SYNC);
  let compared = 0;
  for (const s of scenarios(false)) {
    const a = await transcript(original, s);
    const b = await transcript(replacement, s);
    assert.deepEqual(b, a, JSON.stringify(s));
    compared++;
  }
  assert.ok(compared > 500, `compared ${compared} scenarios`);
});

test("createJsInvoker (async/unified build): replacement matches, including isAsync promise chaining", async () => {
  const original = loadFactory(NEEDLE_CREATE_JS_INVOKER_ASYNC);
  const replacement = loadFactory(REPLACEMENT_CREATE_JS_INVOKER_ASYNC);
  let compared = 0;
  for (const s of scenarios(true)) {
    const a = await transcript(original, s);
    const b = await transcript(replacement, s);
    assert.deepEqual(b, a, JSON.stringify(s));
    compared++;
  }
  assert.ok(compared > 1000, `compared ${compared} scenarios`);
});

// --- emval method caller -------------------------------------------------------

interface EmvalRun {
  trace: string[];
  result?: unknown;
  error?: string;
  length?: number;
  name?: string;
  createError?: string;
}

function emvalRun(source: string, kind: number, arity: number, isVoid: boolean): EmvalRun {
  const trace: string[] = [];
  const retType = {
    name: isVoid ? "void" : "val",
    isVoid,
    toWireType: (d: unknown[], v: unknown) => {
      trace.push(`toReturnWire(${String(v)})`);
      return `RW(${String(v)})`;
    },
  };
  const argTypes = Array.from({ length: arity }, (_, i) => ({
    name: `T${i}`,
    readValueFromPointer: (ptr: number) => {
      trace.push(`read${i}@${ptr}`);
      return `v${i}`;
    },
  }));
  const target = function (this: unknown, ...a: unknown[]) {
    trace.push(`call this=${this === undefined ? "undefined" : (this as { tag?: string })?.tag ?? typeof this} args=${a.join(",")}`);
    return "CALLED";
  };
  class Ctor {
    constructor(...a: unknown[]) {
      trace.push(`new args=${a.join(",")}`);
    }
  }
  const receiver = new Proxy(
    { tag: "OBJ", meth: target },
    {
      get(o, p, r) {
        trace.push(`get ${String(p)}`);
        return Reflect.get(o, p, r);
      },
    }
  );
  const handles: Record<number, unknown> = { 1: target, 2: receiver, 3: Ctor };
  const scope = {
    emval_lookupTypes: (argCount: number, ptr: number) => {
      trace.push(`lookup(${argCount},${ptr})`);
      return [retType, ...argTypes];
    },
    Emval: {
      toValue: (h: number) => {
        trace.push(`toValue(${h})`);
        return handles[h];
      },
    },
    getStringOrSymbol: (addr: number) => {
      trace.push(`name(${addr})`);
      return "meth";
    },
    emval_returnValue: (tw: Function, ref: number, v: unknown) => {
      trace.push(`emval_returnValue(${ref})`);
      return tw([], v);
    },
    createNamedFunction: (name: string, f: Function) => Object.defineProperty(f, "name", { value: name }),
    emval_addMethodCaller: (c: Function) => c,
  };
  let caller: Function;
  try {
    // eslint-disable-next-line no-new-func
    caller = new Function(...Object.keys(scope), `${source}\nreturn __emval_create_invoker;`)(...Object.values(scope))(
      arity + 1,
      64,
      kind
    );
  } catch (e) {
    return { trace, createError: (e as Error).constructor.name };
  }
  const handle = kind === 1 ? 2 : kind === 2 ? 3 : 1;
  const out: EmvalRun = { trace, length: caller.length, name: caller.name };
  try {
    const r = caller(handle, 5, 900, 1000);
    out.result = r instanceof Ctor ? "instance" : r;
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

test("__emval_create_invoker: replacement matches every kind, arity and return shape", () => {
  let compared = 0;
  for (const kind of [0, 1, 2, 3])
    for (let arity = 0; arity <= 4; arity++)
      for (const isVoid of [false, true]) {
        const a = emvalRun(NEEDLE_EMVAL_CREATE_INVOKER, kind, arity, isVoid);
        const b = emvalRun(REPLACEMENT_EMVAL_CREATE_INVOKER, kind, arity, isVoid);
        if (kind === 3 && arity === 0) {
          // The one documented deviation: upstream generates `()` and fails
          // to parse; the replacement yields undefined. Unreachable upstream.
          assert.equal(a.createError, "SyntaxError");
          assert.equal(b.createError, undefined);
          continue;
        }
        assert.deepEqual(b, a, JSON.stringify({ kind, arity, isVoid }));
        compared++;
      }
  assert.equal(compared, 38);
});

// --- patch mechanics -------------------------------------------------------------

const SYNTH_SYNC = `var a=1;${NEEDLE_CREATE_JS_INVOKER_SYNC}var b=2;${NEEDLE_EMVAL_CREATE_INVOKER}${NEEDLE_EXPORTS_ANCHOR}var c=3;`;
const SYNTH_ASYNC = `var a=1;${NEEDLE_CREATE_JS_INVOKER_ASYNC}${NEEDLE_EMVAL_CREATE_INVOKER}Module["HEAPU8"]=HEAPU8=x;${NEEDLE_EXPORTS_ANCHOR}`;

test("patchGlue picks the variant, applies every patch once and is deterministic", () => {
  const r1 = patchGlue(SYNTH_SYNC);
  const r2 = patchGlue(SYNTH_SYNC);
  assert.equal(r1.output, r2.output);
  assert.equal(r1.variant, "sync");
  assert.deepEqual(r1.applied, ["embind-createJsInvoker-sync@1", "emval-create-invoker@1", "export-heap@1"]);
  assert.ok(r1.output.includes(REPLACEMENT_CREATE_JS_INVOKER_SYNC));
  assert.ok(r1.output.includes(REPLACEMENT_EXPORT_HEAP));
  assert.ok(r1.output.startsWith("var a=1;") && r1.output.endsWith("var c=3;"));

  const r3 = patchGlue(SYNTH_ASYNC);
  assert.equal(r3.variant, "async");
  // A build that already exports HEAPU8 gets no heap patch.
  assert.deepEqual(r3.applied, ["embind-createJsInvoker-async@1", "emval-create-invoker@1"]);
});

test("patchGlue refuses a missing, drifted, duplicated or already-patched input", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof GluePatchError);
      return (e as GluePatchError).patchId;
    }
    assert.fail("expected GluePatchError");
  };
  assert.equal(code(() => patchGlue("var nothing=1;")), "embind-createJsInvoker");
  // One character of drift inside the function is enough to refuse.
  const drifted = SYNTH_SYNC.replace("var argCount=argTypes.length-2;", "var argCount=argTypes.length - 2;");
  assert.equal(code(() => patchGlue(drifted)), "embind-createJsInvoker");
  assert.equal(code(() => patchGlue(SYNTH_SYNC + NEEDLE_EMVAL_CREATE_INVOKER)), "emval-create-invoker");
  assert.equal(code(() => patchGlue(SYNTH_SYNC.replace(NEEDLE_EXPORTS_ANCHOR, ""))), "export-heap");
  assert.equal(code(() => patchGlue(patchGlue(SYNTH_SYNC).output)), "already-patched");
  assert.equal(code(() => patchGlue(SYNTH_SYNC + "var z=eval('1');")), "dynamic-code");
});

test("scanDynamicCode: two sites in the upstream needles, none in any replacement", () => {
  assert.equal(scanDynamicCode(NEEDLE_CREATE_JS_INVOKER_SYNC + NEEDLE_EMVAL_CREATE_INVOKER).length, 2);
  assert.equal(scanDynamicCode(NEEDLE_CREATE_JS_INVOKER_ASYNC).length, 1);
  for (const r of [REPLACEMENT_CREATE_JS_INVOKER_SYNC, REPLACEMENT_CREATE_JS_INVOKER_ASYNC, REPLACEMENT_EMVAL_CREATE_INVOKER, REPLACEMENT_EXPORT_HEAP]) {
    assert.deepEqual(scanDynamicCode(r), []);
    assert.ok(r.includes(GLUE_PATCH_MARKER));
  }
  // Member calls and identifiers merely containing the words are not sites.
  assert.deepEqual(scanDynamicCode("obj.eval(x); myFunction(y); a.Function(z); setTimeout(fn, 1);"), []);
  assert.deepEqual(
    scanDynamicCode("Function('x'); new  Function (a); eval(b); setInterval(\"x()\", 5);").map((s) => s.kind),
    ["Function", "Function", "eval", "string-timer"]
  );
});
