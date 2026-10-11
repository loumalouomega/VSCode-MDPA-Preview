/**
 * The material rows that ship with the extension.
 *
 * Data only — the rules for applying, converting and validating a row live in
 * `materialCatalog.ts`, which re-exports `BUILTIN_PRESETS` from here. The module
 * imports types only, so it stays a leaf both runtimes can bundle.
 *
 * Every row is a published property at ONE stated reference state, quoted from a
 * named source — never a measurement of the user's case. Where a source gives a
 * range (concrete, polymers, timber) the row says which point of it is used.
 * Several rows quote a value the law does not store directly (a modulus in GPa,
 * a viscosity in mPa·s); the unit table converts on apply, so the numbers here
 * read the way the source prints them.
 */

import type { MaterialPreset, MaterialReference } from "./materialCatalog";

const NOT_A_GUARANTEE = "A published property at one reference state — not a guarantee for your operating range.";

const TYPICAL = "Typical engineering values; vendor and grade data vary, so check your own specification.";

// --- fluids ---------------------------------------------------------------------

const NEWTONIAN = ["newtonian_3d", "newtonian_2d"];

const atmospheric = (celsius: number, note?: string): MaterialReference => ({
  temperature: celsius,
  temperatureUnit: "C",
  pressure: 101325,
  pressureUnit: "Pa",
  ...(note ? { note } : {}),
});

/** A Newtonian fluid quoted as density + DYNAMIC viscosity (the source's own pair). */
function fluidRow(
  id: string,
  name: string,
  density: number,
  dynamicViscosity: number,
  reference: MaterialReference,
  source: MaterialPreset["source"]
): MaterialPreset {
  return {
    id,
    name,
    laws: NEWTONIAN,
    values: { DENSITY: density, DYNAMIC_VISCOSITY: dynamicViscosity },
    units: { DENSITY: "kg/m³", DYNAMIC_VISCOSITY: "Pa·s" },
    reference,
    source,
    origin: "builtin",
  };
}

const IAPWS = {
  name: "IAPWS R7-97 (IF97) and IAPWS R12-08 (viscosity of ordinary water substance)",
  version: "1997 / 2008",
  url: "https://iapws.org/public/documents/",
  note: NOT_A_GUARANTEE,
};

const CRC = (what: string) => ({
  name: `CRC Handbook of Chemistry and Physics — ${what}`,
  version: "97th edition",
  note: NOT_A_GUARANTEE,
});

const FLUIDS: MaterialPreset[] = [
  // The first two keep their historical quoting (density + KINEMATIC viscosity), so
  // μ = ρ·ν stays the exercised derivation.
  {
    id: "water-liquid-20c",
    name: "Water (liquid, 20 °C)",
    laws: NEWTONIAN,
    values: { DENSITY: 998.2, KINEMATIC_VISCOSITY: 1.004e-6 },
    units: { DENSITY: "kg/m³", KINEMATIC_VISCOSITY: "m²/s" },
    reference: atmospheric(
      20,
      "Pure water at atmospheric pressure. Density from the industrial formulation; viscosity from the IAPWS release, which reproduces the ISO value at 20 °C."
    ),
    source: IAPWS,
    origin: "builtin",
  },
  {
    id: "air-dry-20c-1atm",
    name: "Air (dry, 20 °C, 1 atm)",
    laws: NEWTONIAN,
    values: { DENSITY: 1.2041, KINEMATIC_VISCOSITY: 1.516e-5 },
    units: { DENSITY: "kg/m³", KINEMATIC_VISCOSITY: "m²/s" },
    reference: atmospheric(
      20,
      "Dry air at standard atmospheric pressure. Gas properties scale with absolute pressure and temperature, so these are 1 atm figures only."
    ),
    source: CRC("physical constants of dry air"),
    origin: "builtin",
  },
  fluidRow("water-liquid-40c", "Water (liquid, 40 °C)", 992.2, 6.527e-4, atmospheric(40, "Pure water at atmospheric pressure."), IAPWS),
  fluidRow("water-liquid-60c", "Water (liquid, 60 °C)", 983.2, 4.665e-4, atmospheric(60, "Pure water at atmospheric pressure."), IAPWS),
  fluidRow("water-liquid-80c", "Water (liquid, 80 °C)", 971.8, 3.547e-4, atmospheric(80, "Pure water at atmospheric pressure."), IAPWS),
  fluidRow(
    "seawater-20c-s35",
    "Seawater (20 °C, salinity 35 g/kg)",
    1024.8,
    1.08e-3,
    atmospheric(20, "Standard-salinity seawater at atmospheric pressure; density and viscosity both vary with salinity."),
    {
      name: "Sharqawy, Lienhard & Zubair — Thermophysical properties of seawater (Desalination and Water Treatment 16)",
      version: "2010",
      note: NOT_A_GUARANTEE,
    }
  ),
  fluidRow(
    "glycerol-20c",
    "Glycerol (pure, 20 °C)",
    1261,
    1.41,
    atmospheric(20, "Pure glycerol. Viscosity is extremely temperature-sensitive (roughly a factor of two per 5 °C) and drops sharply with absorbed water."),
    CRC("properties of glycerol")
  ),
  fluidRow("ethanol-20c", "Ethanol (20 °C)", 789, 1.074e-3, atmospheric(20, "Pure ethanol."), CRC("properties of ethanol")),
  fluidRow("mercury-20c", "Mercury (20 °C)", 13546, 1.526e-3, atmospheric(20, "Liquid mercury."), CRC("properties of mercury")),
  fluidRow(
    "air-dry-0c-1atm",
    "Air (dry, 0 °C, 1 atm)",
    1.2922,
    1.716e-5,
    atmospheric(0, "Dry air at standard atmospheric pressure; density from the ideal-gas law with R = 287.05 J/(kg·K)."),
    CRC("physical constants of dry air")
  ),
  fluidRow(
    "air-dry-40c-1atm",
    "Air (dry, 40 °C, 1 atm)",
    1.1272,
    1.91e-5,
    atmospheric(40, "Dry air at standard atmospheric pressure; density from the ideal-gas law with R = 287.05 J/(kg·K)."),
    CRC("physical constants of dry air")
  ),
];

// --- structural (linear elastic, isotropic) -------------------------------------

const ELASTIC = ["linear_elastic_3d", "linear_elastic_plane_strain", "linear_elastic_plane_stress"];

const room = (note?: string): MaterialReference => ({
  temperature: 20,
  temperatureUnit: "C",
  ...(note ? { note } : {}),
});

/**
 * An isotropic linear-elastic solid: density, Young's modulus and Poisson's
 * ratio. The row never carries THICKNESS — that is a property of the model
 * (plane strain/stress), not of the material — so applying one to a plane law
 * leaves the row's thickness alone.
 */
function elasticRow(
  id: string,
  name: string,
  density: number,
  youngGPa: number,
  poisson: number,
  reference: MaterialReference,
  source: MaterialPreset["source"]
): MaterialPreset {
  return {
    id,
    name,
    laws: ELASTIC,
    values: { DENSITY: density, YOUNG_MODULUS: youngGPa, POISSON_RATIO: poisson },
    units: { DENSITY: "kg/m³", YOUNG_MODULUS: "GPa" },
    reference,
    source,
    origin: "builtin",
  };
}

const EUROCODE = (part: string, what: string) => ({
  name: `${part} — ${what}`,
  note: "Design value of a standard material property. Characteristic strengths are not part of a linear-elastic law and are not carried.",
});

const ASM = (what: string) => ({
  name: `ASM Handbook / ASM material data sheet — ${what}`,
  note: TYPICAL,
});

const STRUCTURAL: MaterialPreset[] = [
  elasticRow(
    "steel-structural-en1993",
    "Structural steel (EN 1993-1-1)",
    7850,
    210,
    0.3,
    room("Applies to the S235–S460 grades alike: elastic constants do not depend on strength grade."),
    EUROCODE("EN 1993-1-1 §3.2.6", "design of steel structures, material constants")
  ),
  elasticRow(
    "steel-reinforcing-en1992",
    "Reinforcing steel (EN 1992-1-1)",
    7850,
    200,
    0.3,
    room(),
    EUROCODE("EN 1992-1-1 §3.2.7 and EN 1991-1-1 Annex A", "design of concrete structures, reinforcing steel")
  ),
  elasticRow(
    "steel-stainless-en1993-1-4",
    "Stainless steel (EN 1993-1-4)",
    7900,
    200,
    0.3,
    room("Austenitic and duplex grades; the modulus softens noticeably with plastic strain, which a linear law ignores."),
    EUROCODE("EN 1993-1-4 §2.1.4", "design of stainless steel structures")
  ),
  elasticRow(
    "iron-ductile-en1563",
    "Ductile cast iron (EN-GJS-400 to 500)",
    7100,
    169,
    0.275,
    room("Spheroidal-graphite iron. Grey cast iron is markedly softer and nonlinear in tension — do not use this row for it."),
    { name: "EN 1563 — spheroidal graphite cast irons", note: TYPICAL }
  ),
  elasticRow(
    "aluminium-en1999",
    "Aluminium alloy (EN 1999-1-1)",
    2700,
    70,
    0.3,
    room(),
    EUROCODE("EN 1999-1-1 §3.2.5", "design of aluminium structures")
  ),
  elasticRow("aluminium-6061-t6", "Aluminium 6061-T6", 2713, 68.9, 0.33, room(), {
    name: "MMPDS (formerly MIL-HDBK-5) — aluminium alloy 6061-T6",
    note: "Converted from handbook US units (10.0 Msi; 0.098 lb/in³).",
  }),
  elasticRow("aluminium-7075-t6", "Aluminium 7075-T6", 2810, 71.7, 0.33, room(), ASM("aluminium 7075-T6")),
  elasticRow("aluminium-2024-t3", "Aluminium 2024-T3", 2780, 73.1, 0.33, room(), ASM("aluminium 2024-T3")),
  elasticRow("titanium-ti6al4v", "Titanium Ti-6Al-4V (annealed)", 4430, 113.8, 0.342, room(), ASM("Ti-6Al-4V (grade 5), annealed")),
  elasticRow(
    "nickel-inconel-718",
    "Inconel 718",
    8190,
    205,
    0.29,
    room("Room-temperature modulus; it falls by roughly a third by 700 °C."),
    {
      name: "Special Metals — INCONEL alloy 718 data sheet",
      note: TYPICAL,
    }
  ),
  elasticRow("copper-c11000", "Copper (C11000, annealed)", 8940, 117, 0.34, room(), {
    name: "Copper Development Association — C11000 electrolytic tough pitch copper",
    note: TYPICAL,
  }),
  elasticRow("magnesium-az31b", "Magnesium AZ31B", 1770, 45, 0.35, room(), ASM("magnesium AZ31B")),
  elasticRow(
    "concrete-c25-30",
    "Concrete C25/30 (EN 1992-1-1)",
    2400,
    31,
    0.2,
    room("Uncracked concrete, secant modulus Ecm. Reinforced concrete is conventionally taken at 2500 kg/m³ — edit the density if you model the bars into the material."),
    EUROCODE("EN 1992-1-1 Table 3.1, §3.1.3(4); EN 1991-1-1 Annex A", "design of concrete structures")
  ),
  elasticRow(
    "concrete-c30-37",
    "Concrete C30/37 (EN 1992-1-1)",
    2400,
    33,
    0.2,
    room("Uncracked concrete, secant modulus Ecm. Reinforced concrete is conventionally taken at 2500 kg/m³."),
    EUROCODE("EN 1992-1-1 Table 3.1, §3.1.3(4); EN 1991-1-1 Annex A", "design of concrete structures")
  ),
  elasticRow(
    "concrete-c40-50",
    "Concrete C40/50 (EN 1992-1-1)",
    2400,
    35,
    0.2,
    room("Uncracked concrete, secant modulus Ecm. Reinforced concrete is conventionally taken at 2500 kg/m³."),
    EUROCODE("EN 1992-1-1 Table 3.1, §3.1.3(4); EN 1991-1-1 Annex A", "design of concrete structures")
  ),
  elasticRow(
    "timber-c24-en338",
    "Softwood timber C24 (EN 338)",
    420,
    11,
    0.3,
    room(
      "Wood is strongly orthotropic; this is the mean modulus parallel to the grain used as an ISOTROPIC approximation. EN 338 defines no Poisson ratio — 0.3 is a common modelling convention, not a standard value."
    ),
    { name: "EN 338 — structural timber, strength classes", note: "Mean density and mean modulus of elasticity parallel to the grain, at 12 % moisture." }
  ),
  elasticRow(
    "timber-gl24h-en14080",
    "Glulam GL24h (EN 14080)",
    420,
    11.5,
    0.3,
    room(
      "Homogeneous glued laminated timber, mean modulus parallel to the grain as an ISOTROPIC approximation. The Poisson ratio is a modelling convention, not a standard value."
    ),
    { name: "EN 14080 — glued laminated timber and glued solid timber", note: "Mean density and mean modulus parallel to the grain." }
  ),
  elasticRow(
    "glass-soda-lime-en572",
    "Soda-lime glass (EN 572-1)",
    2500,
    70,
    0.2,
    room("Linear to failure, brittle: a stress check against the tensile strength matters more than the modulus."),
    EUROCODE("EN 572-1 §4.3", "basic soda-lime silicate glass products, physical properties")
  ),
  elasticRow(
    "polymer-pmma",
    "PMMA (cast acrylic)",
    1190,
    3,
    0.37,
    room("Viscoelastic: the modulus depends on loading rate and temperature, and creeps under sustained load. Treat as a short-term value."),
    { name: "Typical room-temperature values for cast acrylic (PMMA)", note: "Grades vary by about ±20 %; check the manufacturer's data sheet." }
  ),
];

// --- thermal (convection-diffusion) ---------------------------------------------

const THERMAL = ["thermal"];

const kelvin300 = (note?: string): MaterialReference => ({
  temperature: 300,
  temperatureUnit: "K",
  ...(note ? { note } : {}),
});

function thermalRow(
  id: string,
  name: string,
  density: number,
  conductivity: number,
  specificHeat: number,
  reference: MaterialReference,
  source: MaterialPreset["source"]
): MaterialPreset {
  return {
    id,
    name,
    laws: THERMAL,
    values: { DENSITY: density, CONDUCTIVITY: conductivity, SPECIFIC_HEAT: specificHeat },
    units: { DENSITY: "kg/m³", CONDUCTIVITY: "W/(m·K)", SPECIFIC_HEAT: "J/(kg·K)" },
    reference,
    source,
    origin: "builtin",
  };
}

const INCROPERA = (table: string) => ({
  name: `Incropera, DeWitt, Bergman & Lavine — Fundamentals of Heat and Mass Transfer, ${table}`,
  version: "6th edition",
  note: "Conductivity and specific heat are temperature dependent; these are the 300 K entries.",
});

const THERMAL_ROWS: MaterialPreset[] = [
  thermalRow("thermal-water-20c", "Water (liquid, 20 °C) — thermal", 998.2, 0.598, 4182, atmospheric(20, "Conduction only: convection is a separate effect the solver must model."), IAPWS),
  thermalRow(
    "thermal-air-20c",
    "Air (dry, 20 °C, 1 atm) — thermal",
    1.2041,
    0.0257,
    1006,
    atmospheric(20, "Conduction only: convection is a separate effect the solver must model."),
    CRC("thermal properties of dry air")
  ),
  thermalRow("thermal-aluminium", "Aluminium (pure) — thermal", 2702, 237, 903, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-copper", "Copper (pure) — thermal", 8933, 401, 385, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-iron", "Iron (pure) — thermal", 7870, 80.2, 447, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-steel-carbon", "Carbon steel (AISI 1010) — thermal", 7832, 63.9, 434, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-steel-304", "Stainless steel (AISI 304) — thermal", 7900, 14.9, 477, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-titanium", "Titanium (pure) — thermal", 4500, 21.9, 522, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-nickel", "Nickel (pure) — thermal", 8900, 90.7, 444, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-brass", "Brass (cartridge, 70Cu-30Zn) — thermal", 8530, 110, 380, kelvin300(), INCROPERA("Table A.1")),
  thermalRow("thermal-concrete", "Concrete (stone mix) — thermal", 2300, 1.4, 880, kelvin300(), INCROPERA("Table A.3")),
  thermalRow("thermal-glass", "Plate glass — thermal", 2500, 1.4, 750, kelvin300(), INCROPERA("Table A.3")),
];

// --- shallow water (Manning roughness) ------------------------------------------

const CHOW = {
  name: "Chow — Open-Channel Hydraulics, Table 5-6 (values of the roughness coefficient n)",
  version: "1959",
  note: "The 'normal' value of the published range. Roughness varies with stage, season and vegetation — treat as a starting estimate to calibrate.",
};

function manningRow(id: string, name: string, n: number, note: string): MaterialPreset {
  return {
    id,
    name,
    laws: ["manning"],
    values: { MANNING: n },
    // No temperature applies; the reference states what the surface is.
    reference: { note },
    source: CHOW,
    origin: "builtin",
  };
}

const MANNING: MaterialPreset[] = [
  manningRow("manning-concrete-trowel", "Manning n — concrete, trowel finish", 0.013, "Lined channel, concrete with a trowel finish."),
  manningRow("manning-concrete-float", "Manning n — concrete, float finish", 0.015, "Lined channel, concrete with a float finish."),
  manningRow("manning-concrete-unfinished", "Manning n — concrete, unfinished", 0.017, "Lined channel, unfinished concrete."),
  manningRow("manning-earth-weathered", "Manning n — excavated earth, weathered", 0.022, "Straight, uniform excavated earth channel, clean, after weathering."),
  manningRow("manning-stream-clean", "Manning n — natural stream, clean and straight", 0.03, "Minor stream, full stage, no rifts or deep pools."),
  manningRow("manning-stream-winding", "Manning n — natural stream, winding", 0.04, "Minor stream, clean, winding, with some pools and shoals."),
  manningRow("manning-stream-weedy", "Manning n — natural stream, sluggish and weedy", 0.07, "Sluggish reaches, weedy, deep pools."),
  manningRow("manning-floodplain-pasture", "Manning n — floodplain, short grass", 0.03, "Floodplain pasture, no brush, short grass."),
  manningRow("manning-floodplain-crops", "Manning n — floodplain, mature crops", 0.04, "Floodplain cultivated area, mature field crops."),
];

// --- Kratos GiD Interface defaults ----------------------------------------------
//
// The materials the Kratos GiD interface (KratosMultiphysics/GiDInterface,
// `kratos.gid/apps/<App>/xml/Materials.xml`) offers, so a case moving over from GiD
// starts from the numbers it already knew. They are the Kratos team's tutorial
// defaults, NOT handbook figures: no reference temperature is stated, a few are
// round engineering numbers, and they differ slightly from the standards-based
// rows above (e.g. steel E = 206.9 GPa here against 210 GPa in EN 1993-1-1).
// Rows from that repository that this catalog deliberately leaves out: "Rubber"
// (Poisson ratio 0.5, singular for a linear-elastic law), "Dirt" (a copy of
// steel) and GeoMechanics "Sand" (a copy of aluminium), and the DEM, Dam-joint
// and compressible-flow entries, whose laws this extension does not declare.

const GID_SOURCE = (app: string) => ({
  name: `Kratos GiD Interface (KratosMultiphysics/GiDInterface) — apps/${app}/xml/Materials.xml`,
  note: "The Kratos team's default for tutorials, not a handbook value; no reference state is stated.",
});

const GID_REFERENCE = (what: string): MaterialReference => ({
  note: `${what} Default shipped with the Kratos GiD interface; no reference temperature is stated.`,
});

function gidElastic(
  id: string,
  name: string,
  app: string,
  density: number,
  youngPa: number,
  poisson: number,
  what: string
): MaterialPreset {
  return {
    id,
    name,
    laws: ELASTIC,
    values: { DENSITY: density, YOUNG_MODULUS: youngPa, POISSON_RATIO: poisson },
    units: { DENSITY: "kg/m³", YOUNG_MODULUS: "Pa" },
    reference: GID_REFERENCE(what),
    source: GID_SOURCE(app),
    origin: "builtin",
  };
}

const GID: MaterialPreset[] = [
  gidElastic("gid-steel", "Steel (Kratos GiD default)", "Structural", 7850, 206.9e9, 0.29, "Elastic constants only; the interface also lists plasticity parameters, which a linear-elastic law does not use."),
  gidElastic("gid-aluminium", "Aluminium (Kratos GiD default)", "Structural", 2650, 69e9, 0.22, "The interface's density is that of a generic aluminium; Poisson ratio 0.22 is lower than the usual 0.33."),
  gidElastic("gid-concrete-mpm", "Concrete (Kratos GiD default, MPM)", "MPM", 2550, 30e9, 0.2, "Elastic constants only."),
  gidElastic("gid-concrete-dam", "Concrete — dam (Kratos GiD default)", "Dam", 2400, 26e9, 0.2, "Elastic constants only; the thermal expansion coefficient (1e-5 1/K) is not carried."),
  gidElastic("gid-soil-dam", "Soil / rock foundation — dam (Kratos GiD default)", "Dam", 3000, 49e9, 0.25, "Elastic constants only; this is a stiff rock foundation, not a soft soil. Thermal expansion (1e-5 1/K) is not carried."),
  gidElastic("gid-sand-mpm", "Sand (Kratos GiD default, MPM)", "MPM", 2300, 6e6, 0.3, "Elastic constants only; the interface's cohesion and friction angle belong to a Mohr–Coulomb law this extension does not declare."),
  {
    id: "gid-fluid-water",
    name: "Water (Kratos GiD default)",
    laws: NEWTONIAN,
    values: { DENSITY: 1000, DYNAMIC_VISCOSITY: 1.002e-3 },
    units: { DENSITY: "kg/m³", DYNAMIC_VISCOSITY: "Pa·s" },
    reference: GID_REFERENCE("Rounded density."),
    source: GID_SOURCE("Fluid"),
    origin: "builtin",
  },
  {
    id: "gid-fluid-air",
    name: "Air (Kratos GiD default)",
    laws: NEWTONIAN,
    values: { DENSITY: 1.225, DYNAMIC_VISCOSITY: 1.846e-5 },
    units: { DENSITY: "kg/m³", DYNAMIC_VISCOSITY: "Pa·s" },
    reference: GID_REFERENCE("Close to ISA sea-level conditions (15 °C)."),
    source: GID_SOURCE("Fluid"),
    origin: "builtin",
  },
  thermalRow("gid-thermal-steel", "Steel — thermal (Kratos GiD default)", 7850, 50, 460, GID_REFERENCE("Conduction properties."), GID_SOURCE("ConvectionDiffusion")),
  thermalRow("gid-thermal-gold", "Gold — thermal (Kratos GiD default)", 19300, 310, 125.6, GID_REFERENCE("Conduction properties."), GID_SOURCE("ConvectionDiffusion")),
  thermalRow("gid-thermal-air", "Air — thermal (Kratos GiD default)", 1.225, 0.024, 1012, GID_REFERENCE("Conduction properties."), GID_SOURCE("ConvectionDiffusion")),
  thermalRow("gid-thermal-water", "Water — thermal (Kratos GiD default)", 1000, 0.58, 4181.3, GID_REFERENCE("Conduction properties."), GID_SOURCE("ConvectionDiffusion")),
  {
    ...manningRow("gid-manning-concrete", "Manning n — concrete (Kratos GiD default)", 0.009, "Concrete bottom friction."),
    source: GID_SOURCE("ShallowWater"),
  },
  {
    ...manningRow("gid-manning-grass", "Manning n — grass (Kratos GiD default)", 0.032, "Grass bottom friction."),
    source: GID_SOURCE("ShallowWater"),
  },
];

export const BUILTIN_PRESET_DATA: MaterialPreset[] = [
  ...FLUIDS,
  ...STRUCTURAL,
  ...THERMAL_ROWS,
  ...MANNING,
  ...GID,
];
