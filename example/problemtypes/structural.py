"""Structural Mechanics problemtype — Python port of the built-in.

A faithful port of the extension's built-in Structural problemtype
(src/problemtype/builtins/structural.ts), kept as a worked example of the
Python authoring API. The parity test src/test/problemtypeExamples.test.ts
asserts it generates byte-identical case files to the TypeScript original.

It also demonstrates the ``build_process`` hook: the single "Fixed" checkbox
of the Displacement condition is broadcast into Kratos' per-component
``constrained: [true, true, true]`` — something a static template cannot do.
"""

from kratos_problemtype import (define_problemtype, section, field, condition,
                                material_law, process, INTERVAL_TOTAL)

ELASTIC_VARIABLES = [
    field("DENSITY", "Density [kg/m³]", "number", default=7850),
    field("YOUNG_MODULUS", "Young modulus [Pa]", "number", default=2.1e11),
    field("POISSON_RATIO", "Poisson ratio", "number", default=0.29),
]
THICKNESS = field("THICKNESS", "Thickness [m]", "number", default=1.0)


def solver_settings(values, ctx):
    dynamic = values["solverType"] == "dynamic"
    settings = {
        "solver_type": "Dynamic" if dynamic else "Static",
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "echo_level": values["echoLevel"],
        "analysis_type": values["analysisType"],
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "time_stepping": {"time_step": values["timeStep"]},
        "rotation_dofs": False,
    }
    if dynamic:
        settings["time_integration_method"] = "implicit"
        settings["scheme_type"] = "bossak"
    return settings


def build_process(cond, assignment, ctx):
    # Only displacement needs code (per-component constrained broadcast);
    # returning None lets every other condition use its declarative template.
    if cond["id"] != "displacement":
        return None
    values = assignment["values"]
    fixed = values.get("constrained", True)
    fixed = fixed if isinstance(fixed, bool) else True
    value = values.get("value", [0, 0, 0])
    value = value if isinstance(value, list) else [0, 0, 0]
    smp_dotted = assignment["smpPath"].replace("/", ".")
    return {
        "python_module": "assign_vector_variable_process",
        "kratos_module": "KratosMultiphysics",
        "process_name": "AssignVectorVariableProcess",
        "Parameters": {
            "model_part_name": f'{ctx["model_part_name"]}.{smp_dotted}',
            "variable_name": "DISPLACEMENT",
            "interval": INTERVAL_TOTAL,
            "constrained": [fixed, fixed, fixed],
            "value": value,
        },
    }


define_problemtype(
    id="structural_py",
    name="Structural Mechanics (Python example)",
    description="Static / dynamic solid mechanics (StructuralMechanicsApplication)",
    analysis_stage="KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis",
    model_part_name="Structure",
    materials_file_name="StructuralMaterials.json",
    domain_sizes=[2, 3],
    sections=[
        section("problem", "Problem data",
                field("solverType", "Analysis", "enum", default="static",
                      options=[{"value": "static", "label": "Static"},
                               {"value": "dynamic", "label": "Dynamic"}]),
                field("analysisType", "Linearity", "enum", default="linear",
                      options=[{"value": "linear", "label": "Linear"},
                               {"value": "non_linear", "label": "Non-linear"}]),
                field("timeStep", "Time step", "number", default=0.1),
                field("endTime", "End time", "number", default=1.0),
                field("echoLevel", "Echo level", "int", default=1)),
    ],
    parts_condition="parts",
    conditions=[
        condition("parts", "Body / Parts", list="list_other_processes", target="volume",
                  process_template={},
                  help="Marks a SubModelPart as computing domain; assign a material to it."),
        condition("displacement", "Displacement", list="constraints_process_list", target="any",
                  fields=[field("value", "Value [ux, uy, uz]", "vector3", default=[0, 0, 0]),
                          field("constrained", "Fixed", "bool", default=True)],
                  # constrained is broadcast to per-component form by build_process.
                  process_template=process(
                      "assign_vector_variable_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "DISPLACEMENT",
                                  "interval": INTERVAL_TOTAL,
                                  "constrained": "$field:constrained",
                                  "value": "$field:value"})),
        condition("selfWeight", "Self weight", list="loads_process_list", target="volume",
                  fields=[field("modulus", "Modulus [m/s²]", "number", default=9.81),
                          field("direction", "Direction", "vector3", default=[0, 0, -1])],
                  process_template=process(
                      "assign_vector_by_direction_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "VOLUME_ACCELERATION",
                                  "modulus": "$field:modulus",
                                  "constrained": False,
                                  "direction": "$field:direction",
                                  "interval": INTERVAL_TOTAL})),
        condition("pointLoad", "Point load", list="loads_process_list", target="nodes",
                  fields=[field("modulus", "Modulus [N]", "number", default=0),
                          field("direction", "Direction", "vector3", default=[0, 0, -1])],
                  process_template=process(
                      "assign_vector_by_direction_to_condition_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "POINT_LOAD",
                                  "modulus": "$field:modulus",
                                  "direction": "$field:direction",
                                  "interval": INTERVAL_TOTAL})),
        condition("surfacePressure", "Surface pressure", list="loads_process_list", target="surface",
                  fields=[field("value", "Pressure [Pa]", "number", default=0)],
                  process_template=process(
                      "assign_scalar_variable_to_conditions_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "POSITIVE_FACE_PRESSURE",
                                  "value": "$field:value",
                                  "interval": INTERVAL_TOTAL})),
    ],
    material_laws=[
        material_law("linear_elastic_3d", "LinearElastic3DLaw", domain_size=3,
                     variables=ELASTIC_VARIABLES),
        material_law("linear_elastic_plane_strain", "LinearElasticPlaneStrain2DLaw",
                     domain_size=2, variables=ELASTIC_VARIABLES + [THICKNESS]),
        material_law("linear_elastic_plane_stress", "LinearElasticPlaneStress2DLaw",
                     domain_size=2, variables=ELASTIC_VARIABLES + [THICKNESS]),
    ],
    output={"nodal_defaults": ["DISPLACEMENT", "REACTION"],
            "gauss_defaults": ["VON_MISES_STRESS"]},
    solver_settings=solver_settings,
    build_process=build_process,
)
