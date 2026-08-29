import * as THREE from "three";

/**
 * Which object put a NaN in the environment cube?
 *
 * The environment is the one piece of shared state in this project that any
 * single object can destroy for every other system: one non-finite texel
 * propagates through the PMREM's GGX filter into a whole neighbourhood of every
 * mip, and from there into every `MeshStandardMaterial` in the scene, direct
 * sun included, while the sky dome and the unlit backdrop keep rendering
 * perfectly. NOTES.md case 31 is the full account, and the expensive part of it
 * was that the failure presented as four different plausible bugs in four other
 * people's code.
 *
 * So the counterpart to "the guard must refuse to publish" is "the guard must
 * be able to name the object", and that is this. Given a capture that has
 * already been measured as poisoned, it bisects the scene by **visibility** —
 * render only half the meshes, count non-finite texels, recurse into whichever
 * half still poisons the cube — and then, for an `InstancedMesh`, bisects again
 * over `count` to find the first offending instance and prints its transform.
 *
 * Three properties are deliberate:
 *
 * - **It tests "show only this subset", not "hide this subset".** Hiding a
 *   group proves that group is *sufficient* to remove the fault only if nothing
 *   else also causes it; showing a group proves that group causes it on its
 *   own. The difference matters here because occlusion changes the pixel count
 *   in both directions, and the count is the measurement.
 * - **It carries two controls and reports BROKEN if either fails**: the full
 *   scene must poison the cube, and the scene with every candidate hidden must
 *   not. A bisect whose predicate is stuck on true walks confidently to an
 *   arbitrary leaf, which is exactly the sort of authoritative wrong answer
 *   this project keeps paying for.
 * - **It never leaves the scene modified.** Visibility and instance counts are
 *   restored on every path including the throwing one.
 *
 * Off unless `?envculprit=1`. It costs one cube capture per probe and is
 * therefore far too expensive to run in a normal round.
 */

export interface CulpritReport {
  /** Non-finite cube texels with the whole scene visible. */
  baseline: number;
  /** With every candidate mesh hidden. Must be 0, or the bisect means nothing. */
  control: number;
  ok: boolean;
  why?: string;
  probes: number;
  /** Names of the meshes the bisect landed on. */
  culprits: string[];
  /**
   * With only the culprit visible, one material feature switched off at a time.
   * The entry that drops to 0 is the mechanism. `solo` is the control: it is
   * the same probe with nothing switched off and must be non-zero, or every
   * other row in the table is meaningless.
   */
  ablation?: Record<string, number>;
  /**
   * Range of every attribute buffer the culprit draws from, scanned on the CPU.
   *
   * The ablation table names the *feature* that carries the fault, which is a
   * shader-side answer; this says whether the data going into that feature was
   * already broken before it reached the GPU. Those need fixes in different
   * files, and reading source to guess which is how this bug has survived.
   */
  attributes?: Record<string, { count: number; bad: number; min: number; max: number }>;
  /** For an `InstancedMesh` culprit, the first instance index that poisons it. */
  instance?: {
    mesh: string;
    total: number;
    index: number;
    position: [number, number, number];
    scale: [number, number, number];
    quaternion: [number, number, number, number];
    /** Determinant of the upper 3x3. Zero means a collapsed instance. */
    determinant: number;
  };
}

/** IEEE 754 half -> float. Local copy so this module has no import cycle. */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const sign = s ? -1 : 1;
  if (e === 0) return sign * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : sign * Infinity;
  return sign * Math.pow(2, e - 15) * (1 + f / 1024);
}

export function findEnvCulprit(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  opts: { position: THREE.Vector3; size: number; near?: number; far?: number; maxProbes?: number }
): CulpritReport {
  // Deliberately coarser than the shipped cube. Every probe is six renders of
  // the whole scene, and at 256 the bisect blocks the frame for long enough to
  // risk a GPU watchdog reset. Dropping to 128 is only safe because the
  // baseline control below has to come back non-zero at *this* resolution: if
  // the fault is sub-pixel here, the probe reports BROKEN rather than a wrong
  // answer.
  const size = Math.min(opts.size, 128);
  const maxProbes = opts.maxProbes ?? 48;
  const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const cam = new THREE.CubeCamera(opts.near ?? 0.3, opts.far ?? 3000, cubeRT);
  cam.position.copy(opts.position);
  cam.updateMatrixWorld(true);
  const buf = new Uint16Array(size * size * 4);

  // Every mesh that is currently drawn, minus the sky dome: the dome is the one
  // object that must stay visible in every probe, because with it hidden the
  // whole cube is the clear colour and nothing can be distinguished.
  const candidates: THREE.Mesh[] = [];
  scene.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.name !== "sky-dome") candidates.push(m);
  });
  const wasVisible = candidates.map((m) => m.visible);
  const wasCount = candidates.map((m) =>
    (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : -1
  );

  let probes = 0;
  const badCount = (): number => {
    probes++;
    const prevTarget = renderer.getRenderTarget();
    const autoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    try {
      cam.update(renderer, scene);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.shadowMap.autoUpdate = autoUpdate;
    }
    let bad = 0;
    for (let f = 0; f < 6; f++) {
      renderer.readRenderTargetPixels(cubeRT, 0, 0, size, size, buf, f);
      for (let i = 0; i < size * size; i++) {
        if (
          !Number.isFinite(halfToFloat(buf[i * 4])) ||
          !Number.isFinite(halfToFloat(buf[i * 4 + 1])) ||
          !Number.isFinite(halfToFloat(buf[i * 4 + 2]))
        ) {
          bad++;
        }
      }
    }
    return bad;
  };

  const showOnly = (set: Set<THREE.Mesh>) => {
    for (const m of candidates) m.visible = set.has(m);
  };

  const report: CulpritReport = { baseline: 0, control: 0, ok: false, probes: 0, culprits: [] };
  try {
    showOnly(new Set(candidates));
    report.baseline = badCount();
    showOnly(new Set());
    report.control = badCount();
    if (report.baseline === 0 || report.control !== 0) {
      report.why =
        report.baseline === 0
          ? "BROKEN: the full scene does not poison the cube, so there is nothing to bisect"
          : `BROKEN: ${report.control} non-finite texels with every candidate mesh hidden - the fault is ` +
            `not in a mesh, or the sky dome itself is producing it`;
      return report;
    }

    // Bisect on "show only this list".
    const find = (list: THREE.Mesh[]): THREE.Mesh[] => {
      if (list.length <= 1 || probes >= maxProbes) return list;
      const mid = list.length >> 1;
      const a = list.slice(0, mid);
      const b = list.slice(mid);
      showOnly(new Set(a));
      if (badCount() > 0) return find(a);
      showOnly(new Set(b));
      if (badCount() > 0) return find(b);
      // Neither half poisons the cube alone, so the fault needs both - most
      // likely an occlusion effect rather than one object. Report the pair
      // rather than picking one, per NOTES: a probe that must return an answer
      // returns a wrong one.
      return list;
    };
    console.log(
      `[lighting] env culprit bisect: ${candidates.length} candidate meshes, ` +
        `baseline ${report.baseline} bad texels at ${size}px, control clean`
    );
    const culprits = find(candidates);
    report.culprits = culprits.map((m) => m.name || m.type);

    // Feature ablation on the culprit's own material.
    //
    // Naming the mesh is only half an answer: "the grass clumps do it" does not
    // say whether the fault is in the geometry, the instancing, the foliage
    // transmission patch or the standard material's own environment term, and
    // those need different fixes in different people's files. Switching one
    // feature off at a time, with only the culprit drawn, turns that into a
    // table where exactly one row should read zero.
    if (culprits.length === 1) {
      const mesh = culprits[0];
      const mat = mesh.material as THREE.Material;

      const attrs: CulpritReport["attributes"] = {};
      const scan = (name: string, a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
        let bad = 0;
        let min = Infinity;
        let max = -Infinity;
        const n = a.count * a.itemSize;
        for (let i = 0; i < n; i++) {
          const v = a.array[i] as number;
          if (!Number.isFinite(v)) bad++;
          else {
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }
        attrs[name] = { count: a.count, bad, min: bad === n ? NaN : min, max: bad === n ? NaN : max };
      };
      for (const [name, a] of Object.entries(mesh.geometry.attributes)) scan(name, a);
      const im = mesh as THREE.InstancedMesh;
      if (im.isInstancedMesh) {
        scan("instanceMatrix", im.instanceMatrix);
        if (im.instanceColor) scan("instanceColor", im.instanceColor);
      }
      report.attributes = attrs;

      if (!Array.isArray(mesh.material)) {
        showOnly(new Set([mesh]));
        const table: Record<string, number> = { solo: badCount() };
        const std = mat as THREE.MeshStandardMaterial;
        const ablations: { name: string; apply: () => () => void }[] = [
          {
            // The one custom shader on this material. Replacing the hook and
            // the cache key together is what actually forces a different
            // program; changing either alone silently reuses the old one.
            name: "noTransmissionPatch",
            apply: () => {
              const hook = mat.onBeforeCompile;
              const key = mat.customProgramCacheKey;
              mat.onBeforeCompile = () => {};
              mat.customProgramCacheKey = () => "envculprit-ablate-transmission";
              mat.needsUpdate = true;
              return () => {
                mat.onBeforeCompile = hook;
                mat.customProgramCacheKey = key;
                mat.needsUpdate = true;
              };
            },
          },
          {
            name: "noFog",
            apply: () => {
              // `fog` is declared on the concrete material classes rather than
              // on `Material`, and this probe deliberately does not care which
              // class it was handed.
              const f = mat as unknown as { fog: boolean };
              const v = f.fog;
              f.fog = false;
              mat.needsUpdate = true;
              return () => {
                f.fog = v;
                mat.needsUpdate = true;
              };
            },
          },
          {
            name: "noVertexColors",
            apply: () => {
              const v = mat.vertexColors;
              mat.vertexColors = false;
              mat.needsUpdate = true;
              return () => {
                mat.vertexColors = v;
                mat.needsUpdate = true;
              };
            },
          },
          {
            name: "noDithering",
            apply: () => {
              const v = mat.dithering;
              mat.dithering = false;
              mat.needsUpdate = true;
              return () => {
                mat.dithering = v;
                mat.needsUpdate = true;
              };
            },
          },
          {
            name: "frontSideOnly",
            apply: () => {
              const v = mat.side;
              mat.side = THREE.FrontSide;
              mat.needsUpdate = true;
              return () => {
                mat.side = v;
                mat.needsUpdate = true;
              };
            },
          },
          {
            name: "noEnvIntensity",
            apply: () => {
              const v = std.envMapIntensity;
              if (std.isMeshStandardMaterial) std.envMapIntensity = 0;
              return () => {
                if (std.isMeshStandardMaterial) std.envMapIntensity = v;
              };
            },
          },
          {
            name: "noAlphaTest",
            apply: () => {
              const v = mat.alphaTest;
              mat.alphaTest = 0;
              mat.needsUpdate = true;
              return () => {
                mat.alphaTest = v;
                mat.needsUpdate = true;
              };
            },
          },
        ];
        for (const a of ablations) {
          if (probes >= maxProbes + ablations.length + 4) break;
          const undo = a.apply();
          try {
            table[a.name] = badCount();
          } finally {
            undo();
          }
        }
        report.ablation = table;
      }
    }

    // If it came down to one InstancedMesh, find the first offending instance
    // by bisecting the draw count. `count` is the cheapest instance-level knob
    // there is and it needs no buffer rewrite.
    if (culprits.length === 1) {
      const im = culprits[0] as THREE.InstancedMesh;
      if (im.isInstancedMesh) {
        const total = im.count;
        showOnly(new Set([im]));
        let lo = 0; // known clean prefix length
        let hi = total; // known poisoning prefix length
        while (hi - lo > 1 && probes < maxProbes) {
          const midC = (lo + hi) >> 1;
          im.count = midC;
          if (badCount() > 0) hi = midC;
          else lo = midC;
        }
        im.count = total;
        const m4 = new THREE.Matrix4();
        im.getMatrixAt(hi - 1, m4);
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        m4.decompose(p, q, s);
        report.instance = {
          mesh: im.name || im.type,
          total,
          index: hi - 1,
          position: [p.x, p.y, p.z],
          scale: [s.x, s.y, s.z],
          quaternion: [q.x, q.y, q.z, q.w],
          determinant: m4.determinant(),
        };
      }
    }
    report.ok = true;
  } finally {
    candidates.forEach((m, i) => {
      m.visible = wasVisible[i];
      if (wasCount[i] >= 0) (m as THREE.InstancedMesh).count = wasCount[i];
    });
    cubeRT.dispose();
    report.probes = probes;
  }
  return report;
}
