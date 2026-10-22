// The one place the webview touches vtk.js's widget framework (roadmap item
// 22 C). A widget is a VIEW of state the webview already owns — the clip plane
// is `PaneClipState`, mapped by widgetMath.ts — so the callback hands back
// plain origin/normal and nothing here keeps state of its own.

import vtkWidgetManager from "@kitware/vtk.js/Widgets/Core/WidgetManager";
import vtkImplicitPlaneWidget from "@kitware/vtk.js/Widgets/Widgets3D/ImplicitPlaneWidget";
import type { Bounds6, Vec3 } from "../../../src/parser/render/types";
import type { RPlaneWidget } from "../backend";

export function createPlaneWidget(
  renderer: any,
  onChange: (origin: Vec3, normal: Vec3) => void,
  onInteraction: (active: boolean) => void
): RPlaneWidget {
  const manager: any = vtkWidgetManager.newInstance();
  manager.setRenderer(renderer);
  const widget: any = vtkImplicitPlaneWidget.newInstance();
  const view: any = manager.addWidget(widget);
  view.setNormalVisible?.(true);
  view.setOutlineVisible?.(false);
  widget.setPlaceFactor?.(1);
  let applying = false;
  const emit = (): void => {
    if (applying) return;
    const st = widget.getWidgetState();
    onChange([...st.getOrigin()] as Vec3, [...st.getNormal()] as Vec3);
  };
  const subs = [
    view.onStartInteractionEvent?.(() => onInteraction(true)),
    view.onInteractionEvent?.(emit),
    view.onEndInteractionEvent?.(() => {
      emit();
      onInteraction(false);
    }),
  ];
  manager.enablePicking?.();
  return {
    setPlane(origin: Vec3, normal: Vec3): void {
      applying = true;
      try {
        const st = widget.getWidgetState();
        st.setOrigin(origin);
        st.setNormal(normal);
      } finally {
        applying = false;
      }
    },
    setBounds(b: Bounds6): void {
      widget.placeWidget(b);
    },
    setVisible(v: boolean): void {
      view.setVisibility?.(v);
      if (v) manager.enablePicking?.();
      else manager.disablePicking?.();
      renderer.getRenderWindow()?.render();
    },
    dispose(): void {
      for (const s of subs) s?.unsubscribe?.();
      manager.removeWidget(widget);
      manager.delete?.();
      widget.delete?.();
    },
  };
}
