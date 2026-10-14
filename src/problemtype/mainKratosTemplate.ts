/**
 * The default MainKratos.py written next to the generated ProjectParameters.json.
 * Ported from GiDInterface's kratos.gid/exec/MainKratos.py: reads the JSON,
 * imports the module named in parameters["analysis_stage"], derives the
 * AnalysisStage class name from the module name and runs the simulation
 * (with periodic stdout flushing so terminal output stays live under OpenMP).
 */

/** The cooperative-stop check every driver shares: the launcher names a file and the run it addresses. */
const STOP_REQUESTED_PY = `def StopRequested():
    # Cooperative stop: the launcher names a file (KRATOS_PREVIEW_STOP_FILE) and
    # the run it addresses (KRATOS_PREVIEW_RUN_ID). Only a file holding THIS
    # run's id counts, so a leftover from an earlier run cannot stop this one.
    # Standalone launches set neither variable and this is a no-op.
    stop_file = os.environ.get("KRATOS_PREVIEW_STOP_FILE")
    run_id = os.environ.get("KRATOS_PREVIEW_RUN_ID")
    if not stop_file or not run_id:
        return False
    try:
        with open(stop_file, "r") as handle:
            return handle.read().strip() == run_id
    except OSError:
        return False

`;

export const MAIN_KRATOS_PY = `import sys
import os
import time
import importlib

import KratosMultiphysics

${STOP_REQUESTED_PY}def CreateAnalysisStageWithFlushInstance(cls, global_model, parameters):
    class AnalysisStageWithFlush(cls):

        def __init__(self, model, project_parameters, flush_frequency=10.0):
            super().__init__(model, project_parameters)
            self.flush_frequency = flush_frequency
            self.last_flush = time.time()
            sys.stdout.flush()

        def Initialize(self):
            super().Initialize()
            sys.stdout.flush()

        def FinalizeSolutionStep(self):
            super().FinalizeSolutionStep()

            if self.parallel_type == "OpenMP":
                now = time.time()
                if now - self.last_flush > self.flush_frequency:
                    sys.stdout.flush()
                    self.last_flush = now

        def KeepAdvancingSolutionLoop(self):
            if not super().KeepAdvancingSolutionLoop():
                return False
            if StopRequested():
                # Leaving the loop here runs the normal Finalize, which closes
                # the last result file instead of truncating it.
                print("[stop requested - finalizing]")
                sys.stdout.flush()
                return False
            return True

    return AnalysisStageWithFlush(global_model, parameters)

if __name__ == "__main__":

    with open("ProjectParameters.json", 'r') as parameter_file:
        parameters = KratosMultiphysics.Parameters(parameter_file.read())

    analysis_stage_module_name = parameters["analysis_stage"].GetString()
    analysis_stage_class_name = analysis_stage_module_name.split('.')[-1]
    analysis_stage_class_name = ''.join(x.title() for x in analysis_stage_class_name.split('_'))

    analysis_stage_module = importlib.import_module(analysis_stage_module_name)
    analysis_stage_class = getattr(analysis_stage_module, analysis_stage_class_name)

    global_model = KratosMultiphysics.Model()
    simulation = CreateAnalysisStageWithFlushInstance(analysis_stage_class, global_model, parameters)
    simulation.Run()
`;

/**
 * Present in every script that honours the cooperative stop sentinel. The
 * launchers look for it in the script on disk, so a case generated before the
 * contract existed is stopped from the signal rung instead of waiting out a
 * grace period it cannot answer.
 */
export const STOP_SENTINEL_MARKER = "KRATOS_PREVIEW_STOP_FILE";

export function scriptHonoursStopSentinel(scriptText: string): boolean {
  return scriptText.includes(STOP_SENTINEL_MARKER);
}

/**
 * The driver for a CoSimulation case (roadmap item 16): CoSimulationAnalysis with
 * the same cooperative stop as MAIN_KRATOS_PY. The stop is checked after the base
 * loop condition, so the end time still comes from Kratos' own check.
 * `primaryDocumentName` is the CoSimulation settings file the driver reads.
 */
export function cosimMainKratosPy(primaryDocumentName: string): string {
  return `import sys
import os

import KratosMultiphysics
from KratosMultiphysics.CoSimulationApplication.co_simulation_analysis import CoSimulationAnalysis

${STOP_REQUESTED_PY}class CoSimulationAnalysisWithStop(CoSimulationAnalysis):

    def KeepAdvancingSolutionLoop(self):
        if not super().KeepAdvancingSolutionLoop():
            return False
        if StopRequested():
            # Leaving the loop here runs the normal Finalize, which closes the
            # last result file instead of truncating it.
            print("[stop requested - finalizing]")
            sys.stdout.flush()
            return False
        return True

if __name__ == "__main__":

    with open(${JSON.stringify(primaryDocumentName)}, 'r') as parameter_file:
        parameters = KratosMultiphysics.Parameters(parameter_file.read())

    simulation = CoSimulationAnalysisWithStop(parameters)
    simulation.Run()
`;
}

/** Structural adapter v2 observes the real AnalysisStage solve hook. Residual
 * values come from the solver's ProcessInfo; absent values are never invented.
 * Linear strategies return a successful solve-step without evaluating a
 * convergence criterion, so that result is preserved separately while the
 * numerical convergence field remains unknown. */
export const STRUCTURAL_MAIN_KRATOS_PY = MAIN_KRATOS_PY
  .replace("import importlib", "import importlib\nimport json\nimport os\nimport math")
  .replace(
    'if __name__ == "__main__":',
    `if __name__ == "__main__":

    try:
        os.remove(os.path.join(os.path.dirname(__file__), "kkss-convergence-v2.jsonl"))
    except FileNotFoundError:
        pass`
  )
  .replace(
    "        def Initialize(self):",
    `        def SolveSolutionStep(self):
            try:
                solver_result = super().SolveSolutionStep()
            except Exception as error:
                self._kkss_write_convergence(None, None, error)
                raise
            solver = self._GetSolver()
            settings = solver.settings
            analysis_type = settings["analysis_type"].GetString() if settings.Has("analysis_type") else "unavailable"
            convergence = solver_result if analysis_type == "non_linear" and isinstance(solver_result, bool) else None
            self._kkss_write_convergence(convergence, solver_result if isinstance(solver_result, bool) else None)
            return solver_result

        def _kkss_monitor_record(self, record):
            record.update({"adapter": "kkss.structural-convergence", "version": 2})
            with open(os.path.join(os.path.dirname(__file__), "kkss-convergence-v2.jsonl"), "a", encoding="utf-8") as monitor:
                monitor.write(json.dumps(record, sort_keys=True, allow_nan=False) + "\\n")
                monitor.flush()

        def _kkss_write_convergence(self, converged, solver_result, error=None):
            solver = self._GetSolver()
            info = solver.GetComputingModelPart().ProcessInfo
            settings = solver.settings
            analysis_type = settings["analysis_type"].GetString() if settings.Has("analysis_type") else "unavailable"
            criterion = settings["convergence_criterion"].GetString() if settings.Has("convergence_criterion") else "unavailable"
            record = {
                "event": "step",
                "iteration": int(info[KratosMultiphysics.STEP]),
                "time": float(info[KratosMultiphysics.TIME]),
                "converged": converged,
                "solverStepResult": solver_result,
                "analysisType": analysis_type,
                "criterion": criterion,
                "residualDefinition": "For residual_criterion: Kratos ResidualCriteria L2 norm of the free-DOF RHS divided by active DOF count; convergence_ratio is current/reference norm. Physical units are undeclared.",
                "runtime": {"kratosVersion": KratosMultiphysics.KratosGlobals.Kernel.Version(), "pythonVersion": sys.version.split()[0]},
            }
            for name in ["residual_relative_tolerance", "residual_absolute_tolerance", "displacement_relative_tolerance", "displacement_absolute_tolerance", "max_iteration"]:
                if settings.Has(name):
                    record.setdefault("criterionParameters", {})[name] = settings[name].GetDouble() if name != "max_iteration" else settings[name].GetInt()
            # Only ResidualCriteria owns these ProcessInfo values. Other
            # criteria may leave old values from a prior step in place.
            residual_criterion = analysis_type == "non_linear" and criterion.lower() == "residual_criterion"
            variables = [("nonlinearIteration", "NL_ITERATION_NUMBER")]
            if residual_criterion:
                variables = [("residual", "RESIDUAL_NORM"), ("convergenceRatio", "CONVERGENCE_RATIO")] + variables
            for key, name in variables:
                variable = getattr(KratosMultiphysics, name, None)
                if variable is not None and info.Has(variable):
                    value = float(info[variable])
                    if math.isfinite(value) and value >= 0:
                        record[key] = int(value) if key == "nonlinearIteration" else value
            if "residual" not in record:
                if analysis_type == "linear":
                    record["residualUnavailableReason"] = "The linear strategy completed without evaluating an iterative convergence criterion."
                elif criterion.lower() != "residual_criterion":
                    record["residualUnavailableReason"] = "The selected convergence criterion does not publish a residual norm."
                else:
                    record["residualUnavailableReason"] = "The solver did not publish RESIDUAL_NORM for this step."
            if error is not None:
                record["error"] = str(error)
            self._kkss_monitor_record(record)

        def Finalize(self):
            super().Finalize()
            self._kkss_monitor_record({"event": "end", "completed": True})

        def Initialize(self):`
  );

/** Built-in adapters share framing and validation; policy is solver-specific.
 * Only a solver's published boolean and the owning criterion's ProcessInfo
 * values qualify as convergence evidence. Buffer warmup is not a solve. */
export const CONVERGENCE_ADAPTERS: Record<string, string> = {
  structural: 'kkss.structural-convergence', fluid: 'kkss.fluid-convergence',
  convectionDiffusion: 'kkss.thermal-convergence', potentialFlow: 'kkss.potential-flow-convergence',
  shallowWater: 'kkss.shallow-water-convergence',
};
/** Built-ins that run the same solver settings as another and so share its monitor adapter. */
const ADAPTER_ALIASES: Record<string, string> = { embeddedFluid: 'fluid' };
export function monitoredMainScript(id: string): string {
  const problemtype = ADAPTER_ALIASES[id] ?? id;
  if (problemtype === 'structural') return STRUCTURAL_MAIN_KRATOS_PY;
  const adapter = CONVERGENCE_ADAPTERS[problemtype];
  if (!adapter) return MAIN_KRATOS_PY;
  const analysis = problemtype === 'potentialFlow'
    ? 'solver._GetStrategyType() if callable(getattr(solver, "_GetStrategyType", None)) else "unavailable"'
    : problemtype === 'shallowWater'
      ? '"non_linear" if solver._TimeBufferIsInitialized() else "buffer_warmup"'
      : 'settings["analysis_type"].GetString() if settings.Has("analysis_type") else "unavailable"';
  const criterion = problemtype === 'fluid'
    ? '("residual_criterion" if settings["time_scheme"].GetString() == "steady" else "mixed_velocity_pressure") if settings.Has("time_scheme") else "unavailable"'
    : problemtype === 'shallowWater'
      ? '("residual_criterion" if settings["convergence_criterion"].GetString() == "residual" else "displacement_criterion")'
      : 'settings["convergence_criterion"].GetString() if settings.Has("convergence_criterion") else "unavailable"';
  return STRUCTURAL_MAIN_KRATOS_PY
    .replaceAll('kkss.structural-convergence', adapter)
    .replaceAll('settings["analysis_type"].GetString() if settings.Has("analysis_type") else "unavailable"', analysis)
    .replaceAll('settings["convergence_criterion"].GetString() if settings.Has("convergence_criterion") else "unavailable"', criterion)
    .replace('"max_iteration"]:', '"max_iteration", "maximum_iterations", "relative_tolerance", "absolute_tolerance", "relative_velocity_tolerance", "absolute_velocity_tolerance", "relative_pressure_tolerance", "absolute_pressure_tolerance"]:')
    .replace('name != "max_iteration"', 'name not in ("max_iteration", "maximum_iterations")');
}

/** File name of the optimization stop process module written beside the case. */
export const OPTIMIZATION_STOP_MODULE = "kkss_optimization_stop";

/**
 * The cooperative stop for an OptimizationApplication run. OptimizationAnalysis
 * has no solution-loop hook to override, but it builds every entry of
 * `processes.kratos_processes.<group>` through KratosProcessFactory (a user module
 * with no `kratos_module` is imported by name, so this file beside the case
 * is found from the run folder) and calls ExecuteInitializeSolutionStep on each at
 * the start of every optimization iteration (Algorithm._InitializeIteration).
 * Raising there leaves the algorithm between iterations; the driver catches it
 * and still calls Finalize, so the summary and the design-field output close.
 */
export const OPTIMIZATION_STOP_PY = `import os

import KratosMultiphysics


class StopRequestedError(Exception):
    """Raised between optimization iterations when the launcher asked this run to stop."""


${STOP_REQUESTED_PY}class OptimizationStopProcess(KratosMultiphysics.Process):

    def __init__(self, model, settings):
        KratosMultiphysics.Process.__init__(self)

    def ExecuteInitializeSolutionStep(self):
        if StopRequested():
            raise StopRequestedError("stop requested")


def Factory(settings, model):
    return OptimizationStopProcess(model, settings)
`;

/**
 * The driver for an OptimizationApplication case. It runs the same stages as
 * OptimizationAnalysis.Run (Initialize, Check, Solve, Finalize) itself, so a stop
 * raised between iterations by kkss_optimization_stop (which reads
 * KRATOS_PREVIEW_STOP_FILE / KRATOS_PREVIEW_RUN_ID) still reaches Finalize.
 */
export function optimizationMainKratosPy(primaryDocumentName: string): string {
  return `import sys

import KratosMultiphysics
import KratosMultiphysics.StructuralMechanicsApplication
from KratosMultiphysics.OptimizationApplication.optimization_analysis import OptimizationAnalysis

# Cooperative stop: ${OPTIMIZATION_STOP_MODULE}.py beside this script checks
# KRATOS_PREVIEW_STOP_FILE at the start of every optimization iteration.
from ${OPTIMIZATION_STOP_MODULE} import StopRequestedError

if __name__ == "__main__":

    with open(${JSON.stringify(primaryDocumentName)}, 'r') as parameter_file:
        parameters = KratosMultiphysics.Parameters(parameter_file.read())

    model = KratosMultiphysics.Model()
    analysis = OptimizationAnalysis(model, parameters)
    analysis.Initialize()
    analysis.Check()
    try:
        analysis.GetAlgorithm().Solve()
    except StopRequestedError:
        print("[stop requested - finalizing]")
        sys.stdout.flush()
    analysis.Finalize()
`;
}

/** Files the ROM driver reads and writes beside the case. */
export const ROM_MANAGER_PARAMETERS = "RomManagerParameters.json";
export const ROM_SAMPLES = "RomSamples.json";
export const ROM_PROGRESS = "kkss-rom-progress.jsonl";
export const ROM_SUMMARY = "kkss-rom-summary-v1.json";

/**
 * The driver for a ROM case: RomApplication's RomManager over the case's own
 * ProjectParameters.json, with the sampled parameter values written into the
 * places RomSamples.json names (found at generate time by perturbation).
 *
 * - UpdateProjectParameters writes each path into the Parameters copy the
 *   manager hands it; UpdateMaterialParametersFile rewrites the materials file
 *   IN PLACE (that is the manager's contract), so the driver keeps the original
 *   text and restores it when the run ends, stopped or not.
 * - CustomizeSimulation (the four-argument form RomManager calls at master)
 *   adds the cooperative stop (KRATOS_PREVIEW_STOP_FILE / KRATOS_PREVIEW_RUN_ID)
 *   and one kkss-rom-progress.jsonl line per analysis start and end.
 * - kkss-rom-summary-v1.json records what rom_data/ holds afterwards, read from
 *   the files themselves.
 */
export function romMainKratosPy(): string {
  return `import sys
import os
import json
import time

import KratosMultiphysics
from KratosMultiphysics.RomApplication.rom_manager import RomManager

${STOP_REQUESTED_PY}class StopRequestedError(Exception):
    """Raised after the current analysis has finalized, so the manager stops starting new ones."""


def LoadJson(name):
    with open(name, "r") as handle:
        return json.load(handle)


samples = LoadJson(${JSON.stringify(ROM_SAMPLES)})
rom_manager_parameters = KratosMultiphysics.Parameters(json.dumps(LoadJson(${JSON.stringify(ROM_MANAGER_PARAMETERS)})))
run_counter = {"index": 0, "started": time.time()}


def SampleValue(parameter, x):
    return int(round(x)) if parameter.get("integer") else float(x)


def UpdateProjectParameters(parameters, mu=None):
    if mu is None:
        return parameters
    for parameter, x in zip(samples["parameters"], mu):
        value = SampleValue(parameter, x)
        for target in parameter["paths"]:
            if target["document"] != "parameters":
                continue
            node = parameters
            for key in target["path"]:
                node = node[key]
            if target["kind"] == "string":
                node.SetString(target["template"].replace("{mu}", repr(value)))
            elif isinstance(value, int):
                node.SetInt(value)
            else:
                node.SetDouble(value)
    return parameters


materials_original = {}


def UpdateMaterialParametersFile(materials_file_name=None, mu=None):
    if materials_file_name is None or mu is None:
        return
    targets = [(p, t) for p in samples["parameters"] for t in p["paths"] if t["document"] == "materials"]
    if not targets:
        return
    if materials_file_name not in materials_original:
        with open(materials_file_name, "r") as handle:
            materials_original[materials_file_name] = handle.read()
    data = json.loads(materials_original[materials_file_name])
    values = dict((id(p), SampleValue(p, x)) for p, x in zip(samples["parameters"], mu))
    for parameter, target in targets:
        node = data
        for key in target["path"][:-1]:
            node = node[key]
        value = values[id(parameter)]
        last = target["path"][-1]
        node[last] = target["template"].replace("{mu}", repr(value)) if target["kind"] == "string" else value
    with open(materials_file_name, "w") as handle:
        json.dump(data, handle, indent=4)


def RestoreMaterials():
    for name, text in materials_original.items():
        with open(name, "w") as handle:
            handle.write(text)


def RunLabel(cls, parameters):
    # The manager names each analysis' VTK output after its stage and sample
    # (Results/vtk_output_ROM_Fit3); without VTK output only the class is known.
    try:
        path = parameters["output_processes"]["vtk_output"][0]["Parameters"]["output_path"].GetString()
        return path.split("vtk_output_", 1)[-1]
    except Exception:
        return "ROM" if "Rom" in cls.__name__ else "FOM"


def Progress(record):
    record["time"] = time.time()
    with open(${JSON.stringify(ROM_PROGRESS)}, "a") as handle:
        handle.write(json.dumps(record) + "\\n")


def CustomizeSimulation(cls, global_model, parameters, mu=None):
    label = RunLabel(cls, parameters)

    class CustomSimulation(cls):

        def Initialize(self):
            if StopRequested():
                raise StopRequestedError()
            run_counter["index"] += 1
            self._kkss_index = run_counter["index"]
            self._kkss_started = time.time()
            Progress({"event": "start", "index": self._kkss_index, "label": label, "mu": list(mu) if mu is not None else None})
            super().Initialize()
            sys.stdout.flush()

        def KeepAdvancingSolutionLoop(self):
            if not super().KeepAdvancingSolutionLoop():
                return False
            if StopRequested():
                print("[stop requested - finalizing]")
                sys.stdout.flush()
                return False
            return True

        def Finalize(self):
            super().Finalize()
            Progress({"event": "end", "index": self._kkss_index, "label": label, "mu": list(mu) if mu is not None else None,
                      "elapsed": time.time() - self._kkss_started})
            if StopRequested():
                raise StopRequestedError()

    return CustomSimulation(global_model, parameters)


def WriteSummary(stopped, error=None):
    folder = rom_manager_parameters["ROM"]["rom_basis_output_folder"].GetString()
    name = rom_manager_parameters["ROM"]["rom_basis_output_name"].GetString()
    summary = {"version": 1, "stopped": stopped, "runs": run_counter["index"],
               "elapsed": time.time() - run_counter["started"],
               "train": len(samples["mu_train"]), "test": len(samples["mu_test"]),
               "stagesToTrain": rom_manager_parameters["rom_stages_to_train"].GetStringArray(),
               "stagesToTest": rom_manager_parameters["rom_stages_to_test"].GetStringArray()}
    if error is not None:
        summary["error"] = error
    try:
        rom = LoadJson(os.path.join(folder, name + ".json"))
        summary["numberOfRomDofs"] = rom.get("rom_settings", {}).get("number_of_rom_dofs")
        summary["projectionStrategy"] = rom.get("projection_strategy")
    except Exception:
        pass
    try:
        import numpy
        for key, file_name in (("hromElements", "HROM_ElementIds.npy"), ("hromConditions", "HROM_ConditionIds.npy")):
            file_path = os.path.join(folder, file_name)
            if os.path.exists(file_path):
                summary[key] = int(numpy.load(file_path).size)
        summary["singularValues"] = os.path.exists(os.path.join(folder, "SingularValuesVector.npy"))
    except Exception:
        pass
    with open(${JSON.stringify(ROM_SUMMARY)}, "w") as handle:
        json.dump(summary, handle, indent=2)


if __name__ == "__main__":

    rom_manager = RomManager("ProjectParameters.json", rom_manager_parameters, CustomizeSimulation,
                             UpdateProjectParameters, UpdateMaterialParametersFile, samples["mu_names"])
    stopped = False
    try:
        rom_manager.Fit(samples["mu_train"])
        if samples["mu_test"] and rom_manager_parameters["rom_stages_to_test"].size() > 0:
            rom_manager.Test(samples["mu_test"], samples["mu_train"])
        rom_manager.PrintErrors()
    except StopRequestedError:
        stopped = True
        print("[stop requested - the ROM database is partial]")
    finally:
        RestoreMaterials()
        WriteSummary(stopped)
    sys.stdout.flush()
`;
}
