import * as THREE from "three";

/**
 * Makes `envMapIntensity` mean something for materials that inherit their
 * environment from `scene.environment`.
 *
 * ## The defect this exists for
 *
 * In three 0.185.1 the per-material intensity is only pushed into the uniform
 * when the material owns an `envMap` of its own (`WebGLMaterials`,
 * `refreshUniformsStandard`):
 *
 * ```js
 * if ( material.envMap ) {
 *     uniforms.envMapIntensity.value = material.envMapIntensity;
 * }
 * ```
 *
 * Every material in this project inherits from `scene.environment` and has
 * `material.envMap === null`, so that branch never runs. What runs instead is
 * `WebGLRenderer.setProgram`:
 *
 * ```js
 * if ( ( material.isMeshStandardMaterial || ... ) && material.envMap === null && scene.environment !== null ) {
 *     m_uniforms.envMapIntensity.value = scene.environmentIntensity;
 * }
 * ```
 *
 * so the uniform is not left at its declared default so much as *overwritten
 * every frame by the scene-wide value*, which amounts to the same thing: the
 * authored per-material number is discarded, silently, and the object is still
 * lit by the environment so nothing looks broken.
 *
 * ## The fix, and why it lives here
 *
 * Assigning `material.envMap = scene.environment` puts the material back on the
 * branch that reads its own value. For a `MeshStandardMaterial` that assignment
 * changes nothing else: `setProgram` resolves `material.envMap ||
 * materialProperties.environment` to the same PMREM texture with the same
 * `usePMREM`, and `envMapRotation` falls back from `scene.environmentRotation`
 * to `material.envMapRotation`, both identity here. The program cache key does
 * not move, so no material recompiles.
 *
 * It costs one thing, and the cost is why this is a mechanism rather than a
 * line in each system: **`scene.environmentIntensity` stops applying to a bound
 * material.** That is the knob `?env=`, `?lforce=noenv` and `?lforce=env8` drive,
 * so the binder folds it in itself — the material carries `authored * intensity`
 * and the authored number is kept here.
 *
 * Ownership: the lighting system owns the PMREM, so it owns this. Systems get
 * it for free and must not opt in; the whole reason this bug survived is that
 * the correct-looking thing (authoring `envMapIntensity`) silently did nothing,
 * and an opt-in fix has exactly the same failure mode for the next system.
 *
 * ## Lifetime
 *
 * `setEnvironment()` re-binds the whole scene before it returns, so the caller
 * may dispose the previous texture immediately afterwards: no material in the
 * graph still references it. Materials whose meshes are not in the graph at
 * that moment are picked up by the next sync, which runs from
 * `scene.onBeforeRender` — i.e. before every frame, including the first, and
 * including anything a system creates lazily or swaps in at runtime.
 */

/** Only `MeshStandardMaterial` and its `MeshPhysicalMaterial` subclass. Lambert
 *  and Phong read `scene.environment` too, but an `envMap` assigned to them
 *  switches the shader to the reflection/refraction blend path, which is a
 *  different feature. Basic and Shader materials never see the environment at
 *  all. None of the three are used with an authored intensity in this project. */
type Bindable = THREE.MeshStandardMaterial;

/**
 * `WebGLRenderer.render()` calls `scene.onBeforeRender( renderer, scene,
 * camera, renderTarget )` once per render, before anything is drawn. The
 * `@types/three` declaration only models the per-mesh form, which takes
 * geometry, material and group instead, hence the cast at the one call site.
 */
type SceneBeforeRender = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  renderTarget: THREE.WebGLRenderTarget | null
) => void;

interface Bound {
  /** What the owning system authored, before `scene.environmentIntensity`. */
  authored: number;
  /** The last value this binder wrote, so a later edit by the owner is visible. */
  applied: number;
}

export interface EnvBindCounts {
  /** Distinct materials bound since construction. */
  materials: number;
  /** Objects walked on the last sync, and standard-material slots seen. */
  objects: number;
  slots: number;
  /** Environments installed (1 unless something rebuilt the PMREM). */
  environments: number;
  syncs: number;
  /** `scene.environmentIntensity` as folded into every bound material. */
  intensity: number;
  lastSyncMs: number;
  worstSyncMs: number;
  /** Materials excused from binding because they own a different environment. */
  excluded: number;
}

export class EnvironmentBinding {
  /** Live object; safe to publish on a report and read later. */
  readonly counts: EnvBindCounts = {
    materials: 0,
    objects: 0,
    slots: 0,
    environments: 0,
    syncs: 0,
    intensity: 1,
    lastSyncMs: 0,
    worstSyncMs: 0,
    excluded: 0,
  };

  private texture: THREE.Texture | null = null;
  private intensity = 1;
  private readonly state = new WeakMap<THREE.Material, Bound>();
  private readonly excluded = new Set<THREE.Material>();
  private installed = false;
  private previousHook: SceneBeforeRender | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * Sync before every render. `Object3D.onBeforeRender` on the scene is called
   * once per `WebGLRenderer.render()` and before anything is drawn, so a
   * material created during this frame's `update()` is already correct in the
   * frame it first appears in. Any existing hook is chained, not replaced.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    const hooked = this.scene as unknown as { onBeforeRender: SceneBeforeRender };
    this.previousHook = hooked.onBeforeRender;
    hooked.onBeforeRender = (renderer, scene, camera, target) => {
      this.previousHook?.call(this.scene, renderer, scene, camera, target);
      this.sync();
    };
  }

  /**
   * Install (or replace) the environment. Binds the whole scene before
   * returning, so a previous texture is safe to dispose immediately after.
   */
  setEnvironment(texture: THREE.Texture | null, intensity: number): void {
    this.texture = texture;
    this.intensity = intensity;
    this.counts.environments++;
    this.counts.intensity = intensity;
    this.sync();
    if (texture !== null && this.counts.materials === 0) {
      // Only reachable if this is called before any mesh exists, which is the
      // normal case during init - the per-frame sync covers it. Loud enough to
      // notice if it is ever still true at capture time, which it must not be.
      console.warn("[envbind] environment installed but no materials bound yet (scene has no meshes)");
    }
  }

  /** Fold `scene.environmentIntensity` into every bound material. */
  setIntensity(intensity: number): void {
    if (intensity === this.intensity) return;
    this.intensity = intensity;
    this.counts.intensity = intensity;
    this.sync();
  }

  sync(): void {
    const t0 = performance.now();
    let objects = 0;
    let slots = 0;
    this.scene.traverse((o) => {
      objects++;
      const m = (o as THREE.Mesh).material;
      if (m === undefined) return;
      if (Array.isArray(m)) {
        for (const one of m) slots += this.bind(one);
      } else {
        slots += this.bind(m);
      }
    });
    const ms = performance.now() - t0;
    this.counts.objects = objects;
    this.counts.slots = slots;
    this.counts.syncs++;
    this.counts.lastSyncMs = ms;
    if (ms > this.counts.worstSyncMs) this.counts.worstSyncMs = ms;
  }

  /**
   * Excuse a material from binding, because it owns a *different* environment
   * on purpose.
   *
   * This binder's whole job is to force every standard material onto
   * `scene.environment`, and until the interior irradiance probe existed there
   * was no such thing as a material that legitimately wanted a different one.
   * There is now: the shop interior samples a PMREM of the room rather than the
   * outdoor sky, and without this exclusion the next `sync()` silently reverts
   * it — the probe is assigned, the frame is captured much later, and what gets
   * measured is the interior on the *world* environment at the probe's
   * intensity. That reads as a plausible improvement and is a completely
   * different change; it is exactly the shape of NOTES.md's recurring
   * "correct-looking code that never reached the screen", with the extra twist
   * that here something else reached the screen instead.
   *
   * Excluded materials are still counted, so a report can show the split.
   */
  exclude(materials: Iterable<THREE.Material>): void {
    for (const m of materials) this.excluded.add(m);
    this.counts.excluded = this.excluded.size;
  }

  private bind(material: THREE.Material): number {
    const m = material as Bindable;
    if (m.isMeshStandardMaterial !== true) return 0;
    if (this.excluded.has(material)) return 0;

    let st = this.state.get(m);
    if (st === undefined) {
      st = { authored: m.envMapIntensity, applied: Number.NaN };
      this.state.set(m, st);
      this.counts.materials++;
    } else if (m.envMapIntensity !== st.applied) {
      // The owning system retuned it since the last sync - that is now the
      // authored value. Without this, a later write (LightingSystem's own
      // `tuneInteriorMaterials`, or anything animating a material) would be
      // reverted on the next frame, which would be this bug's mirror image.
      st.authored = m.envMapIntensity;
    }

    // No `needsUpdate`: `setProgram` re-resolves `material.envMap ||
    // materialProperties.environment` every frame and the resolved texture is
    // unchanged, so the program cache key does not move and a recompile of
    // every material in the scene is not needed.
    if (m.envMap !== this.texture) m.envMap = this.texture;

    const want = st.authored * this.intensity;
    if (m.envMapIntensity !== want) m.envMapIntensity = want;
    st.applied = want;
    return 1;
  }

  /** What a bound material would have rendered with before this existed. */
  authoredIntensity(material: THREE.Material): number | null {
    return this.state.get(material)?.authored ?? null;
  }

  dispose(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.previousHook) {
      (this.scene as unknown as { onBeforeRender: SceneBeforeRender }).onBeforeRender = this.previousHook;
    }
    this.previousHook = null;
  }
}
