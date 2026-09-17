"use strict";
// Named colormaps for field visualization. Each is a small set of ordered RGB
// stops (t in [0,1]); the same stops drive both the vtk.js color transfer
// function (3D coloring) and the DOM legend gradient, keeping them in sync.
// The stop type + interpolation live in the pure src/parser/fieldScalars.ts so
// log/banded transforms and range math stay Node-testable.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_COLORMAP = exports.COLORMAPS = void 0;
exports.getColormap = getColormap;
exports.makeCtfFromStops = makeCtfFromStops;
exports.makeColorTransferFunction = makeColorTransferFunction;
exports.colorAt = colorAt;
exports.gradientCssFromStops = gradientCssFromStops;
exports.gradientCss = gradientCss;
const ColorTransferFunction_1 = __importDefault(require("@kitware/vtk.js/Rendering/Core/ColorTransferFunction"));
const fieldScalars_1 = require("../src/parser/fieldScalars");
// Rainbow / jet is the default (first entry). The matplotlib-family maps
// (Viridis, Plasma, Inferno, Magma, Cividis, Turbo) are coarse resamplings of
// the published tables — close enough visually at gradient resolution.
exports.COLORMAPS = [
    {
        name: "Rainbow",
        stops: [
            [0.0, 0.0, 0.0, 1.0],
            [0.25, 0.0, 1.0, 1.0],
            [0.5, 0.0, 1.0, 0.0],
            [0.75, 1.0, 1.0, 0.0],
            [1.0, 1.0, 0.0, 0.0],
        ],
    },
    {
        name: "Viridis",
        stops: [
            [0.0, 0.267, 0.005, 0.329],
            [0.25, 0.231, 0.318, 0.545],
            [0.5, 0.128, 0.567, 0.551],
            [0.75, 0.369, 0.789, 0.383],
            [1.0, 0.993, 0.906, 0.144],
        ],
    },
    {
        name: "Plasma",
        stops: [
            [0.0, 0.05, 0.03, 0.528],
            [0.25, 0.417, 0.0, 0.658],
            [0.5, 0.694, 0.165, 0.564],
            [0.75, 0.881, 0.392, 0.383],
            [1.0, 0.94, 0.975, 0.131],
        ],
    },
    {
        name: "Inferno",
        stops: [
            [0.0, 0.001, 0.0, 0.014],
            [0.25, 0.342, 0.062, 0.429],
            [0.5, 0.729, 0.212, 0.333],
            [0.75, 0.965, 0.556, 0.235],
            [1.0, 0.988, 0.998, 0.645],
        ],
    },
    {
        name: "Magma",
        stops: [
            [0.0, 0.001, 0.0, 0.014],
            [0.25, 0.316, 0.072, 0.485],
            [0.5, 0.716, 0.215, 0.475],
            [0.75, 0.986, 0.535, 0.382],
            [1.0, 0.987, 0.991, 0.75],
        ],
    },
    {
        name: "Cividis",
        stops: [
            [0.0, 0.0, 0.135, 0.304],
            [0.25, 0.253, 0.265, 0.44],
            [0.5, 0.503, 0.474, 0.435],
            [0.75, 0.771, 0.7, 0.4],
            [1.0, 0.995, 0.909, 0.217],
        ],
    },
    {
        name: "Turbo",
        stops: [
            [0.0, 0.19, 0.072, 0.232],
            [0.125, 0.276, 0.408, 0.86],
            [0.25, 0.09, 0.72, 0.954],
            [0.375, 0.16, 0.912, 0.616],
            [0.5, 0.53, 0.966, 0.265],
            [0.625, 0.888, 0.848, 0.183],
            [0.75, 0.985, 0.535, 0.15],
            [0.875, 0.87, 0.24, 0.07],
            [1.0, 0.48, 0.016, 0.011],
        ],
    },
    {
        name: "Cool-warm",
        stops: [
            [0.0, 0.23, 0.299, 0.754],
            [0.5, 0.865, 0.865, 0.865],
            [1.0, 0.706, 0.016, 0.15],
        ],
    },
    {
        name: "Blue-Orange",
        stops: [
            [0.0, 0.15, 0.3, 0.75],
            [0.5, 0.95, 0.95, 0.95],
            [1.0, 0.9, 0.45, 0.07],
        ],
    },
    {
        name: "Spectral",
        stops: [
            [0.0, 0.62, 0.004, 0.259],
            [0.25, 0.976, 0.557, 0.323],
            [0.5, 1.0, 1.0, 0.749],
            [0.75, 0.4, 0.761, 0.647],
            [1.0, 0.369, 0.31, 0.635],
        ],
    },
    {
        name: "HSV",
        stops: [
            [0.0, 1.0, 0.0, 0.0],
            [1 / 6, 1.0, 1.0, 0.0],
            [2 / 6, 0.0, 1.0, 0.0],
            [3 / 6, 0.0, 1.0, 1.0],
            [4 / 6, 0.0, 0.0, 1.0],
            [5 / 6, 1.0, 0.0, 1.0],
            [1.0, 1.0, 0.0, 0.0],
        ],
    },
    {
        name: "Grayscale",
        stops: [
            [0.0, 0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0, 1.0],
        ],
    },
];
exports.DEFAULT_COLORMAP = exports.COLORMAPS[0].name;
function getColormap(name) {
    return exports.COLORMAPS.find((c) => c.name === name) ?? exports.COLORMAPS[0];
}
// Builds a vtk color transfer function spanning [min, max] from a stop list
// (typically the named map's stops, optionally transformed for log/bands).
function makeCtfFromStops(stops, min, max) {
    const ctf = ColorTransferFunction_1.default.newInstance();
    if (max <= min) {
        // Degenerate/empty range: fanning stops across a fake [min, min+1] span
        // would corrupt ctf.getMappingRange() to an arbitrary non-zero width —
        // which both the mapper (useLookupTableScalarRange) and the in-scene
        // scalar bar's auto-generated ticks read directly off the CTF, producing
        // bogus non-zero labels/colors for genuinely flat data. A single point
        // keeps getMappingRange() truthfully [min, min] and colors the whole
        // field with one deliberate mid-colormap hue.
        const [r, g, b] = (0, fieldScalars_1.interpolateStops)(stops, 0.5);
        ctf.addRGBPoint(min, r, g, b);
        return ctf;
    }
    const span = max - min;
    for (const [t, r, g, b] of stops) {
        ctf.addRGBPoint(min + t * span, r, g, b);
    }
    return ctf;
}
// Builds a vtk color transfer function spanning [min, max] for the named map.
function makeColorTransferFunction(name, min, max) {
    return makeCtfFromStops(getColormap(name).stops, min, max);
}
// Interpolated RGB (0..1) at normalized position t along the colormap.
function colorAt(name, t) {
    return (0, fieldScalars_1.interpolateStops)(getColormap(name).stops, t);
}
// CSS linear-gradient stop list (left→right) for a DOM legend bar.
function gradientCssFromStops(stops) {
    const parts = stops.map(([t, r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}) ${(t * 100).toFixed(1)}%`);
    return `linear-gradient(to right, ${parts.join(", ")})`;
}
function gradientCss(name) {
    return gradientCssFromStops(getColormap(name).stops);
}
