"""Fluid Dynamics (monolithic Navier-Stokes) problemtype — Python port of the built-in.

A faithful port of src/problemtype/builtins/fluid.ts, kept as a worked example
of the Python authoring API (parity-tested against the TypeScript original).

This is the port that shows why hooks exist: ``volume_model_part_name`` and
``skin_parts`` are derived from the user's assignments inside
``solver_settings`` — a static template cannot express that.
"""

from kratos_problemtype import (define_problemtype, section, field, condition,
                                material_law, INTERVAL_TOTAL)

NEWTONIAN_VARIABLES = [
    field("DENSITY", "Density [kg/m³]", "number", default=1000),
    field("DYNAMIC_VISCOSITY", "Dynamic viscosity [Pa·s]", "number", default=1e-3),
]


def solver_settings(values, ctx):
    return {
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "solver_type": "Monolithic",
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "material_import_settings": {"materials_filename": ctx["materials_file_name"]},
        "echo_level": values["echoLevel"],
        "compute_reactions": False,
        "maximum_iterations": values["maxIterations"],
        "relative_velocity_tolerance": values["relVelTol"],
        "absolute_velocity_tolerance": values["absVelTol"],
        "relative_pressure_tolerance": values["relPresTol"],
        "absolute_pressure_tolerance": values["absPresTol"],
        # Derived from the assignments — the reason this is a hook, not a template.
        "volume_model_part_name": (ctx["parts_model_parts"][0]
                                   if ctx["parts_model_parts"] else ctx["model_part_name"]),
        "skin_parts": ctx["skin_model_parts"],
        "no_skin_parts": [],
        "time_stepping": {"automatic_time_step": False, "time_step": values["timeStep"]},
        "formulation": {
            "element_type": "vms",
            "use_orthogonal_subscales": False,
            "dynamic_tau": values["dynamicTau"],
        },
    }


define_problemtype(
    id="fluid_py",
    name="Fluid Dynamics (Python example)",
    description="Incompressible Navier-Stokes, monolithic solver (FluidDynamicsApplication)",
    analysis_stage="KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis",
    model_part_name="FluidModelPart",
    materials_file_name="FluidMaterials.json",
    domain_sizes=[2, 3],
    sections=[
        section("problem", "Problem data",
                field("timeStep", "Time step", "number", default=0.01),
                field("endTime", "End time", "number", default=1.0),
                field("echoLevel", "Echo level", "int", default=0),
                field("maxIterations", "Max iterations", "int", default=10),
                field("relVelTol", "Rel. velocity tol.", "number", default=1e-3),
                field("absVelTol", "Abs. velocity tol.", "number", default=1e-5),
                field("relPresTol", "Rel. pressure tol.", "number", default=1e-3),
                field("absPresTol", "Abs. pressure tol.", "number", default=1e-5),
                field("dynamicTau", "Dynamic tau", "number", default=1.0)),
    ],
    parts_condition="parts",
    conditions=[
        condition("parts", "Fluid body", list="list_other_processes", target="volume",
                  process_template={},
                  help="Marks a SubModelPart as the fluid domain; assign a material to it."),
        # These templates mirror the built-in exactly, including which ones
        # carry a process_name — hence raw dicts instead of the process() sugar.
        condition("inlet", "Inlet velocity", list="constraints_process_list", target="surface",
                  fields=[field("modulus", "|v| [m/s]", "number", default=1.0),
                          field("direction", "Direction", "enum",
                                default="automatic_inwards_normal",
                                options=[{"value": "automatic_inwards_normal", "label": "Inwards normal"},
                                         {"value": "x", "label": "+X"},
                                         {"value": "y", "label": "+Y"},
                                         {"value": "z", "label": "+Z"}])],
                  process_template={
                      "python_module": "apply_inlet_process",
                      "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                      "Parameters": {"model_part_name": "$path",
                                     "variable_name": "VELOCITY",
                                     "modulus": "$field:modulus",
                                     "direction": "$field:direction",
                                     "interval": INTERVAL_TOTAL},
                  }),
        condition("outlet", "Outlet pressure", list="constraints_process_list", target="surface",
                  fields=[field("value", "Pressure [Pa]", "number", default=0)],
                  process_template={
                      "python_module": "apply_outlet_process",
                      "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                      "Parameters": {"model_part_name": "$path",
                                     "variable_name": "PRESSURE",
                                     "constrained": True,
                                     "value": "$field:value",
                                     "hydrostatic_outlet": False,
                                     "h_top": 0.0},
                  }),
        condition("slip", "Slip wall", list="constraints_process_list", target="surface",
                  process_template={
                      "python_module": "apply_slip_process",
                      "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                      "process_name": "ApplySlipProcess",
                      "Parameters": {"model_part_name": "$path"},
                  }),
        condition("noSlip", "No-slip wall", list="constraints_process_list", target="surface",
                  process_template={
                      "python_module": "apply_noslip_process",
                      "kratos_module": "KratosMultiphysics.FluidDynamicsApplication",
                      "Parameters": {"model_part_name": "$path"},
                  }),
    ],
    material_laws=[
        material_law("newtonian_3d", "Newtonian3DLaw", domain_size=3,
                     variables=NEWTONIAN_VARIABLES),
        material_law("newtonian_2d", "Newtonian2DLaw", domain_size=2,
                     variables=NEWTONIAN_VARIABLES),
    ],
    output={"nodal_defaults": ["VELOCITY", "PRESSURE"]},
    solver_settings=solver_settings,
)
