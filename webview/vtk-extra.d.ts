// Ambient declarations for VTK.js modules that ship without .d.ts files.
declare module "@kitware/vtk.js/Rendering/Core/CubeAxesActor" {
  const vtkCubeAxesActor: {
    newInstance(initialValues?: Record<string, unknown>): any;
    extend(publicAPI: object, model: object, initialValues?: Record<string, unknown>): void;
  };
  export default vtkCubeAxesActor;
}

declare module "@kitware/vtk.js/Rendering/OpenGL/CubeAxesActor" {
  // Side-effect import — registers the OpenGL rendering backend.
}
