"""Python problemtype-authoring API for the Kratos MDPA Preview extension.

A user problemtype is a plain ``.py`` file in ``<workspace>/.kratos/problemtypes/``
(or any directory listed in the ``kratos.problemtypes.extraPaths`` setting). It
imports this module and calls :func:`define_problemtype` once per problemtype.
The extension executes the file inside Pyodide (Python-in-WebAssembly): it cannot
import Kratos or touch the filesystem — it only *describes* the case; the
generated ``ProjectParameters.json`` runs with the real Kratos install.

Compact reference (mirrors the JavaScript API, spelled snake_case)::

    field(id, label, type, default=None, options=None, visible_when=None, unit=None,
          help=None, group=None, min=None, max=None, step=None, advanced=None)
        A form field. type: "number" | "int" | "string" | "bool" | "enum" | "vector3".
        enum needs options (strings or {"value","label"} dicts).
        visible_when={"field": <other id>, "equals": <value>} hides it conditionally
        ("one_of": [<value>, ...] matches any of several values instead; a list of
        such rules means all of them must hold).
        group=<field_group id> draws it inside that collapsible sub-group;
        advanced=True files it under the section's collapsed "Advanced" group;
        min/max/step are advisory bounds for number/int inputs.

    field_group(id, label, icon=None, collapsed=None)
        A collapsible sub-group of a section's fields (presentational only).

    section(id, label, *fields, groups=None, icon=None)
        A collapsible form section. Field ids must be unique across ALL sections
        (the generator flattens them into one `values` dict). groups is a list
        of field_group entries; icon a toolbar icon id for the header.

    condition(id, label, list="constraints_process_list", target="any",
              fields=(), process_template=None, help=None, category=None, icon=None)
        A condition / BC / load. category ("initial" | "constraints" | "loads" |
        "other") picks the tree branch it is listed under (derived from list when
        absent); icon is a toolbar icon id drawn on its rows. list: "constraints_process_list" |
        "loads_process_list" | "list_other_processes". target (SubModelPart
        picker hint): "nodes" | "surface" | "volume" | "any".
        process_template placeholders resolved per assignment:
          "$path"       -> dotted model-part name of the assigned SubModelPart
          "$root"       -> the root model part name
          "$field:<id>" -> the assignment's value for that field

    process(python_module, process_name=None, kratos_module="KratosMultiphysics",
            parameters=None)
        Sugar for a process_template dict. process_name defaults to the
        CamelCased python_module (assign_scalar_variable_process ->
        AssignScalarVariableProcess).

    material_law(id, name, variables=(), domain_size=None)
        A constitutive law. Empty name omits the constitutive_law block
        (e.g. thermal materials). domain_size (2|3) restricts availability.

    INTERVAL_TOTAL
        The whole-simulation interval ``[0.0, "End"]`` for process Parameters.

    define_problemtype(id, name, analysis_stage, model_part_name,
                       materials_file_name, domain_sizes, sections=(),
                       conditions=(), material_laws=(), parts_condition=None,
                       mesh_naming=None, output=None, description=None,
                       icon=None, family=None,   # family: solid|fluid|thermal|coupled|particles|workflow
                       solver_settings=None,     # required hook
                       build_process=None, post_process=None, main_script=None,
                       domains=None, extra_files=None, validate=None)
        Registers the problemtype. output = {"nodal_defaults": [...],
        "gauss_defaults": [...]}. parts_condition names the pseudo-condition
        whose assignments mark the computing domain (emits no process).
        mesh_naming = {"elements": <base>, "conditions": <base>} declares the
        block names the solver expects in the mdpa; <base> is a string
        ("Element", "$field:<id>") or a per-dimension dict {2: ..., 3: ...}.
        The final name is <base><dim>D<nnodes>N; when the mesh differs a
        renamed <stem>_case.mdpa copy is generated automatically.

Hooks (plain JSON data in and out — no interpreter objects cross the boundary)::

    solver_settings(values, ctx) -> dict          # required
    build_process(cond, assignment, ctx) -> dict | None   # None = use template
    post_process(project_parameters, ctx) -> dict
    validate(ctx) -> [str, ...]
        Problems that make the case ungeneratable; Generate refuses on any.
    extra_files(ctx, materials) -> [{"name": str, "content": str}, ...]
        Extra files written beside the case (e.g. a second materials file).
    main_script(ctx) -> str

``ctx`` keys (snake_case): mdpa_stem, domain_size, model_part_name,
materials_file_name, values (all form values flattened), assignments, materials,
parts_model_parts, skin_model_parts, sub_model_parts.

Validation happens eagerly: malformed specs raise ``ValueError`` naming the
offending id at definition time, so a broken problemtype fails at load with a
readable Python traceback instead of a cryptic error at generate time.
"""

import json

FIELD_TYPES = ("number", "int", "string", "bool", "enum", "vector3")
PROCESS_LISTS = ("constraints_process_list", "loads_process_list", "list_other_processes")
TARGETS = ("nodes", "surface", "volume", "any")

#: The whole-simulation interval for process Parameters: ``[0.0, "End"]``.
INTERVAL_TOTAL = [0.0, "End"]

# Handle -> {"decl": ..., "hooks": ...}. Never reset: the extension keeps hook
# handles alive across catalog reloads within one pyodide interpreter.
_REGISTRY = {}
_NEXT_HANDLE = 0
# Handles registered since the last _take_pending() call (i.e. by the file
# currently being executed).
_PENDING = []


def _require_str(value, what):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{what} must be a non-empty string (got {value!r})")


def field(id, label, type, default=None, options=None, visible_when=None, unit=None, help=None,
          group=None, min=None, max=None, step=None, advanced=None):
    """A form field spec (mirrors the JS ``FieldSpec``). See the module docstring.

    ``unit`` is the unit the value is entered in (e.g. ``"kg/m³"``). Material
    presets convert into it; without one the unit is read from the brackets in
    ``label`` and then from a well-known Kratos variable id, and a value whose
    unit cannot be established is never converted.

    ``group`` names one of the owning section's ``field_group`` ids: the field is
    drawn inside that collapsible sub-group. Purely presentational — saved
    values keep the same ``values[section][field]`` address. ``min``/``max``/
    ``step`` are advisory bounds for number/int inputs, and ``advanced=True``
    files the field under the section's collapsed "Advanced" group.
    """
    _require_str(id, "field id")
    if type not in FIELD_TYPES:
        raise ValueError(f'field "{id}": unknown type {type!r} (one of {", ".join(FIELD_TYPES)})')
    f = {"id": id, "label": label, "type": type}
    if type == "enum":
        if not options:
            raise ValueError(f'field "{id}": enum fields need options')
        f["options"] = [o if isinstance(o, dict) else {"value": o} for o in options]
    elif options is not None:
        f["options"] = [o if isinstance(o, dict) else {"value": o} for o in options]
    if default is not None:
        f["default"] = default
    if visible_when is not None:
        rules = visible_when if isinstance(visible_when, (list, tuple)) else [visible_when]
        out = []
        for rule in rules:
            if (not isinstance(rule, dict) or "field" not in rule
                    or ("equals" not in rule and "one_of" not in rule)):
                raise ValueError(f'field "{id}": visible_when needs {{"field", "equals"}} or {{"field", "one_of"}}')
            r = {"field": rule["field"]}
            if "equals" in rule:
                r["equals"] = rule["equals"]
            else:
                r["oneOf"] = list(rule["one_of"])
            out.append(r)
        # A single rule keeps the plain-object spelling; several mean "all must hold".
        f["visibleWhen"] = out[0] if not isinstance(visible_when, (list, tuple)) else out
    if unit is not None:
        if not isinstance(unit, str) or not unit:
            raise ValueError(f'field "{id}": unit must be a non-empty string')
        f["unit"] = unit
    if help is not None:
        f["help"] = help
    if group is not None:
        _require_str(group, f'field "{id}": group')
        f["group"] = group
    for key, value in (("min", min), ("max", max), ("step", step)):
        if value is not None:
            f[key] = value
    if advanced is not None:
        f["advanced"] = bool(advanced)
    return f


def field_group(id, label, icon=None, collapsed=None):
    """A collapsible sub-group of a section's fields (mirrors the JS ``FieldGroupSpec``)."""
    _require_str(id, "field group id")
    g = {"id": id, "label": label}
    if icon is not None:
        g["icon"] = icon
    if collapsed is not None:
        g["collapsed"] = bool(collapsed)
    return g


def section(id, label, *fields, groups=None, icon=None):
    """A form section grouping fields (mirrors the JS ``SectionSpec``).

    ``groups`` is an optional list of ``field_group`` entries; ``icon`` a toolbar
    icon id drawn on the section header.
    """
    _require_str(id, "section id")
    s = {"id": id, "label": label, "fields": [dict(f) for f in fields]}
    if groups is not None:
        s["groups"] = [dict(g) for g in groups]
    if icon is not None:
        s["icon"] = icon
    return s


def condition(id, label, list="constraints_process_list", target="any",
              fields=(), process_template=None, help=None, category=None, icon=None,
              no_process=None):
    """A condition / boundary-condition spec (mirrors the JS ``ConditionSpec``).

    ``category`` (``"initial"`` / ``"constraints"`` / ``"loads"`` / ``"other"``) is the
    tree branch the condition is listed under; it is derived from ``list`` when
    absent. ``icon`` is a toolbar icon id drawn on its rows.
    """
    _require_str(id, "condition id")
    # Custom list names are allowed (e.g. boundary_conditions_process_list);
    # the three PROCESS_LISTS standards are always present in the output.
    if not isinstance(list, str) or not list:
        raise ValueError(f'condition "{id}": missing process list')
    if target not in TARGETS:
        raise ValueError(f'condition "{id}": unknown target {target!r} (one of {", ".join(TARGETS)})')
    c = {
        "id": id,
        "label": label,
        "list": list,
        "target": target,
        "fields": [dict(f) for f in fields],
        "processTemplate": process_template if process_template is not None else {},
    }
    if help is not None:
        c["help"] = help
    if category is not None:
        if category not in ("initial", "constraints", "loads", "other"):
            raise ValueError(f'condition "{id}": unknown category {category!r}')
        c["category"] = category
    if icon is not None:
        c["icon"] = icon
    if no_process:
        # Marks a SubModelPart for the hooks (e.g. an FSI interface); emits no process.
        c["noProcess"] = True
    return c


def process(python_module, process_name=None, kratos_module="KratosMultiphysics",
            parameters=None):
    """Sugar for a ``process_template`` dict.

    ``process_name`` defaults to the CamelCased ``python_module`` (the Kratos
    convention): ``assign_scalar_variable_process`` -> ``AssignScalarVariableProcess``.
    ``parameters`` becomes the ``Parameters`` block (with ``$path`` / ``$root`` /
    ``$field:<id>`` placeholders resolved per assignment).
    """
    _require_str(python_module, "process python_module")
    if process_name is None:
        process_name = "".join(part.title() for part in python_module.split("_"))
    template = {
        "python_module": python_module,
        "kratos_module": kratos_module,
        "process_name": process_name,
    }
    if parameters is not None:
        template["Parameters"] = parameters
    return template


def domain(id, label, model_part_name, mdpa_suffix, parts_condition, condition_ids,
           materials_file_name=None, required=None, mesh_naming=None):
    """A physics domain of a coupled problemtype (mirrors the JS ``DomainSpec``).

    Each domain owns some conditions and material laws and gets its own mesh file
    ``<stem>_<mdpa_suffix>.mdpa`` and materials file; ``required`` is a list of
    ``{"conditionId", "message"}`` entries Generate refuses without.
    """
    _require_str(id, "domain id")
    d = {
        "id": id,
        "label": label,
        "modelPartName": model_part_name,
        "mdpaSuffix": mdpa_suffix,
        "partsCondition": parts_condition,
        "conditionIds": list(condition_ids),
    }
    if materials_file_name is not None:
        d["materialsFileName"] = materials_file_name
    if required:
        d["required"] = [dict(r) for r in required]
    naming = _normalize_mesh_naming(mesh_naming, id)
    if naming is not None:
        d["meshNaming"] = naming
    return d


def material_law(id, name, variables=(), domain_size=None, domain=None):
    """A constitutive-law spec (mirrors the JS ``MaterialLawSpec``).

    An empty ``name`` omits the ``constitutive_law`` block in the materials file
    (used e.g. for thermal materials that carry variables only).
    """
    _require_str(id, "material law id")
    if domain_size is not None and domain_size not in (2, 3):
        raise ValueError(f'material law "{id}": domain_size must be 2 or 3')
    m = {"id": id, "name": name, "variables": [dict(v) for v in variables]}
    if domain_size is not None:
        m["domainSize"] = domain_size
    if domain is not None:
        m["domain"] = domain
    return m


def _check_unique(ids, what):
    seen = set()
    for i in ids:
        if i in seen:
            raise ValueError(f'duplicate {what} id "{i}"')
        seen.add(i)


def _normalize_mesh_naming(mesh_naming, ptid):
    if mesh_naming is None:
        return None
    if not isinstance(mesh_naming, dict):
        raise ValueError(f'problemtype "{ptid}": mesh_naming must be a dict')
    out = {}
    for kind in ("elements", "conditions"):
        value = mesh_naming.get(kind)
        if value is None:
            continue
        if isinstance(value, str):
            if not value:
                raise ValueError(f'problemtype "{ptid}": mesh_naming.{kind} must be non-empty')
            out[kind] = value
        elif isinstance(value, dict):
            sizes = {}
            for k, base in value.items():
                if str(k) not in ("2", "3") or not isinstance(base, str) or not base:
                    raise ValueError(
                        f'problemtype "{ptid}": mesh_naming.{kind} keys must be 2/3 with non-empty names'
                    )
                sizes[str(k)] = base
            out[kind] = sizes
        else:
            raise ValueError(f'problemtype "{ptid}": mesh_naming.{kind} must be a string or dict')
    return out or None


def define_problemtype(id, name, analysis_stage, model_part_name,
                       materials_file_name, domain_sizes,
                       sections=(), conditions=(), material_laws=(),
                       parts_condition=None, mesh_naming=None, output=None,
                       description=None, icon=None, family=None,
                       solver_settings=None, build_process=None,
                       post_process=None, main_script=None,
                       domains=None, extra_files=None, validate=None):
    """Registers a problemtype; returns its handle (used internally).

    See the module docstring for every argument. Raises ``ValueError`` on a
    malformed declaration so authoring mistakes fail at load time.
    """
    global _NEXT_HANDLE
    _require_str(id, "problemtype id")
    _require_str(name, f'problemtype "{id}": name')
    _require_str(analysis_stage, f'problemtype "{id}": analysis_stage')
    _require_str(model_part_name, f'problemtype "{id}": model_part_name')
    _require_str(materials_file_name, f'problemtype "{id}": materials_file_name')
    domain_sizes = list(domain_sizes)
    if not domain_sizes or any(d not in (2, 3) for d in domain_sizes):
        raise ValueError(f'problemtype "{id}": domain_sizes must be a non-empty list of 2 | 3')
    if solver_settings is None:
        raise ValueError(f'problemtype "{id}": the solver_settings hook is required')
    sections = [dict(s) for s in sections]
    conditions = [dict(c) for c in conditions]
    material_laws = [dict(m) for m in material_laws]
    # Section field ids share one flattened namespace; condition/law ids are per-kind.
    _check_unique([f["id"] for s in sections for f in s["fields"]], "field")
    _check_unique([c["id"] for c in conditions], "condition")
    _check_unique([m["id"] for m in material_laws], "material law")
    if parts_condition is not None and parts_condition not in [c["id"] for c in conditions]:
        raise ValueError(f'problemtype "{id}": parts_condition "{parts_condition}" is not a condition id')

    out = output or {}
    decl = {
        "id": id,
        "name": name,
        "analysisStage": analysis_stage,
        "modelPartName": model_part_name,
        "materialsFileName": materials_file_name,
        "domainSizes": domain_sizes,
        "sections": sections,
        "conditions": conditions,
        "materialLaws": material_laws,
        "output": {
            "nodalDefaults": list(out.get("nodal_defaults", out.get("nodalDefaults", []))),
        },
    }
    gauss = out.get("gauss_defaults", out.get("gaussDefaults"))
    if gauss is not None:
        decl["output"]["gaussDefaults"] = list(gauss)
    if parts_condition is not None:
        decl["partsCondition"] = parts_condition
    if domains is not None:
        decl["domains"] = [dict(d) for d in domains]
    naming = _normalize_mesh_naming(mesh_naming, id)
    if naming is not None:
        decl["meshNaming"] = naming
    if description is not None:
        decl["description"] = description
    if icon is not None:
        # Toolbar icon id shown on the problemtype's forms (e.g. "ptStructural");
        # unknown ids fall back to the generic glyph.
        decl["icon"] = icon
    if family is not None:
        if family not in ("solid", "fluid", "thermal", "coupled", "particles", "workflow"):
            raise ValueError(f'problemtype "{id}": unknown family {family!r}')
        # Catalog grouping (the dropdown's <optgroup>).
        decl["family"] = family
    handle = _NEXT_HANDLE
    _NEXT_HANDLE += 1
    _REGISTRY[handle] = {
        "decl": decl,
        "hooks": {
            "solverSettings": solver_settings,
            "buildProcess": build_process,
            "postProcess": post_process,
            "mainScript": main_script,
            "extraFiles": extra_files,
            "validate": validate,
        },
    }
    _PENDING.append(handle)
    return handle


_CTX_SNAKE = {
    "mdpaStem": "mdpa_stem",
    "domainSize": "domain_size",
    "modelPartName": "model_part_name",
    "materialsFileName": "materials_file_name",
    "values": "values",
    "assignments": "assignments",
    "materials": "materials",
    "partsModelParts": "parts_model_parts",
    "skinModelParts": "skin_model_parts",
    "subModelParts": "sub_model_parts",
    "domains": "domains",
}


def _snake_ctx(ctx):
    out = {_CTX_SNAKE.get(k, k): v for k, v in ctx.items()}
    # Per-domain contexts (coupled problemtypes) are contexts themselves.
    if isinstance(out.get("domains"), dict):
        out["domains"] = {key: _snake_ctx(value) for key, value in out["domains"].items()}
    return out


def _take_pending():
    """JSON of the declarations registered by the file just executed."""
    global _PENDING
    out = [{"handle": h, "decl": _REGISTRY[h]["decl"]} for h in _PENDING]
    _PENDING = []
    return json.dumps(out)


def _has_hook(handle, name):
    entry = _REGISTRY.get(handle)
    return bool(entry and entry["hooks"].get(name))


def _call_hook(handle, name, args_json):
    """Invokes a hook with JSON args; returns a JSON result or None (= use default)."""
    entry = _REGISTRY.get(handle)
    hook = entry["hooks"].get(name) if entry else None
    if hook is None:
        return None
    args = json.loads(args_json)
    ctx = _snake_ctx(args["ctx"])
    if name == "solverSettings":
        result = hook(args["values"], ctx)
    elif name == "buildProcess":
        result = hook(args["cond"], args["assignment"], ctx)
    elif name == "postProcess":
        result = hook(args["pp"], ctx)
    elif name == "mainScript":
        result = hook(ctx)
    elif name == "extraFiles":
        result = hook(ctx, args["materials"])
    elif name == "validate":
        result = hook(ctx)
    else:
        raise ValueError(f"unknown hook {name!r}")
    if result is None:
        return None
    return json.dumps(result)
