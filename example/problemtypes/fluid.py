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

from kratos_problemtype import (define_problemtype, section, field, field_group,
                                condition, material_law)

NAME = "Fluid Dynamics (Python example)"

# Conditions that are not boundary skin: GiD lists them in no_skin_parts.
NO_SKIN = ("velocityConstraints", "pressureConstraints")


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


def build_process(cond, assignment, ctx):
    values = assignment["values"]
    if cond["id"] == "inlet":
        process = _resolve(cond["processTemplate"], assignment, ctx)
        direction = values.get("direction", "automatic_inwards_normal")
        process["Parameters"]["direction"] = {
            "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1],
        }.get(direction, direction)
        return process
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
    skin, no_skin = [], []
    for a in ctx["assignments"]:
        if a["conditionId"] == "parts" or a["conditionId"].startswith("initial"):
            continue
        name = ctx["model_part_name"] + "." + a["smpPath"].replace("/", ".")
        (no_skin if a["conditionId"] in NO_SKIN else skin).append(name)
    settings = {
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "solver_type": "FractionalStep" if fractional else "Monolithic",
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "echo_level": values["echoLevel"],
        "compute_reactions": values["computeReactions"],
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
        # Only the VMS family has an orthogonal-subscales switch.
        if element_type in ("qsvms", "dvms", "vms"):
            formulation["use_orthogonal_subscales"] = values["oss"]
        formulation["dynamic_tau"] = values["dynamicTau"]
        settings["formulation"] = formulation
        if linear:
            settings["linear_solver_settings"] = linear
    settings["reform_dofs_at_each_step"] = False
    return settings


def post_process(project_parameters, ctx):
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
    field("strategy", "Strategy", "enum", default="monolithic", options=[{"value": "monolithic", "label": "Monolithic"}, {"value": "fractional_step", "label": "Fractional step"}], group="formulation"),
    field("elementType", "Element", "enum", default="qsvms", options=[{"value": "qsvms", "label": "Quasi-static VMS"}, {"value": "dvms", "label": "Dynamic VMS"}, {"value": "fic", "label": "FIC"}, {"value": "vms", "label": "Classic VMS (legacy)"}], visible_when={"field": "strategy", "equals": "monolithic"}, group="formulation"),
    field("timeScheme", "Time scheme", "enum", default="bdf2", options=[{"value": "bdf2", "label": "BDF2"}, {"value": "bossak", "label": "Bossak"}], visible_when={"field": "strategy", "equals": "monolithic"}, group="formulation"),
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
    condition("initialVelocity", "Initial velocity", list="constraints_process_list", target="any",
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
    condition("initialPressure", "Initial pressure", list="constraints_process_list", target="any",
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
    condition("inlet", "Inlet velocity", list="constraints_process_list", target="surface",
              fields=[field("modulus", "|v| [m/s]", "number", default=1),
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
