# Recording GIFs and videos

Choose **View ▾ → Record…** to capture frames, review them, then export a GIF, WebM video or numbered PNG sequence. The workflow takes inspiration from [ScreenToGif](https://github.com/nickemanarin/screentogif); no external recording application is required.

## Capture

**Turntable** rotates the focused pane through a complete revolution, including for `.mdpa` meshes. **Time series** captures selected solution steps: choose an inclusive first/last step and a positive stride. Step positions in these controls start at 1.

Expand **Capture settings** for whole-layout or focused-pane output, resolution, backgrounds, legends, step/time labels, title and caption. These are independent of the Screenshot panel. **Use screenshot settings** explicitly copies its current settings.

The camera and each pane's current color range stay fixed across solution steps. The recorded result keeps a shared range across steps; if no range was set before capture, the initial step supplies it. Values outside that range use the colormap endpoints. Capture waits for each step to load and render, then writes its PNG before advancing. Slow loading affects capture time, not playback timing.

The panel shows progress and permits cancellation. Missing fields/components, changed source files and failed steps stop capture and retain completed frames. Capture temporarily locks other scene interactions and restores the original timeline position, camera, fields and clipping when it finishes or stops.

## Review and recovery

Scrub captured frames, trim the first/last frame and exclude individual frames. Included frames keep their original order. Set playback FPS (12 by default), preview the selection and choose once or forever looping. Physical-time labels identify source data; they do not change playback durations.

Drafts are stored on disk in VS Code's extension storage, including after cancellation or export failure. Reopen Record and choose a **Saved draft** to continue. **Discard draft** removes that draft's captured images; exported files are unaffected. Long or high-resolution recordings need sufficient disk space. The recorder keeps a bounded number of pixel buffers in memory rather than holding the entire animation.

## Export

| Format | Behavior |
| --- | --- |
| **Numbered PNG frames** | Lossless images with original alpha, written into a new folder. Includes a manifest mapping images to source steps and playback timestamps, plus FFmpeg instructions. |
| **GIF** | A shared palette of up to 256 colors, fixed playback timing rounded to GIF's centisecond precision, and once/forever looping. Maximum 50 FPS. |
| **WebM** | VP9 or VP8 encoding when supported by the browser at the requested dimensions. Explicit timestamps give the chosen playback rate regardless of loading speed. One playback pass; looping belongs to the player. |

GIF and WebM composite transparent captures onto the **GIF / WebM matte**, white by default. PNG exports retain transparency. GIF quantization and WebM compression can change pixel colors; use PNG for lossless scientific images.

Encoders are bundled for offline use. If the browser cannot encode WebM, use GIF or PNG. Cancelling a save dialog or encountering an encoding/write error preserves the draft. “Saved” appears only after the host finishes writing the export.

Native MP4 is not offered. The PNG folder includes commands such as the following, with the selected FPS and filename width filled in. Run them inside that folder using your own FFmpeg installation:

```sh
ffmpeg -framerate 12 -start_number 0 -i "frame_%04d.png" -c:v libvpx-vp9 "output.webm"
ffmpeg -framerate 12 -start_number 0 -i "frame_%04d.png" -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -pix_fmt yuv420p "output.mp4"
```

## Split views

Whole-layout capture includes every pane and separator, with each pane's matching field legend. Focused-pane capture includes only the selected pane. A turntable rotates only that pane and restores its camera afterward. Both paths share the [screenshot compositor](./screenshot-export).

For implementation details, see [Capture architecture](../capture-architecture).
