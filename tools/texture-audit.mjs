/**
 * texture-audit.mjs — where the texture memory actually is, and what could be
 * shared without changing a pixel.
 *
 * Counts by `source.uuid`, never by `Texture` object: the renderer keys an
 * upload on the source, and `Texture.clone()` shares it, so counting wrappers
 * multiplies the answer by however many clones exist. Three parties overstated
 * their texture memory that way in one night (see NOTES).
 *
 * Reports four things:
 *
 *   1. Every unique source, its bytes, and which meshes reference it.
 *   2. Sources with byte-identical content under different uuids — a real
 *      consolidation candidate, since they are separate uploads of the same
 *      image.
 *   3. Sources whose content is a single flat colour, which do not need to be
 *      full size at all.
 *   4. Materials that share a `customProgramCacheKey` while having different
 *      `onBeforeCompile` functions — the precondition for the wrong-shader bug.
 *
 * On (2) and (3) the output is deliberately *candidates*, not findings. A
 * previous version of the capture check in this project shipped a 42:1
 * false-positive rate and had to be withdrawn; a list nobody trusts is worse
 * than no list. Identity here requires equal dimensions, equal format, equal
 * type and an equal hash of a 128x128 resample — enough to be worth a human
 * look, not enough to act on blind.
 *
 * No timing. The host is saturated (PERF.md section 5); bytes are the
 * contention-robust quantity.
 *
 *   node tools/texture-audit.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { launchOptions, assertHardwareGpu, isSoftwareRenderer, assertSceneGpu } from "./gpu.mjs";
import { assertPrivateBuildDir, scratchDir } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const OUT_DIR = path.join(ROOT, "tools/perf-out");
// tools/scratch.mjs for why this is not a top-level directory.
const BUILD_DIR = scratchDir(ROOT, "texaudit");
const DO_BUILD = !process.argv.includes("--no-build");

const resources = { server: null, browser: null, startedServer: false };

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

async function shutdown(code, reason) {
  if (reason) console.error(`[texaudit] shutting down: ${reason}`);
  try {
    if (resources.browser) await resources.browser.close();
  } catch (e) {
    console.error(`[texaudit] browser close failed: ${e.message}`);
  }
  try {
    if (resources.server) await resources.server.close();
  } catch (e) {
    console.error(`[texaudit] server close failed: ${e.message}`);
  }
  if (resources.startedServer && (await portInUse(PORT))) {
    console.error(`[texaudit] !! port ${PORT} still listening after teardown; this harness started it`);
  } else {
    console.log(`[texaudit] port ${PORT} clear`);
  }
  process.exit(code);
}

const PAGE_AUDIT = () => {
  const g = window.__GAME;

  /* Bytes per pixel by three's format/type constants. Only the combinations
   * this project actually uses; anything else is reported as unknown rather
   * than guessed, because a wrong bpp silently rescales the whole report. */
  const FORMAT_CH = { 1023: 4, 1022: 3, 1028: 1, 1029: 2, 1026: 1, 1027: 1 };
  const TYPE_BYTES = { 1009: 1, 1010: 1, 1015: 4, 1016: 2, 1014: 4, 1012: 2, 1013: 2 };
  const FORMAT_NAME = { 1023: "RGBA", 1022: "RGB", 1028: "Red", 1029: "RG", 1026: "Depth", 1027: "DepthStencil" };
  const TYPE_NAME = { 1009: "u8", 1015: "f32", 1016: "f16", 1014: "u32" };

  const sources = new Map();
  const meshOf = new Map();

  const topLevelName = (obj) => {
    let n = obj;
    let last = obj.name || "";
    while (n && n.parent && n.parent !== g.scene) {
      n = n.parent;
      if (n.name) last = n.name;
    }
    return last || "(unnamed)";
  };

  const noteTexture = (tex, slot, owner) => {
    if (!tex || !tex.isTexture || !tex.source) return;
    const id = tex.source.uuid;
    let rec = sources.get(id);
    if (!rec) {
      const img = tex.source.data;
      const w = (img && (img.width ?? img.videoWidth)) || tex.image?.width || 0;
      const h = (img && (img.height ?? img.videoHeight)) || tex.image?.height || 0;
      const ch = FORMAT_CH[tex.format];
      const tb = TYPE_BYTES[tex.type];
      const base = ch && tb ? w * h * ch * tb : null;
      // A generated mip chain is 1/3 again on top of level 0.
      const mipped = tex.generateMipmaps !== false && tex.minFilter !== 1003 && tex.minFilter !== 1006;
      rec = {
        uuid: id,
        w,
        h,
        format: FORMAT_NAME[tex.format] ?? tex.format,
        type: TYPE_NAME[tex.type] ?? tex.type,
        bytes: base === null ? null : Math.round(base * (mipped ? 4 / 3 : 1)),
        mipped,
        isRenderTarget: !!tex.isRenderTargetTexture,
        wrappers: 0,
        names: new Set(),
        slots: new Set(),
        owners: new Set(),
        hash: null,
        flat: null,
        // Kept only for hashing below, and stripped before the record is
        // returned: a canvas or ImageBitmap cannot cross the CDP boundary.
        drawable: img,
      };
      sources.set(id, rec);
    }
    rec.wrappers++;
    if (tex.name) rec.names.add(tex.name);
    rec.slots.add(slot);
    if (owner) rec.owners.add(owner);
  };

  const SLOTS = [
    "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap",
    "alphaMap", "bumpMap", "displacementMap", "envMap", "lightMap", "clearcoatMap",
    "clearcoatNormalMap", "clearcoatRoughnessMap", "sheenColorMap", "sheenRoughnessMap",
    "specularIntensityMap", "specularColorMap", "transmissionMap", "thicknessMap",
    "iridescenceMap", "anisotropyMap",
  ];

  const materials = [];
  g.scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    const owner = topLevelName(o);
    for (const one of Array.isArray(m) ? m : [m]) {
      materials.push({ mat: one, owner, mesh: o.name || "" });
      for (const s of SLOTS) noteTexture(one[s], s, owner);
      if (one.uniforms) {
        for (const k of Object.keys(one.uniforms)) {
          const v = one.uniforms[k]?.value;
          if (v && v.isTexture) noteTexture(v, `uniform:${k}`, owner);
        }
      }
    }
    meshOf.set(o, owner);
  });
  if (g.scene.environment) noteTexture(g.scene.environment, "scene.environment", "(scene)");
  if (g.scene.background && g.scene.background.isTexture) noteTexture(g.scene.background, "scene.background", "(scene)");
  g.scene.traverse((o) => {
    if (o.isLight && o.shadow && o.shadow.map) {
      if (o.shadow.map.texture) noteTexture(o.shadow.map.texture, "shadow.colour", `light:${o.name || "?"}`);
      if (o.shadow.map.depthTexture) noteTexture(o.shadow.map.depthTexture, "shadow.depth", `light:${o.name || "?"}`);
    }
  });

  /* Content hash. Resample to 128x128 through a canvas so sources of the same
   * dimensions can be compared cheaply, and separately detect a single flat
   * colour, which is the one case where a large texture is certainly wasteful. */
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 128;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  for (const rec of sources.values()) {
    if (rec.isRenderTarget || !rec.w || !rec.h) continue;
    const drawable = rec.drawable;
    // Canvas, ImageBitmap and HTMLImageElement are drawImage-able. A raw typed
    // array (DataTexture) is not; it is hashed directly below.
    const isDrawable =
      drawable &&
      (typeof HTMLCanvasElement !== "undefined" && drawable instanceof HTMLCanvasElement ||
        (typeof ImageBitmap !== "undefined" && drawable instanceof ImageBitmap) ||
        (typeof HTMLImageElement !== "undefined" && drawable instanceof HTMLImageElement) ||
        (typeof OffscreenCanvas !== "undefined" && drawable instanceof OffscreenCanvas));
    if (!isDrawable) {
      const raw = drawable && drawable.data;
      if (raw && raw.length) {
        let h1 = 0x811c9dc5;
        // Stride so a 4096-square DataTexture does not dominate the run; the
        // stride is deterministic, so equal content still hashes equal.
        const stride = Math.max(1, Math.floor(raw.length / 65536));
        for (let i = 0; i < raw.length; i += stride) {
          h1 ^= raw[i] & 0xff;
          h1 = (h1 * 0x01000193) >>> 0;
        }
        rec.hash = `d${h1.toString(16)}`;
        let flat = true;
        for (let i = 4; i < raw.length && flat; i += 4) {
          if (raw[i] !== raw[0] || raw[i + 1] !== raw[1] || raw[i + 2] !== raw[2]) flat = false;
        }
        rec.flat = flat ? `raw(${raw[0]},${raw[1]},${raw[2]})` : null;
      }
      continue;
    }
    try {
      cx.clearRect(0, 0, 128, 128);
      cx.drawImage(drawable, 0, 0, 128, 128);
      const d = cx.getImageData(0, 0, 128, 128).data;
      let h1 = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) {
        h1 ^= d[i];
        h1 = (h1 * 0x01000193) >>> 0;
      }
      rec.hash = h1.toString(16);
      let flat = true;
      for (let i = 4; i < d.length && flat; i += 4) {
        if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) flat = false;
      }
      rec.flat = flat ? `rgba(${d[0]},${d[1]},${d[2]},${d[3]})` : null;
    } catch {
      rec.hash = null;
    }
  }

  /* Cache-key collisions.
   *
   * The naive test — same key, different `onBeforeCompile` function object — is
   * useless here, and knowing why matters. Three's *default*
   * `customProgramCacheKey()` is `this.onBeforeCompile.toString()`
   * (`Material.js:543`), so a wrapped hook normally lands in the key by itself
   * and materials sharing a key are usually sharing it correctly. Function
   * identity differs for every closure, so that test flagged 16 groups
   * including 46 foliage materials that are all fine.
   *
   * What actually matters is whether two materials under one key generate
   * different *text*. So run each hook against a mock shader object and hash
   * what comes out. Same key + different generated source = the real defect:
   * one of them will silently render with the other's program.
   *
   * The hooks are invoked on a throwaway page, and a hook that mutates its
   * material (the terrain `?flat=` path sets `normalScale`) does so on a scene
   * that is about to be discarded. */
  const mockShader = () => ({
    uniforms: {},
    vertexShader: "#include <common>\n#include <begin_vertex>\n#include <beginnormal_vertex>\n#include <project_vertex>\n#include <fog_vertex>\n#include <worldpos_vertex>\n#include <defaultnormal_vertex>\n#include <uv_vertex>",
    fragmentShader:
      "#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <lights_physical_fragment>\n#include <lights_fragment_maps>\n#include <emissivemap_fragment>\n#include <transmission_fragment>\n#include <opaque_fragment>\n#include <dithering_fragment>\n#include <alphatest_fragment>\n#include <metalnessmap_fragment>\n#include <aomap_fragment>\n#include <clipping_planes_fragment>\n#include <output_fragment>\n#include <fog_fragment>\n#include <colorspace_fragment>",
    defines: {},
  });
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  };

  const byKey = new Map();
  const seenMat = new Set();
  for (const { mat, owner } of materials) {
    if (seenMat.has(mat)) continue;
    seenMat.add(mat);
    let key = null;
    try {
      key = typeof mat.customProgramCacheKey === "function" ? mat.customProgramCacheKey() : null;
    } catch {
      key = "(threw)";
    }
    if (!key) continue;
    let genHash = "(no hook)";
    if (typeof mat.onBeforeCompile === "function") {
      try {
        const sh = mockShader();
        mat.onBeforeCompile(sh, g.renderer);
        genHash = fnv(`${sh.vertexShader}\u0000${sh.fragmentShader}\u0000${Object.keys(sh.defines ?? {}).sort().join(",")}`);
      } catch (e) {
        genHash = `(threw: ${e.message})`;
      }
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ owner, genHash, hookSrc: fnv(String(mat.onBeforeCompile)) });
  }

  const keyCollisions = [];
  for (const [key, group] of byKey) {
    const gens = new Set(group.map((e) => e.genHash));
    if (group.length > 1 && gens.size > 1) {
      const byGen = {};
      for (const e of group) (byGen[e.genHash] ??= []).push(e.owner);
      keyCollisions.push({
        // A key can be an entire shader (three's default is the stringified
        // hook), so truncate for the report and keep the hash for identity.
        key: key.length > 120 ? `${key.slice(0, 120)}… (${key.length} chars, hash ${fnv(key)})` : key,
        materials: group.length,
        distinctGeneratedShaders: gens.size,
        groups: Object.entries(byGen).map(([h, owners]) => ({ generated: h, owners: [...new Set(owners)].slice(0, 8) })),
      });
    }
  }
  const keyGroupsChecked = byKey.size;

  const list = [...sources.values()].map((r) => {
    const { drawable, ...rest } = r;
    void drawable;
    return {
      ...rest,
      names: [...r.names].slice(0, 4),
      slots: [...r.slots],
      owners: [...r.owners].slice(0, 6),
    };
  });
  list.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

  /* Duplicate content across distinct sources. Requires dimensions, format,
   * type AND hash to agree; a hash alone would collapse every 256-square
   * cutout that happens to resample the same way. Flat-colour sources are
   * excluded here and reported in their own category, because "these twelve
   * white squares are identical" is true, useless, and exactly the kind of
   * bulk false positive that got the first capture check withdrawn. */
  const dupGroups = new Map();
  for (const r of list) {
    if (!r.hash || r.flat || r.isRenderTarget) continue;
    const k = `${r.w}x${r.h}|${r.format}|${r.type}|${r.hash}`;
    if (!dupGroups.has(k)) dupGroups.set(k, []);
    dupGroups.get(k).push(r);
  }
  const duplicates = [...dupGroups.values()]
    .filter((grp) => grp.length > 1)
    .map((grp) => ({
      w: grp[0].w,
      h: grp[0].h,
      format: grp[0].format,
      copies: grp.length,
      bytesEach: grp[0].bytes,
      reclaimableMB: +(((grp.length - 1) * (grp[0].bytes ?? 0)) / 1048576).toFixed(2),
      names: grp.map((r) => r.names[0] ?? "(unnamed)"),
      owners: [...new Set(grp.flatMap((r) => r.owners))],
    }))
    .sort((a, b) => b.reclaimableMB - a.reclaimableMB);

  const totalBytes = list.reduce((a, b) => a + (b.bytes ?? 0), 0);
  const wrappers = list.reduce((a, b) => a + b.wrappers, 0);

  const byOwner = {};
  for (const r of list) {
    // Attribute a shared source to every owner that references it, and say so:
    // splitting it would invent a division that does not exist.
    for (const o of r.owners) byOwner[o] = (byOwner[o] ?? 0) + (r.bytes ?? 0) / r.owners.length;
  }

  return {
    uniqueSources: list.length,
    textureWrappers: wrappers,
    totalMB: +(totalBytes / 1048576).toFixed(2),
    glLiveMB: +(window.__GLSTAT.live.texBytes / 1048576).toFixed(2),
    glPeakMB: +(window.__GLSTAT.peak.texBytes / 1048576).toFixed(2),
    byOwner: Object.fromEntries(
      Object.entries(byOwner)
        .map(([k, v]) => [k, +(v / 1048576).toFixed(2)])
        .sort((a, b) => b[1] - a[1])
    ),
    top: list.slice(0, 30),
    flat: list.filter((r) => r.flat),
    duplicates,
    keyCollisions,
    keyGroupsChecked,
  };
};

async function run() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  const instrument = await fs.readFile(path.join(ROOT, "tools/perf-instrument.js"), "utf8");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (DO_BUILD) {
    console.log("[texaudit] building...");
    assertPrivateBuildDir(ROOT, BUILD_DIR, "texaudit");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  resources.startedServer = true;
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions());
  const context = await resources.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpu = await assertHardwareGpu(gpuPage, { tag: "texaudit" });
  if (isSoftwareRenderer(gpu.renderer)) throw new Error("software renderer");
  await gpuPage.close();

  const page = await context.newPage();
  await page.addInitScript({ content: instrument });
  await page.goto(base, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
  await assertSceneGpu(page, { tag: "texaudit", when: "after ready" });
  await page.evaluate(
    () => new Promise((r) => { let n = 0; const t = () => (++n < 90 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); })
  );

  const a = await page.evaluate(PAGE_AUDIT);

  const lines = [];
  const line = (s = "") => {
    lines.push(s);
    console.log(s);
  };
  line();
  line("=========== TEXTURE AUDIT (by source.uuid) ===========");
  line(`unique sources ${a.uniqueSources}   texture wrappers ${a.textureWrappers}   (wrappers/sources = ${(a.textureWrappers / a.uniqueSources).toFixed(2)})`);
  line(`scene-graph total ${a.totalMB} MB     GL live ${a.glLiveMB} MB     GL peak ${a.glPeakMB} MB`);
  line(`unaccounted (GL live - scene graph) ${+(a.glLiveMB - a.totalMB).toFixed(2)} MB`);
  line();
  line("-- by owner (shared sources split evenly across referencing owners) --");
  for (const [k, v] of Object.entries(a.byOwner)) if (v >= 1) line(`  ${String(v).padStart(8)} MB  ${k}`);
  line();
  line("-- 30 largest sources --");
  for (const r of a.top) {
    line(
      `  ${String(+((r.bytes ?? 0) / 1048576).toFixed(2)).padStart(7)} MB  ${String(r.w) + "x" + String(r.h)} ${r.format}/${r.type}` +
        `${r.mipped ? " +mip" : ""}${r.isRenderTarget ? " [RT]" : ""}  x${r.wrappers}  ${r.slots.slice(0, 3).join(",")}  ${r.names[0] ?? ""}  <- ${r.owners.join(", ")}`
    );
  }
  line();
  line(`-- byte-identical duplicate sources (${a.duplicates.length} groups) --`);
  if (!a.duplicates.length) line("  none");
  for (const d of a.duplicates) {
    line(`  ${String(d.reclaimableMB).padStart(7)} MB reclaimable  ${d.copies} copies of ${d.w}x${d.h} ${d.format}  ${d.names.join(" / ")}  <- ${d.owners.join(", ")}`);
  }
  line();
  line(`-- flat single-colour sources (${a.flat.length}) --`);
  for (const r of a.flat) {
    line(`  ${String(+((r.bytes ?? 0) / 1048576).toFixed(2)).padStart(7)} MB  ${r.w}x${r.h} ${r.flat}  ${r.names[0] ?? ""}  <- ${r.owners.join(", ")}`);
  }
  line();
  line(`-- cache-key collisions: same key, different generated shader (${a.keyCollisions.length} of ${a.keyGroupsChecked} key groups) --`);
  if (!a.keyCollisions.length) line("  none — every group of materials sharing a cache key generates identical source");
  for (const c of a.keyCollisions) {
    line(`  ${c.materials} materials -> ${c.distinctGeneratedShaders} DIFFERENT shaders under one key`);
    line(`    key: ${c.key}`);
    for (const grp of c.groups) line(`      shader ${grp.generated}: ${grp.owners.join(", ")}`);
  }
  line("======================================================");

  await fs.writeFile(path.join(OUT_DIR, "texture-audit.json"), JSON.stringify({ gpu, ...a }, null, 2));
  await fs.writeFile(path.join(OUT_DIR, "texture-audit.log"), lines.join("\n"));
}

process.on("SIGINT", () => shutdown(130, "SIGINT"));
run().then(
  () => shutdown(0, null),
  (e) => {
    console.error(e);
    shutdown(1, e.message);
  }
);
