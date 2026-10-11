# Linked Previews

Compare two meshes or two runs by **linking** their previews: open each in its own tab, then let one viewpoint, field, colour range, clip plane or point in physical time drive the other. Every setting is its own switch, because "same camera, own field" and "same field, own camera" are both everyday comparisons.

## Linking two previews

Open both meshes (side by side in the editor works well), then in either one choose **Advanced ▸ Link previews…** (or the **Kratos MDPA: Link Previews…** command) and press **Link with…**. Pick the other preview from the list. The preview you asked from reports its view once and the other adopts it; from then on a change in either one follows in the other. **Unlink** ends it, and closing either preview does too.

| Shared setting | What follows |
|---|---|
| **Camera** | The viewpoint of the focused pane. Both meshes need to occupy the same coordinates for this to line up. |
| **Field** | The coloured field, its component and its display modes — when the other mesh has that field. |
| **Colour map and range** | Colormap, fixed range, log scale and bands, so the same colour means the same value. |
| **Clip plane** | Axis, position and flip of the clipping plane. |
| **Physical time** | The frame at the same physical time. |

## Time is matched by time, never by frame number

Two runs seldom share a time grid, so frame 7 of one is usually not frame 7 of the other. A linked preview moves to the frame whose **physical time** matches:

- **Exact time** (the default) needs a frame at that time; **Nearest within tolerance** takes the closest one that is no further away than the tolerance you give, in the series' own time unit.
- A tie — a time exactly halfway between two frames — is refused rather than guessed.
- A time with no counterpart leaves the other preview where it is, and the panel says so under **Not synchronised**, together with the reason.
- A series whose steps are plain step numbers (a filename series such as `Main_0_12.vtu`) has no physical time, so it is never linked on time; the panel explains that too.

## A field the other mesh does not have

A linked field choice is applied only where the receiving mesh can honour it. If the other mesh has no such field, it keeps its own and the panel lists the field that could not be shared, rather than blanking the display.

## What is remembered

The compared runs are saved with the view (the `<stem>.kratosview.json` sidecar, as paths relative to the mesh), together with which settings were shared. Reopening the mesh links it again as soon as the other preview is open, now or later. The sidecar records only identity — it never opens or reads the other file.

::: tip View only
Linking changes what you see, never the mesh: nothing is added to the edit history, no document is marked unsaved and no file is written other than the view sidecar.
:::
