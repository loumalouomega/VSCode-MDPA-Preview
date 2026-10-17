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
    field("elementBase", "Element formulation", "enum", default="SmallDisplacementElement", options=[{"value": "SmallDisplacementElement", "label": "Solid small displacements"}, {"value": "SmallDisplacementBbarElement", "label": "Solid small displacements B-bar"}, {"value": "SmallDisplacementMixedVolumetricStrainElement", "label": "Solid small displacements mixed u-εvol"}, {"value": "SmallDisplacementMixedVolumetricStrainOssElement", "label": "Solid small displacements mixed u-εvol (OSS)"}, {"value": "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "label": "Solid small displacements mixed u-εvol (OSS, non-linear)"}, {"value": "SmallDisplacementMixedStrainElement", "label": "Solid small displacements mixed u-ε"}, {"value": "TotalLagrangianElement", "label": "Solid total Lagrangian"}, {"value": "UpdatedLagrangianElement", "label": "Solid updated Lagrangian"}, {"value": "TotalLagrangianMixedVolumetricStrainElement", "label": "Solid total Lagrangian mixed u-εvol"}, {"value": "TotalLagrangianQ1P0MixedElement", "label": "Solid total Lagrangian Q1P0"}, {"value": "AxisymSmallDisplacementElement", "label": "Axisymmetric small displacements"}, {"value": "AxisymTotalLagrangianElement", "label": "Axisymmetric total Lagrangian"}, {"value": "AxisymUpdatedLagrangianElement", "label": "Axisymmetric updated Lagrangian"}, {"value": "SolidShellElementSprism", "label": "Solid-shell (SPRISM 3D6N)"}, {"value": "LinearTimoshenkoBeamElement", "label": "Beam small displacements (Timoshenko)"}, {"value": "LinearTimoshenkoCurvedBeamElement", "label": "Beam small displacements (curved Timoshenko)"}, {"value": "CrBeamElement", "label": "Beam large displacements (corotational)"}, {"value": "CrLinearBeamElement", "label": "Beam small displacements (corotational)"}, {"value": "LinearTrussElement", "label": "Truss small displacements"}, {"value": "TotalLagrangianTrussElement", "label": "Truss large displacements"}, {"value": "TrussElement", "label": "Truss large displacements (legacy)"}, {"value": "TrussLinearElement", "label": "Truss small displacements (legacy)"}, {"value": "CableElement", "label": "Cable"}, {"value": "ShellThinElementCorotational", "label": "Shell thin corotational"}, {"value": "ShellThickElementCorotational", "label": "Shell thick corotational"}, {"value": "ShellThinElement", "label": "Shell thin"}, {"value": "MITCThickShellElement", "label": "Shell thick (MITC)"}, {"value": "MITCThickShellCorotationalElement", "label": "Shell thick corotational (MITC)"}, {"value": "CSDSG3ThickShellLinearElement", "label": "Shell thick CS-DSG3"}, {"value": "CSDSG3ThickShellCorotationalElement", "label": "Shell thick corotational CS-DSG3"}, {"value": "MembraneElement", "label": "Membrane"}, {"value": "NodalConcentratedElement", "label": "Point mass"}, {"value": "NodalConcentratedDampedElement", "label": "Point mass (damped)"}, {"value": "LineMassElement", "label": "Line mass"}, {"value": "SurfaceMassElement", "label": "Surface mass"}, {"value": "BushingElement", "label": "Bushing"}, {"value": "SpringDamperElement", "label": "Spring / damper"}], group="analysis"),
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
    condition("angularAcceleration", "Angular acceleration", list="constraints_process_list", target="any",
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
                 group="Elastic",
                 when={"field": "elementBase", "one_of": ["SmallDisplacementElement", "SmallDisplacementBbarElement", "SmallDisplacementMixedVolumetricStrainElement", "SmallDisplacementMixedVolumetricStrainOssElement", "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "SmallDisplacementMixedStrainElement", "TotalLagrangianElement", "UpdatedLagrangianElement", "TotalLagrangianMixedVolumetricStrainElement", "TotalLagrangianQ1P0MixedElement", "SolidShellElementSprism", "ShellThinElementCorotational", "ShellThickElementCorotational", "ShellThinElement", "MITCThickShellElement", "MITCThickShellCorotationalElement", "CSDSG3ThickShellLinearElement", "CSDSG3ThickShellCorotationalElement"]},
                 domain_size=3),
    material_law("linear_elastic_plane_strain", "LinearElasticPlaneStrain2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Elastic",
                 when={"field": "elementBase", "one_of": ["SmallDisplacementElement", "SmallDisplacementBbarElement", "SmallDisplacementMixedVolumetricStrainElement", "SmallDisplacementMixedVolumetricStrainOssElement", "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "SmallDisplacementMixedStrainElement", "TotalLagrangianElement", "UpdatedLagrangianElement", "TotalLagrangianMixedVolumetricStrainElement", "TotalLagrangianQ1P0MixedElement", "SolidShellElementSprism"]},
                 domain_size=2),
    material_law("linear_elastic_plane_stress", "LinearElasticPlaneStress2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Elastic",
                 when={"field": "elementBase", "one_of": ["SmallDisplacementElement", "SmallDisplacementBbarElement", "SmallDisplacementMixedVolumetricStrainElement", "SmallDisplacementMixedVolumetricStrainOssElement", "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", "SmallDisplacementMixedStrainElement", "TotalLagrangianElement", "UpdatedLagrangianElement", "TotalLagrangianMixedVolumetricStrainElement", "TotalLagrangianQ1P0MixedElement", "SolidShellElementSprism"]},
                 domain_size=2),
    material_law("linear_elastic_axisym", "LinearElasticAxisym2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29)],
                 group="Elastic",
                 when={"field": "elementBase", "one_of": ["AxisymSmallDisplacementElement", "AxisymTotalLagrangianElement", "AxisymUpdatedLagrangianElement"]},
                 domain_size=2),
    material_law("beam_2d", "BeamConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²"),
                            field("I33", "Bending inertia I33 [m⁴]", "number", default=1, unit="m⁴")],
                 group="Beam",
                 when={"field": "elementBase", "one_of": ["LinearTimoshenkoBeamElement", "LinearTimoshenkoCurvedBeamElement", "CrBeamElement", "CrLinearBeamElement"]},
                 domain_size=2),
    material_law("beam_3d", "BeamConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²"),
                            field("TORSIONAL_INERTIA", "Torsional inertia [m⁴]", "number", default=1, unit="m⁴"),
                            field("I22", "Bending inertia I22 [m⁴]", "number", default=1, unit="m⁴"),
                            field("I33", "Bending inertia I33 [m⁴]", "number", default=1, unit="m⁴")],
                 group="Beam",
                 when={"field": "elementBase", "one_of": ["LinearTimoshenkoBeamElement", "LinearTimoshenkoCurvedBeamElement", "CrBeamElement", "CrLinearBeamElement"]},
                 domain_size=3),
    material_law("truss", "TrussConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²"),
                            field("TRUSS_PRESTRESS_PK2", "Prestress [Pa]", "number", default=0, unit="Pa")],
                 group="Truss & cable",
                 when={"field": "elementBase", "one_of": ["LinearTrussElement", "TotalLagrangianTrussElement", "TrussElement", "TrussLinearElement", "CableElement"]}),
    material_law("shell", "ReissnerMindlinShellElasticConstitutiveLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Shell",
                 when={"field": "elementBase", "one_of": ["ShellThinElementCorotational", "ShellThickElementCorotational", "ShellThinElement", "MITCThickShellElement", "MITCThickShellCorotationalElement", "CSDSG3ThickShellLinearElement", "CSDSG3ThickShellCorotationalElement"]},
                 domain_size=3),
    material_law("membrane", "LinearElasticPlaneStress2DLaw",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=210000000000, unit="Pa"),
                            field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Membrane",
                 when={"field": "elementBase", "one_of": ["MembraneElement"]}),
    material_law("point_mass", "",
                 variables=[field("NODAL_MASS", "Point mass [kg]", "number", default=1, unit="kg"),
                            field("NODAL_INERTIA", "Rotational inertia [kg·m²]", "vector3", unit="kg·m²"),
                            field("NODAL_DISPLACEMENT_STIFFNESS", "Spring stiffness [N/m]", "vector3", unit="N/m"),
                            field("NODAL_DAMPING_RATIO", "Damper coefficient [N·s/m]", "vector3", unit="N·s/m")],
                 group="Discrete",
                 when={"field": "elementBase", "one_of": ["NodalConcentratedElement", "NodalConcentratedDampedElement"]}),
    material_law("spring", "",
                 variables=[field("NODAL_DISPLACEMENT_STIFFNESS", "Translational stiffness [N/m]", "vector3", unit="N/m"),
                            field("NODAL_ROTATIONAL_STIFFNESS", "Rotational stiffness [N·m/rad]", "vector3", unit="N·m/rad"),
                            field("NODAL_DAMPING_RATIO", "Translational damper [N·s/m]", "vector3", unit="N·s/m"),
                            field("NODAL_ROTATIONAL_DAMPING_RATIO", "Rotational damper [N·m·s/rad]", "vector3", unit="N·m·s/rad")],
                 group="Discrete",
                 when={"field": "elementBase", "one_of": ["SpringDamperElement"]}),
    material_law("bushing", "",
                 variables=[field("NODAL_DISPLACEMENT_STIFFNESS", "Translational stiffness [N/m]", "vector3", unit="N/m"),
                            field("NODAL_ROTATIONAL_STIFFNESS", "Rotational stiffness [N·m/rad]", "vector3", unit="N·m/rad")],
                 group="Discrete",
                 when={"field": "elementBase", "one_of": ["BushingElement"]},
                 domain_size=3),
    material_law("line_mass", "",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("CROSS_AREA", "Cross area [m²]", "number", default=1, unit="m²")],
                 group="Discrete",
                 when={"field": "elementBase", "one_of": ["LineMassElement"]},
                 domain_size=3),
    material_law("surface_mass", "",
                 variables=[field("DENSITY", "Density [kg/m³]", "number", default=7850, unit="kg/m³"),
                            field("THICKNESS", "Thickness [m]", "number", default=1, unit="m")],
                 group="Discrete",
                 when={"field": "elementBase", "one_of": ["SurfaceMassElement"]},
                 domain_size=3),
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
    description="Static / dynamic / eigenvalue solid, beam, truss, shell, membrane and mass/spring mechanics (StructuralMechanicsApplication)",
    icon="ptStructural",
    family="solid",
    analysis_stage="KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis",
    model_part_name="Structure",
    materials_file_name="StructuralMaterials.json",
    domain_sizes=[2, 3],
    parts_condition="parts",
    mesh_naming={
        "elements": {
            "field": "elementBase",
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
    output={
        "nodal_defaults": ["DISPLACEMENT", "REACTION"],
        "gauss_defaults": ["VON_MISES_STRESS"],
    },
)
