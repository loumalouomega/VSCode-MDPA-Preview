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
              fields=(), process_template=None, help=None, category=None, icon=None,
              no_process=None)
        A condition / BC / load. no_process=True only marks a SubModelPart for
        the hooks (an FSI interface) and emits no process. category ("initial" | "constraints" | "loads" |
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

    domain(id, label, model_part_name, mdpa_suffix, parts_condition, condition_ids,
           materials_file_name=None, required=None, mesh_naming=None)
        A physics domain of a coupled problemtype: its own mesh slice
        <stem>_<mdpa_suffix>.mdpa and materials file, owning condition_ids.

    material_law(id, name, variables=(), domain_size=None, domain=None,
                 application=None, group=None, parameters=None, when=None)
        A constitutive law (domain = the domain id it belongs to, coupled only). Empty name omits the constitutive_law block
        (e.g. thermal materials). domain_size (2|3) restricts availability.
        application = Kratos application the law needs (required when a material
        uses it); group = Materials-form heading; parameters = extra
        constitutive_law keys (CLApp factory settings); when = visibility rule
        over case values the law is offered for.

    INTERVAL_TOTAL
        The whole-simulation interval ``[0.0, "End"]`` for process Parameters.

    define_problemtype(id, name, analysis_stage, model_part_name,
                       materials_file_name, domain_sizes, sections=(),
                       conditions=(), material_laws=(), parts_condition=None,
                       mesh_naming=None, output=None, description=None,
                       icon=None, family=None,   # family: solid|fluid|thermal|coupled|particles|workflow
                       solver_settings=None,     # required hook
                       build_process=None, post_process=None, main_script=None,
                       domains=None, extra_files=None, validate=None,
                       collections=None, applications=None,
                       coupling_interfaces=None, primary_document_name=None,
                       driver_script_name=None, driver_template=None)
        Registers the problemtype. coupling_interfaces = [{"label", "sides":
        [fluid-side condition, structure-side condition]}]: Generate checks the
        two sides pair up one-to-one (by assignment order), carry boundary cells
        and overlap. primary_document_name / driver_script_name rename the
        primary JSON document and the driver script. driver_template ("standard",
        "fsi" or "cosim") picks the shipped driver when there is no main_script
        hook. applications = Kratos applications the
        case needs beyond the analysis stage's and those its documents name
        (names, or application(name, when=rule)); the generated driver checks
        them before running. output = {"nodal_defaults": [...],
        "gauss_defaults": [...]}. parts_condition names the pseudo-condition
        whose assignments mark the computing domain (emits no process).
        mesh_naming = {"elements": <names>, "conditions": <names>} declares the
        block names the solver expects in the mdpa. <names> is a string
        ("Element", "$field:<id>") or a per-dimension dict {2: ..., 3: ...}; a
        {"field": "<id>", "names": {<value>: <entry>}} table gives an enum
        field's values their own names, where <entry> is a template
        ("SpringDamperElement{dim}"), one exact name ("CableElement3D2N") or a
        {dim: {nodes: name}} table of exact names — a shape such a table omits
        is refused, because renaming it would invent a Kratos type. The final
        name is <base><dim>D<nnodes>N; when the mesh differs a renamed
        <stem>_case.mdpa copy is generated automatically.

Hooks (plain JSON data in and out — no interpreter objects cross the boundary)::

    solver_settings(values, ctx) -> dict          # required
    build_process(cond, assignment, ctx) -> dict | None   # None = use template
    post_process(project_parameters, ctx) -> dict
    validate(ctx) -> [str, ...]
        Problems that make the case ungeneratable; Generate refuses on any.
    extra_files(ctx, materials) -> [{"name": str, "content": str | dict | list}, ...]
        Extra files written beside the case (e.g. a second materials file). A
        content given as a dict or list is written as JSON formatted like the
        primary document (4-space indent).
    main_script(ctx) -> str

``ctx`` keys (snake_case): mdpa_stem, domain_size, model_part_name,
materials_file_name, values (all form values flattened), assignments, materials,
parts_model_parts, skin_model_parts, sub_model_parts, domains (coupled only) and
collections (collection id -> entries with defaults merged and dotted
``modelParts``, when the problemtype declares collections).

Validation happens eagerly: malformed specs raise ``ValueError`` naming the
offending id at definition time, so a broken problemtype fails at load with a
readable Python traceback instead of a cryptic error at generate time.
"""

import json
import re

FIELD_TYPES = ("number", "int", "string", "bool", "enum", "vector3",
               "ref", "smp", "smpList", "numberList", "stringList", "caseValue")
FAMILIES = ("solid", "fluid", "thermal", "coupled", "particles", "reduced", "optimization", "workflow")
PROCESS_LISTS = ("constraints_process_list", "loads_process_list", "list_other_processes")
TARGETS = ("nodes", "surface", "volume", "any")
DRIVER_TEMPLATES = ("standard", "fsi", "cosim")

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


def _normalize_when(when, what):
    """A ``{"field", "equals"|"one_of"}`` rule or list of them, in JS spelling.

    ``field(visible_when=...)``, ``application(when=...)`` and
    ``material_law(when=...)`` share the spelling; a single rule keeps the
    plain-object form, a list means "all must hold".
    """
    rules = when if isinstance(when, (list, tuple)) else [when]
    out = []
    for rule in rules:
        if (not isinstance(rule, dict) or "field" not in rule
                or ("equals" not in rule and "one_of" not in rule)):
            raise ValueError(f'{what} needs {{"field", "equals"}} or {{"field", "one_of"}}')
        r = {"field": rule["field"]}
        if "equals" in rule:
            r["equals"] = rule["equals"]
        else:
            r["oneOf"] = list(rule["one_of"])
        out.append(r)
    return out[0] if not isinstance(when, (list, tuple)) else out


def field(id, label, type, default=None, options=None, visible_when=None, unit=None, help=None,
          group=None, min=None, max=None, step=None, advanced=None, ref_collection=None):
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

    ``type="ref"`` needs ``ref_collection``: the id of the collection whose entry
    names are the choices. ``caseValue`` fields are only valid inside a
    collection's ``entry_type``.
    """
    _require_str(id, "field id")
    if type not in FIELD_TYPES:
        raise ValueError(f'field "{id}": unknown type {type!r} (one of {", ".join(FIELD_TYPES)})')
    f = {"id": id, "label": label, "type": type}
    if type == "ref":
        _require_str(ref_collection, f'ref field "{id}": ref_collection')
        f["refCollection"] = ref_collection
    elif ref_collection is not None:
        raise ValueError(f'field "{id}": ref_collection is only valid on type="ref"')
    if type == "enum":
        if not options:
            raise ValueError(f'field "{id}": enum fields need options')
        f["options"] = [o if isinstance(o, dict) else {"value": o} for o in options]
    elif options is not None:
        f["options"] = [o if isinstance(o, dict) else {"value": o} for o in options]
    if default is not None:
        f["default"] = default
    if visible_when is not None:
        # A single rule keeps the plain-object spelling; several mean "all must hold".
        f["visibleWhen"] = _normalize_when(visible_when, f'field "{id}": visible_when')
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


def entry_type(id, label, *fields, parts=None, icon=None, help=None):
    """One kind of entry a collection accepts (mirrors the JS ``CollectionEntryTypeSpec``).

    ``parts`` is ``{"label": str, "target": "nodes"|"surface"|"volume"|"any",
    "min": int?, "max": int?}`` when the entry applies to SubModelParts.
    """
    _require_str(id, "entry type id")
    _check_unique([f["id"] for f in fields], f'entry type "{id}" field')
    t = {"id": id, "label": label, "fields": [dict(f) for f in fields]}
    if parts is not None:
        if not isinstance(parts, dict) or parts.get("target") not in TARGETS:
            raise ValueError(f'entry type "{id}": parts needs a "target" in {TARGETS}')
        t["parts"] = {"label": parts.get("label", "SubModelParts"), "target": parts["target"]}
        for key in ("min", "max"):
            if parts.get(key) is not None:
                t["parts"][key] = int(parts[key])
    if icon is not None:
        t["icon"] = icon
    if help is not None:
        t["help"] = help
    return t


def collection(id, label, *entry_types, min=None, max=None, defaults=None, icon=None, help=None):
    """A repeatable list of named entries (mirrors the JS ``CollectionSpec``).

    ``defaults`` is a list of ``{"name", "type", "values"?}`` seeded into a fresh case.
    """
    _require_str(id, "collection id")
    if not entry_types:
        raise ValueError(f'collection "{id}": needs at least one entry_type')
    _check_unique([t["id"] for t in entry_types], f'collection "{id}" entry type')
    c = {"id": id, "label": label, "entryTypes": [dict(t) for t in entry_types]}
    for key, value in (("min", min), ("max", max)):
        if value is not None:
            c[key] = int(value)
    if defaults is not None:
        type_ids = [t["id"] for t in entry_types]
        for d in defaults:
            if not isinstance(d, dict) or d.get("type") not in type_ids:
                raise ValueError(f'collection "{id}": default {d!r} has an unknown type')
        c["defaults"] = [dict(d) for d in defaults]
    if icon is not None:
        c["icon"] = icon
    if help is not None:
        c["help"] = help
    return c


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
           materials_file_name=None, required=None, mesh_naming=None, point_load_interface=None):
    """A physics domain of a coupled problemtype (mirrors the JS ``DomainSpec``).

    Each domain owns some conditions and material laws and gets its own mesh file
    ``<stem>_<mdpa_suffix>.mdpa`` and materials file; ``required`` is a list of
    ``{"conditionId", "message"}`` entries Generate refuses without.
    ``point_load_interface`` is ``{"conditionId": ...}`` for the interface that receives
    a mapped POINT_LOAD: one 1-node point condition per interface node is emitted into a
    sibling SubModelPart (mirrors ``DomainSpec.pointLoadInterface``).
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
    if point_load_interface is not None:
        if not isinstance(point_load_interface, dict):
            raise ValueError(f'domain "{id}": point_load_interface must be {{"conditionId": ...}}')
        _require_str(point_load_interface.get("conditionId"), f'domain "{id}" point_load_interface conditionId')
        d["pointLoadInterface"] = {"conditionId": point_load_interface["conditionId"]}
    return d


def material_law(id, name, variables=(), domain_size=None, domain=None,
                 application=None, group=None, parameters=None, when=None):
    """A constitutive-law spec (mirrors the JS ``MaterialLawSpec``).

    An empty ``name`` omits the ``constitutive_law`` block in the materials file
    (used e.g. for thermal materials that carry variables only). ``application``
    is the Kratos application the law's name comes from (the generated driver
    then requires it when a material uses the law); ``group`` is the Materials
    form heading the law is listed under. ``parameters`` are extra keys of the
    ``constitutive_law`` block, written as they are (the ConstitutiveLaws
    Application factories' ``law_type``/``yield_surface``/``plastic_potential``),
    and ``when`` a visibility rule ({"field", "equals"} or {"field", "one_of"}) or
    list of them over the case values: the form offers the law only while they
    hold, and Generate refuses an assignment left on a law the setup excludes.
    """
    _require_str(id, "material law id")
    if domain_size is not None and domain_size not in (2, 3):
        raise ValueError(f'material law "{id}": domain_size must be 2 or 3')
    m = {"id": id, "name": name, "variables": [dict(v) for v in variables]}
    if domain_size is not None:
        m["domainSize"] = domain_size
    if domain is not None:
        m["domain"] = domain
    if application is not None:
        _require_str(application, f'material law "{id}" application')
        m["application"] = application
    if group is not None:
        _require_str(group, f'material law "{id}" group')
        m["group"] = group
    if parameters is not None:
        if not isinstance(parameters, dict):
            raise ValueError(f'material law "{id}": parameters must be a dict')
        if "name" in parameters:
            raise ValueError(f'material law "{id}": parameters may not set "name"')
        m["parameters"] = dict(parameters)
    if when is not None:
        m["when"] = _normalize_when(when, f'material law "{id}": when')
    return m


def _check_unique(ids, what):
    seen = set()
    for i in ids:
        if i in seen:
            raise ValueError(f'duplicate {what} id "{i}"')
        seen.add(i)


def _normalize_naming_entry(entry, where, ptid):
    """One formulation's names: a template/verbatim string, or a {dim: {nodes: name}} table."""
    if isinstance(entry, str):
        if not entry:
            raise ValueError(f'problemtype "{ptid}": {where} must be non-empty')
        return entry
    if not isinstance(entry, dict):
        raise ValueError(
            f'problemtype "{ptid}": {where} must be a name or a {{dim: {{nodes: name}}}} table'
        )
    shapes = {}
    for dim, by_nodes in entry.items():
        if str(dim) not in ("2", "3"):
            raise ValueError(f'problemtype "{ptid}": {where} keys must be 2/3')
        if not isinstance(by_nodes, dict) or not by_nodes:
            raise ValueError(f'problemtype "{ptid}": {where}[{dim}] must map node counts to names')
        counts = {}
        for nodes, name in by_nodes.items():
            if not str(nodes).isdigit() or int(nodes) < 1:
                raise ValueError(
                    f'problemtype "{ptid}": {where}[{dim}] node counts must be positive integers'
                )
            if not isinstance(name, str) or not name:
                raise ValueError(
                    f'problemtype "{ptid}": {where}[{dim}][{nodes}] must be a non-empty name'
                )
            counts[str(nodes)] = name
        shapes[str(dim)] = counts
    return shapes


def _normalize_formulation_naming(value, kind, ptid):
    """A {"field", "names"} mesh_naming table: the field value picks the entry."""
    field = value.get("field")
    if not isinstance(field, str) or not field:
        raise ValueError(f'problemtype "{ptid}": mesh_naming.{kind}.field must name a section field')
    names = value.get("names")
    if not isinstance(names, dict) or not names:
        raise ValueError(
            f'problemtype "{ptid}": mesh_naming.{kind}.names must map field values to names'
        )
    out = {}
    for entry_value, entry in names.items():
        out[str(entry_value)] = _normalize_naming_entry(
            entry, f'mesh_naming.{kind}.names.{entry_value}', ptid
        )
    return {"field": field, "names": out}


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
            if "field" in value:
                out[kind] = _normalize_formulation_naming(value, kind, ptid)
                continue
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


def application(name, when=None):
    """A required Kratos application, optionally only when a rule holds.

    ``when`` uses the ``visible_when`` spelling (``{"field", "equals"}`` or
    ``{"field", "one_of"}``, or a list of rules that must all hold) over the
    section values. Applications named by the analysis stage or by any module
    in the generated documents are found automatically; declare only the rest.
    """
    _require_str(name, "application name")
    if not re.match(r"^[A-Z][A-Za-z0-9]*Application$", name):
        raise ValueError(f'application {name!r}: expected a Kratos application name such as "FluidDynamicsApplication"')
    if when is None:
        return name
    return {"application": name, "when": _normalize_when(when, f"application {name!r}: when")}


def define_problemtype(id, name, analysis_stage, model_part_name,
                       materials_file_name, domain_sizes,
                       sections=(), conditions=(), material_laws=(),
                       parts_condition=None, mesh_naming=None, output=None,
                       description=None, icon=None, family=None,
                       solver_settings=None, build_process=None,
                       post_process=None, main_script=None,
                       domains=None, extra_files=None, validate=None, collections=None,
                       applications=None, coupling_interfaces=None,
                       primary_document_name=None, driver_script_name=None,
                       driver_template=None):
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
    collections = [dict(c) for c in (collections or ())]
    _check_unique([c["id"] for c in collections], "collection")
    collection_ids = {c["id"] for c in collections}
    for f in [f for s in sections for f in s["fields"]] + [
            f for c in collections for t in c["entryTypes"] for f in t["fields"]]:
        if f["type"] == "ref" and f.get("refCollection") not in collection_ids:
            raise ValueError(f'problemtype "{id}": ref field "{f["id"]}" names unknown collection {f.get("refCollection")!r}')
    for f in [f for s in sections for f in s["fields"]]:
        if f["type"] == "caseValue":
            raise ValueError(f'problemtype "{id}": caseValue field "{f["id"]}" is only valid inside a collection entry_type')

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
    if collections:
        decl["collections"] = collections
    if applications is not None:
        apps = [application(a) if isinstance(a, str) else a for a in applications]
        for a in apps:
            if not isinstance(a, (str, dict)):
                raise ValueError(f'problemtype "{id}": applications entries must be names or application(...)')
        decl["applications"] = apps
    if coupling_interfaces is not None:
        condition_ids = {c["id"] for c in conditions}
        interfaces = []
        for spec in coupling_interfaces:
            sides = list(spec.get("sides", ())) if isinstance(spec, dict) else []
            if len(sides) != 2 or not isinstance(spec.get("label"), str):
                raise ValueError(f'problemtype "{id}": coupling_interfaces entries are {{"label", "sides": [condition, condition]}}')
            for side in sides:
                if side not in condition_ids:
                    raise ValueError(f'problemtype "{id}": coupling interface "{spec["label"]}" names unknown condition "{side}"')
            interfaces.append({"label": spec["label"], "sides": sides})
        decl["couplingInterfaces"] = interfaces
    for key, value, extension in (("primaryDocumentName", primary_document_name, ".json"),
                                  ("driverScriptName", driver_script_name, ".py")):
        if value is None:
            continue
        if not isinstance(value, str) or not re.match(r"^[A-Za-z0-9_.-]+$", value) or not value.endswith(extension):
            raise ValueError(f'problemtype "{id}": {key} must be a plain file name ending in {extension}')
        decl[key] = value
    if driver_template is not None:
        if driver_template not in DRIVER_TEMPLATES:
            raise ValueError(f'problemtype "{id}": unknown driver_template {driver_template!r} (one of {", ".join(DRIVER_TEMPLATES)})')
        decl["driverTemplate"] = driver_template
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
        if family not in FAMILIES:
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
    "collections": "collections",
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
