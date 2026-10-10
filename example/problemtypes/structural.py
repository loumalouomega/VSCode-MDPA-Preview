"""Structural Mechanics problemtype — Python port of the built-in.

A faithful port of the extension's built-in Structural problemtype
(src/problemtype/builtins/structural.ts), kept as a worked example of the
Python authoring API. The parity test src/test/problemtypeExamples.test.ts
asserts it generates byte-identical case files to the TypeScript original.

The declaration below (sections, field groups, conditions, material laws) is
generated from the TypeScript original by scripts/problemtype-to-python.mjs so
it cannot drift; only the hooks are hand-written. They show:

* ``solver_settings`` — Static / Dynamic / eigenvalue solver settings, with the
  non-linear parameters written only for a non-linear analysis;
* ``build_process`` — the single "Fixed" checkbox of each nodal vector
  condition is broadcast into Kratos' per-component ``constrained: [b, b, b]``,
  something a static template cannot do;
* ``post_process`` — an eigenvalue run drops the regular output and adds the
  GiD eigenvalue post-process.
"""

from kratos_problemtype import (define_problemtype, section, field, field_group,
                                condition, material_law)

NAME = "Structural Mechanics (Python example)"

# Element formulations and the DOF flags each switches on in solver_settings.
FORMULATIONS = {
    "LinearTimoshenkoBeamElement": {"rotation": True},
    "CrBeamElement": {"rotation": True},
    "SmallDisplacementMixedVolumetricStrainElement": {"volumetric_strain": True},
    "SmallDisplacementMixedStrainElement": {"strain": True},
}


def solver_settings(values, ctx):
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


def build_process(cond, assignment, ctx):
    template = cond["processTemplate"]
    if template.get("python_module") != "assign_vector_variable_process":
        return None  # every other condition uses its declarative template
    process = _resolve(template, assignment, ctx)
    fixed = assignment["values"].get("constrained", True)
    fixed = fixed if isinstance(fixed, bool) else True
    value = assignment["values"].get("value", [0, 0, 0])
    process["Parameters"]["constrained"] = [fixed, fixed, fixed]
    process["Parameters"]["value"] = value if isinstance(value, list) else [0, 0, 0]
    return process


def post_process(project_parameters, ctx):
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


# --- declaration of "structural" generated by scripts/problemtype-to-python.mjs ---
SECTION_0 = section("problem", "Problem data",
    field("solverType", "Analysis", "enum", default="static", options=[{"value": "static", "label": "Static"}, {"value": "dynamic", "label": "Dynamic"}, {"value": "eigen_value", "label": "Eigenvalues"}], group="analysis"),
    field("analysisType", "Linearity", "enum", default="linear", options=[{"value": "linear", "label": "Linear"}, {"value": "non_linear", "label": "Non-linear"}], visible_when={"field": "solverType", "one_of": ["static", "dynamic"]}, group="analysis"),
    field("elementBase", "Element formulation", "enum", default="SmallDisplacementElement", options=[{"value": "SmallDisplacementElement", "label": "Solid small displacements"}, {"value": "SmallDisplacementBbarElement", "label": "Solid small displacements B-bar"}, {"value": "SmallDisplacementMixedVolumetricStrainElement", "label": "Solid small displacements mixed u-εvol"}, {"value": "SmallDisplacementMixedStrainElement", "label": "Solid small displacements mixed u-ε"}, {"value": "TotalLagrangianElement", "label": "Solid total Lagrangian"}, {"value": "UpdatedLagrangianElement", "label": "Solid updated Lagrangian"}, {"value": "LinearTimoshenkoBeamElement", "label": "Beam small displacements"}, {"value": "CrBeamElement", "label": "Beam large displacements (corotational)"}, {"value": "LinearTrussElement", "label": "Truss small displacements"}, {"value": "TotalLagrangianTrussElement", "label": "Truss large displacements"}], group="analysis"),
    field("schemeType", "Scheme", "enum", default="bossak", options=[{"value": "newmark", "label": "Newmark"}, {"value": "bossak", "label": "Bossak"}], visible_when={"field": "solverType", "equals": "dynamic"}, help="Bossak damps high-frequency accelerations; Newmark does not.", group="analysis"),
    field("startTime", "Start time", "number", default=0, unit="s", group="time"),
    field("timeStep", "Time step", "number", default=0.1, unit="s", group="time", min=0),
    field("endTime", "End time", "number", default=1, unit="s", group="time"),
    field("convergenceCriterion", "Convergence criterion", "enum", default="residual_criterion", options=[{"value": "residual_criterion", "label": "Residual"}, {"value": "displacement_criterion", "label": "Displacement"}, {"value": "and_criterion", "label": "Residual and displacement"}, {"value": "or_criterion", "label": "Residual or displacement"}], visible_when=[{"field": "analysisType", "equals": "non_linear"}, {"field": "solverType", "one_of": ["static", "dynamic"]}], group="nonlinear"),
    field("residualRelTol", "Residual rel. tol.", "number", default=0.0001, visible_when=[{"field": "analysisType", "equals": "non_linear"}, {"field": "convergenceCriterion", "one_of": ["residual_criterion", "and_criterion", "or_criterion"]}], group="nonlinear", min=0),
    field("residualAbsTol", "Residual abs. tol.", "number", default=1e-9, visible_when=[{"field": "analysisType", "equals": "non_linear"}, {"field": "convergenceCriterion", "one_of": ["residual_criterion", "and_criterion", "or_criterion"]}], group="nonlinear", min=0),
    field("displacementRelTol", "Displacement rel. tol.", "number", default=0.0001, visible_when=[{"field": "analysisType", "equals": "non_linear"}, {"field": "convergenceCriterion", "one_of": ["displacement_criterion", "and_criterion", "or_criterion"]}], group="nonlinear", min=0),
    field("displacementAbsTol", "Displacement abs. tol.", "number", default=1e-9, visible_when=[{"field": "analysisType", "equals": "non_linear"}, {"field": "convergenceCriterion", "one_of": ["displacement_criterion", "and_criterion", "or_criterion"]}], group="nonlinear", min=0),
    field("maxIteration", "Max iterations", "int", default=10, visible_when={"field": "analysisType", "equals": "non_linear"}, group="nonlinear", min=1),
    field("lineSearch", "Line search", "bool", default=False, visible_when={"field": "analysisType", "equals": "non_linear"}, group="nonlinear"),
    field("useOldStiffness", "Use old stiffness in first iteration", "bool", default=False, visible_when={"field": "analysisType", "equals": "non_linear"}, group="nonlinear"),
    field("rayleighAlpha", "Rayleigh α (mass)", "number", default=0, visible_when={"field": "solverType", "equals": "dynamic"}, group="dynamic", min=0),
    field("rayleighBeta", "Rayleigh β (stiffness)", "number", default=0, visible_when={"field": "solverType", "equals": "dynamic"}, group="dynamic", min=0),
    field("eigenCount", "Number of eigenvalues", "int", default=5, visible_when={"field": "solverType", "equals": "eigen_value"}, group="eigen", min=1),
    field("eigenMaxIteration", "Max iterations", "int", default=1000, visible_when={"field": "solverType", "equals": "eigen_value"}, group="eigen", min=1),
    field("eigenTolerance", "Tolerance", "number", default=0.000001, visible_when={"field": "solverType", "equals": "eigen_value"}, group="eigen", min=0),
    field("linearSolver", "Solver", "enum", default="automatic", options=[{"value": "automatic", "label": "Automatic"}, {"value": "LinearSolversApplication.sparse_lu", "label": "Sparse LU"}, {"value": "cg", "label": "Conjugate gradients"}, {"value": "bicgstab", "label": "BiCGStab"}], visible_when={"field": "solverType", "one_of": ["static", "dynamic"]}, help="Automatic lets Kratos pick the default solver of the selected strategy.", group="linear"),
    field("linearMaxIteration", "Max iterations", "int", default=200, visible_when=[{"field": "solverType", "one_of": ["static", "dynamic"]}, {"field": "linearSolver", "one_of": ["cg", "bicgstab"]}], group="linear", min=1),
    field("linearTolerance", "Tolerance", "number", default=1e-7, visible_when=[{"field": "solverType", "one_of": ["static", "dynamic"]}, {"field": "linearSolver", "one_of": ["cg", "bicgstab"]}], group="linear", min=0),
    field("preconditioner", "Preconditioner", "enum", default="none", options=["none", "diagonal", "ilu", "ilu0"], visible_when=[{"field": "solverType", "one_of": ["static", "dynamic"]}, {"field": "linearSolver", "one_of": ["cg", "bicgstab"]}], group="linear"),
    field("echoLevel", "Echo level", "int", default=1, min=0, max=3, advanced=True),
    groups=[field_group("analysis", "Analysis", icon="ptSolver"), field_group("time", "Time", icon="ptTime"), field_group("nonlinear", "Non-linear iteration", icon="ptSolver"), field_group("dynamic", "Dynamic damping", icon="ptTime"), field_group("eigen", "Eigenvalue solver", icon="ptSolver"), field_group("linear", "Linear solver", icon="ptSolver", collapsed=True)])

CONDITIONS = [
    condition("parts", "Body / Parts", list="list_other_processes", target="volume",
              fields=[],
              process_template={

              },
              help="Marks a SubModelPart as computing domain; assign a material to it."),
    condition("displacement", "Displacement", list="constraints_process_list", target="any",
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
    condition("rotation", "Rotation", list="constraints_process_list", target="any",
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
    condition("pressure", "Pressure", list="constraints_process_list", target="any",
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
    condition("volumetricStrain", "Volumetric strain", list="constraints_process_list", target="any",
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
              help="Dynamic analysis: velocity at the first step only.", category="initial", icon="ptInitial"),
    condition("initialAcceleration", "Initial acceleration", list="constraints_process_list", target="any",
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
    condition("angularVelocity", "Angular velocity", list="constraints_process_list", target="any",
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
    condition("selfWeight", "Self weight", list="loads_process_list", target="volume",
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
    condition("pointLoad", "Point load", list="loads_process_list", target="nodes",
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
    condition("pointMoment", "Point moment", list="loads_process_list", target="nodes",
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
    condition("lineLoad", "Line load", list="loads_process_list", target="surface",
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
    condition("surfaceLoad", "Surface load", list="loads_process_list", target="surface",
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
    condition("surfacePressure", "Surface pressure", list="loads_process_list", target="surface",
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

MATERIAL_LAWS = [
    material_law("linear_elastic_3d", "LinearElastic3DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29)],
                 domain_size=3),
    material_law("linear_elastic_plane_strain", "LinearElasticPlaneStrain2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 domain_size=2),
    material_law("linear_elastic_plane_stress", "LinearElasticPlaneStress2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 domain_size=2),
]



define_problemtype(
    id="structural_py",
    name=NAME,
    sections=[SECTION_0],
    conditions=CONDITIONS,
    material_laws=MATERIAL_LAWS,
    solver_settings=solver_settings,
    build_process=build_process,
    post_process=post_process,
    description="Static / dynamic / eigenvalue solid, beam and truss mechanics (StructuralMechanicsApplication)",
    icon="ptStructural",
    family="solid",
    analysis_stage="KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis",
    model_part_name="Structure",
    materials_file_name="StructuralMaterials.json",
    domain_sizes=[2, 3],
    parts_condition="parts",
    mesh_naming={
        "elements": "$field:elementBase",
        "conditions": {
            "2": "LineLoadCondition",
            "3": "SurfaceLoadCondition",
        },
    },
    output={
        "nodal_defaults": ["DISPLACEMENT", "REACTION"],
        "gauss_defaults": ["VON_MISES_STRESS"],
    },
)
