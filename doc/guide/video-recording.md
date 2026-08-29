# Recording a Video

**View ▾ ▸ Record…** captures the viewport as an animation.

![The Record panel, set to capture a 24-frame camera turntable as a WebM video](https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/video-record.png)

## Two sources

**Turntable** spins the camera through one full revolution and works for any
mesh — including `.mdpa` files, which have no time dimension at all. Choose how
many frames make up the turn; they divide 360° exactly, so the loop repeats
seamlessly with no duplicated frame at the seam.

**Time series** plays through every step of a VTK series. It is offered only
when the preview actually has one.

## Two outputs

| | |
|---|---|
| **WebM video** | One file, ready to play or drop into a slide. |
| **PNG frames** | One numbered image per frame, for encoding yourself. |

mp4 is not offered. The browser engine VS Code is built on cannot reliably
encode H.264, so rather than a format that sometimes fails, the PNG sequence is
the route — and when it saves, the extension prints the exact command:

```
ffmpeg -i mymesh_%04d.png out.mp4
```

The names are zero-padded so both a shell glob and ffmpeg's `%04d` see them in
the right order.

## What it costs

A turntable is cheap: it only moves the camera, so frames come as fast as the
scene draws.

A **time-series** recording is not. Every step is a full re-read of that step's
file from disk, and the recorder waits for each frame to genuinely be on screen
before capturing it. That is deliberate — capturing on a timer would record
whichever frame happened to have arrived — but it means a long series takes real
time. The panel counts frames as it goes, and **Cancel** keeps everything
captured so far.

## Split views

A recording includes every pane, with the separators between them drawn in so it
matches what you see. A turntable spins the **focused** pane, leaving the others
still — spinning all of them would destroy the side-by-side comparison a split
exists for.

## Why it looks the way it does

The recorder never samples the live 3D canvas on a timer. The renderer does not
preserve its drawing buffer between frames, so a capture taken even one moment
late comes back **black** — measured, not guessed. Instead each frame is drawn
and copied in the same breath onto a separate canvas, which is also where the
legend and the pane separators are painted. That is why a recording matches the
screen rather than being a slightly different picture of it.
