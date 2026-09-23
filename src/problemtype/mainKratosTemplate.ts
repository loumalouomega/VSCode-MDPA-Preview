/**
 * The default MainKratos.py written next to the generated ProjectParameters.json.
 * Ported from GiDInterface's kratos.gid/exec/MainKratos.py: reads the JSON,
 * imports the module named in parameters["analysis_stage"], derives the
 * AnalysisStage class name from the module name and runs the simulation
 * (with periodic stdout flushing so terminal output stays live under OpenMP).
 */

export const MAIN_KRATOS_PY = `import sys
import time
import importlib

import KratosMultiphysics

def CreateAnalysisStageWithFlushInstance(cls, global_model, parameters):
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

/** Structural adapter v1 records the AnalysisStage solve-step outcome. A
 * successful process exit alone is never treated as convergence. */
export const STRUCTURAL_MAIN_KRATOS_PY = MAIN_KRATOS_PY
  .replace("import importlib", "import importlib\nimport json\nimport os")
  .replace(
    'if __name__ == "__main__":',
    `if __name__ == "__main__":

    try:
        os.remove(os.path.join(os.path.dirname(__file__), "kkss-convergence-v1.jsonl"))
    except FileNotFoundError:
        pass`
  )
  .replace(
    "        def Initialize(self):",
    `        def SolveSolutionStep(self):
            try:
                converged = super().SolveSolutionStep()
            except Exception as error:
                self._kkss_write_convergence(False, error)
                raise
            self._kkss_write_convergence(bool(converged))
            return converged

        def _kkss_write_convergence(self, converged, error=None):
            record = {
                "adapter": "kkss.structural-convergence",
                "version": 1,
                "iteration": int(getattr(self, "step", 0)),
                "time": float(getattr(self, "time", 0.0)),
                "converged": converged,
            }
            if error is not None:
                record["error"] = str(error)
            with open(os.path.join(os.path.dirname(__file__), "kkss-convergence-v1.jsonl"), "a", encoding="utf-8") as monitor:
                monitor.write(json.dumps(record, sort_keys=True) + "\\n")
                monitor.flush()

        def Initialize(self):`
  );
