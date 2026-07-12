"""Potential Flow problemtype — Python port of the built-in.

A faithful port of src/problemtype/builtins/potentialFlow.ts, kept as a worked
example of the Python authoring API (parity-tested against the TypeScript
original). Notable: no material laws at all — the free-stream state rides on
the far-field process — and generic mesh names (the solver replaces elements
per formulation.element_type).
"""

from kratos_problemtype import define_problemtype, section, field, condition


def solver_settings(values, ctx):
    return {
        "model_part_name": ctx["model_part_name"],
        "domain_size": ctx["domain_size"],
        "solver_type": "potential_flow",
        "model_import_settings": {"input_type": "mdpa", "input_filename": ctx["mdpa_stem"]},
        "formulation": {"element_type": values["formulation"]},
        "maximum_iterations": values["maxIterations"],
        "echo_level": values["echoLevel"],
        "volume_model_part_name": (ctx["parts_model_parts"][0]
                                   if ctx["parts_model_parts"] else ctx["model_part_name"]),
        "skin_parts": ctx["skin_model_parts"],
        "no_skin_parts": [],
    }


define_problemtype(
    id="potentialFlow_py",
    name="Potential Flow (Python example)",
    description="Incompressible / compressible potential flow around bodies (CompressiblePotentialFlowApplication)",
    icon="ptPotentialFlow",
    analysis_stage="KratosMultiphysics.CompressiblePotentialFlowApplication.potential_flow_analysis",
    model_part_name="FluidModelPart",
    materials_file_name="FluidMaterials.json",
    domain_sizes=[2, 3],
    sections=[
        section("problem", "Problem data",
                field("formulation", "Formulation", "enum", default="incompressible",
                      options=[{"value": "incompressible", "label": "Incompressible"},
                               {"value": "compressible", "label": "Compressible"}]),
                field("echoLevel", "Echo level", "int", default=0),
                field("maxIterations", "Max iterations", "int", default=10)),
    ],
    parts_condition="parts",
    mesh_naming={"elements": "Element",
                 "conditions": {2: "LineCondition", 3: "SurfaceCondition"}},
    conditions=[
        condition("parts", "Fluid domain", list="list_other_processes", target="volume",
                  process_template={},
                  help="Marks a SubModelPart as the flow domain."),
        condition("farField", "Far field", list="constraints_process_list", target="surface",
                  fields=[field("angleOfAttack", "Angle of attack [rad]", "number", default=0.0),
                          field("machInfinity", "Mach ∞", "number", default=0.03),
                          field("speedOfSound", "Speed of sound [m/s]", "number", default=340.0)],
                  process_template={
                      "python_module": "apply_far_field_process",
                      "kratos_module": "KratosMultiphysics.CompressiblePotentialFlowApplication",
                      "process_name": "FarFieldProcess",
                      "Parameters": {"model_part_name": "$path",
                                     "angle_of_attack": "$field:angleOfAttack",
                                     "mach_infinity": "$field:machInfinity",
                                     "speed_of_sound": "$field:speedOfSound"},
                  }),
        condition("body2d", "Body / wake (2D)", list="list_other_processes", target="surface",
                  fields=[field("epsilon", "Wake ε", "number", default=1e-9)],
                  process_template={
                      "python_module": "define_wake_process_2d",
                      "kratos_module": "KratosMultiphysics.CompressiblePotentialFlowApplication",
                      "process_name": "DefineWakeProcess2D",
                      "Parameters": {"model_part_name": "$path",
                                     "epsilon": "$field:epsilon"},
                  },
                  help="The body boundary whose trailing edge sheds the wake (2D cases)."),
    ],
    output={"nodal_defaults": ["VELOCITY_POTENTIAL", "AUXILIARY_VELOCITY_POTENTIAL"]},
    solver_settings=solver_settings,
)
