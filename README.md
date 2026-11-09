# Klein Local

A local image studio for **FLUX.2 Klein 4B** on a pan-and-zoom canvas. Generate with [Draw Things](https://drawthings.ai) on your machine. Drop a picture onto the subject or style box to describe it with fal.ai.

Open [http://127.0.0.1:3456](http://127.0.0.1:3456) after start. Nothing is uploaded except describe requests to fal.

## Requirements

- macOS with [Draw Things](https://drawthings.ai) and `draw-things-cli` on your `PATH`
- Node.js 20+
- A [fal.ai](https://fal.ai) API key if you want image describe (optional for generate-only)

Download the Klein checkpoint once:

```bash
draw-things-cli models ensure --model flux_2_klein_4b_q8p.ckpt
```

## Setup

```bash
npm install
```

For describe, create a `.env` in the project root (this file is gitignored):

```
FALKEY=your_fal_key
```

Then:

```bash
npm start
```

The studio listens on port `3456`. Use `PORT=3457 npm start` to change it.

## Using it

The right panel is always open. The rest of the window is the canvas: scroll to pan, pinch or trackpad to zoom, drag a box to select.

**Describe.** Drop or paste an image onto **Subject** or **Style**. fal writes a subject layout or a style brief (medium, palette, light). Generated images reuse the prompt that made them instead of calling fal again.

**Generate.** Fill subject and/or style, pick an aspect on the placeholder, choose a sampler (including **Random**), and press play. Play stays available — extra presses queue more jobs. A live preview appears on the canvas while Klein samples.

**Canvas.** Drop or paste images onto the board to import them. Right-click one image for Copy, Download, or Enlarge. Right-click a multi-selection for Grid (animated masonry) or Delete. Delete removes the file from `generated/`.

**Enlarge.** Lanczos-rescales the short side to 1024px, then runs Klein img2img at strength `0.3`. The new node sits beside the original at 2× canvas size.

## Layout

| Path | Role |
| --- | --- |
| `server.js` | Express app, Draw Things generate, fal describe |
| `public/` | Studio UI |
| `src/canvas/` | React Flow canvas (bundled on start) |
| `generated/` | Library folder; the canvas is a live view of it |

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `FALKEY` | — | fal.ai key for describe (`FAL_KEY` also works) |
| `PORT` | `3456` | Studio port |
| `DRAWTHINGS_MODEL` | `flux_2_klein_4b_q8p.ckpt` | Draw Things checkpoint |
| `FAL_DESCRIBE_MODEL` | `openai/gpt-5-mini` | Vision model on fal |

Keep `.env` local. Do not commit API keys.
