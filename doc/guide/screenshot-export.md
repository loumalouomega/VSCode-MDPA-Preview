# Screenshot export

Choose **View ▾ → Screenshot…** to review and save a PNG of the current field visualization. The preview is the exact image saved by **Save PNG…**; after changing a setting, refresh it before saving.

Capture the whole pane layout or only the pane that has focus. Output can follow the viewport at 1×, 2× or 4×, or use custom pixel dimensions. When a custom aspect ratio differs from the rendered view, the utility pads the image to preserve the scene proportions. Very large captures are rejected before rendering to avoid excessive GPU and canvas memory use.

Choose the scene background, white, black, a custom color, or transparent PNG. Transparent edges preserve renderer alpha. The preview uses a checkerboard to show transparency; the checkerboard is not saved.

Automatic legends follow each pane's active field colormap and value range. Vector labels identify the selected component or magnitude, and units appear when supplied by the source data. Transient previews can include their step or physical-time label. A title and multiline caption are presentation text baked into the export and do not modify the mesh or live view.

The same legend compositor decorates recorded frames. Screenshot-panel settings apply to the still-image preview; the existing recorder keeps its own capture settings.
