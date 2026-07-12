"""Convection-Diffusion (thermal) problemtype — Python port of the built-in.

A faithful port of src/problemtype/builtins/convectionDiffusion.ts, kept as a
worked example of the Python authoring API (parity-tested against the
TypeScript original). Shows a law-less material: the empty ``material_law``
name omits the ``constitutive_law`` block, so the thermal materials file
carries variables only.
"""

from kratos_problemtype import (define_problemtype, section, field, condition,
                                material_law, process, INTERVAL_TOTAL)


def solver_settings(values, ctx):
    return {
        "solver_type": values["solverType"],
        "analysis_type": "linear",
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "echo_level": values["echoLevel"],
        # Derived from the assignments, like the fluid solver's skin_parts.
        "problem_domain_sub_model_part_list": ctx["parts_model_parts"],
        "processes_sub_model_part_list": ctx["skin_model_parts"],
        "time_stepping": {"time_step": values["timeStep"]},
    }


define_problemtype(
    id="convectionDiffusion_py",
    name="Convection-Diffusion (Python example)",
    description="Transient / stationary heat transfer (ConvectionDiffusionApplication)",
    icon="ptThermal",
    analysis_stage="KratosMultiphysics.ConvectionDiffusionApplication.convection_diffusion_analysis",
    model_part_name="ThermalModelPart",
    materials_file_name="ConvectionDiffusionMaterials.json",
    domain_sizes=[2, 3],
    sections=[
        section("problem", "Problem data",
                field("solverType", "Analysis", "enum", default="transient",
                      options=[{"value": "transient", "label": "Transient"},
                               {"value": "stationary", "label": "Stationary"}]),
                field("timeStep", "Time step", "number", default=0.1),
                field("endTime", "End time", "number", default=1.0),
                field("echoLevel", "Echo level", "int", default=1)),
    ],
    parts_condition="parts",
    # The solver's element_replace_settings swap generic names for
    # EulerianConvDiff*/ThermalFace* at import time.
    mesh_naming={"elements": "Element",
                 "conditions": {2: "LineCondition", 3: "SurfaceCondition"}},
    conditions=[
        condition("parts", "Thermal body", list="list_other_processes", target="volume",
                  process_template={},
                  help="Marks a SubModelPart as computing domain; assign a material to it."),
        condition("temperature", "Fixed temperature", list="constraints_process_list", target="any",
                  fields=[field("value", "Temperature [K]", "number", default=293.15)],
                  process_template=process(
                      "assign_scalar_variable_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "TEMPERATURE",
                                  "constrained": True,
                                  "value": "$field:value",
                                  "interval": INTERVAL_TOTAL})),
        condition("heatFlux", "Heat flux (volume)", list="loads_process_list", target="volume",
                  fields=[field("value", "Heat flux [W/m³]", "number", default=0)],
                  process_template=process(
                      "assign_scalar_variable_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "HEAT_FLUX",
                                  "constrained": False,
                                  "value": "$field:value",
                                  "interval": INTERVAL_TOTAL})),
        condition("faceHeatFlux", "Face heat flux", list="loads_process_list", target="surface",
                  fields=[field("value", "Heat flux [W/m²]", "number", default=0)],
                  process_template=process(
                      "assign_scalar_variable_to_conditions_process",
                      parameters={"model_part_name": "$path",
                                  "variable_name": "FACE_HEAT_FLUX",
                                  "value": "$field:value",
                                  "interval": INTERVAL_TOTAL})),
    ],
    material_laws=[
        # Thermal materials carry variables only; no constitutive law block.
        material_law("thermal", "", variables=[
            field("DENSITY", "Density [kg/m³]", "number", default=1000),
            field("CONDUCTIVITY", "Conductivity [W/(m·K)]", "number", default=0.6),
            field("SPECIFIC_HEAT", "Specific heat [J/(kg·K)]", "number", default=4184),
        ]),
    ],
    output={"nodal_defaults": ["TEMPERATURE"]},
    solver_settings=solver_settings,
)
