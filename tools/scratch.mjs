/**
 * Scratch and private-build-directory conventions for the headless harnesses.
 *
 * ## Why this exists
 *
 * A vite build with `emptyOutDir: true` deletes its `outDir` first. Every
 * harness here uses that, correctly — a stale chunk left behind from a previous
 * build is how a capture ends up photographing two bundles at once. The
 * arrangement is safe exactly as long as every `outDir` is private to one run.
 *
 * It stopped being safe. `.shot-build/` currently holds an `index.html` and an
 * `assets/` directory at its **root**, and most of the per-harness
 * subdirectories that used to sit beside them are gone. That is the signature
 * of a build pointed at `.shot-build/` itself with `emptyOutDir: true`: it
 * wiped every agent's private bundle and left its own in the crater. It cost
 * one agent two rounds.
 *
 * The mechanism is in `tools/shoot.mjs`:
 *
 *     const SYSTEM = arg("system", "system1");
 *     const BUILD_DIR = `.shot-build/${SYSTEM}`;
 *
 * `arg()` returns whatever followed the `=`, so `--system=` — a shell variable
 * that expanded to nothing, a copied command with the value trimmed off — makes
 * `SYSTEM` the empty string and `BUILD_DIR` the shared root. Nothing in the
 * defaulting is wrong; `arg("system", "system1")` supplies a fallback for a
 * *missing* flag, and `--system=` is not missing. It is present and empty, and
 * an empty string interpolated into a path silently removes a level.
 *
 * That is the same failure as the 65-byte 0x0 PNGs in the repo root, which were
 * written to paths named `640`, `560` and `100`: **an argument that is empty or
 * mis-parsed becomes a path, and a path is acted on without being checked.**
 * Neither case announced itself. One deleted six directories, the other created
 * files that a critic could have been shown.
 *
 * So: assert the destination before destroying it. `assertPrivateBuildDir` is
 * one line at each call site and refuses the shared roots outright.
 *
 * Node built-ins only.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Directories that hold *other* harnesses' output and must never themselves be
 * an `outDir`. A build into any of these with `emptyOutDir` takes every
 * sibling's bundle with it.
 */
export const SHARED_ROOTS = [".shot-build", "dist", "shots", "tmp", "tools", "src", ".work"];

/**
 * Throws unless `outDir` is a safe private build destination under `root`.
 *
 * Call it immediately before any `build({ build: { outDir, emptyOutDir: true } })`.
 * The check is deliberately blunt: a destination that is one of the shared
 * roots, or the repo root, or outside the repo entirely, is refused whatever
 * the reason it ended up that way.
 *
 * @param {string} root   repo root
 * @param {string} outDir the `build.outDir` about to be emptied, absolute or
 *                        relative to `root`
 * @param {string} [tag]  log prefix for the error message
 */
export function assertPrivateBuildDir(root, outDir, tag = "scratch") {
  const abs = path.resolve(root, String(outDir ?? ""));
  const rel = path.relative(root, abs);

  if (!rel || rel === ".") {
    throw new Error(
      `[${tag}] refusing to build with outDir="${outDir}", which resolves to the repo root. ` +
        `With emptyOutDir this deletes the working tree. This is almost always an argument that ` +
        `expanded to an empty string being interpolated into a path.`
    );
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`[${tag}] refusing to build with outDir="${outDir}", which resolves outside the repo (${abs}).`);
  }

  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length === 1 && SHARED_ROOTS.includes(parts[0])) {
    throw new Error(
      `[${tag}] refusing to build with outDir="${outDir}". "${parts[0]}/" is shared by every harness in this repo, ` +
        `and emptyOutDir:true would delete all of it — that has already happened once to ".shot-build/", ` +
        `destroying two agents' private bundles mid-round. Use a subdirectory: "${parts[0]}/<your-harness>".`
    );
  }

  return abs;
}

/**
 * Throws unless the bundle being served still exists. Call before **every**
 * `page.goto`, not once after the build.
 *
 * ## Why before every navigation
 *
 * The wipe lands mid-round. `shoot4` and Lighting's harness each arrived at
 * this independently after losing captures to:
 *
 *     page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at http://127.0.0.1:5125/...
 *
 * which reads like a server fault or a page fault and is neither — the build
 * output directory had been deleted between the build and the navigation. A
 * single post-build check passes and a later pose still fails, so placement is
 * the whole point of the check.
 *
 * Six rounds died on that error across `system1` and `system6` in one night,
 * recorded in their own manifests. The failure is **maximally misleading in the
 * direction of retrying**: a network-shaped error invites "run it again", and
 * running it again often works, because by then the sibling's build has
 * finished and yours rebuilds into the hole. Intermittent, unattributable, and
 * self-healing on retry.
 *
 * `assertPrivateBuildDir` closes the hole at the writing end; this reports it
 * at the reading end, for the wipes that happen anyway.
 *
 * @param {string} root      repo root
 * @param {string} buildDir  the `outDir` being served, absolute or relative
 * @param {string} [tag]     log prefix
 * @param {string} [context] what was about to be loaded, e.g. the shot name
 */
export function assertBuildIntact(root, buildDir, tag = "scratch", context = "") {
  const dir = path.resolve(root, String(buildDir ?? ""));
  const entry = path.join(dir, "index.html");
  if (existsSync(entry)) return entry;
  throw new Error(
    `[${tag}] ${path.relative(root, entry)} is gone${context ? ` (before ${context})` : ""}, so there is nothing ` +
      `to serve. **Do not retry blindly.** This is almost always a sibling build with outDir set to a shared ` +
      `directory and emptyOutDir:true, which deletes every agent's private bundle — the error surfaces as an ` +
      `opaque net::ERR_HTTP_RESPONSE_CODE_FAILURE on the next navigation, and it self-heals on retry once the ` +
      `sibling finishes, which is why it goes undiagnosed. Check ${path.relative(root, path.dirname(dir))}/ for ` +
      `a stray top-level index.html and assets/, and see NOTES.md case 43.`
  );
}

/**
 * The private scratch directory for one harness: `tmp/<name>/`.
 *
 * `tmp/` is the agreed home for ad-hoc output. It is gitignored, and nothing
 * else in the repo reads from it, so a harness cannot destroy anything anybody
 * needs by emptying its own subdirectory of it.
 */
export function scratchDir(root, name) {
  const safe = String(name ?? "").replace(/[^a-z0-9._-]+/gi, "-");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`[scratch] scratchDir needs a name; got ${JSON.stringify(name)}`);
  }
  return path.join(root, "tmp", safe);
}

/** `scratchDir`, created, and asserted safe to empty. */
export async function ensureScratchDir(root, name, tag = "scratch") {
  const dir = scratchDir(root, name);
  assertPrivateBuildDir(root, dir, tag);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
