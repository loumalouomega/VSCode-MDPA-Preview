"""Fluid Dynamics problemtype — Python port of the built-in.

A faithful port of src/problemtype/builtins/fluid.ts, kept as a worked example
of the Python authoring API (parity-tested against the TypeScript original).
The declaration is generated from the TypeScript original by
scripts/problemtype-to-python.mjs; only the hooks are hand-written.

This is the port that shows why hooks exist: ``volume_model_part_name``,
``skin_parts`` and ``no_skin_parts`` are derived from the user's assignments
inside ``solver_settings`` — a static template cannot express that — and the
wall law nests its model settings per wall model in ``build_process``.
"""

import math
import re

from kratos_problemtype import (define_problemtype, section, field, field_group,
                                condition, material_law)

NAME = "Fluid Dynamics (Python example)"

# Conditions that are not boundary skin: GiD lists them in no_skin_parts.
NO_SKIN = ("velocityConstraints", "pressureConstraints")
# Conditions that name a part without being a boundary condition of the solver.
NOT_BOUNDARY = ("flowForces", "aerodynamicCoefficients", "pressureCoefficient", "yPlus", "periodic", "integrationStats")
# Output variables a monitor writes as non-historical data.
#
# The two are written on DIFFERENT entities, and that is not a detail:
# PRESSURE_COEFFICIENT is set on the part's nodes, so it belongs in the
# output's nodal_data_value_variables; Y_PLUS is set on the part's conditions
# (computed per wall face from that face's parent element), so it belongs in
# condition_data_value_variables — asking for it as nodal data makes Kratos
# read the nodes, which never carry it, and the output file gets zeros.
MONITOR_NODAL_OUTPUT = {"pressureCoefficient": "PRESSURE_COEFFICIENT"}
MONITOR_CONDITION_OUTPUT = {"yPlus": "Y_PLUS"}


def _condition_vtk_output_process(model_part_name, variables, volume_vtk):
    """A vtk output process for a part whose results live on its CONDITIONS.

    Kratos' VtkOutput writes condition data only for a model part whose entity
    type is CONDITION, so the wall's own part gets its own output process. The
    file it writes is a condition mesh (the wall's faces): a SECOND file beside
    the volume output, not a replacement.
    """
    parameters = volume_vtk["Parameters"]
    return {
        "python_module": "vtk_output_process",
        "kratos_module": "KratosMultiphysics",
        "process_name": "VtkOutputProcess",
        "help": "This process writes postprocessing files for Paraview",
        "Parameters": {
            "model_part_name": model_part_name,
            "output_control_type": parameters["output_control_type"],
            "output_interval": parameters["output_interval"],
            "file_format": parameters["file_format"],
            "output_precision": parameters["output_precision"],
            "output_sub_model_parts": False,
            "output_path": parameters["output_path"],
            "save_output_files_in_folder": True,
            "entity_type": "condition",
            "nodal_solution_step_data_variables": [],
            "nodal_data_value_variables": [],
            "element_data_value_variables": [],
            "condition_data_value_variables": list(variables),
            "gauss_point_variables_extrapolated_to_nodes": [],
        },
    }
FORMULATION_KEY = {"axisymmetric": "axisymmetric_navier_stokes"}


def _resolve(node, assignment, ctx):
    """Replaces the $path / $root / $field:<id> placeholders of a template."""
    if isinstance(node, str):
        if node == "$path":
            return ctx["model_part_name"] + "." + assignment["smpPath"].replace("/", ".")
        if node == "$root":
            return ctx["model_part_name"]
        if node.startswith("$field:"):
            return assignment["values"].get(node[len("$field:"):])
        return node
    if isinstance(node, list):
        return [_resolve(item, assignment, ctx) for item in node]
    if isinstance(node, dict):
        return {key: _resolve(item, assignment, ctx) for key, item in node.items()}
    return node


def _broadcast_constrained(cond, assignment, ctx):
    """The single "Fixed" checkbox of an Assign*VariableProcess on nodes becomes
    Kratos' per-component ``constrained: [b, b, b]`` (None for any other condition)."""
    template = cond["processTemplate"]
    if template.get("python_module") != "assign_vector_variable_process":
        return None
    process = _resolve(template, assignment, ctx)
    fixed = assignment["values"].get("constrained", True)
    fixed = fixed if isinstance(fixed, bool) else True
    value = assignment["values"].get("value", [0, 0, 0])
    process["Parameters"]["constrained"] = [fixed, fixed, fixed]
    process["Parameters"]["value"] = value if isinstance(value, list) else [0, 0, 0]
    return process


def _linear_solver(values):
    """``linear_solver_settings`` for the chosen solver (None for Automatic)."""
    solver = values["linearSolver"]
    if solver in ("cg", "bicgstab"):
        return {
            "solver_type": solver,
            "max_iteration": values["linearMaxIteration"],
            "tolerance": values["linearTolerance"],
            "preconditioner_type": values["preconditioner"],
            "scaling": False,
        }
    if solver != "automatic":
        return {"solver_type": solver}
    return None


_JS_DECIMAL = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_JS_RADIX = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+")


def _str(value, default):
    return value if isinstance(value, str) else default


def _js_number(text):
    """Number(text) for a trimmed string: the finite number it spells, else None."""
    if _JS_RADIX.fullmatch(text):
        return int(text, 0)
    if _JS_DECIMAL.fullmatch(text):
        number = float(text)
        return number if math.isfinite(number) else None
    return None


def _interval_end(value):
    """The inlet's intervalEnd: "End" (blank or in any case), a finite number, or the text."""
    text = _str(value, "End").strip()
    if text == "" or text.lower() == "end":
        return "End"
    number = _js_number(text)
    return text if number is None else number


def build_process(cond, assignment, ctx):
    values = assignment["values"]
    if cond["id"] == "inlet":
        process = _resolve(cond["processTemplate"], assignment, ctx)
        # The optional symbolic modulus and activation window (fluid.ts's inlet hook).
        expression = _str(values.get("modulusExpression"), "").strip()
        if expression:
            process["Parameters"]["modulus"] = expression
        process["Parameters"]["interval"] = [values.get("intervalStart", 0), _interval_end(values.get("intervalEnd"))]
        direction = values.get("direction", "automatic_inwards_normal")
        process["Parameters"]["direction"] = {
            "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1],
        }.get(direction, direction)
        return process
    if cond["id"] == "periodic":
        master = _str(values.get("master"), "")
        direction = values.get("translation")
        direction = direction if isinstance(direction, list) else [1, 0, 0]
        return {
            "python_module": "apply_periodic_condition_process",
            "kratos_module": "KratosMultiphysics",
            "process_name": "ApplyPeriodicConditionProcess",
            "Parameters": {
                "model_part_name": ctx["model_part_name"],
                "computing_model_part_name": "fluid_computational_model_part",
                "first_model_part_name": master.replace("/", "."),
                "second_model_part_name": assignment["smpPath"].replace("/", "."),
                "variable_names": ["VELOCITY", "PRESSURE"],
                "transformation_settings": {
                    "translation_settings": {
                        "dir_of_translation": direction,
                        "magnitude": values.get("magnitude", 1),
                    },
                },
            },
        }
    if cond["id"] == "wallLaw":
        process = _resolve(cond["processTemplate"], assignment, ctx)
        if process["Parameters"]["wall_model_name"] == "linear_log":
            process["Parameters"]["wall_model_settings"] = {"y_wall": values.get("yWall", 0.001)}
        else:
            process["Parameters"]["wall_model_settings"] = {"slip_length": values.get("slipLength", 0.001)}
        return process
    # The custom velocity / pressure constraints are plain Assign*VariableProcess.
    return _broadcast_constrained(cond, assignment, ctx)


def solver_settings(values, ctx):
    fractional = values["strategy"] == "fractional_step"
    strategy = values["strategy"]
    skin, no_skin = [], []
    for a in ctx["assignments"]:
        if (a["conditionId"] == "parts" or a["conditionId"].startswith("initial")
                or a["conditionId"] in NOT_BOUNDARY):
            continue
        name = ctx["model_part_name"] + "." + a["smpPath"].replace("/", ".")
        (no_skin if a["conditionId"] in NO_SKIN else skin).append(name)
    settings = {
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "solver_type": ("FractionalStep" if fractional
                        else "monolithic_stokes" if strategy == "stokes" else "Monolithic"),
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "echo_level": values["echoLevel"],
        # The wall y+ is computed from the wall's REACTION, so a case that
        # asks for it needs the solver to compute the reactions.
        "compute_reactions": values["computeReactions"] or any(
            a["conditionId"] == "yPlus" for a in ctx["assignments"]),
        # Derived from the assignments — the reason this is a hook, not a template.
        "volume_model_part_name": (ctx["parts_model_parts"][0]
                                   if ctx["parts_model_parts"] else ctx["model_part_name"]),
        "skin_parts": skin,
        "no_skin_parts": no_skin,
        "time_stepping": (
            {
                "automatic_time_step": True,
                "CFL_number": values["courantTarget"],
                "minimum_delta_time": values["minDeltaTime"],
                "maximum_delta_time": values["maxDeltaTime"],
            }
            if values["timeStepMode"] == "adaptive"
            else {"automatic_time_step": False, "time_step": values["timeStep"]}
        ),
    }
    if values["considerPeriodic"]:
        settings["consider_periodic_conditions"] = True
    linear = _linear_solver(values)
    if fractional:
        settings["dynamic_tau"] = values["dynamicTau"]
        settings["predictor_corrector"] = values["predictorCorrector"]
        if values["predictorCorrector"]:
            settings["pressure_tolerance"] = values["pressureTolerance"]
            settings["maximum_pressure_iterations"] = values["maxPressureIterations"]
        settings["velocity_tolerance"] = values["velocityTolerance"]
        settings["maximum_velocity_iterations"] = values["maxVelocityIterations"]
        settings["time_order"] = values["timeOrder"]
        settings["use_slip_conditions"] = values["useSlipConditions"]
        if linear:
            settings["velocity_linear_solver_settings"] = dict(linear)
            settings["pressure_linear_solver_settings"] = dict(linear)
    elif strategy == "stokes":
        # The Stokes solver is linear, steady-capable and takes the symbolic Stokes element.
        settings["formulation"] = {"element_type": "symbolic_stokes"}
        settings["analysis_type"] = "linear"
        settings["force_steady_state"] = values["forceSteadyState"]
        if linear:
            settings["linear_solver_settings"] = linear
    else:
        element_type = values["elementType"]
        settings["maximum_iterations"] = values["maxIterations"]
        settings["relative_velocity_tolerance"] = values["relVelTol"]
        settings["absolute_velocity_tolerance"] = values["absVelTol"]
        settings["relative_pressure_tolerance"] = values["relPresTol"]
        settings["absolute_pressure_tolerance"] = values["absPresTol"]
        settings["time_scheme"] = values["timeScheme"]
        # Kratos' own defaults (alpha -0.3, FIC beta 0.8) are not written.
        if settings["time_scheme"] == "bossak" and values["bossakAlpha"] != -0.3:
            settings["alpha"] = values["bossakAlpha"]
        # Each formulation validates its own key set, so only its keys are written.
        formulation = {"element_type": FORMULATION_KEY.get(element_type, element_type)}
        if element_type in ("qsvms", "dvms", "vms"):
            formulation["use_orthogonal_subscales"] = values["oss"]
        if element_type == "qsvms" and values["timeIntegrated"]:
            formulation["element_manages_time_integration"] = True
        if element_type == "fic" and values["ficBeta"] != 0.8:
            formulation["beta"] = values["ficBeta"]
        if element_type == "weakly_compressible":
            formulation["sound_velocity"] = values["soundVelocity"]
        if element_type == "vms" and values["nonNewtonian"]:
            formulation["non_newtonian_fluid_parameters"] = {
                "power_law_k": values["powerLawK"],
                "power_law_n": values["powerLawN"],
                "yield_stress": values["yieldStress"],
                "regularization_coefficient": values["regularization"],
            }
        formulation["dynamic_tau"] = values["dynamicTau"]
        settings["formulation"] = formulation
        if linear:
            settings["linear_solver_settings"] = linear
    settings["reform_dofs_at_each_step"] = False
    return settings


def _stats_by_part(ctx):
    """Group the integration-point statistics assignments by part, with problems."""
    by_part = {}
    problems = []

    def pretty(t):
        return t.replace("_", " ")

    for a in ctx["assignments"]:
        if a["conditionId"] != "integrationStats":
            continue
        values = a["values"]
        stype = str(values.get("statisticType", "average"))
        if stype not in ("average", "variance", "third_order_moment"):
            problems.append(f'"{a["smpPath"]}": unknown statistic "{stype}".')
            continue
        variables = [x.strip() for x in str(values.get("variable", "")).split(",")]
        variables = [x for x in variables if x]
        tags = [x.strip() for x in str(values.get("tags", "")).split(",")]
        tags = [x for x in tags if x]
        entry = {"part": a["smpPath"], "type": stype, "variables": variables,
                 "tags": tags,
                 "output_file": str(values.get("outputFile", "statistics")).strip() or "statistics",
                 "start_time": values.get("startTime", 0)}
        need = ("one variable" if stype == "average"
                else "one or two variables" if stype == "variance"
                else "three variables")
        ok_count = ((len(variables) == 1) if stype == "average"
                    else (1 <= len(variables) <= 2) if stype == "variance"
                    else len(variables) == 3)
        if not ok_count:
            problems.append(f'"{a["smpPath"]}": a {pretty(stype)} needs {need} (got {len(variables)}).')
            continue
        if stype != "average" and tags:
            problems.append(f'"{a["smpPath"]}": tags belong to an average, not to a {pretty(stype)}.')
            continue
        if stype == "average":
            if variables[0] == "VELOCITY":
                if not tags:
                    entry["tags"] = (["VELOCITY_X", "VELOCITY_Y"] if ctx["domain_size"] == 2
                                     else ["VELOCITY_X", "VELOCITY_Y", "VELOCITY_Z"])
                elif len(tags) != ctx["domain_size"]:
                    problems.append(f'"{a["smpPath"]}": a vector average needs one tag per component ({ctx["domain_size"]} for VELOCITY).')
                    continue
            elif len(tags) > 1:
                problems.append(f'"{a["smpPath"]}": a scalar average takes at most one tag.')
                continue
        by_part.setdefault(a["smpPath"], []).append(entry)
    for part, entries in by_part.items():
        if len({e["output_file"] for e in entries}) > 1:
            problems.append(f'"{part}": one statistics file per part.')
        if len({e["start_time"] for e in entries}) > 1:
            problems.append(f'"{part}": one start time per part.')
        averages = {e["variables"][0] for e in entries if e["type"] == "average"}
        for e in entries:
            if e["type"] == "average":
                continue
            for v in e["variables"]:
                base = v[:-2] if (len(v) > 2 and v[-2] == "_" and v[-1] in "XYZ") else v
                if base not in averages and v not in averages:
                    problems.append(f'"{part}": the {pretty(e["type"])} of "{v}" needs its average on the same part.')
    return by_part, problems


def validate(ctx):
    by_part, stats_problems = _stats_by_part(ctx)
    problems = list(stats_problems)
    v = ctx["values"]
    if v["elementType"] == "axisymmetric" and v["strategy"] == "monolithic" and ctx["domain_size"] != 2:
        problems.append("The axisymmetric element is two-dimensional: use a 2D mesh or another element.")
    periodic = [a for a in ctx["assignments"] if a["conditionId"] == "periodic"]
    if periodic and not v["considerPeriodic"]:
        problems.append('A Periodic boundary is assigned but "Periodic boundaries" is off in Problem data: the solver would ignore the pairing.')
    for a in periodic:
        master = _str(a["values"].get("master"), "")
        if not master:
            problems.append(f'The periodic boundary "{a["smpPath"]}" has no master boundary.')
        if master == a["smpPath"]:
            problems.append(f'The periodic boundary "{a["smpPath"]}" is its own master.')
    return problems


def post_process(project_parameters, ctx):
    # One statistics process per part: higher moments read the average
    # sampled in the same process, so the entries merge here.
    by_part, _problems = _stats_by_part(ctx)
    if by_part:
        auxiliar = project_parameters["processes"].setdefault("auxiliar_process_list", [])
        for part, entries in by_part.items():
            statistics = []
            for e in entries:
                if e["type"] == "average":
                    stat = {"type": e["type"], "variable": e["variables"][0]}
                    if e["tags"]:
                        stat["tags"] = list(e["tags"])
                else:
                    stat = {"type": e["type"], "variables": list(e["variables"])}
                statistics.append(stat)
            auxiliar.append({
                "python_module": "integration_point_statistics_process",
                "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                "process_name": "IntegrationPointStatisticsProcess",
                "Parameters": {
                    "model_part_name": ctx["model_part_name"] + "." + part.replace("/", "."),
                    "output_file_name": entries[0]["output_file"],
                    "dimension": ctx["domain_size"],
                    "start_time": entries[0]["start_time"],
                    "statistics": statistics,
                },
            })
    # A monitor that writes a nodal result needs it in the output's non-historical list.
    wanted = []
    for a in ctx["assignments"]:
        name = MONITOR_NODAL_OUTPUT.get(a["conditionId"])
        if name and name not in wanted:
            wanted.append(name)
    vtk = (project_parameters.get("output_processes") or {}).get("vtk_output") or []
    if wanted and vtk:
        parameters = vtk[0]["Parameters"]
        listed = list(parameters.get("nodal_data_value_variables") or [])
        for name in wanted:
            if name not in listed:
                listed.append(name)
        parameters["nodal_data_value_variables"] = listed
    # A monitor that writes a CONDITION result (the wall y+) needs a
    # condition-typed output on the wall's own part: asking the element part
    # for condition data writes nothing, and asking for it as nodal data
    # writes zeros (the nodes never carry it).
    condition_wanted = []
    for a in ctx["assignments"]:
        name = MONITOR_CONDITION_OUTPUT.get(a["conditionId"])
        if name and name not in condition_wanted:
            condition_wanted.append(name)
    if condition_wanted and vtk:
        wall_parts = []
        for a in ctx["assignments"]:
            if MONITOR_CONDITION_OUTPUT.get(a["conditionId"]):
                dotted = ctx["model_part_name"] + "." + a["smpPath"].replace("/", ".")
                if dotted not in wall_parts:
                    wall_parts.append(dotted)
        outputs = (project_parameters["output_processes"] or {}).get("vtk_output") or []
        for wall_part in wall_parts:
            outputs.append(_condition_vtk_output_process(wall_part, condition_wanted, vtk[0]))
        project_parameters["output_processes"]["vtk_output"] = outputs
    modulus = ctx["values"]["gravityValue"]
    if modulus == 0:
        return project_parameters
    # GiD writes gravity as its own process list on the fluid part.
    project_parameters["processes"]["gravity"] = [{
        "python_module": "assign_vector_by_direction_process",
        "kratos_module": "KratosMultiphysics",
        "process_name": "AssignVectorByDirectionProcess",
        "Parameters": {
            "model_part_name": (ctx["parts_model_parts"][0]
                                if ctx["parts_model_parts"] else ctx["model_part_name"]),
            "variable_name": "BODY_FORCE",
            "modulus": modulus,
            "constrained": False,
            "direction": ctx["values"]["gravityDirection"],
        },
    }]
    return project_parameters


# --- declaration of "fluid" generated by scripts/problemtype-to-python.mjs ---
SECTION_0 = section("problem", "Problem data",
    field("strategy", "Strategy", "enum", default="monolithic", options=[{"value": "monolithic", "label": "Monolithic"}, {"value": "fractional_step", "label": "Fractional step"}, {"value": "stokes", "label": "Stokes (monolithic, linear)"}], group="formulation"),
    field("elementType", "Element", "enum", default="qsvms", options=[{"value": "qsvms", "label": "Quasi-static VMS"}, {"value": "dvms", "label": "Dynamic VMS"}, {"value": "fic", "label": "FIC"}, {"value": "vms", "label": "Classic VMS (legacy)"}, {"value": "weakly_compressible", "label": "Weakly compressible"}, {"value": "axisymmetric", "label": "Axisymmetric (2D)"}, {"value": "p2p1", "label": "P2-P1 continuous (quadratic)"}], visible_when={"field": "strategy", "equals": "monolithic"}, group="formulation"),
    field("timeIntegrated", "Element integrates in time", "bool", default=False, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "qsvms"}], help="TimeIntegratedQSVMS: the element applies the time scheme itself instead of the strategy.", group="formulation"),
    field("ficBeta", "FIC beta", "number", default=0.8, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "fic"}], group="formulation", min=0),
    field("soundVelocity", "Speed of sound", "number", default=1000000000000, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "weakly_compressible"}], unit="m/s", help="The default is effectively incompressible; use the real speed of sound for a compressible-limit study.", group="formulation", min=0),
    field("nonNewtonian", "Non-Newtonian (Herschel-Bulkley)", "bool", default=False, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "vms"}], help="The legacy VMS element takes its power-law parameters from the solver; the other elements read a constitutive law from the material.", group="formulation"),
    field("powerLawK", "Consistency index K", "number", default=0.000001, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "vms"}, {"field": "nonNewtonian", "equals": True}], group="formulation", min=0),
    field("powerLawN", "Power-law index n", "number", default=1, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "vms"}, {"field": "nonNewtonian", "equals": True}], group="formulation", min=0),
    field("yieldStress", "Yield stress", "number", default=0, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "vms"}, {"field": "nonNewtonian", "equals": True}], unit="Pa", group="formulation", min=0),
    field("regularization", "Regularization coefficient", "number", default=100, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "equals": "vms"}, {"field": "nonNewtonian", "equals": True}], group="formulation", min=0),
    field("forceSteadyState", "Force steady state", "bool", default=False, visible_when={"field": "strategy", "equals": "stokes"}, group="formulation"),
    field("timeOrder", "Time order", "int", default=2, visible_when={"field": "strategy", "equals": "fractional_step"}, group="formulation", min=1, max=2),
    field("useSlipConditions", "Slip conditions on the skin", "bool", default=True, visible_when={"field": "strategy", "equals": "fractional_step"}, group="formulation"),
    field("considerPeriodic", "Periodic boundaries", "bool", default=False, help="Turn on when a Periodic boundary condition is assigned.", group="formulation"),
    field("timeScheme", "Time scheme", "enum", default="bossak", options=[{"value": "bdf2", "label": "BDF2"}, {"value": "bossak", "label": "Bossak"}], visible_when={"field": "strategy", "equals": "monolithic"}, group="formulation"),
    field("bossakAlpha", "Bossak alpha", "number", default=-0.3, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "timeScheme", "equals": "bossak"}], group="formulation", min=-0.5, max=0),
    field("oss", "Orthogonal subscales", "bool", default=False, visible_when=[{"field": "strategy", "equals": "monolithic"}, {"field": "elementType", "one_of": ["qsvms", "dvms"]}], group="formulation"),
    field("dynamicTau", "Dynamic tau", "number", default=1, group="formulation", min=0),
    field("timeStepMode", "Time stepping", "enum", default="fixed", options=[{"value": "fixed", "label": "Fixed step"}, {"value": "adaptive", "label": "Adaptive (CFL)"}], group="time"),
    field("startTime", "Start time", "number", default=0, unit="s", group="time"),
    field("timeStep", "Time step", "number", default=0.01, unit="s", group="time", min=0),
    field("courantTarget", "Target Courant number", "number", default=1, visible_when={"field": "timeStepMode", "equals": "adaptive"}, group="time"),
    field("minDeltaTime", "Min. time step", "number", default=0.0001, visible_when={"field": "timeStepMode", "equals": "adaptive"}, group="time"),
    field("maxDeltaTime", "Max. time step", "number", default=0.1, visible_when={"field": "timeStepMode", "equals": "adaptive"}, group="time"),
    field("refVelocity", "Reference velocity (estimate only)", "number", default=1, group="time"),
    field("endTime", "End time", "number", default=1, unit="s", group="time"),
    field("maxIterations", "Max iterations", "int", default=10, visible_when={"field": "strategy", "equals": "monolithic"}, group="convergence", min=1),
    field("relVelTol", "Rel. velocity tol.", "number", default=0.001, visible_when={"field": "strategy", "equals": "monolithic"}, group="convergence", min=0),
    field("absVelTol", "Abs. velocity tol.", "number", default=0.00001, visible_when={"field": "strategy", "equals": "monolithic"}, group="convergence", min=0),
    field("relPresTol", "Rel. pressure tol.", "number", default=0.001, visible_when={"field": "strategy", "equals": "monolithic"}, group="convergence", min=0),
    field("absPresTol", "Abs. pressure tol.", "number", default=0.00001, visible_when={"field": "strategy", "equals": "monolithic"}, group="convergence", min=0),
    field("velocityTolerance", "Velocity tolerance", "number", default=0.001, visible_when={"field": "strategy", "equals": "fractional_step"}, group="convergence", min=0),
    field("maxVelocityIterations", "Max velocity iterations", "int", default=4, visible_when={"field": "strategy", "equals": "fractional_step"}, group="convergence", min=1),
    field("predictorCorrector", "Predictor-corrector", "bool", default=False, visible_when={"field": "strategy", "equals": "fractional_step"}, group="convergence"),
    field("pressureTolerance", "Pressure tolerance", "number", default=0.001, visible_when=[{"field": "strategy", "equals": "fractional_step"}, {"field": "predictorCorrector", "equals": True}], group="convergence", min=0),
    field("maxPressureIterations", "Max pressure iterations", "int", default=4, visible_when=[{"field": "strategy", "equals": "fractional_step"}, {"field": "predictorCorrector", "equals": True}], group="convergence", min=1),
    field("gravityValue", "Gravity", "number", default=0, unit="m/s²", help="Body force modulus; 0 writes no gravity process.", group="gravity", min=0),
    field("gravityDirection", "Direction", "vector3", default=[0, -1, 0], group="gravity"),
    field("linearSolver", "Solver", "enum", default="automatic", options=[{"value": "automatic", "label": "Automatic"}, {"value": "LinearSolversApplication.sparse_lu", "label": "Sparse LU"}, {"value": "cg", "label": "Conjugate gradients"}, {"value": "bicgstab", "label": "BiCGStab"}], help="Automatic lets Kratos pick the default solver of the selected strategy.", group="linear"),
    field("linearMaxIteration", "Max iterations", "int", default=200, visible_when={"field": "linearSolver", "one_of": ["cg", "bicgstab"]}, group="linear", min=1),
    field("linearTolerance", "Tolerance", "number", default=1e-7, visible_when={"field": "linearSolver", "one_of": ["cg", "bicgstab"]}, group="linear", min=0),
    field("preconditioner", "Preconditioner", "enum", default="none", options=["none", "diagonal", "ilu", "ilu0"], visible_when={"field": "linearSolver", "one_of": ["cg", "bicgstab"]}, group="linear"),
    field("echoLevel", "Echo level", "int", default=0, min=0, max=3, advanced=True),
    field("computeReactions", "Compute reactions", "bool", default=False, advanced=True),
    groups=[field_group("formulation", "Formulation", icon="ptSolver"), field_group("time", "Time", icon="ptTime"), field_group("convergence", "Convergence", icon="ptSolver"), field_group("gravity", "Gravity", icon="ptGravity", collapsed=True), field_group("linear", "Linear solver", icon="ptSolver", collapsed=True)])

CONDITIONS = [
    condition("parts", "Fluid body", list="list_other_processes", target="volume",
              fields=[],
              process_template={

              },
              help="Marks a SubModelPart as the fluid domain; assign a material to it."),
    condition("initialVelocity", "Initial velocity", list="initial_conditions_process_list", target="any",
              fields=[field("value", "Value [m/s]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=False)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "VELOCITY",
                      "interval": [0, 0],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              category="initial", icon="ptInitial"),
    condition("initialPressure", "Initial pressure", list="initial_conditions_process_list", target="any",
              fields=[field("value", "Value [Pa]", "number", default=0),
                      field("constrained", "Fixed", "bool", default=False)],
              process_template={
                  "python_module": "assign_scalar_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignScalarVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "PRESSURE",
                      "interval": [0, 0],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              category="initial", icon="ptInitial"),
    condition("initialTemperature", "Initial temperature", list="initial_conditions_process_list", target="any",
              fields=[field("value", "Value [K]", "number", default=293.15),
                      field("constrained", "Fixed", "bool", default=False)],
              process_template={
                  "python_module": "assign_scalar_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignScalarVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "TEMPERATURE",
                      "interval": [0, 0],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              category="initial", icon="ptInitial"),
    condition("inlet", "Inlet velocity", list="constraints_process_list", target="surface",
              fields=[field("modulus", "|v| [m/s]", "number", default=1),
                      field("modulusExpression", "|v| expression", "string", default="", help="A Kratos expression in the inlet's own coordinates and the current time t, e.g. 0.1214*(1-cos(0.1*pi*t))*y*(1-y). When set it replaces the numeric |v| above.", advanced=True),
                      field("intervalStart", "Active from [s]", "number", default=0, help="The process applies from this time on. Two inlet assignments on one surface with disjoint windows write a two-phase inlet (the fsi_mok benchmark ramps up until 10 s, then holds).", advanced=True),
                      field("intervalEnd", "Active until [s]", "string", default="End", help="\"End\" keeps the process active to the end of the simulation; a number deactivates it there.", advanced=True),
                      field("direction", "Direction", "enum", default="automatic_inwards_normal", options=[{"value": "automatic_inwards_normal", "label": "Inwards normal"}, {"value": "automatic_outwards_normal", "label": "Outwards normal"}, {"value": "x", "label": "+X"}, {"value": "y", "label": "+Y"}, {"value": "z", "label": "+Z"}])],
              process_template={
                  "python_module": "apply_inlet_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "VELOCITY",
                      "modulus": "$field:modulus",
                      "direction": "$field:direction",
                      "interval": [0, "End"],
                  },
              },
              category="constraints", icon="ptConstraint"),
    condition("outlet", "Outlet pressure", list="constraints_process_list", target="surface",
              fields=[field("value", "Pressure [Pa]", "number", default=0),
                      field("hydrostatic", "Add hydrostatic contribution", "bool", default=False),
                      field("hTop", "Top height [m]", "number", default=0, visible_when={"field": "hydrostatic", "equals": True}, help="Fluid height above the outlet.")],
              process_template={
                  "python_module": "apply_outlet_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "PRESSURE",
                      "constrained": True,
                      "value": "$field:value",
                      "hydrostatic_outlet": "$field:hydrostatic",
                      "h_top": "$field:hTop",
                  },
              },
              category="constraints", icon="ptConstraint"),
    condition("slip", "Slip wall", list="constraints_process_list", target="surface",
              fields=[],
              process_template={
                  "python_module": "apply_slip_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "process_name": "ApplySlipProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                  },
              },
              category="constraints", icon="ptConstraint"),
    condition("noSlip", "No-slip wall", list="constraints_process_list", target="surface",
              fields=[],
              process_template={
                  "python_module": "apply_noslip_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "Parameters": {
                      "model_part_name": "$path",
                  },
              },
              category="constraints", icon="ptConstraint"),
    condition("wallLaw", "Wall law", list="constraints_process_list", target="surface",
              fields=[field("wallModel", "Wall model", "enum", default="navier_slip", options=[{"value": "navier_slip", "label": "Navier slip"}, {"value": "linear_log", "label": "Linear-logarithmic"}]),
                      field("slipLength", "Slip length [m]", "number", default=0.001, visible_when={"field": "wallModel", "equals": "navier_slip"}),
                      field("yWall", "Wall distance [m]", "number", default=0.001, visible_when={"field": "wallModel", "equals": "linear_log"})],
              process_template={
                  "python_module": "apply_wall_law_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "process_name": "ApplyWallLawProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "wall_model_name": "$field:wallModel",
                  },
              },
              category="constraints", icon="ptConstraint"),
    condition("velocityConstraints", "Custom velocity constraints", list="constraints_process_list", target="any",
              fields=[field("value", "Value [m/s]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=True)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "VELOCITY",
                      "interval": [0, "End"],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              help="Imposes velocity components on a SubModelPart that is not a skin boundary.", category="constraints", icon="ptConstraint"),
    condition("pressureConstraints", "Custom pressure constraints", list="constraints_process_list", target="any",
              fields=[field("value", "Value [Pa]", "number", default=0),
                      field("constrained", "Fixed", "bool", default=True)],
              process_template={
                  "python_module": "assign_scalar_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignScalarVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "PRESSURE",
                      "interval": [0, "End"],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              help="Imposes pressure on a SubModelPart that is not a skin boundary.", category="constraints", icon="ptConstraint"),
    condition("periodic", "Periodic boundary", list="constraints_process_list", target="surface",
              fields=[field("master", "Master boundary", "smp", default=""),
                      field("translation", "Translation direction", "vector3", default=[1, 0, 0], help="From the master to the slave."),
                      field("magnitude", "Translation distance [m]", "number", default=1, min=0)],
              process_template={

              },
              help="Ties this boundary (the slave) to the master boundary a translation away, for velocity and pressure. Assign it to the slave only and turn on Periodic boundaries. The translation runs from the master to the slave, and Generate checks that the master moved by it lands on the slave.", category="constraints", icon="ptConstraint"),
    condition("flowForces", "Forces and moments on a body", list="auxiliar_process_list", target="surface",
              fields=[field("referencePoint", "Moment reference point", "vector3", default=[0, 0, 0]),
                      field("writeMoments", "Write moments", "bool", default=True),
                      field("printToScreen", "Print to screen", "bool", default=False)],
              process_template={
                  "python_module": "compute_body_fitted_flow_forces_and_moments_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "process_name": "ComputeBodyFittedFlowForcesAndMomentsProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "interval": [0, "End"],
                      "print_to_screen": "$field:printToScreen",
                      "write_forces_output_file": True,
                      "write_moments_output_file": "$field:writeMoments",
                      "reference_point": "$field:referencePoint",
                  },
              },
              help="Integrates pressure and viscous traction over this wall and writes Fx Fy Fz (and moments) per step to <model part>_drag.dat.", category="other", icon="ptResults"),
    condition("aerodynamicCoefficients", "Aerodynamic coefficients", list="auxiliar_process_list", target="surface",
              fields=[field("referenceArea", "Reference area [m²]", "number", default=1, min=0),
                      field("referenceChord", "Reference chord [m]", "number", default=1, min=0),
                      field("dynamicPressure", "Dynamic pressure [Pa]", "number", default=1, help="0.5 · density · speed².", min=0),
                      field("referencePoint", "Moment reference point", "vector3", default=[0, 0, 0]),
                      field("printToScreen", "Print to screen", "bool", default=False)],
              process_template={
                  "python_module": "compute_aerodynamic_coefficients_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "process_name": "ComputeAerodynamicCoefficientsProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "interval": [0, "End"],
                      "print_coefficients_to_screen": "$field:printToScreen",
                      "write_output_file": True,
                      "is_embedded": False,
                      "reference_point": "$field:referencePoint",
                      "reference_area": "$field:referenceArea",
                      "reference_chord": "$field:referenceChord",
                      "dynamic_pressure": "$field:dynamicPressure",
                  },
              },
              help="Writes drag, lift and moment coefficients of this wall: force over the dynamic pressure times the reference area (moments also times the reference chord).", category="other", icon="ptResults"),
    condition("pressureCoefficient", "Pressure coefficient", list="auxiliar_process_list", target="surface",
              fields=[field("freestreamDensity", "Free-stream density [kg/m³]", "number", default=1.204, min=0),
                      field("freestreamVelocity", "Free-stream speed [m/s]", "number", default=1, min=0),
                      field("freestreamPressure", "Free-stream pressure [Pa]", "number", default=0)],
              process_template={
                  "python_module": "compute_pressure_coefficient_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "process_name": "ComputePressureCoefficientProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "freestream_density": "$field:freestreamDensity",
                      "freestream_velocity": "$field:freestreamVelocity",
                      "freestream_pressure": "$field:freestreamPressure",
                      "pressure_is_historical": True,
                      "execution_step": "ExecuteBeforeOutputStep",
                  },
              },
              help="Writes PRESSURE_COEFFICIENT on this part's nodes for the output: (p − p∞) over the free-stream dynamic pressure.", category="other", icon="ptResults"),
    condition("yPlus", "Wall y+", list="auxiliar_process_list", target="surface",
              fields=[],
              process_template={
                  "python_module": "compute_y_plus_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "process_name": "ComputeYPlusProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "output_variable_name": "Y_PLUS",
                      "output_to_elements": False,
                      "calculate_normals_every_time_step": False,
                      "echo_level": 0,
                  },
              },
              help="Writes Y_PLUS on this wall's faces for the output, to check the first cell height against the wall model.", category="other", icon="ptResults"),
    condition("integrationStats", "Integration-point statistics", list="auxiliar_process_list", target="volume",
              fields=[field("statisticType", "Statistic", "enum", default="average", options=[{"value": "average", "label": "Average"}, {"value": "variance", "label": "Variance"}, {"value": "third_order_moment", "label": "Third-order moment"}]),
                      field("variable", "Variable(s)", "string", default="VELOCITY", help="One variable for an average, one or two for a variance, three for a third-order moment, comma-separated."),
                      field("tags", "Tags", "string", default="", help="Comma-separated output names for a vector average (VELOCITY fills VELOCITY_X, VELOCITY_Y, VELOCITY_Z itself); empty for a scalar."),
                      field("outputFile", "Output file", "string", default="statistics"),
                      field("startTime", "Start time [s]", "number", default=0, min=0)],
              process_template={

              },
              help="Samples a statistic at the integration points over time (average, variance or third-order moment) and writes it to a file. One entry per assignment on the same part merges into a single process; a variance or third-order moment needs its average on the same part, and a vector average needs a tag per component (VELOCITY tags itself).", category="other", icon="ptResults", no_process=True),
]

MATERIAL_LAWS = [
    material_law("newtonian_3d", "Newtonian3DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("DYNAMIC_VISCOSITY", "Dynamic viscosity [Pa·s]", "number", default=0.001, unit="Pa·s")],
                 domain_size=3),
    material_law("newtonian_2d", "Newtonian2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("DYNAMIC_VISCOSITY", "Dynamic viscosity [Pa·s]", "number", default=0.001, unit="Pa·s")],
                 domain_size=2),
    material_law("bingham_3d", "Bingham3DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("DYNAMIC_VISCOSITY", "Plastic viscosity [Pa·s]", "number", default=0.001, unit="Pa·s"),
                            field("YIELD_STRESS", "Yield stress [Pa]", "number", default=1, unit="Pa"),
                            field("REGULARIZATION_COEFFICIENT", "Regularization coefficient", "number", default=100)],
                 group="Non-Newtonian",
                 when={"field": "strategy", "equals": "monolithic"},
                 domain_size=3),
    material_law("bingham_2d", "Bingham2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("DYNAMIC_VISCOSITY", "Plastic viscosity [Pa·s]", "number", default=0.001, unit="Pa·s"),
                            field("YIELD_STRESS", "Yield stress [Pa]", "number", default=1, unit="Pa"),
                            field("REGULARIZATION_COEFFICIENT", "Regularization coefficient", "number", default=100)],
                 group="Non-Newtonian",
                 when={"field": "strategy", "equals": "monolithic"},
                 domain_size=2),
    material_law("herschel_bulkley_3d", "HerschelBulkley3DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("YIELD_STRESS", "Yield stress [Pa]", "number", default=1, unit="Pa"),
                            field("POWER_LAW_K", "Consistency index K", "number", default=0.001),
                            field("POWER_LAW_N", "Power-law index n", "number", default=1),
                            field("REGULARIZATION_COEFFICIENT", "Regularization coefficient", "number", default=100)],
                 group="Non-Newtonian",
                 when={"field": "strategy", "equals": "monolithic"},
                 domain_size=3),
    material_law("temperature_dependent_3d", "NewtonianTemperatureDependent3DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("TEMPERATURE_TABLE", "Viscosity table [K, Pa·s]", "string", default="293.15,1e-3; 373.15,2.8e-4", help="Temperature–viscosity pairs, one `T,mu` per `;`, read as the TEMPERATURE–DYNAMIC_VISCOSITY table. Set the nodal TEMPERATURE (initial temperature) or every node reads the table at 0 K.")],
                 group="Temperature dependent",
                 when={"field": "strategy", "equals": "monolithic"},
                 tables=[{
                     "id": "Table1",
                     "input_variable": "TEMPERATURE",
                     "output_variable": "DYNAMIC_VISCOSITY",
                     "data_field": "TEMPERATURE_TABLE",
                 }],
                 domain_size=3),
    material_law("temperature_dependent_2d", "NewtonianTemperatureDependent2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("TEMPERATURE_TABLE", "Viscosity table [K, Pa·s]", "string", default="293.15,1e-3; 373.15,2.8e-4", help="Temperature–viscosity pairs, one `T,mu` per `;`, read as the TEMPERATURE–DYNAMIC_VISCOSITY table. Set the nodal TEMPERATURE (initial temperature) or every node reads the table at 0 K.")],
                 group="Temperature dependent",
                 when={"field": "strategy", "equals": "monolithic"},
                 tables=[{
                     "id": "Table1",
                     "input_variable": "TEMPERATURE",
                     "output_variable": "DYNAMIC_VISCOSITY",
                     "data_field": "TEMPERATURE_TABLE",
                 }],
                 domain_size=2),
]

define_problemtype(
    id="fluid_py",
    name=NAME,
    sections=[SECTION_0],
    conditions=CONDITIONS,
    material_laws=MATERIAL_LAWS,
    solver_settings=solver_settings,
    build_process=build_process,
    post_process=post_process,
    validate=validate,
    description="Incompressible Navier-Stokes: monolithic (QSVMS, DVMS, FIC) or fractional step (FluidDynamicsApplication)",
    icon="ptFluid",
    family="fluid",
    analysis_stage="KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis",
    model_part_name="FluidModelPart",
    materials_file_name="FluidMaterials.json",
    domain_sizes=[2, 3],
    parts_condition="parts",
    mesh_naming={
        "elements": "Element",
        "conditions": "WallCondition",
    },
    output={
        "nodal_defaults": ["VELOCITY", "PRESSURE"],
    },
)
