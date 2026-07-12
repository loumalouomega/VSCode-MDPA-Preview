"""Shallow Water problemtype — Python port of the built-in.

A faithful port of src/problemtype/builtins/shallowWater.ts, kept as a worked
example of the Python authoring API (parity-tested against the TypeScript
original). Notable: 2D-only, MANNING-roughness materials without a
constitutive law, and the app's own process lists (topography /
initial_conditions / boundary_conditions) instead of the GiD-standard three.
"""

from kratos_problemtype import (define_problemtype, section, field, condition,
                                material_law, process, INTERVAL_TOTAL)


def solver_settings(values, ctx):
    return {
        "solver_type": "stabilized_shallow_water_solver",
        "model_part_name": ctx["model_part_name"],
        "domain_size": 2,
        "gravity": values["gravity"],
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "echo_level": values["echoLevel"],
        "maximum_iterations": values["maxIterations"],
        "shock_capturing_type": values["shockCapturing"],
        "shock_capturing_factor": values["shockCapturingFactor"],
        "time_stepping": {"automatic_time_step": False, "time_step": values["timeStep"]},
    }


define_problemtype(
    id="shallowWater_py",
    name="Shallow Water (Python example)",
    description="2D free-surface shallow-water flows (ShallowWaterApplication)",
    icon="ptShallowWater",
    analysis_stage="KratosMultiphysics.ShallowWaterApplication.shallow_water_analysis",
    model_part_name="main_model_part",
    materials_file_name="TopographyMaterials.json",
    domain_sizes=[2],
    sections=[
        section("problem", "Problem data",
                field("timeStep", "Time step", "number", default=0.01),
                field("endTime", "End time", "number", default=1.0),
                field("echoLevel", "Echo level", "int", default=1),
                field("gravity", "Gravity [m/s²]", "number", default=9.81),
                field("maxIterations", "Max iterations", "int", default=10),
                field("shockCapturing", "Shock capturing", "enum", default="residual_viscosity",
                      options=[{"value": "residual_viscosity", "label": "Residual viscosity"},
                               {"value": "gradient_jump", "label": "Gradient jump"},
                               {"value": "flux_correction", "label": "Flux correction"}]),
                field("shockCapturingFactor", "Shock capturing factor", "number", default=0.5)),
    ],
    parts_condition="parts",
    mesh_naming={"elements": "Element", "conditions": {2: "LineCondition"}},
    conditions=[
        condition("parts", "Water domain", list="list_other_processes", target="volume",
                  process_template={},
                  help="Marks a SubModelPart as computing domain; assign a Manning roughness to it."),
        condition("imposedFlowRate", "Imposed flow rate",
                  list="boundary_conditions_process_list", target="surface",
                  fields=[field("value", "q [m²/s]", "vector3", default=[0, 0, 0])],
                  process_template=process(
                      "assign_vector_variable_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "MOMENTUM",
                                  "value": "$field:value",
                                  "interval": INTERVAL_TOTAL})),
        condition("imposedFreeSurface", "Imposed free surface",
                  list="boundary_conditions_process_list", target="surface",
                  fields=[field("value", "Elevation [m]", "number", default=0)],
                  process_template=process(
                      "assign_scalar_variable_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "HEIGHT",
                                  "value": "$field:value",
                                  "interval": INTERVAL_TOTAL})),
        condition("slip", "Slip wall", list="boundary_conditions_process_list", target="surface",
                  process_template={
                      "python_module": "apply_slip_process",
                      "kratos_module": "KratosMultiphysics.ShallowWaterApplication",
                      "process_name": "ApplySlipProcess",
                      "Parameters": {"model_part_name": "$path"},
                  }),
        condition("initialWaterLevel", "Initial water level",
                  list="initial_conditions_process_list", target="volume",
                  fields=[field("variable", "Variable", "enum", default="HEIGHT",
                                options=["HEIGHT", "FREE_SURFACE_ELEVATION"]),
                          field("value", "Value [m]", "number", default=1.0)],
                  process_template={
                      "python_module": "set_initial_water_level_process",
                      "kratos_module": "KratosMultiphysics.ShallowWaterApplication",
                      "process_name": "SetInitialWaterLevelProcess",
                      "Parameters": {"model_part_name": "$path",
                                     "variable_name": "$field:variable",
                                     "value": "$field:value"},
                  }),
        condition("topography", "Topography", list="topography_process_list", target="volume",
                  fields=[field("value", "z(x,y) expression", "string", default="0.0",
                                help="Bathymetry as a function of x and y, e.g. 0.05*x")],
                  process_template={
                      "python_module": "set_topography_process",
                      "kratos_module": "KratosMultiphysics.ShallowWaterApplication",
                      "process_name": "SetTopographyProcess",
                      "Parameters": {"model_part_name": "$path",
                                     "variable_name": "TOPOGRAPHY",
                                     "value": "$field:value"},
                  }),
    ],
    material_laws=[
        # Roughness only; no constitutive-law block.
        material_law("manning", "", variables=[
            field("MANNING", "Manning coefficient", "number", default=0.01),
        ]),
    ],
    output={"nodal_defaults": ["HEIGHT", "MOMENTUM", "VELOCITY"]},
    solver_settings=solver_settings,
)
