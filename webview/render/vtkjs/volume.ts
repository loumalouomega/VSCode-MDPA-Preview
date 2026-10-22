// Image-data rendering for a dense lattice (roadmap item 22 D): a volume with
// an editable opacity curve, three orthogonal slices, and marching-cubes iso
// surfaces. A display representation only — the webview hands in plain arrays
// (imageLattice.ts) and never lets this replace edited or exported geometry.

import "@kitware/vtk.js/Rendering/OpenGL/ImageMapper";
import "@kitware/vtk.js/Rendering/OpenGL/ImageSlice";
import "@kitware/vtk.js/Rendering/OpenGL/Volume";
import "@kitware/vtk.js/Rendering/OpenGL/VolumeMapper";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import vtkImageSlice from "@kitware/vtk.js/Rendering/Core/ImageSlice";
import vtkImageMapper from "@kitware/vtk.js/Rendering/Core/ImageMapper";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageMarchingCubes from "@kitware/vtk.js/Filters/General/ImageMarchingCubes";
import vtkImageDataOutlineFilter from "@kitware/vtk.js/Filters/General/ImageDataOutlineFilter";
import type { Bounds6 } from "../../../src/parser/render/types";
import type { RVolume, VolumeLattice, VolumeMode } from "../backend";

const MAX_ISO = 4;

export function createVolume(renderer: any, lattice: VolumeLattice): RVolume {
  const image: any = vtkImageData.newInstance();
  image.setDimensions(...lattice.dims);
  image.setSpacing(...lattice.spacing);
  image.setOrigin(...lattice.origin);
  image.getPointData().setScalars(vtkDataArray.newInstance({ name: lattice.name, values: lattice.values, numberOfComponents: 1 }));

  const ctf: any = vtkColorTransferFunction.newInstance();
  const opacity: any = vtkPiecewiseFunction.newInstance();

  // --- volume ---
  const volMapper: any = vtkVolumeMapper.newInstance();
  volMapper.setInputData(image);
  volMapper.setSampleDistance(Math.max(1e-9, 0.7 * Math.min(...lattice.spacing)));
  volMapper.setAutoAdjustSampleDistances(true);
  const volume: any = vtkVolume.newInstance();
  volume.setMapper(volMapper);
  const vp = volume.getProperty();
  vp.setRGBTransferFunction(0, ctf);
  vp.setScalarOpacity(0, opacity);
  vp.setInterpolationTypeToLinear();
  vp.setShade(false);

  // --- slices ---
  const slices: { actor: any; mapper: any }[] = [0, 1, 2].map((axis) => {
    const mapper: any = vtkImageMapper.newInstance();
    mapper.setInputData(image);
    mapper.setSlicingMode(axis); // SlicingMode.I / J / K
    const actor: any = vtkImageSlice.newInstance();
    actor.setMapper(mapper);
    const p = actor.getProperty();
    p.setRGBTransferFunction(0, ctf);
    p.setUseLookupTableScalarRange(true);
    p.setInterpolationTypeToLinear();
    return { actor, mapper };
  });

  // --- outline (always drawn with a view, so a slice or iso surface has a frame) ---
  const outlineFilter: any = vtkImageDataOutlineFilter.newInstance();
  outlineFilter.setGenerateFaces(false);
  outlineFilter.setGenerateLines(true);
  outlineFilter.setInputData(image);
  const outlineMapper: any = vtkMapper.newInstance();
  outlineMapper.setInputConnection(outlineFilter.getOutputPort());
  const outline: any = vtkActor.newInstance();
  outline.setMapper(outlineMapper);
  outline.getProperty().setColor(0.8, 0.8, 0.8);
  outline.setPickable(false);

  // --- iso surfaces ---
  let iso: { actor: any }[] = [];
  let isoValues: number[] = [];
  let mode: VolumeMode = "off";
  const added = new Set<any>();
  const show = (prop: any, on: boolean): void => {
    if (on && !added.has(prop)) {
      renderer.addViewProp(prop);
      added.add(prop);
    } else if (!on && added.has(prop)) {
      renderer.removeViewProp(prop);
      added.delete(prop);
    }
  };
  const clearIso = (): void => {
    for (const i of iso) {
      show(i.actor, false);
      i.actor.delete?.();
    }
    iso = [];
  };
  const buildIso = (): void => {
    clearIso();
    for (const v of isoValues.slice(0, MAX_ISO)) {
      const mc: any = vtkImageMarchingCubes.newInstance({ contourValue: v, computeNormals: true, mergePoints: true });
      mc.setInputData(image);
      const m: any = vtkMapper.newInstance({ scalarVisibility: false });
      m.setInputConnection(mc.getOutputPort());
      const a: any = vtkActor.newInstance();
      a.setMapper(m);
      a.getProperty().setColor(...ctfColor(ctf, v));
      a.setPickable(false);
      iso.push({ actor: a });
    }
  };
  const apply = (): void => {
    show(volume, mode === "volume");
    slices.forEach((s) => show(s.actor, mode === "slices" && s.actor.getVisibility()));
    if (mode === "contour") {
      if (iso.length === 0) buildIso();
      iso.forEach((i) => show(i.actor, true));
    } else {
      iso.forEach((i) => show(i.actor, false));
    }
    show(outline, mode !== "off");
    renderer.getRenderWindow()?.render();
  };
  const bounds = (): Bounds6 => image.getBounds() as Bounds6;

  return {
    bounds,
    setMode(m: VolumeMode): void {
      mode = m;
      apply();
    },
    setColoring(ctfPoints: number[], range: [number, number]): void {
      ctf.removeAllPoints();
      for (let i = 0; i + 3 < ctfPoints.length; i += 4) ctf.addRGBPoint(ctfPoints[i], ctfPoints[i + 1], ctfPoints[i + 2], ctfPoints[i + 3]);
      ctf.setMappingRange(range[0], range[1]);
      ctf.updateRange?.();
      if (iso.length) buildIso();
      apply();
    },
    setOpacity(flat: number[]): void {
      const nodes: { x: number; y: number; midpoint: number; sharpness: number }[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) nodes.push({ x: flat[i], y: flat[i + 1], midpoint: 0.5, sharpness: 0 });
      opacity.setNodes(nodes);
      renderer.getRenderWindow()?.render();
    },
    setSlices(index: [number, number, number], visible: [boolean, boolean, boolean]): void {
      slices.forEach((s, axis) => {
        s.mapper.setSlice(Math.max(0, Math.min(lattice.dims[axis] - 1, Math.round(index[axis]))));
        s.actor.setVisibility(visible[axis]);
      });
      apply();
    },
    setIsoValues(values: number[]): void {
      isoValues = values.slice(0, MAX_ISO);
      if (mode === "contour") buildIso();
      else clearIso();
      apply();
    },
    dispose(): void {
      for (const p of [volume, outline, ...slices.map((s) => s.actor), ...iso.map((i) => i.actor)]) show(p, false);
      clearIso();
      volume.delete?.();
      volMapper.delete?.();
      image.delete?.();
    },
  };
}

function ctfColor(ctf: any, v: number): [number, number, number] {
  const out = [0.8, 0.8, 0.8];
  ctf.getColor(v, out);
  return out as [number, number, number];
}
