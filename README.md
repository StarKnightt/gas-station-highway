# dawn-station

A photorealistic first-person Three.js scene: a gas station on a highway, at dawn.

Every texture, mesh, material and sound in the scene is generated at runtime from
code. There are no image files, no model files and no audio files — the only
runtime dependency is `three`. The asphalt, the soil, the pump housings, the
building, the vegetation, the car, the sky and the ambient audio bed are all
built procedurally in `src/gen/` and assembled by the systems in `src/systems/`.

## Running it

```
pnpm install
pnpm dev        # vite dev server
```

To build and serve a production bundle:

```
pnpm build      # tsc --noEmit && vite build
pnpm preview
```

Two other scripts exist for the capture pipeline: `pnpm shoot` (renders stills
and frame sequences via Playwright into `shots/`) and `pnpm audio` (renders the
audio bed and its plots).

## Hardware

This needs a real GPU. It is not a scene that degrades gracefully onto
integrated graphics or a software rasteriser — expect single-digit frame rates
if you try.

## Layout

- `src/gen/` — procedural generators: geometry, textures, noise, materials.
- `src/systems/` — scene systems: terrain, building, canopy, pumps, car,
  vegetation, lighting, sky, audio, player and interaction.
- `tools/` — measurement and capture harnesses. Most are single-purpose probes
  written to answer one question about a rendered frame.
- `NOTES.md` — a running log of silent failure modes hit while building this,
  and what each one taught about instrumenting a renderer.
- `PERF.md`, `HANDOVER-*.md` — performance budget and per-system handover notes.

Capture output (`shots/`, `audio-plots/`) is generated and is not tracked here.
