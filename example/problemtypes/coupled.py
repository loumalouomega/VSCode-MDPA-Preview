"""Fluid-Structure Interaction and generic CoSimulation problemtypes — Python ports of the built-ins.

Faithful ports of src/problemtype/builtins/fsi.ts and cosim.ts, kept in one
file because both compose the same two physics: the Fluid and Structural
Mechanics hooks below are copies of example/problemtypes/fluid.py and
structural.py (each port is executed alone, so it cannot import them), and
src/test/problemtypeExamples.test.ts asserts both problemtypes generate
byte-identical case files to the TypeScript originals, the CoSimulation
participant documents included.

The declarations are generated from the TypeScript originals by
scripts/problemtype-to-python.mjs (the fluid and structure sections,
conditions and material laws are shared by both); only the hooks are
hand-written. They show what a coupled problemtype needs:

* ``domains`` — one mesh slice and one materials file per physics;
* ``coupling_interfaces`` — Generate checks the two interface sides pair up,
  carry boundary cells and overlap;
* hooks that call one physics' hooks with the unprefixed values of its fields;
* ``extra_files`` returning documents as JSON values, which the host writes
  formatted like the primary document (``ProjectParametersCFD.json`` and
  ``ProjectParametersCSM.json`` for CoSimulation);
* ``driver_template`` — the shipped FSI or CoSimulation driver, which records
  the coupling iterations of every step.
"""

import math
import re

from kratos_problemtype import (define_problemtype, section, field, field_group,
                                condition, material_law, domain)

F = "f_"
S = "s_"


# --- shared helpers (the generator's own rules) --------------------------------------

def _num(value, default):
    """asNum: a finite number, else the default (bools are not numbers)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return value if value == value and value not in (float("inf"), float("-inf")) else default


def _str(value, default):
    return value if isinstance(value, str) else default


_JS_DECIMAL = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_JS_RADIX = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+")


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


def _unprefix(values, prefix):
    """The values whose ids start with prefix, with the prefix removed."""
    return {key[len(prefix):]: value for key, value in values.items() if key.startswith(prefix)}


def _dotted(smp_path):
    return smp_path.replace("/", ".")


def _field_default(spec):
    if "default" in spec:
        return spec["default"]
    kind = spec["type"]
    if kind in ("number", "int"):
        return 0
    if kind == "bool":
        return False
    if kind == "vector3":
        return [0, 0, 0]
    if kind == "enum":
        options = spec.get("options") or []
        return options[0]["value"] if options else ""
    if kind in ("smpList", "numberList", "stringList"):
        return []
    return ""


def _resolve(cond, assignment, ctx):
    """resolveProcessTemplate: $path / $root / $field:<id> (falling back to the field's default)."""
    def field_value(field_id):
        if field_id in assignment["values"]:
            return assignment["values"][field_id]
        spec = next((f for f in cond["fields"] if f["id"] == field_id), None)
        return _field_default(spec) if spec is not None else None

    def walk(node):
        if isinstance(node, str):
            if node == "$path":
                return ctx["model_part_name"] + "." + _dotted(assignment["smpPath"])
            if node == "$root":
                return ctx["model_part_name"]
            if node.startswith("$field:"):
                return field_value(node[len("$field:"):])
            return node
        if isinstance(node, list):
            return [walk(item) for item in node]
        if isinstance(node, dict):
            return {key: walk(item) for key, item in node.items()}
        return node

    return walk(cond["processTemplate"])


def _broadcast_constrained(cond, assignment, ctx):
    """The single "Fixed" checkbox of an AssignVectorVariableProcess becomes
    Kratos' per-component ``constrained: [b, b, b]`` (None for any other process)."""
    if cond["processTemplate"].get("python_module") != "assign_vector_variable_process":
        return None
    process = _resolve(cond, assignment, ctx)
    fixed = assignment["values"].get("constrained", True)
    fixed = fixed if isinstance(fixed, bool) else True
    value = assignment["values"].get("value")
    process["Parameters"]["model_part_name"] = ctx["model_part_name"] + "." + _dotted(assignment["smpPath"])
    process["Parameters"]["constrained"] = [fixed, fixed, fixed]
    process["Parameters"]["value"] = value if isinstance(value, list) else [0, 0, 0]
    return process


def _fluid_time_stepping_errors(values):
    """The error half of validateFluidTimeStepping (timeStepEstimate.ts)."""
    def num(v):
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf") else None
    errors = []
    mode = values.get("timeStepMode")
    if mode is not None and mode not in ("fixed", "adaptive"):
        return [f'Time stepping mode "{mode}" is unknown (expected "fixed" or "adaptive").']
    dt = num(values.get("timeStep"))
    if dt is None or not dt > 0:
        errors.append("Time step must be a positive number.")
    if mode == "adaptive":
        co, lo, hi = (num(values.get(k)) for k in ("courantTarget", "minDeltaTime", "maxDeltaTime"))
        if co is None or not co > 0:
            errors.append("Target Courant number must be a positive number.")
        if lo is None or not lo > 0:
            errors.append("Min. time step must be a positive number.")
        if hi is None or not hi > 0:
            errors.append("Max. time step must be a positive number.")
        if lo is not None and hi is not None and lo > 0 and hi > 0 and lo > hi:
            errors.append("Min. time step exceeds Max. time step.")
    return errors


# --- the Fluid Dynamics hooks (example/problemtypes/fluid.py) ------------------------

FLUID_NO_SKIN = ("velocityConstraints", "pressureConstraints")


def _linear_solver(values):
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


def fluid_build_process(cond, assignment, ctx):
    values = assignment["values"]
    if cond["id"] == "inlet":
        process = _resolve(cond, assignment, ctx)
        # The optional symbolic modulus and activation window (fluid.ts's inlet hook).
        expression = _str(values.get("modulusExpression"), "").strip()
        if expression:
            process["Parameters"]["modulus"] = expression
        process["Parameters"]["interval"] = [_num(values.get("intervalStart"), 0), _interval_end(values.get("intervalEnd"))]
        direction = values.get("direction")
        if direction in ("x", "y", "z"):
            process["Parameters"]["direction"] = {"x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1]}[direction]
        return process
    if cond["id"] == "wallLaw":
        process = _resolve(cond, assignment, ctx)
        if process["Parameters"]["wall_model_name"] == "linear_log":
            process["Parameters"]["wall_model_settings"] = {"y_wall": _num(values.get("yWall"), 0.001)}
        else:
            process["Parameters"]["wall_model_settings"] = {"slip_length": _num(values.get("slipLength"), 0.001)}
        return process
    return _broadcast_constrained(cond, assignment, ctx)


def fluid_solver_settings(values, ctx):
    fractional = values["strategy"] == "fractional_step"
    skin, no_skin = [], []
    for a in ctx["assignments"]:
        if a["conditionId"] == "parts" or a["conditionId"].startswith("initial"):
            continue
        name = ctx["model_part_name"] + "." + _dotted(a["smpPath"])
        (no_skin if a["conditionId"] in FLUID_NO_SKIN else skin).append(name)
    settings = {
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "solver_type": "FractionalStep" if fractional else "Monolithic",
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "echo_level": values["echoLevel"],
        "compute_reactions": values["computeReactions"],
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
                "time_step": values["timeStep"],
            }
            if values["timeStepMode"] == "adaptive"
            else {"automatic_time_step": False, "time_step": values["timeStep"]}
        ),
    }
    linear = _linear_solver(values)
    if fractional:
        settings["dynamic_tau"] = values["dynamicTau"]
        settings["predictor_corrector"] = values["predictorCorrector"]
        if values["predictorCorrector"]:
            settings["pressure_tolerance"] = values["pressureTolerance"]
            settings["maximum_pressure_iterations"] = values["maxPressureIterations"]
        settings["velocity_tolerance"] = values["velocityTolerance"]
        settings["maximum_velocity_iterations"] = values["maxVelocityIterations"]
        if linear:
            settings["velocity_linear_solver_settings"] = dict(linear)
            settings["pressure_linear_solver_settings"] = dict(linear)
    else:
        element_type = values["elementType"]
        settings["maximum_iterations"] = values["maxIterations"]
        settings["relative_velocity_tolerance"] = values["relVelTol"]
        settings["absolute_velocity_tolerance"] = values["absVelTol"]
        settings["relative_pressure_tolerance"] = values["relPresTol"]
        settings["absolute_pressure_tolerance"] = values["absPresTol"]
        settings["time_scheme"] = values["timeScheme"]
        formulation = {"element_type": element_type}
        if element_type in ("qsvms", "dvms", "vms"):
            formulation["use_orthogonal_subscales"] = values["oss"]
        formulation["dynamic_tau"] = values["dynamicTau"]
        settings["formulation"] = formulation
        if linear:
            settings["linear_solver_settings"] = linear
    settings["reform_dofs_at_each_step"] = False
    return settings


def fluid_post_process(project_parameters, ctx):
    modulus = _num(ctx["values"].get("gravityValue"), 0)
    if modulus == 0:
        return project_parameters
    direction = ctx["values"].get("gravityDirection")
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
            "direction": direction if isinstance(direction, list) else [0, -1, 0],
        },
    }]
    return project_parameters


# --- the Structural Mechanics hooks (example/problemtypes/structural.py) -------------

FORMULATIONS = {
    "LinearTimoshenkoBeamElement": {"rotation": True},
    "LinearTimoshenkoCurvedBeamElement": {"rotation": True},
    "CrBeamElement": {"rotation": True},
    "CrLinearBeamElement": {"rotation": True},
    "ShellThinElementCorotational": {"rotation": True},
    "ShellThickElementCorotational": {"rotation": True},
    "ShellThinElement": {"rotation": True},
    "MITCThickShellElement": {"rotation": True},
    "MITCThickShellCorotationalElement": {"rotation": True},
    "CSDSG3ThickShellLinearElement": {"rotation": True},
    "CSDSG3ThickShellCorotationalElement": {"rotation": True},
    "BushingElement": {"rotation": True},
    "SpringDamperElement": {"rotation": True},
    "SmallDisplacementMixedVolumetricStrainElement": {"volumetric_strain": True},
    "SmallDisplacementMixedVolumetricStrainOssElement": {"volumetric_strain": True},
    "SmallDisplacementMixedVolumetricStrainOssNonLinearElement": {"volumetric_strain": True},
    "TotalLagrangianMixedVolumetricStrainElement": {"volumetric_strain": True},
    "SmallDisplacementMixedStrainElement": {"strain": True},
}


def structural_solver_settings(values, ctx):
    kind = values["solverType"]
    dynamic = kind == "dynamic"
    eigen = kind == "eigen_value"
    flags = FORMULATIONS.get(values["elementBase"], {})
    settings = {
        "solver_type": "eigen_value" if eigen else "Dynamic" if dynamic else "Static",
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "echo_level": values["echoLevel"],
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "time_stepping": {"time_step": values["timeStep"]},
        "rotation_dofs": flags.get("rotation", False),
    }
    if flags.get("strain"):
        settings["strain_dofs"] = True
    if flags.get("volumetric_strain"):
        settings["volumetric_strain_dofs"] = True
    if eigen:
        settings["eigensolver_settings"] = {
            "solver_type": "eigen_eigensystem",
            "max_iteration": values["eigenMaxIteration"],
            "tolerance": values["eigenTolerance"],
            "number_of_eigenvalues": values["eigenCount"],
            "echo_level": 1,
        }
        settings["builder_and_solver_settings"] = {"use_block_builder": False}
        return settings
    non_linear = values["analysisType"] == "non_linear"
    settings["analysis_type"] = "non_linear" if non_linear else "linear"
    if dynamic:
        settings["time_integration_method"] = "implicit"
        settings["scheme_type"] = values["schemeType"]
        settings["rayleigh_alpha"] = values["rayleighAlpha"]
        settings["rayleigh_beta"] = values["rayleighBeta"]
    if non_linear:
        criterion = values["convergenceCriterion"]
        settings["convergence_criterion"] = criterion
        if criterion != "displacement_criterion":
            settings["residual_relative_tolerance"] = values["residualRelTol"]
            settings["residual_absolute_tolerance"] = values["residualAbsTol"]
        if criterion != "residual_criterion":
            settings["displacement_relative_tolerance"] = values["displacementRelTol"]
            settings["displacement_absolute_tolerance"] = values["displacementAbsTol"]
        settings["max_iteration"] = values["maxIteration"]
        settings["line_search"] = values["lineSearch"]
        settings["use_old_stiffness_in_first_iteration"] = values["useOldStiffness"]
    solver = values["linearSolver"]
    if solver in ("cg", "bicgstab"):
        settings["linear_solver_settings"] = {
            "solver_type": solver,
            "max_iteration": values["linearMaxIteration"],
            "tolerance": values["linearTolerance"],
            "preconditioner_type": values["preconditioner"],
            "scaling": False,
        }
    elif solver != "automatic":
        settings["linear_solver_settings"] = {"solver_type": solver}
    return settings


def structural_build_process(cond, assignment, ctx):
    return _broadcast_constrained(cond, assignment, ctx)


def structural_post_process(project_parameters, ctx):
    if ctx["values"]["solverType"] != "eigen_value":
        return project_parameters
    project_parameters.pop("output_processes", None)
    project_parameters["processes"]["list_other_processes"].append({
        "python_module": "postprocess_eigenvalues_process",
        "kratos_module": "KratosMultiphysics.StructuralMechanicsApplication",
        "help": "This process postprocces the eigen values for GiD",
        "process_name": "PostProcessEigenvaluesProcess",
        "Parameters": {
            "result_file_name": ctx["mdpa_stem"],
            "animation_steps": 20,
            "file_format": "gid",
            "label_type": "frequency",
        },
    })
    return project_parameters


def _own(cond, prefix):
    """The physics' own condition behind a prefixed one (only its id differs for the hooks)."""
    return dict(cond, id=cond["id"][len(prefix):])


def _strip(assignment, prefix):
    return dict(assignment, conditionId=assignment["conditionId"][len(prefix):])


def coupled_build_process(cond, assignment, ctx):
    """Each prefixed condition is built by its physics' hook (None = its template)."""
    if cond["id"].startswith(F):
        own = _own(cond, F)
        return fluid_build_process(own, assignment, ctx) or _resolve(own, assignment, ctx)
    if cond["id"].startswith(S):
        own = _own(cond, S)
        return structural_build_process(own, assignment, ctx) or _resolve(own, assignment, ctx)
    return None


def _interfaces(ctx):
    domains = ctx.get("domains") or {}
    fluid = [a["smpPath"] for a in domains.get("fluid", {}).get("assignments", []) if a["conditionId"] == "fluidInterface"]
    structure = [a["smpPath"] for a in domains.get("structure", {}).get("assignments", []) if a["conditionId"] == "structureInterface"]
    return fluid, structure


def coupled_validate(ctx):
    return _fluid_time_stepping_errors(_unprefix(ctx["values"], F))


# --- FSI (fsi.ts) ----------------------------------------------------------------------

FSI_FLUID_NO_SKIN = ("velocityConstraints", "pressureConstraints", "aleMeshBC")


def fsi_build_process(cond, assignment, ctx):
    built = coupled_build_process(cond, assignment, ctx)
    if built is not None or cond["id"].startswith(F) or cond["id"].startswith(S):
        return built
    # ALE mesh BC: a plain AssignVectorVariableProcess with the Fixed broadcast.
    return structural_build_process(cond, assignment, ctx)


def fsi_solver_settings(values, ctx):
    fluid_ctx = ctx["domains"]["fluid"]
    struct_ctx = ctx["domains"]["structure"]
    time = {"startTime": values.get("startTime"), "endTime": values.get("endTime")}
    fluid_values = dict(_unprefix(values, F), **time)
    fluid_settings = fluid_solver_settings(fluid_values, dict(
        fluid_ctx,
        assignments=[_strip(a, F) if a["conditionId"].startswith(F) else a for a in fluid_ctx["assignments"]]))
    # The fluid hook splits skin / no-skin by condition id; the interface is a skin, the mesh BC is not.
    skin, no_skin = [], []
    for a in fluid_ctx["assignments"]:
        cid = a["conditionId"][len(F):] if a["conditionId"].startswith(F) else a["conditionId"]
        if cid == "parts" or cid.startswith("initial"):
            continue
        (no_skin if cid in FSI_FLUID_NO_SKIN else skin).append(fluid_ctx["model_part_name"] + "." + _dotted(a["smpPath"]))
    fluid_settings["skin_parts"] = skin
    fluid_settings["no_skin_parts"] = no_skin
    struct_values = dict(_unprefix(values, S), **time)
    struct_values["timeStep"] = _num(values.get("f_timeStep"), 0.01)
    struct_settings = structural_solver_settings(struct_values, struct_ctx)
    struct_settings["time_stepping"] = fluid_settings["time_stepping"]  # the structure takes the fluid's step
    fl, st = _interfaces(ctx)

    def mapper_face(smp):
        hit = next((a for a in fluid_ctx["assignments"]
                    if a["smpPath"] == smp and a["conditionId"] == "fluidInterface"), None)
        face = hit["values"].get("mapperFace") if hit else None
        return face if face is not None else "unique"

    method = _str(values.get("couplingStrategy"), "Relaxation")
    strategy = {"solver_type": method, "w_0": _num(values.get("w0"), 0.825)}
    if method == "Relaxation":
        strategy["acceleration_type"] = _str(values.get("accelerationType"), "Aitken")
    if method == "MVQN_recursive":
        strategy["buffer_size"] = _num(values.get("bufferSize"), 7)
    return {
        "solver_type": "Partitioned",
        "coupling_scheme": _str(values.get("couplingScheme"), "DirichletNeumann"),
        "echo_level": 1,
        "structure_solver_settings": struct_settings,
        "fluid_solver_settings": fluid_settings,
        "mesh_solver_settings": {
            "echo_level": 0,
            "domain_size": ctx["domain_size"],
            "model_part_name": fluid_ctx["model_part_name"],
            "solver_type": _str(values.get("meshSolver"), "structural_similarity"),
        },
        "coupling_settings": {
            "nl_tol": _num(values.get("nlTol"), 1e-7),
            "nl_max_it": _num(values.get("nlMaxIt"), 25),
            "solve_mesh_at_each_iteration": values.get("solveMeshAtEachIteration") is not False,
            "mapper_settings": [{
                "mapper_face": mapper_face(smp),
                "fluid_interface_submodelpart_name": fluid_ctx["model_part_name"] + "." + _dotted(smp),
                "structure_interface_submodelpart_name": struct_ctx["model_part_name"] + "." + _dotted(st[i] if i < len(st) else st[0]),
            } for i, smp in enumerate(fl)],
            "coupling_strategy_settings": strategy,
            "structure_interfaces_list": [struct_ctx["model_part_name"] + "." + _dotted(smp) for smp in st],
            "fluid_interfaces_list": [fluid_ctx["model_part_name"] + "." + _dotted(smp) for smp in fl],
        },
    }


def fsi_post_process(pp, ctx):
    processes = pp["processes"]
    # The fluid gravity process lives in its own list in the coupled analysis.
    scratch = fluid_post_process({"processes": {}}, dict(ctx["domains"]["fluid"], values=_unprefix(ctx["values"], F)))
    # Output: one vtk process per physics (the structure's variables are fixed, the user's list goes to the fluid).
    outputs = pp.get("output_processes")
    vtk = (outputs or {}).get("vtk_output")
    if vtk:
        fluid_out = json_copy(vtk[0])
        fluid_out["Parameters"]["model_part_name"] = ctx["domains"]["fluid"]["model_part_name"]
        struct_out = json_copy(vtk[0])
        p = struct_out["Parameters"]
        p["model_part_name"] = ctx["domains"]["structure"]["model_part_name"]
        p["nodal_solution_step_data_variables"] = ["DISPLACEMENT", "REACTION"]
        p["gauss_point_variables_extrapolated_to_nodes"] = ["VON_MISES_STRESS"]
        outputs["vtk_output"] = [fluid_out, struct_out]
    gravity = scratch["processes"].get("gravity")
    if gravity:
        processes["fluid_gravity"] = gravity
    for key in ("fluid_initial_conditions_process_list", "fluid_boundary_conditions_process_list",
                "structure_constraints_process_list", "structure_loads_process_list"):
        processes.setdefault(key, [])
    for key in ("constraints_process_list", "loads_process_list", "list_other_processes"):
        processes.pop(key, None)
    return pp


def json_copy(value):
    if isinstance(value, dict):
        return {k: json_copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_copy(v) for v in value]
    return value


# --- CoSimulation (cosim.ts) -------------------------------------------------------------

PRIMARY_DOCUMENT = "ProjectParametersCoSim.json"
CFD_DOCUMENT = "ProjectParametersCFD.json"
CSM_DOCUMENT = "ProjectParametersCSM.json"
MAPPER = "kratos_mapping"

# The participants' own declarations, as the generator needs them: the analysis
# stage, the parts condition, the output defaults, and each condition's own list
# (the prefixed copies above carry the coupled analysis' list names).
FLUID_PHYSICS = {
    "analysis_stage": "KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis",
    "nodal_defaults": ["VELOCITY", "PRESSURE"],
    "gauss_defaults": [],
    "lists": {"list_other_processes": "list_other_processes",
              "fluid_initial_conditions_process_list": "initial_conditions_process_list",
              "fluid_boundary_conditions_process_list": "constraints_process_list"},
    "solver_settings": fluid_solver_settings,
    "build_process": fluid_build_process,
    "post_process": fluid_post_process,
}
STRUCTURE_PHYSICS = {
    "analysis_stage": "KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis",
    "nodal_defaults": ["DISPLACEMENT", "REACTION"],
    "gauss_defaults": ["VON_MISES_STRESS"],
    "lists": {"list_other_processes": "list_other_processes",
              "structure_constraints_process_list": "constraints_process_list",
              "structure_loads_process_list": "loads_process_list"},
    "solver_settings": structural_solver_settings,
    "build_process": structural_build_process,
    "post_process": structural_post_process,
}


def _vtk_output_process(ctx, output, gauss):
    return {
        "python_module": "vtk_output_process",
        "kratos_module": "KratosMultiphysics",
        "process_name": "VtkOutputProcess",
        "help": "This process writes postprocessing files for Paraview",
        "Parameters": {
            "model_part_name": ctx["model_part_name"],
            "output_control_type": output["controlType"],
            "output_interval": output["interval"],
            "file_format": output["format"],
            "output_precision": 7,
            "output_sub_model_parts": False,
            "output_path": "vtk_output",
            "save_output_files_in_folder": True,
            "nodal_solution_step_data_variables": list(output["nodalVariables"]),
            "nodal_data_value_variables": [],
            "element_data_value_variables": [],
            "condition_data_value_variables": [],
            "gauss_point_variables_extrapolated_to_nodes": list(gauss),
        },
    }


def _participant_document(physics, prefix, conditions, ctx, domain, extra, nodal_variables):
    """One participant's own solver document, as its physics problemtype builds it
    (buildProcesses + buildSolverDocument), from that participant's domain."""
    assignments = [_strip(a, prefix) for a in domain["assignments"] if a["conditionId"].startswith(prefix)]
    values = dict(_unprefix(ctx["values"], prefix), **extra)
    own_ctx = dict(domain, values=values, assignments=assignments)
    output = dict(ctx.get("output") or {"format": "ascii", "controlType": "step", "interval": 1},
                  nodalVariables=list(nodal_variables))
    own = {c["id"][len(prefix):]: dict(c, id=c["id"][len(prefix):], list=physics["lists"][c["list"]])
           for c in conditions}
    processes = {"constraints_process_list": [], "loads_process_list": [], "list_other_processes": []}
    for c in own.values():
        processes.setdefault(c["list"], [])
    for a in assignments:
        cond = own.get(a["conditionId"])
        if cond is None or cond["id"] == "parts" or cond.get("noProcess"):
            continue
        built = physics["build_process"](cond, a, own_ctx)
        processes[cond["list"]].append(built if built is not None else _resolve(cond, a, own_ctx))
    document = {
        "analysis_stage": physics["analysis_stage"],
        "problem_data": {
            "problem_name": own_ctx["mdpa_stem"],
            "parallel_type": "OpenMP",
            "echo_level": _num(values.get("echoLevel"), 1),
            "start_time": _num(values.get("startTime"), 0),
            "end_time": _num(values.get("endTime"), 1),
        },
        "solver_settings": physics["solver_settings"](values, own_ctx),
        "processes": processes,
        "output_processes": {
            "gid_output": [],
            "vtk_output": [_vtk_output_process(own_ctx, output, physics["gauss_defaults"])],
        },
    }
    return physics["post_process"](document, own_ctx)


def _pair_suffix(i):
    return "" if i == 0 else f"_{i + 1}"


def _mapper_settings(values, dim):
    kind = _str(values.get("mapperType"), "nearest_element")
    if kind == "barycentric":
        return {"mapper_type": kind, "interpolation_type": "line" if dim == 2 else "triangle"}
    return {"mapper_type": kind}


def _predictor(values, suffix):
    kind = _str(values.get("predictor"), "average_value_based")
    base = {"type": kind, "solver": "fluid", "data_name": f"fluid_interface_displacement{suffix}"}
    if kind == "average_value_based":
        return dict(base, beta=_num(values.get("predictorBeta"), 0.5))
    if kind == "linear_derivative_based":
        return dict(base, derivative_data_name=f"fluid_interface_velocity{suffix}")
    return None


def _accelerator(values, suffix):
    kind = _str(values.get("accelerator"), "mvqn")
    base = {"type": kind, "solver": "fluid", "data_name": f"fluid_interface_displacement{suffix}"}
    if kind == "aitken":
        return dict(base,
                    init_alpha=_num(values.get("aitkenInitAlpha"), 0.1),
                    init_alpha_max=_num(values.get("aitkenInitAlphaMax"), 0.45),
                    alpha_max=_num(values.get("aitkenAlphaMax"), 2.0),
                    alpha_min=_num(values.get("aitkenAlphaMin"), -2.0))
    if kind in ("mvqn", "iqnils"):
        return dict(base, alpha=_num(values.get("acceleratorAlpha"), 0.125))
    return None


def cosim_solver_settings(values, ctx):
    fl, st = _interfaces(ctx)
    dim = ctx["domain_size"]
    strong = _str(values.get("couplingType"), "weak") == "strong"
    ale = values.get("aleMesh") is True
    with_velocity = _str(values.get("predictor"), "average_value_based") == "linear_derivative_based"
    fluid_part = ctx["domains"]["fluid"]["model_part_name"]
    structure_part = ctx["domains"]["structure"]["model_part_name"]
    fluid_data, structure_data = {}, {}
    structure_inputs, structure_outputs = [], []
    predictors, accelerators, criteria = [], [], []
    for i in range(min(len(fl), len(st))):
        suffix = _pair_suffix(i)
        fluid_node = fluid_part + "." + _dotted(fl[i])
        structure_node = structure_part + "." + _dotted(st[i])
        fluid_data[f"fluid_interface_load{suffix}"] = {"model_part_name": fluid_node, "variable_name": "REACTION", "dimension": dim}
        fluid_data[f"fluid_interface_displacement{suffix}"] = {
            "model_part_name": fluid_node, "variable_name": "MESH_DISPLACEMENT" if ale else "DISPLACEMENT", "dimension": dim}
        if with_velocity:
            fluid_data[f"fluid_interface_velocity{suffix}"] = {"model_part_name": fluid_node, "variable_name": "VELOCITY", "dimension": dim}
        structure_data[f"structure_interface_load{suffix}"] = {"model_part_name": structure_node, "variable_name": "POINT_LOAD", "dimension": dim}
        structure_data[f"structure_interface_displacement{suffix}"] = {"model_part_name": structure_node, "variable_name": "DISPLACEMENT", "dimension": dim}
        structure_inputs.append({
            "data": f"structure_interface_load{suffix}",
            "from_solver": "fluid",
            "from_solver_data": f"fluid_interface_load{suffix}",
            "data_transfer_operator": MAPPER,
            "data_transfer_operator_options": ["swap_sign"],
        })
        structure_outputs.append({
            "data": f"structure_interface_displacement{suffix}",
            "to_solver": "fluid",
            "to_solver_data": f"fluid_interface_displacement{suffix}",
            "data_transfer_operator": MAPPER,
        })
        predictor = _predictor(values, suffix)
        if predictor:
            predictors.append(predictor)
        if strong:
            accelerator = _accelerator(values, suffix)
            if accelerator:
                accelerators.append(accelerator)
            criteria.append({
                "type": "relative_norm_previous_residual",
                "solver": "fluid",
                "data_name": f"fluid_interface_displacement{suffix}",
                "abs_tolerance": _num(values.get("absTolerance"), 1e-5),
                "rel_tolerance": _num(values.get("relTolerance"), 1e-5),
            })
    settings = {"type": "coupled_solvers.gauss_seidel_strong" if strong else "coupled_solvers.gauss_seidel_weak",
                "echo_level": 1}
    if strong:
        settings["num_coupling_iterations"] = _num(values.get("numCouplingIterations"), 10)
        settings["convergence_accelerators"] = accelerators
        settings["convergence_criteria"] = criteria
    settings["predictors"] = predictors
    settings["data_transfer_operators"] = {MAPPER: {"type": MAPPER, "mapper_settings": _mapper_settings(values, dim)}}
    settings["coupling_sequence"] = [
        {"name": "fluid", "input_data_list": [], "output_data_list": []},
        {"name": "structure", "input_data_list": structure_inputs, "output_data_list": structure_outputs},
    ]
    settings["solvers"] = {
        "fluid": {
            "type": "solver_wrappers.kratos.fluid_dynamics_wrapper",
            "solver_wrapper_settings": {"input_file": CFD_DOCUMENT},
            "data": fluid_data,
        },
        "structure": {
            "type": "solver_wrappers.kratos.structural_mechanics_wrapper",
            "solver_wrapper_settings": {"input_file": CSM_DOCUMENT},
            "data": structure_data,
        },
    }
    return settings


def cosim_validate(ctx):
    problems = []
    ale = ctx["values"].get("aleMesh") is True
    if _str(ctx["values"].get("couplingType"), "weak") == "strong" and not ale:
        problems.append(
            'Strong coupling needs the fluid mesh to move: turn on "Move the fluid mesh (ALE)". Without it the fluid '
            "never sees the structure's displacement, so the iterations have nothing to converge.")
    held = [a for a in ctx["domains"]["fluid"]["assignments"] if a["conditionId"] == "aleMeshBC"]
    if not ale and held:
        names = ", ".join(f'"{a["smpPath"]}"' for a in held)
        problems.append(
            f'"ALE mesh displacement" is assigned to {names} but the fluid mesh does not move: '
            'turn on "Move the fluid mesh (ALE)" or remove the assignment.')
    return problems + coupled_validate(ctx)


def cosim_post_process(pp, ctx):
    return {
        "problem_data": {
            "problem_name": ctx["mdpa_stem"],
            "parallel_type": "OpenMP",
            "echo_level": 1,
            "start_time": _num(ctx["values"].get("startTime"), 0),
            "end_time": _num(ctx["values"].get("endTime"), 1),
        },
        "solver_settings": pp["solver_settings"],
    }


def _fix_mesh_displacement(model_part):
    return {
        "python_module": "fix_vector_variable_process",
        "kratos_module": "KratosMultiphysics",
        "process_name": "AssignVectorVariableProcess",
        "Parameters": {"model_part_name": model_part, "variable_name": "MESH_DISPLACEMENT", "constrained": [True, True, True]},
    }


def cosim_extra_files(ctx, materials):
    domains = ctx["domains"]
    fl, _ = _interfaces(ctx)
    values = ctx["values"]
    ale = values.get("aleMesh") is True
    time = {"startTime": values.get("startTime", 0) if values.get("startTime") is not None else 0,
            "endTime": values.get("endTime", 1) if values.get("endTime") is not None else 1}
    nodal = list((ctx.get("output") or {}).get("nodalVariables") or FLUID_PHYSICS["nodal_defaults"])
    if ale and "MESH_DISPLACEMENT" not in nodal:
        nodal.append("MESH_DISPLACEMENT")
    fluid_document = _participant_document(FLUID_PHYSICS, F, FLUID_CONDITIONS, ctx, domains["fluid"], time, nodal)
    fluid_settings = fluid_document["solver_settings"]
    # The interfaces are skins of the fluid solver, although they are not its processes.
    fluid_settings["skin_parts"] = list(fluid_settings.get("skin_parts") or []) + [
        domains["fluid"]["model_part_name"] + "." + _dotted(smp) for smp in fl]
    # A skin wall that nothing constrains carries no reaction out of the fluid
    # solve, so the structure would receive an empty load: constrain the
    # interface velocity (the AleFluidSolver then sets it from the mesh).
    fluid_document["processes"]["constraints_process_list"] = list(
        fluid_document["processes"].get("constraints_process_list") or []) + [
        {"python_module": "apply_noslip_process",
         "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
         "process_name": "ApplyNoSlipProcess",
         "Parameters": {"model_part_name": domains["fluid"]["model_part_name"] + "." + _dotted(smp)}}
        for smp in fl]
    structure_document = _participant_document(
        STRUCTURE_PHYSICS, S, STRUCTURE_CONDITIONS, ctx, domains["structure"],
        dict(time, timeStep=_num(values.get("f_timeStep"), 0.01)), STRUCTURE_PHYSICS["nodal_defaults"])
    # Both participants advance with the same time step, as GiD's coupled cases do.
    structure_document["solver_settings"]["time_stepping"] = fluid_settings["time_stepping"]
    if ale:
        fluid_document["solver_settings"] = {
            "solver_type": "ale_fluid",
            "ale_boundary_parts": [_dotted(smp) for smp in fl],
            "mesh_motion_solver_settings": {"solver_type": _str(values.get("meshSolver"), "structural_similarity")},
            "fluid_solver_settings": fluid_settings,
        }
        ale_bc = next(c for c in COSIM_INTERFACE_CONDITIONS if c["id"] == "aleMeshBC")
        held = [structural_build_process(ale_bc, a, domains["fluid"])
                for a in domains["fluid"]["assignments"] if a["conditionId"] == "aleMeshBC"]
        fluid_document["processes"]["ale_boundary_conditions"] = [
            _fix_mesh_displacement(domains["fluid"]["model_part_name"] + "." + _dotted(smp)) for smp in fl
        ] + [p for p in held if p is not None]
    # Documents returned as JSON values are written by the host, formatted like the primary document.
    return [
        {"name": CFD_DOCUMENT, "content": fluid_document},
        {"name": CSM_DOCUMENT, "content": structure_document},
    ]


# --- declarations of "fsi" and "cosim" generated by scripts/problemtype-to-python.mjs ---
# (the fluid and structure sections, conditions, laws and the domains are shared)

FLUID_SECTION = section("fluid", "Fluid",
    field("f_strategy", "Strategy", "enum", default="monolithic", options=[{"value": "monolithic", "label": "Monolithic"}, {"value": "fractional_step", "label": "Fractional step"}], group="f_formulation"),
    field("f_elementType", "Element", "enum", default="qsvms", options=[{"value": "qsvms", "label": "Quasi-static VMS"}, {"value": "dvms", "label": "Dynamic VMS"}, {"value": "fic", "label": "FIC"}, {"value": "vms", "label": "Classic VMS (legacy)"}], visible_when={"field": "f_strategy", "equals": "monolithic"}, group="f_formulation"),
    field("f_timeScheme", "Time scheme", "enum", default="bdf2", options=[{"value": "bdf2", "label": "BDF2"}, {"value": "bossak", "label": "Bossak"}], visible_when={"field": "f_strategy", "equals": "monolithic"}, group="f_formulation"),
    field("f_oss", "Orthogonal subscales", "bool", default=False, visible_when=[{"field": "f_strategy", "equals": "monolithic"}, {"field": "f_elementType", "one_of": ["qsvms", "dvms"]}], group="f_formulation"),
    field("f_dynamicTau", "Dynamic tau", "number", default=1, group="f_formulation", min=0),
    field("f_timeStepMode", "Time stepping", "enum", default="fixed", options=[{"value": "fixed", "label": "Fixed step"}, {"value": "adaptive", "label": "Adaptive (CFL)"}], group="f_time"),
    field("f_timeStep", "Time step", "number", default=0.01, unit="s", group="f_time", min=0),
    field("f_courantTarget", "Target Courant number", "number", default=1, visible_when={"field": "f_timeStepMode", "equals": "adaptive"}, group="f_time"),
    field("f_minDeltaTime", "Min. time step", "number", default=0.0001, visible_when={"field": "f_timeStepMode", "equals": "adaptive"}, group="f_time"),
    field("f_maxDeltaTime", "Max. time step", "number", default=0.1, visible_when={"field": "f_timeStepMode", "equals": "adaptive"}, group="f_time"),
    field("f_refVelocity", "Reference velocity (estimate only)", "number", default=1, group="f_time"),
    field("f_maxIterations", "Max iterations", "int", default=10, visible_when={"field": "f_strategy", "equals": "monolithic"}, group="f_convergence", min=1),
    field("f_relVelTol", "Rel. velocity tol.", "number", default=0.001, visible_when={"field": "f_strategy", "equals": "monolithic"}, group="f_convergence", min=0),
    field("f_absVelTol", "Abs. velocity tol.", "number", default=0.00001, visible_when={"field": "f_strategy", "equals": "monolithic"}, group="f_convergence", min=0),
    field("f_relPresTol", "Rel. pressure tol.", "number", default=0.001, visible_when={"field": "f_strategy", "equals": "monolithic"}, group="f_convergence", min=0),
    field("f_absPresTol", "Abs. pressure tol.", "number", default=0.00001, visible_when={"field": "f_strategy", "equals": "monolithic"}, group="f_convergence", min=0),
    field("f_velocityTolerance", "Velocity tolerance", "number", default=0.001, visible_when={"field": "f_strategy", "equals": "fractional_step"}, group="f_convergence", min=0),
    field("f_maxVelocityIterations", "Max velocity iterations", "int", default=4, visible_when={"field": "f_strategy", "equals": "fractional_step"}, group="f_convergence", min=1),
    field("f_predictorCorrector", "Predictor-corrector", "bool", default=False, visible_when={"field": "f_strategy", "equals": "fractional_step"}, group="f_convergence"),
    field("f_pressureTolerance", "Pressure tolerance", "number", default=0.001, visible_when=[{"field": "f_strategy", "equals": "fractional_step"}, {"field": "f_predictorCorrector", "equals": True}], group="f_convergence", min=0),
    field("f_maxPressureIterations", "Max pressure iterations", "int", default=4, visible_when=[{"field": "f_strategy", "equals": "fractional_step"}, {"field": "f_predictorCorrector", "equals": True}], group="f_convergence", min=1),
    field("f_gravityValue", "Gravity", "number", default=0, unit="m/s²", help="Body force modulus; 0 writes no gravity process.", group="f_gravity", min=0),
    field("f_gravityDirection", "Direction", "vector3", default=[0, -1, 0], group="f_gravity"),
    field("f_linearSolver", "Solver", "enum", default="automatic", options=[{"value": "automatic", "label": "Automatic"}, {"value": "LinearSolversApplication.sparse_lu", "label": "Sparse LU"}, {"value": "cg", "label": "Conjugate gradients"}, {"value": "bicgstab", "label": "BiCGStab"}], help="Automatic lets Kratos pick the default solver of the selected strategy.", group="f_linear"),
    field("f_linearMaxIteration", "Max iterations", "int", default=200, visible_when={"field": "f_linearSolver", "one_of": ["cg", "bicgstab"]}, group="f_linear", min=1),
    field("f_linearTolerance", "Tolerance", "number", default=1e-7, visible_when={"field": "f_linearSolver", "one_of": ["cg", "bicgstab"]}, group="f_linear", min=0),
    field("f_preconditioner", "Preconditioner", "enum", default="none", options=["none", "diagonal", "ilu", "ilu0"], visible_when={"field": "f_linearSolver", "one_of": ["cg", "bicgstab"]}, group="f_linear"),
    field("f_echoLevel", "Echo level", "int", default=0, min=0, max=3, advanced=True),
    field("f_computeReactions", "Compute reactions", "bool", default=False, advanced=True),
    groups=[field_group("f_formulation", "Fluid · Formulation", icon="ptSolver"), field_group("f_time", "Fluid · Time", icon="ptTime"), field_group("f_convergence", "Fluid · Convergence", icon="ptSolver"), field_group("f_gravity", "Fluid · Gravity", icon="ptGravity", collapsed=True), field_group("f_linear", "Fluid · Linear solver", icon="ptSolver", collapsed=True)],
    icon="ptFluid")

STRUCTURE_SECTION = section("structure", "Structure",
    field("s_solverType", "Analysis", "enum", default="static", options=[{"value": "static", "label": "Static"}, {"value": "dynamic", "label": "Dynamic"}, {"value": "eigen_value", "label": "Eigenvalues"}], group="s_analysis"),
    field("s_analysisType", "Linearity", "enum", default="linear", options=[{"value": "linear", "label": "Linear"}, {"value": "non_linear", "label": "Non-linear"}], visible_when={"field": "s_solverType", "one_of": ["static", "dynamic"]}, group="s_analysis"),
    field("s_elementBase", "Element formulation", "enum", default="SmallDisplacementElement", options=[{"value": "SmallDisplacementElement", "label": "Solid small displacements"}, {"value": "SmallDisplacementBbarElement", "label": "Solid small displacements B-bar"}, {"value": "SmallDisplacementMixedVolumetricStrainElement", "label": "Solid small displacements mixed u-εvol"}, {"value": "SmallDisplacementMixedVolumetricStrainOssElement", "label": "Solid small displacements mixed u-εvol (OSS)"}, {"value": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "label": "Solid small displacements mixed u-εvol (OSS, non-linear)"}, {"value": "SmallDisplacementMixedStrainElement", "label": "Solid small displacements mixed u-ε"}, {"value": "TotalLagrangianElement", "label": "Solid total Lagrangian"}, {"value": "UpdatedLagrangianElement", "label": "Solid updated Lagrangian"}, {"value": "TotalLagrangianMixedVolumetricStrainElement", "label": "Solid total Lagrangian mixed u-εvol"}, {"value": "TotalLagrangianQ1P0MixedElement", "label": "Solid total Lagrangian Q1P0"}, {"value": "AxisymSmallDisplacementElement", "label": "Axisymmetric small displacements"}, {"value": "AxisymTotalLagrangianElement", "label": "Axisymmetric total Lagrangian"}, {"value": "AxisymUpdatedLagrangianElement", "label": "Axisymmetric updated Lagrangian"}, {"value": "SolidShellElementSprism", "label": "Solid-shell (SPRISM 3D6N)"}, {"value": "LinearTimoshenkoBeamElement", "label": "Beam small displacements (Timoshenko)"}, {"value": "LinearTimoshenkoCurvedBeamElement", "label": "Beam small displacements (curved Timoshenko)"}, {"value": "CrBeamElement", "label": "Beam large displacements (corotational)"}, {"value": "CrLinearBeamElement", "label": "Beam small displacements (corotational)"}, {"value": "LinearTrussElement", "label": "Truss small displacements"}, {"value": "TotalLagrangianTrussElement", "label": "Truss large displacements"}, {"value": "TrussElement", "label": "Truss large displacements (legacy)"}, {"value": "TrussLinearElement", "label": "Truss small displacements (legacy)"}, {"value": "CableElement", "label": "Cable"}, {"value": "ShellThinElementCorotational", "label": "Shell thin corotational"}, {"value": "ShellThickElementCorotational", "label": "Shell thick corotational"}, {"value": "ShellThinElement", "label": "Shell thin"}, {"value": "MITCThickShellElement", "label": "Shell thick (MITC)"}, {"value": "MITCThickShellCorotationalElement", "label": "Shell thick corotational (MITC)"}, {"value": "CSDSG3ThickShellLinearElement", "label": "Shell thick CS-DSG3"}, {"value": "CSDSG3ThickShellCorotationalElement", "label": "Shell thick corotational CS-DSG3"}, {"value": "MembraneElement", "label": "Membrane"}, {"value": "NodalConcentratedElement", "label": "Point mass"}, {"value": "NodalConcentratedDampedElement", "label": "Point mass (damped)"}, {"value": "LineMassElement", "label": "Line mass"}, {"value": "SurfaceMassElement", "label": "Surface mass"}, {"value": "BushingElement", "label": "Bushing"}, {"value": "SpringDamperElement", "label": "Spring / damper"}], group="s_analysis"),
    field("s_schemeType", "Scheme", "enum", default="bossak", options=[{"value": "newmark", "label": "Newmark"}, {"value": "bossak", "label": "Bossak"}], visible_when={"field": "s_solverType", "equals": "dynamic"}, help="Bossak damps high-frequency accelerations; Newmark does not.", group="s_analysis"),
    field("s_convergenceCriterion", "Convergence criterion", "enum", default="residual_criterion", options=[{"value": "residual_criterion", "label": "Residual"}, {"value": "displacement_criterion", "label": "Displacement"}, {"value": "and_criterion", "label": "Residual and displacement"}, {"value": "or_criterion", "label": "Residual or displacement"}], visible_when=[{"field": "s_analysisType", "equals": "non_linear"}, {"field": "s_solverType", "one_of": ["static", "dynamic"]}], group="s_nonlinear"),
    field("s_residualRelTol", "Residual rel. tol.", "number", default=0.0001, visible_when=[{"field": "s_analysisType", "equals": "non_linear"}, {"field": "s_convergenceCriterion", "one_of": ["residual_criterion", "and_criterion", "or_criterion"]}], group="s_nonlinear", min=0),
    field("s_residualAbsTol", "Residual abs. tol.", "number", default=1e-9, visible_when=[{"field": "s_analysisType", "equals": "non_linear"}, {"field": "s_convergenceCriterion", "one_of": ["residual_criterion", "and_criterion", "or_criterion"]}], group="s_nonlinear", min=0),
    field("s_displacementRelTol", "Displacement rel. tol.", "number", default=0.0001, visible_when=[{"field": "s_analysisType", "equals": "non_linear"}, {"field": "s_convergenceCriterion", "one_of": ["displacement_criterion", "and_criterion", "or_criterion"]}], group="s_nonlinear", min=0),
    field("s_displacementAbsTol", "Displacement abs. tol.", "number", default=1e-9, visible_when=[{"field": "s_analysisType", "equals": "non_linear"}, {"field": "s_convergenceCriterion", "one_of": ["displacement_criterion", "and_criterion", "or_criterion"]}], group="s_nonlinear", min=0),
    field("s_maxIteration", "Max iterations", "int", default=10, visible_when={"field": "s_analysisType", "equals": "non_linear"}, group="s_nonlinear", min=1),
    field("s_lineSearch", "Line search", "bool", default=False, visible_when={"field": "s_analysisType", "equals": "non_linear"}, group="s_nonlinear"),
    field("s_useOldStiffness", "Use old stiffness in first iteration", "bool", default=False, visible_when={"field": "s_analysisType", "equals": "non_linear"}, group="s_nonlinear"),
    field("s_rayleighAlpha", "Rayleigh α (mass)", "number", default=0, visible_when={"field": "s_solverType", "equals": "dynamic"}, group="s_dynamic", min=0),
    field("s_rayleighBeta", "Rayleigh β (stiffness)", "number", default=0, visible_when={"field": "s_solverType", "equals": "dynamic"}, group="s_dynamic", min=0),
    field("s_eigenCount", "Number of eigenvalues", "int", default=5, visible_when={"field": "s_solverType", "equals": "eigen_value"}, group="s_eigen", min=1),
    field("s_eigenMaxIteration", "Max iterations", "int", default=1000, visible_when={"field": "s_solverType", "equals": "eigen_value"}, group="s_eigen", min=1),
    field("s_eigenTolerance", "Tolerance", "number", default=0.000001, visible_when={"field": "s_solverType", "equals": "eigen_value"}, group="s_eigen", min=0),
    field("s_linearSolver", "Solver", "enum", default="automatic", options=[{"value": "automatic", "label": "Automatic"}, {"value": "LinearSolversApplication.sparse_lu", "label": "Sparse LU"}, {"value": "cg", "label": "Conjugate gradients"}, {"value": "bicgstab", "label": "BiCGStab"}], visible_when={"field": "s_solverType", "one_of": ["static", "dynamic"]}, help="Automatic lets Kratos pick the default solver of the selected strategy.", group="s_linear"),
    field("s_linearMaxIteration", "Max iterations", "int", default=200, visible_when=[{"field": "s_solverType", "one_of": ["static", "dynamic"]}, {"field": "s_linearSolver", "one_of": ["cg", "bicgstab"]}], group="s_linear", min=1),
    field("s_linearTolerance", "Tolerance", "number", default=1e-7, visible_when=[{"field": "s_solverType", "one_of": ["static", "dynamic"]}, {"field": "s_linearSolver", "one_of": ["cg", "bicgstab"]}], group="s_linear", min=0),
    field("s_preconditioner", "Preconditioner", "enum", default="none", options=["none", "diagonal", "ilu", "ilu0"], visible_when=[{"field": "s_solverType", "one_of": ["static", "dynamic"]}, {"field": "s_linearSolver", "one_of": ["cg", "bicgstab"]}], group="s_linear"),
    field("s_echoLevel", "Echo level", "int", default=1, min=0, max=3, advanced=True),
    groups=[field_group("s_analysis", "Structure · Analysis", icon="ptSolver"), field_group("s_nonlinear", "Structure · Non-linear iteration", icon="ptSolver"), field_group("s_dynamic", "Structure · Dynamic damping", icon="ptTime"), field_group("s_eigen", "Structure · Eigenvalue solver", icon="ptSolver"), field_group("s_linear", "Structure · Linear solver", icon="ptSolver", collapsed=True)],
    icon="ptStructural")

FSI_COUPLING_SECTION = section("problem", "Coupling",
    field("startTime", "Start time", "number", default=0, unit="s", group="time"),
    field("endTime", "End time", "number", default=1, unit="s", group="time"),
    field("couplingScheme", "Coupling scheme", "enum", default="DirichletNeumann", options=[{"value": "DirichletNeumann", "label": "Dirichlet-Neumann"}], group="coupling"),
    field("nlTol", "Coupling tolerance", "number", default=1e-7, group="coupling", min=0),
    field("nlMaxIt", "Max. coupling iterations", "int", default=25, group="coupling", min=1),
    field("solveMeshAtEachIteration", "Solve the mesh at each iteration", "bool", default=True, group="coupling"),
    field("couplingStrategy", "Convergence acceleration", "enum", default="Relaxation", options=[{"value": "Relaxation", "label": "Relaxation"}, {"value": "MVQN", "label": "Multi-vector quasi-Newton"}, {"value": "MVQN_recursive", "label": "Recursive multi-vector quasi-Newton"}], group="acceleration"),
    field("accelerationType", "Relaxation type", "enum", default="Aitken", options=["Aitken", "constant"], visible_when={"field": "couplingStrategy", "equals": "Relaxation"}, group="acceleration"),
    field("w0", "Initial relaxation w₀", "number", default=0.825, group="acceleration", min=0, max=1),
    field("bufferSize", "Buffer size", "int", default=7, visible_when={"field": "couplingStrategy", "equals": "MVQN_recursive"}, group="acceleration", min=1),
    field("meshSolver", "ALE mesh solver", "enum", default="structural_similarity", options=[{"value": "structural_similarity", "label": "Structural similarity"}, {"value": "laplacian", "label": "Laplacian"}], group="ale"),
    groups=[field_group("time", "Time", icon="ptTime"), field_group("coupling", "Partitioned coupling", icon="ptCoupling"), field_group("acceleration", "Convergence acceleration", icon="ptSolver"), field_group("ale", "ALE mesh motion", icon="ptSolver")],
    icon="ptCoupling")

COSIM_COUPLING_SECTION = section("coupling", "Coupling",
    field("startTime", "Start time", "number", default=0, unit="s", group="time"),
    field("endTime", "End time", "number", default=1, unit="s", group="time"),
    field("couplingType", "Coupling", "enum", default="weak", options=[{"value": "weak", "label": "Weak (one pass per step)"}, {"value": "strong", "label": "Strong (iterate to convergence)"}], help="Weak coupling exchanges data once per step; strong coupling repeats the exchange until the interface displacement converges. Strong coupling needs ALE mesh motion.", group="coupling"),
    field("numCouplingIterations", "Max coupling iterations", "int", default=10, visible_when={"field": "couplingType", "equals": "strong"}, group="coupling", min=1),
    field("absTolerance", "Absolute tolerance", "number", default=0.00001, visible_when={"field": "couplingType", "equals": "strong"}, help="Of the relative_norm_previous_residual criterion on the fluid interface displacement.", group="coupling", min=0),
    field("relTolerance", "Relative tolerance", "number", default=0.00001, visible_when={"field": "couplingType", "equals": "strong"}, group="coupling", min=0),
    field("accelerator", "Convergence accelerator", "enum", default="mvqn", options=[{"value": "none", "label": "None"}, {"value": "aitken", "label": "Aitken relaxation"}, {"value": "mvqn", "label": "MVQN (multi-vector quasi-Newton)"}, {"value": "iqnils", "label": "IQN-ILS"}], visible_when={"field": "couplingType", "equals": "strong"}, group="acceleration"),
    field("aitkenInitAlpha", "Initial relaxation α₀", "number", default=0.1, visible_when=[{"field": "couplingType", "equals": "strong"}, {"field": "accelerator", "equals": "aitken"}], group="acceleration", advanced=True),
    field("aitkenInitAlphaMax", "Initial relaxation cap", "number", default=0.45, visible_when=[{"field": "couplingType", "equals": "strong"}, {"field": "accelerator", "equals": "aitken"}], group="acceleration", advanced=True),
    field("aitkenAlphaMax", "Largest relaxation", "number", default=2, visible_when=[{"field": "couplingType", "equals": "strong"}, {"field": "accelerator", "equals": "aitken"}], group="acceleration", advanced=True),
    field("aitkenAlphaMin", "Smallest relaxation", "number", default=-2, visible_when=[{"field": "couplingType", "equals": "strong"}, {"field": "accelerator", "equals": "aitken"}], group="acceleration", advanced=True),
    field("acceleratorAlpha", "Quasi-Newton relaxation α", "number", default=0.125, visible_when=[{"field": "couplingType", "equals": "strong"}, {"field": "accelerator", "one_of": ["mvqn", "iqnils"]}], help="The relaxation of the first iteration, before the quasi-Newton update has data.", group="acceleration", advanced=True),
    field("predictor", "Predictor", "enum", default="average_value_based", options=[{"value": "average_value_based", "label": "Average value"}, {"value": "linear_derivative_based", "label": "Linear (from the interface velocity)"}, {"value": "none", "label": "None"}], help="How the interface displacement of a new step is predicted before the fluid solves.", group="acceleration"),
    field("predictorBeta", "Predictor weight β", "number", default=0.5, visible_when={"field": "predictor", "equals": "average_value_based"}, help="Weight of the predicted interface value when a step ends (the average-value predictor).", group="acceleration", min=0, max=1),
    field("mapperType", "Mapper", "enum", default="nearest_element", options=[{"value": "nearest_element", "label": "Nearest element"}, {"value": "nearest_neighbor", "label": "Nearest neighbor"}, {"value": "barycentric", "label": "Barycentric"}], help="The MappingApplication mapper between the two sides of every interface pair.", group="mapping"),
    field("aleMesh", "Move the fluid mesh (ALE)", "bool", default=False, help="The fluid becomes an ale_fluid solver whose interface follows the structure; other fluid boundaries hold their mesh with \"ALE mesh displacement\".", group="ale"),
    field("meshSolver", "Mesh motion solver", "enum", default="structural_similarity", options=[{"value": "structural_similarity", "label": "Structural similarity"}, {"value": "laplacian", "label": "Laplacian"}], visible_when={"field": "aleMesh", "equals": True}, group="ale"),
    groups=[field_group("time", "Time", icon="ptTime"), field_group("coupling", "Partitioned coupling", icon="ptCoupling"), field_group("acceleration", "Prediction and acceleration", icon="ptSolver"), field_group("mapping", "Interface mapping", icon="ptCoupling"), field_group("ale", "ALE mesh motion", icon="ptSolver")],
    icon="ptCoupling")

FLUID_CONDITIONS = [
    condition("f_parts", "Fluid body", list="list_other_processes", target="volume",
              fields=[],
              process_template={

              },
              help="Marks a SubModelPart as the fluid domain; assign a material to it."),
    condition("f_initialVelocity", "Initial velocity", list="fluid_initial_conditions_process_list", target="any",
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
    condition("f_initialPressure", "Initial pressure", list="fluid_initial_conditions_process_list", target="any",
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
    condition("f_inlet", "Inlet velocity", list="fluid_boundary_conditions_process_list", target="surface",
              fields=[field("modulus", "|v| [m/s]", "number", default=1),
                      field("modulusExpression", "|v| expression", "string", default="", advanced=True,
                            help="A Kratos expression in the inlet's own coordinates and the current time t, e.g. 0.1214*(1-cos(0.1*pi*t))*y*(1-y). When set it replaces the numeric |v| above."),
                      field("intervalStart", "Active from [s]", "number", default=0, advanced=True,
                            help="The process applies from this time on. Two inlet assignments on one surface with disjoint windows write a two-phase inlet (the fsi_mok benchmark ramps up until 10 s, then holds)."),
                      field("intervalEnd", "Active until [s]", "string", default="End", advanced=True,
                            help='"End" keeps the process active to the end of the simulation; a number deactivates it there.'),
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
    condition("f_outlet", "Outlet pressure", list="fluid_boundary_conditions_process_list", target="surface",
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
    condition("f_slip", "Slip wall", list="fluid_boundary_conditions_process_list", target="surface",
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
    condition("f_noSlip", "No-slip wall", list="fluid_boundary_conditions_process_list", target="surface",
              fields=[],
              process_template={
                  "python_module": "apply_noslip_process",
                  "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                  "Parameters": {
                      "model_part_name": "$path",
                  },
              },
              category="constraints", icon="ptConstraint"),
    condition("f_wallLaw", "Wall law", list="fluid_boundary_conditions_process_list", target="surface",
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
    condition("f_velocityConstraints", "Custom velocity constraints", list="fluid_boundary_conditions_process_list", target="any",
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
    condition("f_pressureConstraints", "Custom pressure constraints", list="fluid_boundary_conditions_process_list", target="any",
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
]

STRUCTURE_CONDITIONS = [
    condition("s_parts", "Structure body", list="list_other_processes", target="volume",
              fields=[],
              process_template={

              },
              help="Marks a SubModelPart as computing domain; assign a material to it."),
    condition("s_displacement", "Displacement", list="structure_constraints_process_list", target="any",
              fields=[field("value", "Value [m]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=True)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "DISPLACEMENT",
                      "interval": [0, "End"],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              category="constraints", icon="ptConstraint"),
    condition("s_rotation", "Rotation", list="structure_constraints_process_list", target="any",
              fields=[field("value", "Value [rad]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=True)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "ROTATION",
                      "interval": [0, "End"],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              help="Rotational DOFs: beam elements.", category="constraints", icon="ptConstraint"),
    condition("s_pressure", "Pressure", list="structure_constraints_process_list", target="any",
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
              help="Nodal pressure for mixed (u-p) formulations.", category="constraints", icon="ptConstraint"),
    condition("s_volumetricStrain", "Volumetric strain", list="structure_constraints_process_list", target="any",
              fields=[field("value", "Value", "number", default=0),
                      field("constrained", "Fixed", "bool", default=True)],
              process_template={
                  "python_module": "assign_scalar_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignScalarVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "VOLUMETRIC_STRAIN",
                      "interval": [0, "End"],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              help="For the mixed u-εvol formulation.", category="constraints", icon="ptConstraint"),
    condition("s_initialVelocity", "Initial velocity", list="structure_constraints_process_list", target="any",
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
              help="Dynamic analysis: velocity at the first step only.", category="initial", icon="ptInitial"),
    condition("s_initialAcceleration", "Initial acceleration", list="structure_constraints_process_list", target="any",
              fields=[field("value", "Value [m/s²]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=False)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "ACCELERATION",
                      "interval": [0, 0],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              help="Dynamic analysis: acceleration at the first step only.", category="initial", icon="ptInitial"),
    condition("s_angularVelocity", "Angular velocity", list="structure_constraints_process_list", target="any",
              fields=[field("value", "Value [rad/s]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=False)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "ANGULAR_VELOCITY",
                      "interval": [0, 0],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              category="initial", icon="ptInitial"),
    condition("s_angularAcceleration", "Angular acceleration", list="structure_constraints_process_list", target="any",
              fields=[field("value", "Value [rad/s²]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=False)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "ANGULAR_ACCELERATION",
                      "interval": [0, 0],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              category="initial", icon="ptInitial"),
    condition("s_selfWeight", "Self weight", list="structure_loads_process_list", target="volume",
              fields=[field("modulus", "Modulus [m/s²]", "number", default=9.81),
                      field("direction", "Direction", "vector3", default=[0, 0, -1])],
              process_template={
                  "python_module": "assign_vector_by_direction_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorByDirectionProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "VOLUME_ACCELERATION",
                      "modulus": "$field:modulus",
                      "constrained": False,
                      "direction": "$field:direction",
                      "interval": [0, "End"],
                  },
              },
              category="loads", icon="ptGravity"),
    condition("s_pointLoad", "Point load", list="structure_loads_process_list", target="nodes",
              fields=[field("modulus", "Modulus [N]", "number", default=0),
                      field("direction", "Direction", "vector3", default=[0, 0, -1])],
              process_template={
                  "python_module": "assign_vector_by_direction_to_condition_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorByDirectionToConditionProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "POINT_LOAD",
                      "modulus": "$field:modulus",
                      "direction": "$field:direction",
                      "interval": [0, "End"],
                  },
              },
              category="loads", icon="ptLoad"),
    condition("s_pointMoment", "Point moment", list="structure_loads_process_list", target="nodes",
              fields=[field("modulus", "Modulus [N·m]", "number", default=0),
                      field("direction", "Direction", "vector3", default=[0, 0, -1])],
              process_template={
                  "python_module": "assign_vector_by_direction_to_condition_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorByDirectionToConditionProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "POINT_MOMENT",
                      "modulus": "$field:modulus",
                      "direction": "$field:direction",
                      "interval": [0, "End"],
                  },
              },
              help="3D only.", category="loads", icon="ptLoad"),
    condition("s_lineLoad", "Line load", list="structure_loads_process_list", target="surface",
              fields=[field("modulus", "Modulus [N/m]", "number", default=0),
                      field("direction", "Direction", "vector3", default=[0, 0, -1])],
              process_template={
                  "python_module": "assign_vector_by_direction_to_condition_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorByDirectionToConditionProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "LINE_LOAD",
                      "modulus": "$field:modulus",
                      "direction": "$field:direction",
                      "interval": [0, "End"],
                  },
              },
              category="loads", icon="ptLoad"),
    condition("s_surfaceLoad", "Surface load", list="structure_loads_process_list", target="surface",
              fields=[field("modulus", "Modulus [N/m²]", "number", default=0),
                      field("direction", "Direction", "vector3", default=[0, 0, -1])],
              process_template={
                  "python_module": "assign_vector_by_direction_to_condition_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorByDirectionToConditionProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "SURFACE_LOAD",
                      "modulus": "$field:modulus",
                      "direction": "$field:direction",
                      "interval": [0, "End"],
                  },
              },
              help="3D only.", category="loads", icon="ptLoad"),
    condition("s_surfacePressure", "Surface pressure", list="structure_loads_process_list", target="surface",
              fields=[field("value", "Value [Pa]", "number", default=0)],
              process_template={
                  "python_module": "assign_scalar_variable_to_conditions_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignScalarVariableToConditionsProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "POSITIVE_FACE_PRESSURE",
                      "value": "$field:value",
                      "interval": [0, "End"],
                  },
              },
              help="Pressure on boundary faces (3D) or lines (2D).", category="loads", icon="ptLoad"),
]

FSI_INTERFACE_CONDITIONS = [
    condition("aleMeshBC", "ALE mesh displacement", list="fluid_boundary_conditions_process_list", target="any",
              fields=[field("value", "Value [m]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=True)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "MESH_DISPLACEMENT",
                      "interval": [0, "End"],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              help="Fixes the mesh motion on a fluid boundary that does not move with the structure.", category="constraints", icon="ptConstraint"),
    condition("fluidInterface", "FSI fluid interface", list="list_other_processes", target="surface",
              fields=[field("mapperFace", "Mapper face", "enum", default="unique", options=[{"value": "unique", "label": "Unique"}, {"value": "positive", "label": "Positive"}, {"value": "negative", "label": "Negative"}])],
              process_template={

              },
              help="The fluid boundary that exchanges forces and displacements with the structure (a no-slip wall).", category="constraints", icon="ptCoupling", no_process=True),
    condition("structureInterface", "FSI structure interface", list="list_other_processes", target="surface",
              fields=[],
              process_template={

              },
              help="The structure boundary that exchanges forces and displacements with the fluid.", category="constraints", icon="ptCoupling", no_process=True),
]

COSIM_INTERFACE_CONDITIONS = [
    condition("aleMeshBC", "ALE mesh displacement", list="list_other_processes", target="any",
              fields=[field("value", "Value [m]", "vector3", default=[0, 0, 0]),
                      field("constrained", "Fixed", "bool", default=True)],
              process_template={
                  "python_module": "assign_vector_variable_process",
                  "kratos_module": "KratosMultiphysics",
                  "process_name": "AssignVectorVariableProcess",
                  "Parameters": {
                      "model_part_name": "$path",
                      "variable_name": "MESH_DISPLACEMENT",
                      "interval": [0, "End"],
                      "constrained": "$field:constrained",
                      "value": "$field:value",
                  },
              },
              help="Holds the fluid mesh on a boundary that does not move with the structure (ALE mesh motion only).", category="constraints", icon="ptConstraint", no_process=True),
    condition("fluidInterface", "Coupling interface (fluid side)", list="list_other_processes", target="surface",
              fields=[],
              process_template={

              },
              help="The fluid boundary that sends its load to the structure. It marks the interface for the settings; it is not a process.", category="constraints", icon="ptCoupling", no_process=True),
    condition("structureInterface", "Coupling interface (structure side)", list="list_other_processes", target="surface",
              fields=[],
              process_template={

              },
              help="The structure boundary that receives the fluid load and returns its displacement.", category="constraints", icon="ptCoupling", no_process=True),
]

MATERIAL_LAWS = [
    material_law("newtonian_3d", "Newtonian3DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("DYNAMIC_VISCOSITY", "Dynamic viscosity [Pa·s]", "number", default=0.001, unit="Pa·s")],
                 domain_size=3,
                 domain="fluid"),
    material_law("newtonian_2d", "Newtonian2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=1000, unit="kg/m³"),
                            field("DYNAMIC_VISCOSITY", "Dynamic viscosity [Pa·s]", "number", default=0.001, unit="Pa·s")],
                 domain_size=2,
                 domain="fluid"),
    material_law("linear_elastic_3d", "LinearElastic3DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29)],
                 group="Elastic",
                 when={"field": "s_elementBase", "one_of": ["SmallDisplacementElement", "SmallDisplacementBbarElement", "SmallDisplacementMixedVolumetricStrainElement", "SmallDisplacementMixedVolumetricStrainOssElement", "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "SmallDisplacementMixedStrainElement", "TotalLagrangianElement", "UpdatedLagrangianElement", "TotalLagrangianMixedVolumetricStrainElement", "TotalLagrangianQ1P0MixedElement", "SolidShellElementSprism", "ShellThinElementCorotational", "ShellThickElementCorotational", "ShellThinElement", "MITCThickShellElement", "MITCThickShellCorotationalElement", "CSDSG3ThickShellLinearElement", "CSDSG3ThickShellCorotationalElement"]},
                 domain_size=3,
                 domain="structure"),
    material_law("linear_elastic_plane_strain", "LinearElasticPlaneStrain2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Elastic",
                 when={"field": "s_elementBase", "one_of": ["SmallDisplacementElement", "SmallDisplacementBbarElement", "SmallDisplacementMixedVolumetricStrainElement", "SmallDisplacementMixedVolumetricStrainOssElement", "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "SmallDisplacementMixedStrainElement", "TotalLagrangianElement", "UpdatedLagrangianElement", "TotalLagrangianMixedVolumetricStrainElement", "TotalLagrangianQ1P0MixedElement", "SolidShellElementSprism"]},
                 domain_size=2,
                 domain="structure"),
    material_law("linear_elastic_plane_stress", "LinearElasticPlaneStress2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Elastic",
                 when={"field": "s_elementBase", "one_of": ["SmallDisplacementElement", "SmallDisplacementBbarElement", "SmallDisplacementMixedVolumetricStrainElement", "SmallDisplacementMixedVolumetricStrainOssElement", "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "SmallDisplacementMixedStrainElement", "TotalLagrangianElement", "UpdatedLagrangianElement", "TotalLagrangianMixedVolumetricStrainElement", "TotalLagrangianQ1P0MixedElement", "SolidShellElementSprism"]},
                 domain_size=2,
                 domain="structure"),
    material_law("linear_elastic_axisym", "LinearElasticAxisym2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29)],
                 group="Elastic",
                 when={"field": "s_elementBase", "one_of": ["AxisymSmallDisplacementElement", "AxisymTotalLagrangianElement", "AxisymUpdatedLagrangianElement"]},
                 domain_size=2,
                 domain="structure"),
    material_law("beam_2d", "BeamConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²"),
                            field("I33", "Bending inertia I33 [m⁴]", "number", default=1, unit="m⁴")],
                 group="Beam",
                 when={"field": "s_elementBase", "one_of": ["LinearTimoshenkoBeamElement", "LinearTimoshenkoCurvedBeamElement", "CrBeamElement", "CrLinearBeamElement"]},
                 domain_size=2,
                 domain="structure"),
    material_law("beam_3d", "BeamConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²"),
                            field("TORSIONAL_INERTIA", "Torsional inertia [m⁴]", "number", default=1, unit="m⁴"),
                            field("I22", "Bending inertia I22 [m⁴]", "number", default=1, unit="m⁴"),
                            field("I33", "Bending inertia I33 [m⁴]", "number", default=1, unit="m⁴")],
                 group="Beam",
                 when={"field": "s_elementBase", "one_of": ["LinearTimoshenkoBeamElement", "LinearTimoshenkoCurvedBeamElement", "CrBeamElement", "CrLinearBeamElement"]},
                 domain_size=3,
                 domain="structure"),
    material_law("truss", "TrussConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²"),
                            field("TRUSS_PRESTRESS_PK2", "Prestress [Pa]", "number", default=0, unit="Pa")],
                 group="Truss & cable",
                 when={"field": "s_elementBase", "one_of": ["LinearTrussElement", "TotalLagrangianTrussElement", "TrussElement", "TrussLinearElement", "CableElement"]},
                 domain="structure"),
    material_law("shell", "ReissnerMindlinShellElasticConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Shell",
                 when={"field": "s_elementBase", "one_of": ["ShellThinElementCorotational", "ShellThickElementCorotational", "ShellThinElement", "MITCThickShellElement", "MITCThickShellCorotationalElement", "CSDSG3ThickShellLinearElement", "CSDSG3ThickShellCorotationalElement"]},
                 domain_size=3,
                 domain="structure"),
    material_law("membrane", "LinearElasticPlaneStress2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Membrane",
                 when={"field": "s_elementBase", "one_of": ["MembraneElement"]},
                 domain="structure"),
    material_law("point_mass", "",
                 variables=[field("NODAL_MASS", "Point mass [kg]", "number", default=1, unit="kg"),
                            field("NODAL_INERTIA", "Rotational inertia [kg·m²]", "vector3", unit="kg·m²"),
                            field("NODAL_DISPLACEMENT_STIFFNESS", "Spring stiffness [N/m]", "vector3", unit="N/m"),
                            field("NODAL_DAMPING_RATIO", "Damper coefficient [N·s/m]", "vector3", unit="N·s/m")],
                 group="Discrete",
                 when={"field": "s_elementBase", "one_of": ["NodalConcentratedElement", "NodalConcentratedDampedElement"]},
                 domain="structure"),
    material_law("spring", "",
                 variables=[field("NODAL_DISPLACEMENT_STIFFNESS", "Translational stiffness [N/m]", "vector3", unit="N/m"),
                            field("NODAL_ROTATIONAL_STIFFNESS", "Rotational stiffness [N·m/rad]", "vector3", unit="N·m/rad"),
                            field("NODAL_DAMPING_RATIO", "Translational damper [N·s/m]", "vector3", unit="N·s/m"),
                            field("NODAL_ROTATIONAL_DAMPING_RATIO", "Rotational damper [N·m·s/rad]", "vector3", unit="N·m·s/rad")],
                 group="Discrete",
                 when={"field": "s_elementBase", "one_of": ["SpringDamperElement"]},
                 domain="structure"),
    material_law("bushing", "",
                 variables=[field("NODAL_DISPLACEMENT_STIFFNESS", "Translational stiffness [N/m]", "vector3", unit="N/m"),
                            field("NODAL_ROTATIONAL_STIFFNESS", "Rotational stiffness [N·m/rad]", "vector3", unit="N·m/rad")],
                 group="Discrete",
                 when={"field": "s_elementBase", "one_of": ["BushingElement"]},
                 domain_size=3,
                 domain="structure"),
    material_law("line_mass", "",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²")],
                 group="Discrete",
                 when={"field": "s_elementBase", "one_of": ["LineMassElement"]},
                 domain_size=3,
                 domain="structure"),
    material_law("surface_mass", "",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Discrete",
                 when={"field": "s_elementBase", "one_of": ["SurfaceMassElement"]},
                 domain_size=3,
                 domain="structure"),
]

FSI_DOMAINS = [
    domain("fluid", "Fluid", "FluidModelPart", "Fluid", "f_parts",
           condition_ids=["f_parts", "f_initialVelocity", "f_initialPressure", "f_inlet", "f_outlet", "f_slip", "f_noSlip", "f_wallLaw", "f_velocityConstraints", "f_pressureConstraints", "aleMeshBC", "fluidInterface"],
           materials_file_name="FluidMaterials.json",
           required=[{
               "conditionId": "fluidInterface",
               "message": "mark the fluid side of the interface: assign at least one SubModelPart as \"FSI fluid interface\".",
           }],
           mesh_naming={
               "elements": "Element",
               "conditions": "WallCondition",
           }),
    domain("structure", "Structure", "Structure", "Structural", "s_parts",
           condition_ids=["s_parts", "s_displacement", "s_rotation", "s_pressure", "s_volumetricStrain", "s_initialVelocity", "s_initialAcceleration", "s_angularVelocity", "s_angularAcceleration", "s_selfWeight", "s_pointLoad", "s_pointMoment", "s_lineLoad", "s_surfaceLoad", "s_surfacePressure", "structureInterface"],
           materials_file_name="StructuralMaterials.json",
           required=[{
               "conditionId": "structureInterface",
               "message": "mark the structure side of the interface: assign at least one SubModelPart as \"FSI structure interface\".",
           }],
mesh_naming={
               "elements": {
                   "field": "s_elementBase",
                   "names": {
                       "SmallDisplacementElement": {
                           "2": {
                               "3": "SmallDisplacementElement2D3N",
                               "4": "SmallDisplacementElement2D4N",
                               "6": "SmallDisplacementElement2D6N",
                               "8": "SmallDisplacementElement2D8N",
                               "9": "SmallDisplacementElement2D9N",
                               "10": "SmallDisplacementElement2D10N",
                               "15": "SmallDisplacementElement2D15N",
                           },
                           "3": {
                               "4": "SmallDisplacementElement3D4N",
                               "5": "SmallDisplacementElement3D5N",
                               "6": "SmallDisplacementElement3D6N",
                               "8": "SmallDisplacementElement3D8N",
                               "10": "SmallDisplacementElement3D10N",
                               "13": "SmallDisplacementElement3D13N",
                               "15": "SmallDisplacementElement3D15N",
                               "20": "SmallDisplacementElement3D20N",
                               "27": "SmallDisplacementElement3D27N",
                           },
                       },
                       "SmallDisplacementBbarElement": {
                           "2": {
                               "4": "SmallDisplacementBbarElement2D4N",
                           },
                           "3": {
                               "8": "SmallDisplacementBbarElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedVolumetricStrainElement": {
                           "2": {
                               "3": "SmallDisplacementMixedVolumetricStrainElement2D3N",
                               "4": "SmallDisplacementMixedVolumetricStrainElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedVolumetricStrainElement3D4N",
                               "8": "SmallDisplacementMixedVolumetricStrainElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedVolumetricStrainOssElement": {
                           "2": {
                               "3": "SmallDisplacementMixedVolumetricStrainOssElement2D3N",
                               "4": "SmallDisplacementMixedVolumetricStrainOssElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedVolumetricStrainOssElement3D4N",
                               "8": "SmallDisplacementMixedVolumetricStrainOssElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedVolumetricStrainOssNonLinearElement": {
                           "2": {
                               "3": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement2D3N",
                               "4": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement3D4N",
                               "8": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedStrainElement": {
                           "2": {
                               "3": "SmallDisplacementMixedStrainElement2D3N",
                               "4": "SmallDisplacementMixedStrainElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedStrainElement3D4N",
                               "8": "SmallDisplacementMixedStrainElement3D8N",
                           },
                       },
                       "TotalLagrangianElement": {
                           "2": {
                               "3": "TotalLagrangianElement2D3N",
                               "4": "TotalLagrangianElement2D4N",
                               "6": "TotalLagrangianElement2D6N",
                               "8": "TotalLagrangianElement2D8N",
                               "9": "TotalLagrangianElement2D9N",
                               "10": "TotalLagrangianElement2D10N",
                               "15": "TotalLagrangianElement2D15N",
                           },
                           "3": {
                               "4": "TotalLagrangianElement3D4N",
                               "5": "TotalLagrangianElement3D5N",
                               "6": "TotalLagrangianElement3D6N",
                               "8": "TotalLagrangianElement3D8N",
                               "10": "TotalLagrangianElement3D10N",
                               "13": "TotalLagrangianElement3D13N",
                               "15": "TotalLagrangianElement3D15N",
                               "20": "TotalLagrangianElement3D20N",
                               "27": "TotalLagrangianElement3D27N",
                           },
                       },
                       "UpdatedLagrangianElement": {
                           "2": {
                               "3": "UpdatedLagrangianElement2D3N",
                               "4": "UpdatedLagrangianElement2D4N",
                               "6": "UpdatedLagrangianElement2D6N",
                               "8": "UpdatedLagrangianElement2D8N",
                               "9": "UpdatedLagrangianElement2D9N",
                               "10": "UpdatedLagrangianElement2D10N",
                               "15": "UpdatedLagrangianElement2D15N",
                           },
                           "3": {
                               "4": "UpdatedLagrangianElement3D4N",
                               "5": "UpdatedLagrangianElement3D5N",
                               "6": "UpdatedLagrangianElement3D6N",
                               "8": "UpdatedLagrangianElement3D8N",
                               "10": "UpdatedLagrangianElement3D10N",
                               "13": "UpdatedLagrangianElement3D13N",
                               "15": "UpdatedLagrangianElement3D15N",
                               "20": "UpdatedLagrangianElement3D20N",
                               "27": "UpdatedLagrangianElement3D27N",
                           },
                       },
                       "TotalLagrangianMixedVolumetricStrainElement": {
                           "2": {
                               "3": "TotalLagrangianMixedVolumetricStrainElement2D3N",
                           },
                           "3": {
                               "4": "TotalLagrangianMixedVolumetricStrainElement3D4N",
                           },
                       },
                       "TotalLagrangianQ1P0MixedElement": {
                           "2": {
                               "3": "TotalLagrangianQ1P0MixedElement2D3N",
                               "4": "TotalLagrangianQ1P0MixedElement2D4N",
                           },
                           "3": {
                               "4": "TotalLagrangianQ1P0MixedElement3D4N",
                               "8": "TotalLagrangianQ1P0MixedElement3D8N",
                               "10": "TotalLagrangianQ1P0MixedElement3D10N",
                               "20": "TotalLagrangianQ1P0MixedElement3D20N",
                           },
                       },
                       "AxisymSmallDisplacementElement": {
                           "2": {
                               "3": "AxisymSmallDisplacementElement2D3N",
                               "4": "AxisymSmallDisplacementElement2D4N",
                               "6": "AxisymSmallDisplacementElement2D6N",
                               "8": "AxisymSmallDisplacementElement2D8N",
                               "9": "AxisymSmallDisplacementElement2D9N",
                           },
                       },
                       "AxisymTotalLagrangianElement": {
                           "2": {
                               "3": "AxisymTotalLagrangianElement2D3N",
                               "4": "AxisymTotalLagrangianElement2D4N",
                               "6": "AxisymTotalLagrangianElement2D6N",
                               "8": "AxisymTotalLagrangianElement2D8N",
                               "9": "AxisymTotalLagrangianElement2D9N",
                           },
                       },
                       "AxisymUpdatedLagrangianElement": {
                           "2": {
                               "3": "AxisymUpdatedLagrangianElement2D3N",
                               "4": "AxisymUpdatedLagrangianElement2D4N",
                               "6": "AxisymUpdatedLagrangianElement2D6N",
                               "8": "AxisymUpdatedLagrangianElement2D8N",
                               "9": "AxisymUpdatedLagrangianElement2D9N",
                           },
                       },
                       "SolidShellElementSprism": {
                           "3": {
                               "6": "SolidShellElementSprism3D6N",
                           },
                       },
                       "LinearTimoshenkoBeamElement": {
                           "2": {
                               "2": "LinearTimoshenkoBeamElement2D2N",
                               "3": "LinearTimoshenkoBeamElement2D3N",
                           },
                           "3": {
                               "2": "LinearTimoshenkoBeamElement3D2N",
                           },
                       },
                       "LinearTimoshenkoCurvedBeamElement": {
                           "2": {
                               "3": "LinearTimoshenkoCurvedBeamElement2D3N",
                           },
                           "3": {
                               "3": "LinearTimoshenkoCurvedBeamElement3D3N",
                           },
                       },
                       "CrBeamElement": {
                           "2": {
                               "2": "CrBeamElement2D2N",
                           },
                           "3": {
                               "2": "CrBeamElement3D2N",
                           },
                       },
                       "CrLinearBeamElement": {
                           "2": {
                               "2": "CrLinearBeamElement2D2N",
                           },
                           "3": {
                               "2": "CrLinearBeamElement3D2N",
                           },
                       },
                       "LinearTrussElement": {
                           "2": {
                               "2": "LinearTrussElement2D2N",
                               "3": "LinearTrussElement2D3N",
                           },
                           "3": {
                               "2": "LinearTrussElement3D2N",
                               "3": "LinearTrussElement3D3N",
                           },
                       },
                       "TotalLagrangianTrussElement": {
                           "2": {
                               "2": "TotalLagrangianTrussElement2D2N",
                           },
                           "3": {
                               "2": "TotalLagrangianTrussElement3D2N",
                           },
                       },
                       "TrussElement": {
                           "2": {
                               "2": "TrussElement3D2N",
                           },
                           "3": {
                               "2": "TrussElement3D2N",
                           },
                       },
                       "TrussLinearElement": {
                           "2": {
                               "2": "TrussLinearElement3D2N",
                           },
                           "3": {
                               "2": "TrussLinearElement3D2N",
                           },
                       },
                       "CableElement": {
                           "2": {
                               "2": "CableElement3D2N",
                           },
                           "3": {
                               "2": "CableElement3D2N",
                           },
                       },
                       "ShellThinElementCorotational": {
                           "3": {
                               "3": "ShellThinElementCorotational3D3N",
                               "4": "ShellThinElementCorotational3D4N",
                           },
                       },
                       "ShellThickElementCorotational": {
                           "3": {
                               "3": "ShellThickElementCorotational3D3N",
                               "4": "ShellThickElementCorotational3D4N",
                           },
                       },
                       "ShellThinElement": {
                           "3": {
                               "3": "ShellThinElement3D3N",
                           },
                       },
                       "MITCThickShellElement": {
                           "3": {
                               "4": "MITCThickShellElement3D4N",
                           },
                       },
                       "MITCThickShellCorotationalElement": {
                           "3": {
                               "4": "MITCThickShellCorotationalElement3D4N",
                           },
                       },
                       "CSDSG3ThickShellLinearElement": {
                           "3": {
                               "3": "CSDSG3ThickShellLinearElement3D3N",
                           },
                       },
                       "CSDSG3ThickShellCorotationalElement": {
                           "3": {
                               "3": "CSDSG3ThickShellCorotationalElement3D3N",
                           },
                       },
                       "MembraneElement": {
                           "2": {
                               "2": "MembraneElement2D2N",
                           },
                           "3": {
                               "3": "MembraneElement3D3N",
                               "4": "MembraneElement3D4N",
                           },
                       },
                       "NodalConcentratedElement": {
                           "2": {
                               "1": "NodalConcentratedElement2D1N",
                           },
                           "3": {
                               "1": "NodalConcentratedElement3D1N",
                           },
                       },
                       "NodalConcentratedDampedElement": {
                           "2": {
                               "1": "NodalConcentratedDampedElement2D1N",
                           },
                           "3": {
                               "1": "NodalConcentratedDampedElement3D1N",
                           },
                       },
                       "LineMassElement": {
                           "3": {
                               "2": "LineMassElement3D2N",
                           },
                       },
                       "SurfaceMassElement": {
                           "3": {
                               "3": "SurfaceMassElement3D3N",
                               "4": "SurfaceMassElement3D4N",
                           },
                       },
                       "BushingElement": {
                           "3": {
                               "2": "BushingElement3D2N",
                           },
                       },
                       "SpringDamperElement": {
                           "2": {
                               "2": "SpringDamperElement2D",
                           },
                           "3": {
                               "2": "SpringDamperElement3D",
                           },
                       },
                   },
               },
               "conditions": {
                   "2": "LineLoadCondition",
                   "3": "SurfaceLoadCondition",
               },
           }),
]

COSIM_DOMAINS = [
    domain("fluid", "Fluid", "FluidModelPart", "Fluid", "f_parts",
           condition_ids=["f_parts", "f_initialVelocity", "f_initialPressure", "f_inlet", "f_outlet", "f_slip", "f_noSlip", "f_wallLaw", "f_velocityConstraints", "f_pressureConstraints", "aleMeshBC", "fluidInterface"],
           materials_file_name="FluidMaterials.json",
           required=[{
               "conditionId": "fluidInterface",
               "message": "mark the fluid side of the interface: assign at least one SubModelPart as \"Coupling interface (fluid side)\".",
           }],
           mesh_naming={
               "elements": "Element",
               "conditions": "WallCondition",
           }),
    domain("structure", "Structure", "Structure", "Structural", "s_parts",
           condition_ids=["s_parts", "s_displacement", "s_rotation", "s_pressure", "s_volumetricStrain", "s_initialVelocity", "s_initialAcceleration", "s_angularVelocity", "s_angularAcceleration", "s_selfWeight", "s_pointLoad", "s_pointMoment", "s_lineLoad", "s_surfaceLoad", "s_surfacePressure", "structureInterface"],
           materials_file_name="StructuralMaterials.json",
           required=[{
               "conditionId": "structureInterface",
               "message": "mark the structure side of the interface: assign at least one SubModelPart as \"Coupling interface (structure side)\".",
           }],
mesh_naming={
               "elements": {
                   "field": "s_elementBase",
                   "names": {
                       "SmallDisplacementElement": {
                           "2": {
                               "3": "SmallDisplacementElement2D3N",
                               "4": "SmallDisplacementElement2D4N",
                               "6": "SmallDisplacementElement2D6N",
                               "8": "SmallDisplacementElement2D8N",
                               "9": "SmallDisplacementElement2D9N",
                               "10": "SmallDisplacementElement2D10N",
                               "15": "SmallDisplacementElement2D15N",
                           },
                           "3": {
                               "4": "SmallDisplacementElement3D4N",
                               "5": "SmallDisplacementElement3D5N",
                               "6": "SmallDisplacementElement3D6N",
                               "8": "SmallDisplacementElement3D8N",
                               "10": "SmallDisplacementElement3D10N",
                               "13": "SmallDisplacementElement3D13N",
                               "15": "SmallDisplacementElement3D15N",
                               "20": "SmallDisplacementElement3D20N",
                               "27": "SmallDisplacementElement3D27N",
                           },
                       },
                       "SmallDisplacementBbarElement": {
                           "2": {
                               "4": "SmallDisplacementBbarElement2D4N",
                           },
                           "3": {
                               "8": "SmallDisplacementBbarElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedVolumetricStrainElement": {
                           "2": {
                               "3": "SmallDisplacementMixedVolumetricStrainElement2D3N",
                               "4": "SmallDisplacementMixedVolumetricStrainElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedVolumetricStrainElement3D4N",
                               "8": "SmallDisplacementMixedVolumetricStrainElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedVolumetricStrainOssElement": {
                           "2": {
                               "3": "SmallDisplacementMixedVolumetricStrainOssElement2D3N",
                               "4": "SmallDisplacementMixedVolumetricStrainOssElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedVolumetricStrainOssElement3D4N",
                               "8": "SmallDisplacementMixedVolumetricStrainOssElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedVolumetricStrainOssNonLinearElement": {
                           "2": {
                               "3": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement2D3N",
                               "4": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement3D4N",
                               "8": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement3D8N",
                           },
                       },
                       "SmallDisplacementMixedStrainElement": {
                           "2": {
                               "3": "SmallDisplacementMixedStrainElement2D3N",
                               "4": "SmallDisplacementMixedStrainElement2D4N",
                           },
                           "3": {
                               "4": "SmallDisplacementMixedStrainElement3D4N",
                               "8": "SmallDisplacementMixedStrainElement3D8N",
                           },
                       },
                       "TotalLagrangianElement": {
                           "2": {
                               "3": "TotalLagrangianElement2D3N",
                               "4": "TotalLagrangianElement2D4N",
                               "6": "TotalLagrangianElement2D6N",
                               "8": "TotalLagrangianElement2D8N",
                               "9": "TotalLagrangianElement2D9N",
                               "10": "TotalLagrangianElement2D10N",
                               "15": "TotalLagrangianElement2D15N",
                           },
                           "3": {
                               "4": "TotalLagrangianElement3D4N",
                               "5": "TotalLagrangianElement3D5N",
                               "6": "TotalLagrangianElement3D6N",
                               "8": "TotalLagrangianElement3D8N",
                               "10": "TotalLagrangianElement3D10N",
                               "13": "TotalLagrangianElement3D13N",
                               "15": "TotalLagrangianElement3D15N",
                               "20": "TotalLagrangianElement3D20N",
                               "27": "TotalLagrangianElement3D27N",
                           },
                       },
                       "UpdatedLagrangianElement": {
                           "2": {
                               "3": "UpdatedLagrangianElement2D3N",
                               "4": "UpdatedLagrangianElement2D4N",
                               "6": "UpdatedLagrangianElement2D6N",
                               "8": "UpdatedLagrangianElement2D8N",
                               "9": "UpdatedLagrangianElement2D9N",
                               "10": "UpdatedLagrangianElement2D10N",
                               "15": "UpdatedLagrangianElement2D15N",
                           },
                           "3": {
                               "4": "UpdatedLagrangianElement3D4N",
                               "5": "UpdatedLagrangianElement3D5N",
                               "6": "UpdatedLagrangianElement3D6N",
                               "8": "UpdatedLagrangianElement3D8N",
                               "10": "UpdatedLagrangianElement3D10N",
                               "13": "UpdatedLagrangianElement3D13N",
                               "15": "UpdatedLagrangianElement3D15N",
                               "20": "UpdatedLagrangianElement3D20N",
                               "27": "UpdatedLagrangianElement3D27N",
                           },
                       },
                       "TotalLagrangianMixedVolumetricStrainElement": {
                           "2": {
                               "3": "TotalLagrangianMixedVolumetricStrainElement2D3N",
                           },
                           "3": {
                               "4": "TotalLagrangianMixedVolumetricStrainElement3D4N",
                           },
                       },
                       "TotalLagrangianQ1P0MixedElement": {
                           "2": {
                               "3": "TotalLagrangianQ1P0MixedElement2D3N",
                               "4": "TotalLagrangianQ1P0MixedElement2D4N",
                           },
                           "3": {
                               "4": "TotalLagrangianQ1P0MixedElement3D4N",
                               "8": "TotalLagrangianQ1P0MixedElement3D8N",
                               "10": "TotalLagrangianQ1P0MixedElement3D10N",
                               "20": "TotalLagrangianQ1P0MixedElement3D20N",
                           },
                       },
                       "AxisymSmallDisplacementElement": {
                           "2": {
                               "3": "AxisymSmallDisplacementElement2D3N",
                               "4": "AxisymSmallDisplacementElement2D4N",
                               "6": "AxisymSmallDisplacementElement2D6N",
                               "8": "AxisymSmallDisplacementElement2D8N",
                               "9": "AxisymSmallDisplacementElement2D9N",
                           },
                       },
                       "AxisymTotalLagrangianElement": {
                           "2": {
                               "3": "AxisymTotalLagrangianElement2D3N",
                               "4": "AxisymTotalLagrangianElement2D4N",
                               "6": "AxisymTotalLagrangianElement2D6N",
                               "8": "AxisymTotalLagrangianElement2D8N",
                               "9": "AxisymTotalLagrangianElement2D9N",
                           },
                       },
                       "AxisymUpdatedLagrangianElement": {
                           "2": {
                               "3": "AxisymUpdatedLagrangianElement2D3N",
                               "4": "AxisymUpdatedLagrangianElement2D4N",
                               "6": "AxisymUpdatedLagrangianElement2D6N",
                               "8": "AxisymUpdatedLagrangianElement2D8N",
                               "9": "AxisymUpdatedLagrangianElement2D9N",
                           },
                       },
                       "SolidShellElementSprism": {
                           "3": {
                               "6": "SolidShellElementSprism3D6N",
                           },
                       },
                       "LinearTimoshenkoBeamElement": {
                           "2": {
                               "2": "LinearTimoshenkoBeamElement2D2N",
                               "3": "LinearTimoshenkoBeamElement2D3N",
                           },
                           "3": {
                               "2": "LinearTimoshenkoBeamElement3D2N",
                           },
                       },
                       "LinearTimoshenkoCurvedBeamElement": {
                           "2": {
                               "3": "LinearTimoshenkoCurvedBeamElement2D3N",
                           },
                           "3": {
                               "3": "LinearTimoshenkoCurvedBeamElement3D3N",
                           },
                       },
                       "CrBeamElement": {
                           "2": {
                               "2": "CrBeamElement2D2N",
                           },
                           "3": {
                               "2": "CrBeamElement3D2N",
                           },
                       },
                       "CrLinearBeamElement": {
                           "2": {
                               "2": "CrLinearBeamElement2D2N",
                           },
                           "3": {
                               "2": "CrLinearBeamElement3D2N",
                           },
                       },
                       "LinearTrussElement": {
                           "2": {
                               "2": "LinearTrussElement2D2N",
                               "3": "LinearTrussElement2D3N",
                           },
                           "3": {
                               "2": "LinearTrussElement3D2N",
                               "3": "LinearTrussElement3D3N",
                           },
                       },
                       "TotalLagrangianTrussElement": {
                           "2": {
                               "2": "TotalLagrangianTrussElement2D2N",
                           },
                           "3": {
                               "2": "TotalLagrangianTrussElement3D2N",
                           },
                       },
                       "TrussElement": {
                           "2": {
                               "2": "TrussElement3D2N",
                           },
                           "3": {
                               "2": "TrussElement3D2N",
                           },
                       },
                       "TrussLinearElement": {
                           "2": {
                               "2": "TrussLinearElement3D2N",
                           },
                           "3": {
                               "2": "TrussLinearElement3D2N",
                           },
                       },
                       "CableElement": {
                           "2": {
                               "2": "CableElement3D2N",
                           },
                           "3": {
                               "2": "CableElement3D2N",
                           },
                       },
                       "ShellThinElementCorotational": {
                           "3": {
                               "3": "ShellThinElementCorotational3D3N",
                               "4": "ShellThinElementCorotational3D4N",
                           },
                       },
                       "ShellThickElementCorotational": {
                           "3": {
                               "3": "ShellThickElementCorotational3D3N",
                               "4": "ShellThickElementCorotational3D4N",
                           },
                       },
                       "ShellThinElement": {
                           "3": {
                               "3": "ShellThinElement3D3N",
                           },
                       },
                       "MITCThickShellElement": {
                           "3": {
                               "4": "MITCThickShellElement3D4N",
                           },
                       },
                       "MITCThickShellCorotationalElement": {
                           "3": {
                               "4": "MITCThickShellCorotationalElement3D4N",
                           },
                       },
                       "CSDSG3ThickShellLinearElement": {
                           "3": {
                               "3": "CSDSG3ThickShellLinearElement3D3N",
                           },
                       },
                       "CSDSG3ThickShellCorotationalElement": {
                           "3": {
                               "3": "CSDSG3ThickShellCorotationalElement3D3N",
                           },
                       },
                       "MembraneElement": {
                           "2": {
                               "2": "MembraneElement2D2N",
                           },
                           "3": {
                               "3": "MembraneElement3D3N",
                               "4": "MembraneElement3D4N",
                           },
                       },
                       "NodalConcentratedElement": {
                           "2": {
                               "1": "NodalConcentratedElement2D1N",
                           },
                           "3": {
                               "1": "NodalConcentratedElement3D1N",
                           },
                       },
                       "NodalConcentratedDampedElement": {
                           "2": {
                               "1": "NodalConcentratedDampedElement2D1N",
                           },
                           "3": {
                               "1": "NodalConcentratedDampedElement3D1N",
                           },
                       },
                       "LineMassElement": {
                           "3": {
                               "2": "LineMassElement3D2N",
                           },
                       },
                       "SurfaceMassElement": {
                           "3": {
                               "3": "SurfaceMassElement3D3N",
                               "4": "SurfaceMassElement3D4N",
                           },
                       },
                       "BushingElement": {
                           "3": {
                               "2": "BushingElement3D2N",
                           },
                       },
                       "SpringDamperElement": {
                           "2": {
                               "2": "SpringDamperElement2D",
                           },
                           "3": {
                               "2": "SpringDamperElement3D",
                           },
                       },
                   },
               },
               "conditions": {
                   "2": "LineLoadCondition",
                   "3": "SurfaceLoadCondition",
               },
           },
           point_load_interface={
               "conditionId": "structureInterface",
           }),
]


define_problemtype(
    id="fsi_py",
    name="Fluid-Structure Interaction (Python example)",
    sections=[FSI_COUPLING_SECTION, FLUID_SECTION, STRUCTURE_SECTION],
    conditions=FLUID_CONDITIONS + FSI_INTERFACE_CONDITIONS[:2] + STRUCTURE_CONDITIONS + FSI_INTERFACE_CONDITIONS[2:],
    material_laws=MATERIAL_LAWS,
    domains=FSI_DOMAINS,
    solver_settings=fsi_solver_settings,
    build_process=fsi_build_process,
    post_process=fsi_post_process,
    validate=coupled_validate,
    description="Partitioned Dirichlet-Neumann coupling of the fluid and structural solvers over an ALE mesh (FSIApplication)",
    icon="ptFsi",
    family="coupled",
    analysis_stage="KratosMultiphysics.FSIApplication.fsi_analysis",
    model_part_name="FluidModelPart",
    materials_file_name="FluidMaterials.json",
    domain_sizes=[2, 3],
    parts_condition="f_parts",
    applications=["FluidDynamicsApplication", "StructuralMechanicsApplication", "MeshMovingApplication", "MappingApplication"],
    coupling_interfaces=[{"label": "FSI interface", "sides": ["fluidInterface", "structureInterface"]}],
    driver_template="fsi",
    output={"nodal_defaults": ["VELOCITY", "PRESSURE", "MESH_DISPLACEMENT"]},
)

define_problemtype(
    id="cosim_py",
    name="Generic Coupling (CoSimulation, Python example)",
    sections=[COSIM_COUPLING_SECTION, FLUID_SECTION, STRUCTURE_SECTION],
    conditions=FLUID_CONDITIONS + COSIM_INTERFACE_CONDITIONS[:2] + STRUCTURE_CONDITIONS + COSIM_INTERFACE_CONDITIONS[2:],
    material_laws=MATERIAL_LAWS,
    domains=COSIM_DOMAINS,
    solver_settings=cosim_solver_settings,
    build_process=coupled_build_process,
    post_process=cosim_post_process,
    validate=cosim_validate,
    extra_files=cosim_extra_files,
    description="Partitioned weak or strong coupling of the fluid and structural solvers through CoSimulationApplication",
    icon="ptCoupling",
    family="coupled",
    analysis_stage="KratosMultiphysics.CoSimulationApplication.co_simulation_analysis",
    model_part_name="FluidModelPart",
    materials_file_name="FluidMaterials.json",
    domain_sizes=[2, 3],
    parts_condition="f_parts",
    applications=["FluidDynamicsApplication", "StructuralMechanicsApplication", "MappingApplication",
                  {"application": "MeshMovingApplication", "when": {"field": "aleMesh", "equals": True}}],
    coupling_interfaces=[{"label": "Coupling interface", "sides": ["fluidInterface", "structureInterface"]}],
    primary_document_name=PRIMARY_DOCUMENT,
    driver_script_name="MainKratosCoSim.py",
    driver_template="cosim",
    output={"nodal_defaults": ["VELOCITY", "PRESSURE"]},
)
