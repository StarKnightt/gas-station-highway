/**
 * Per-round capture archive shared by the headless harnesses.
 *
 * Every harness used to write to a fixed path — `shots/car/side.png` — and
 * overwrite it on the next run. That cost a full analysis cycle: two critics
 * reviewed the same filenames on different days' builds and returned 5/10 then
 * 3/10, and the delta was read as critic disagreement when in fact they had
 * been shown two different cars. A stale PNG is indistinguishable from a fresh
 * one, and once overwritten the earlier round is simply gone.
 *
 * So: a capture must be traceable to the build that produced it, and comparing
 * two rounds requires that both still exist. This module gives a harness an
 * archive directory keyed by UTC time plus the short bundle hash it already
 * computes:
 *
 *   shots/<system>/rounds/2026-08-28T175859Z-82a250250970/side.png
 *   shots/<system>/rounds/2026-08-28T175859Z-82a250250970/manifest.json
 *   shots/<system>/side.png          <- stable copy, kept for critic prompts
 *
 * The archive is authoritative; the stable path is a copy, not a move, so the
 * habit of opening a known filename still works and pruning can never take the
 * last readable capture away.
 *
 * The manifest exists because `Game` now catches and disables a throwing
 * system (NOTES.md case 8), so a page that renders is not necessarily a page
 * that is healthy. Recording `window.__SYSTEM_ERRORS` at capture time means a
 * round where a system silently failed is identifiable later from the manifest
 * alone, without re-running anything.
 *
 * Usage from a harness — see NOTES.md "Capture archive" for the full recipe:
 *
 *   import { openRound } from "./archive.mjs";
 *   const round = await openRound({ root: ROOT, system: OUT, tag: "shootcar",
 *                                   viewport: { width: 1920, height: 1080 },
 *                                   bundleHash: stamp.hash, bundleMtime: stamp.iso });
 *   const file = await round.save(`${shot}${SUFFIX}`, (dest) => page.screenshot({ path: dest, type: "png" }));
 *   await round.finalise({ gpu: info.renderer, systemErrors: sysErrs });
 *
 * Node built-ins only.
 */

import path from "node:path";
import fs from "node:fs/promises";

/** How many rounds per system survive a prune, unless the caller says otherwise. */
export const DEFAULT_KEEP = 10;

/**
 * A round younger than this is never pruned, whatever `keep` says.
 *
 * Added after an audit found the failure it prevents: `shots/system6/rounds`
 * sat at exactly `keep` entries while a critic was reading a round by name, so
 * the next two capture runs — minutes apart, which is the normal cadence when
 * an agent is iterating — would have deleted the directory out from under the
 * review. A critic quoting a round id and an agent capturing a new one are the
 * *expected* concurrent case here, not an edge case, and the artefact must
 * outlive the conversation about it.
 */
export const MIN_AGE_MS = 45 * 60_000;

/** Drop a file with this name in a round directory to exempt it from pruning. */
export const KEEP_MARKER = "KEEP";

/**
 * Floor for a capture's size, as a fraction of a byte per pixel.
 *
 * Set from measurement, not taste. A solid-colour 1920x1080 PNG compresses to
 * 9.7 KB (0.005 B/px); the smallest real capture in this repo is 1.20 MB
 * (0.58 B/px). 0.05 B/px sits an order of magnitude above the blank frame and
 * an order of magnitude below the darkest genuine one, so it separates
 * "truncated or empty" from "a legitimately dark night shot" with room to
 * spare. Raise it only with a measurement attached.
 */
export const MIN_BYTES_PER_PIXEL = 0.05;

/** Absolute floor, applied at every size. Below this nothing is an image. */
export const MIN_BYTES = 1024;

/**
 * The bytes-per-pixel floor applies only at or above this many pixels.
 *
 * Scene captures — the ones a critic reviews — are 1600x900 (1.44 MP) or
 * 1920x1080 (2.07 MP). Below a megapixel the repo is full of legitimate
 * diagnostic output that is genuinely almost flat: alpha cutouts, material
 * swatches, cropped strips. Running the ratio test on those produced 42 false
 * positives against 1 true one, and a check that cries wolf 42 times is a check
 * everyone learns to skip.
 */
export const RATIO_FLOOR_PIXELS = 1_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width and height from a PNG's IHDR, or null when the buffer is not a PNG.
 *
 * A PNG is signature (8 bytes), then a length (4), then the chunk type — which
 * is required by the spec to be IHDR — then width and height as big-endian
 * uint32.
 */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Throws unless `buf` is a PNG that could plausibly be a real capture.
 *
 * ## Why this exists
 *
 * A 65-byte file appeared in the repo root, and it was not a shell artefact: it
 * was a **valid PNG with dimensions 0x0**, written by a harness that had parsed
 * an argument as an output path. It had a correct signature, a correct IHDR, a
 * correct IEND, and no pixels. Every existing check passed it.
 *
 * That is the failure class that has cost this project the most: not a crash,
 * but a silent absence that looks like a result. These captures feed critics.
 * A critic handed an empty or truncated image reviews it as evidence and
 * returns a score, and nothing downstream can tell that score from a real one.
 * So an unreadable capture must stop the run at the moment it is written, while
 * the harness that wrote it is still on the stack.
 *
 * Four things are checked, each corresponding to something that has actually
 * gone wrong somewhere in the wild:
 *
 * 1. **It is a PNG.** An HTML error page written to a `.png` path is not.
 * 2. **Neither dimension is zero.** The case above.
 * 3. **The dimensions are the ones asked for.** A screenshot at the wrong size
 *    is usually a viewport that never applied, and a critic comparing two
 *    rounds at different sizes is comparing framings, not renders.
 * 4. **It is big enough to contain an image.** Catches truncated writes and
 *    uniform frames — a blank capture compresses to almost nothing, which is
 *    the one property a solid colour cannot hide.
 */
export function assertCaptureUsable(buf, { name = "capture", expect = null, minBytes = MIN_BYTES, ratio = true } = {}) {
  const size = pngSize(buf);
  if (!size) {
    const head = buf?.subarray?.(0, 40)?.toString("utf8").replace(/[^\x20-\x7e]/g, ".") ?? "";
    throw new Error(
      `${name}: not a PNG (${buf?.length ?? 0} bytes). First bytes: "${head}". ` +
        `A harness writing something other than an image to a .png path is usually a mis-parsed argument.`
    );
  }
  if (size.width === 0 || size.height === 0) {
    throw new Error(
      `${name}: PNG is ${size.width}x${size.height} — a valid file containing no pixels. ` +
        `This is what a mis-parsed output path produces, and it passes every check that only looks for a file.`
    );
  }
  if (expect && (size.width !== expect.width || size.height !== expect.height)) {
    throw new Error(
      `${name}: captured ${size.width}x${size.height} but ${expect.width}x${expect.height} was requested. ` +
        `The viewport did not apply, so this frame is not comparable with the rest of the round.`
    );
  }
  const pixels = size.width * size.height;
  const floor = Math.max(minBytes, ratio && pixels >= RATIO_FLOOR_PIXELS ? Math.round(pixels * MIN_BYTES_PER_PIXEL) : 0);
  if (buf.length < floor) {
    throw new Error(
      `${name}: ${buf.length} bytes for a ${size.width}x${size.height} image, below the ${floor}-byte floor. ` +
        `Either the write was truncated or the frame is a single flat colour; a solid-colour frame this size ` +
        `compresses to about ${Math.round(pixels * 0.005)} bytes. Check the page actually rendered.`
    );
  }
  return size;
}

/** Per-system record of which round each stable convenience copy came from. */
export const STABLE_INDEX = "stable.json";

/**
 * Rounds that finished short, kept so the exit code cannot lose them.
 *
 * ## Why a process-level hook and not just a throw
 *
 * `finalise()` throwing is the obvious way to fail a truncated round, and for
 * four of the seven harnesses here it is enough. For the other three it is
 * not, and the reason is worth stating because it is the same shape as the
 * fault being fixed.
 *
 * Every harness copied the same teardown: an array of named closers, each
 * wrapped in its own `try`/`catch` so that one failing closer cannot prevent
 * the browser and the preview server from being closed. That is correct — a
 * leaked Chromium costs six other agents their GPU. But `shoot1`, `shoot2` and
 * `shoot6` call `finalise()` from inside that array, so a throw there is
 * caught, logged as "failed to close archive round", and discarded; the run
 * then reaches `process.exit(code)` with the code it already had, which on a
 * clean-looking run is 0.
 *
 * So the assertion would have run, produced the right answer, printed it, and
 * still exited 0 — a check swallowed by a `catch` written for a different
 * purpose. That is one layer up from "the check did not fail, it failed to
 * run", and adding a check inside a mechanism that discards checks would have
 * been a poor answer to it.
 *
 * An `exit` listener is immune to all of it. Node runs `exit` listeners after
 * `process.exit(code)` has set `process.exitCode`, and re-assigning it there
 * changes the code the process actually returns (verified on Node v22.19:
 * `node -e "process.on('exit',()=>{process.exitCode=1});process.exit(0)"`
 * returns 1). No harness has to be edited, no `catch` can intercept it, and
 * the verdict is reported at the last possible moment.
 */
const shortRounds = [];
/**
 * Rounds that were opened and never closed.
 *
 * The completeness assertion lives in `finalise()`, so it cannot see a run that
 * died before reaching it. Two of `system4`'s eight rounds tonight are exactly
 * that: `…T022407Z` has one PNG and no `manifest.json`, and `…T015141Z` has
 * neither. Captures on disk with no manifest means the round was never closed —
 * the inverse of the catalogued fault, and invisible to a check that runs at
 * close time.
 *
 * So a round registers itself when it *opens* and deregisters when it closes.
 * An unclosed round at exit is reported and forces a non-zero code, which
 * covers "the harness died silently" as well as "the harness lied".
 */
const openRounds = new Map();
let exitHookInstalled = false;

/**
 * Forgets recorded shortfalls, for a test suite that creates them on purpose.
 *
 * `tools/archive.test.mjs` asserts that `finalise()` throws on a partial round,
 * so it produces four of them deliberately and would otherwise exit 1 on its
 * own success — which is what happened the first time. It is a function rather
 * than an environment variable on purpose: an env var that switches off a
 * safety check is one somebody eventually exports in a shell and forgets, and
 * this one must not be reachable from outside the process that imported it.
 */
export function clearShortRoundsForTesting() {
  shortRounds.length = 0;
  openRounds.clear();
}

function reportShortRoundsAtExit() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (openRounds.size) {
      console.error(
        `\n[archive] !! ${openRounds.size} round(s) were opened and never closed, so no manifest was written and ` +
          `the completeness assertion never ran. Captures may be on disk with nothing describing them:`
      );
      for (const [dir, r] of openRounds) console.error(`[archive]    ${r.system}/${r.id} at ${dir}`);
      if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
    }
    if (!shortRounds.length) return;
    // Say it again here. By this point the harness's own summary has scrolled
    // past, and on the swallowing teardown path the only earlier mention was a
    // line reading "failed to close archive round".
    const knew = shortRounds.filter((r) => r.knownFailure).length;
    console.error(
      `\n[archive] !! ${shortRounds.length} round(s) in this run did not deliver; exiting non-zero because a ` +
        `partial round is indistinguishable from a complete one everywhere downstream` +
        (knew ? `, and because ${knew} of them recorded a failure in the manifest while the exit code said 0` : "") +
        `:`
    );
    for (const r of shortRounds) console.error(`[archive]    ${r.system}/${r.id}: ${r.shortfall}`);
    if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
  });
}

/**
 * `2026-08-28T175859Z` — ISO order so a lexical sort is a chronological sort,
 * with the colons dropped because Windows will not accept them in a path.
 */
export function roundStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "");
}

/**
 * Directory name for one round: sortable time first, then the short bundle
 * hash so the build is legible from `ls` without opening the manifest.
 */
export function roundId(bundleHash, date = new Date()) {
  const hash = String(bundleHash ?? "").trim() || "nohash";
  return `${roundStamp(date)}-${hash}`;
}

/**
 * Deletes all but the `keep` most recent round directories under
 * `shots/<system>/rounds/`. Only ever touches that subtree — the stable
 * convenience copies live one level up and are never candidates.
 *
 * Never throws. A cleanup problem must not fail a capture run that has already
 * spent minutes on the GPU; the worst case of a failed prune is disk use.
 */
export async function pruneRounds({
  root,
  system,
  keep = DEFAULT_KEEP,
  tag = "archive",
  minAgeMs = MIN_AGE_MS,
  now = Date.now(),
} = {}) {
  const roundsDir = path.join(root, "shots", system, "rounds");
  const removed = [];
  const spared = [];
  try {
    const entries = await fs.readdir(roundsDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(); // stamp-first names sort oldest to newest
    for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      const dir = path.join(roundsDir, name);
      // Two reprieves, both cheap and both about the same thing: somebody may
      // be reading this directory right now.
      const at = parseRoundTime(name);
      if (at !== null && now - at < minAgeMs) {
        spared.push(`${name} (younger than ${Math.round(minAgeMs / 60_000)} min)`);
        continue;
      }
      try {
        await fs.access(path.join(dir, KEEP_MARKER));
        spared.push(`${name} (${KEEP_MARKER} marker)`);
        continue;
      } catch {
        /* no marker, prune is allowed to proceed */
      }
      try {
        await fs.rm(dir, { recursive: true, force: true });
        removed.push(name);
      } catch (err) {
        console.warn(`[${tag}] could not prune round ${name}: ${err?.message ?? err}`);
      }
    }
  } catch (err) {
    if (err?.code !== "ENOENT") console.warn(`[${tag}] prune skipped: ${err?.message ?? err}`);
  }
  // Naming what was deleted matters as much as deleting it: "the round I was
  // told to look at is not there" is otherwise indistinguishable from "the
  // agent gave me the wrong id".
  if (removed.length) console.log(`[${tag}] pruned: ${removed.join(", ")}`);
  if (spared.length) console.log(`[${tag}] over keep but spared: ${spared.join(", ")}`);
  return removed;
}

/** Milliseconds for a `2026-08-28T174415Z-hash` directory name, or null. */
export function parseRoundTime(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/**
 * Opens an archive round for one capture run.
 *
 * @param {object}  o
 * @param {string}  o.root         repo root (harnesses already compute this)
 * @param {string}  o.system       system name; becomes `shots/<system>/`
 * @param {string}  [o.bundleHash] short content hash of the private build dir
 * @param {string}  [o.bundleMtime] newest mtime in that dir, as text
 * @param {string}  [o.tag]        log prefix, e.g. "shootcar"
 * @param {Date}    [o.at]         capture time; defaults to now
 * @param {object}  [o.viewport]   `{ width, height }` every capture must match.
 *                                 Pass the same object given to `newContext`;
 *                                 without it a wrong-sized frame is only warned
 *                                 about, and only if it differs from its
 *                                 siblings.
 * @param {object}  [o.extra]      anything else worth recording in the manifest
 */
export async function openRound({
  root,
  system,
  bundleHash = "nohash",
  bundleMtime = "unknown",
  tag = "archive",
  at = new Date(),
  viewport = null,
  expect = null,
  extra = {},
} = {}) {
  if (!root) throw new Error("openRound: root is required");
  if (!system) throw new Error("openRound: system is required");

  const stableDir = path.join(root, "shots", system);
  // The id carries the bundle hash, so two runs of the same bundle in the same
  // second collide — which `mkdir recursive` would silently *merge*, leaving
  // one directory holding two runs' PNGs under one manifest. Suffix instead,
  // so a round directory is always exactly one run.
  let id = roundId(bundleHash, at);
  let dir = path.join(stableDir, "rounds", id);
  for (let n = 2; n < 100; n++) {
    try {
      await fs.access(path.join(dir, "manifest.json"));
    } catch {
      break; // no manifest: fresh directory, or one this run already opened
    }
    id = `${roundId(bundleHash, at)}-${n}`;
    dir = path.join(stableDir, "rounds", id);
  }
  await fs.mkdir(dir, { recursive: true });
  openRounds.set(dir, { system, id });
  reportShortRoundsAtExit();

  const captures = [];
  /** Size of the first capture, used as the expectation when none was declared. */
  let roundSize = viewport ?? null;
  /** Shot names this round is contracted to produce. See `requireAll`. */
  let requested = expect ? [...expect].map((n) => String(n).replace(/\.png$/, "")) : null;

  /**
   * Writes one named capture into the round and mirrors it to the stable path.
   *
   * `source` is either a Buffer/Uint8Array of PNG bytes, or a function given
   * the destination path that writes it — the latter suits Playwright's
   * `page.screenshot({ path })`, which is how every harness here captures.
   *
   * Returns the archive path. Harnesses that log a written file should log
   * this one: it is the copy that will still be there next week.
   */
  /**
   * Records, per stable filename, which round it came from.
   *
   * `shots/<system>/` accumulates stable copies from every run that ever
   * touched that system — an audit found `horizon.png` from 23:15 sitting
   * beside `horizon_nohz.png` from 21:38 and `edge_noscrub.png` from 18:33,
   * three different bundles, indistinguishable by inspection. That is case 13
   * exactly, re-entering through the convenience path the case-13 fix created:
   * the archive is stamped and the stable directory is not. A critic handed
   * `shots/<system>/*.png` is once again looking at several builds at once and
   * has no way to know.
   *
   * So the stable directory gets an index. It is written on every save rather
   * than at finalise, because a run that dies mid-capture still leaves the
   * stable copies it already made, and those are exactly the ones nobody
   * should trust silently.
   */
  async function noteStable(file, patch = {}) {
    const indexPath = path.join(stableDir, STABLE_INDEX);
    let index = {};
    try {
      index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    } catch {
      /* first write for this system */
    }
    if (file) {
      index[file] = {
        round: id,
        bundleHash,
        bundleMtime,
        capturedAt: at.toISOString(),
        // Overwritten by finalise once the run's verdict is known. Until then
        // the honest value is "we do not know yet", not "ok".
        outcome: index[file]?.round === id ? index[file].outcome ?? "incomplete" : "incomplete",
        ...patch,
      };
    } else {
      for (const k of Object.keys(index)) if (index[k].round === id) Object.assign(index[k], patch);
    }
    try {
      await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    } catch (err) {
      console.warn(`[${tag}] could not update ${STABLE_INDEX}: ${err?.message ?? err}`);
    }
  }

  async function save(name, source, { expect = viewport } = {}) {
    const file = name.endsWith(".png") ? name : `${name}.png`;
    const dest = path.join(dir, file);

    if (typeof source === "function") await source(dest);
    else if (source) await fs.writeFile(dest, source);
    else throw new Error(`save(${name}): needs a Buffer or a writer function`);

    // Validate before the stable copy is made, so a bad capture never reaches
    // the well-known path a critic reads. Throwing here fails the run while the
    // harness that produced it is still on the stack, which is the only moment
    // the cause is cheap to find.
    let written;
    try {
      written = await fs.readFile(dest);
    } catch (err) {
      throw new Error(`save(${name}): nothing was written to ${path.relative(root, dest)} (${err?.message ?? err})`);
    }
    const size = assertCaptureUsable(written, { name: `save(${name})`, expect });

    // With no declared viewport, the round's own first capture becomes the
    // expectation. Two shots at different sizes in one round is nearly always a
    // bug, but it is legal, so this warns rather than throws.
    if (!expect) {
      if (!roundSize) roundSize = size;
      else if (size.width !== roundSize.width || size.height !== roundSize.height) {
        console.warn(
          `[${tag}] ${file} is ${size.width}x${size.height} but earlier captures in this round are ` +
            `${roundSize.width}x${roundSize.height}. Pass \`viewport\` to openRound() to make this an error.`
        );
      }
    }

    const stable = path.join(stableDir, file);
    try {
      await fs.copyFile(dest, stable);
      await noteStable(file);
    } catch (err) {
      // The archive copy is the one that matters; a failed convenience copy is
      // worth shouting about but is not worth losing the run over.
      console.warn(`[${tag}] could not refresh stable copy ${path.relative(root, stable)}: ${err?.message ?? err}`);
    }

    captures.push(file.replace(/\.png$/, ""));
    return dest;
  }

  /**
   * Writes `manifest.json` and prunes old rounds. Call once, at the end of the
   * run, including on the failure paths — a round that failed is exactly the
   * round somebody will want to look at later.
   *
   * @param {object}   [m]
   * @param {string}   [m.gpu]           renderer string from assertHardwareGpu
   * @param {Array}    [m.systemErrors]  window.__SYSTEM_ERRORS at capture time
   * @param {number}   [m.keep]          rounds to retain for this system
   */
  /**
   * Byte-compares this round's captures against the same names in the previous
   * round, and returns the list that did not move at all.
   *
   * This is the cheap end of the question that started the audit this module
   * was hardened in: "is the harness photographing the build it just made?" A
   * capture that is byte-identical to the last round's is not proof of
   * staleness — an idempotent scene genuinely renders the same twice — but it
   * is the one observation that separates "my change did nothing to the
   * pixels" from "my change did not reach the pixels", and neither the bundle
   * hash nor the manifest could previously tell them apart.
   */
  async function unchangedSincePreviousRound() {
    const roundsDir = path.join(stableDir, "rounds");
    let prev = null;
    try {
      const dirs = (await fs.readdir(roundsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name !== id)
        .map((e) => e.name)
        .sort();
      prev = dirs.length ? dirs[dirs.length - 1] : null;
    } catch {
      return null;
    }
    if (!prev) return null;
    const same = [];
    for (const name of captures) {
      try {
        const a = await fs.readFile(path.join(dir, `${name}.png`));
        const b = await fs.readFile(path.join(roundsDir, prev, `${name}.png`));
        if (a.equals(b)) same.push(name);
      } catch {
        /* the previous round did not take this shot; nothing to compare */
      }
    }
    return { previousRound: prev, identical: same };
  }

  /**
   * Declares the shot list this round is contracted to produce.
   *
   * Call it once the list is known — usually right after parsing `--only=` or
   * whatever selects presets — and `finalise()` will refuse to report success
   * unless every name was written. Equivalent to passing `expect` to
   * `openRound`, for harnesses that compute the list after opening the round.
   */
  function requireAll(names) {
    requested = [...names].map((n) => String(n).replace(/\.png$/, ""));
    return requested;
  }

  async function finalise({
    gpu = null,
    systemErrors = null,
    keep = DEFAULT_KEEP,
    failed = null,
    ...rest
  } = {}) {
    const unchanged = await unchangedSincePreviousRound();
    if (unchanged?.identical?.length) {
      console.warn(
        `[${tag}] ${unchanged.identical.length}/${captures.length} capture(s) are byte-identical to` +
          ` round ${unchanged.previousRound}: ${unchanged.identical.join(", ")}.` +
          ` Whatever changed between those builds did not change these pixels.`
      );
    }
    const missing = requested ? requested.filter((n) => !captures.includes(n)) : [];
    const complete = requested ? missing.length === 0 : null;

    /* `shoot1` and `shoot6` already had a convention for this — they pass
     * `outcome: "failed"` and `failure: <reason>` from their shutdown closers.
     *
     * It suppresses the **throw** only, and that distinction was wrong in the
     * first version of this code. Exempting a self-reported failure from the
     * throw is right: otherwise a run that died on `page.goto` would be told it
     * was incomplete instead of being told about the navigation error, and the
     * assertion would be hiding the diagnosis. Exempting it from the **exit
     * code** reproduced the bug being fixed.
     *
     * Four rounds on disk prove it. `shots/system6/rounds/...T014903Z` has
     * `"presets": []`, `"outcome": "failed"` and a `page.goto` failure recorded
     * in the manifest — the harness knew, wrote it down, and exited 0 anyway.
     * `system1` at 013258Z and `system6` at 005529Z are the same, and
     * `system2` at 005145Z wrote zero captures with `outcome` not even set.
     *
     * So: if `finalise()` is told the run failed, the process must not exit 0,
     * whatever else is true. The harness's own reason survives; only the lie in
     * the exit code is corrected. */
    const knownFailure = failed ?? rest.failure ?? (rest.outcome === "failed" ? "harness reported failure" : null);

    const manifest = {
      round: id,
      capturedAt: at.toISOString(),
      system,
      bundleHash,
      bundleMtime,
      gpu,
      presets: captures.slice(),
      // The contract, recorded whether or not it was met. `requested: null`
      // means the harness never declared one, which is not the same as having
      // declared one and met it.
      requested: requested ? requested.slice() : null,
      written: captures.length,
      missing,
      complete,
      failed: knownFailure,
      // null means the harness never asked, which is not the same as [] meaning
      // it asked and every system initialised. Keep the distinction.
      systemErrors: systemErrors ?? null,
      systemErrorCount: Array.isArray(systemErrors) ? systemErrors.length : null,
      previousRound: unchanged?.previousRound ?? null,
      identicalToPreviousRound: unchanged?.identical ?? null,
      ...extra,
      ...rest,
    };
    /* The shortfall verdict, decided before the manifest is written so the
     * manifest records it. `failed` means the harness already knows it is
     * exiting non-zero and is only here to leave an artefact behind, so a
     * shortfall is expected and must not overwrite its reason. */
    let shortfall = null;
    if (complete === false) {
      shortfall = `wrote ${captures.length}/${requested.length} — missing ${missing.join(", ")}`;
    } else if (captures.length === 0) {
      shortfall = "wrote no captures at all";
    }

    /* ## The net for harnesses that have not declared a shot list yet
     *
     * `expect` is one line to adopt, but six harnesses do not have it and the
     * fault it catches happened three times tonight. The previous round's
     * manifest is a serviceable stand-in: a harness that took 7 shots last
     * round and 2 this round has almost certainly been truncated.
     *
     * Almost, not certainly — `--only=front` is a legitimate one-shot run and
     * would look identical. So this only ever warns, however loudly, and the
     * hard failure stays with the harness that declared its list and can
     * therefore be believed. Guessing is allowed to be noisy; it is not
     * allowed to fail somebody's deliberate subset run at 7am. */
    let shrank = null;
    if (!requested && !knownFailure && captures.length && unchanged?.previousRound) {
      try {
        const prev = JSON.parse(
          await fs.readFile(path.join(stableDir, "rounds", unchanged.previousRound, "manifest.json"), "utf8")
        );
        const before = Array.isArray(prev.presets) ? prev.presets : [];
        const gone = before.filter((n) => !captures.includes(n));
        /* The count has to have dropped, not just the names changed. Several
         * harnesses name their captures `${shot}${SUFFIX}` with the suffix
         * coming from a flag, so a round that renames every shot without
         * dropping any would otherwise report all of them missing — a warning
         * that is wrong every time somebody changes a flag, which is the fast
         * route to a warning nobody reads. */
        if (gone.length && captures.length < before.length) {
          shrank = { previous: before.length, now: captures.length, gone };
        }
      } catch {
        /* no readable previous manifest; nothing to compare against */
      }
    }

    if (shortfall) manifest.outcome = manifest.outcome ?? (knownFailure ? "failed" : "incomplete");
    manifest.shortfall = shortfall ?? null;
    manifest.shrankSincePreviousRound = shrank;

    const file = path.join(dir, "manifest.json");
    await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    // Stamp the verdict onto every stable copy this round refreshed. A frame
    // from a run that failed its own checks must not sit at a well-known path
    // looking like any other frame.
    await noteStable(null, {
      outcome: manifest.outcome ?? (manifest.systemErrorCount ? "system-errors" : "ok"),
      systemErrorCount: manifest.systemErrorCount,
    });
    const pruned = await pruneRounds({ root, system, keep, tag });
    // The round is closed and its manifest is on disk, so it is no longer an
    // orphan. Deliberately after the manifest write, not before: everything
    // between opening and this line is a window in which a crash leaves
    // captures with nothing describing them, and that window is what the
    // open-round ledger exists to report.
    openRounds.delete(dir);

    /* ## Why this throws, and why it throws *here*
     *
     * Three agents lost a round tonight to the same shape of fault, and it was
     * not a check that returned the wrong answer — it was a check that never
     * ran. One round wrote `manifest.json` and zero PNGs at exit code 0. A
     * second wrote 2 of 7 after the preview server stopped answering mid-loop,
     * exited 0, and left the stable directory holding two bundles' frames side
     * by side with nothing to distinguish them. A third died on `page.goto`
     * after 1 of 11.
     *
     * In every case the harness had a `try`/`continue` around the per-shot
     * body, which is reasonable on its own — one bad preset should not discard
     * ten good ones — but nothing afterwards compared what came out against
     * what was asked for. A partial round is *worse* than a failed one,
     * because it is indistinguishable from a complete one at every path a
     * critic or a diff reads.
     *
     * So the contract is `written.length === requested.length`, Vegetation's
     * wording, enforced at the one point that knows both numbers. The manifest
     * and the prune happen first and unconditionally: the round a run failed
     * is exactly the round somebody will want to open, and a throw that also
     * deletes the evidence would trade one silent failure for a louder one.
     *
     * A harness that already knows it failed passes `failed: <reason>` and
     * gets the artefact without the throw, because it is on its way to a
     * non-zero exit already and its own reason is the more specific one. The
     * assertion therefore fires precisely when a harness believes it
     * succeeded, which is the only case where it is telling anyone anything
     * they did not know. */
    /* Registered whenever the round did not deliver, *including* when the
     * harness already knows — that is the case Vegetation reported and the case
     * the first version of this code let through. Registration is what fixes
     * the exit code; the throw below is a separate decision. Three of the seven
     * harnesses catch the throw from inside a best-effort teardown closer, so
     * registration is also the only half that survives them. */
    if (shortfall || knownFailure) {
      /* Both halves when both are known. The shortfall says what is missing;
       * the harness's reason says why, and that is the line somebody actually
       * needs — on the swallowing teardown path the exit summary may be the
       * only place the cause is still legible. */
      const line = [shortfall, knownFailure ? `harness reported: ${knownFailure}` : null].filter(Boolean).join("; ");
      shortRounds.push({ system, id, shortfall: line, knownFailure });
      reportShortRoundsAtExit();
    }

    if (shortfall && !knownFailure) {
      throw new Error(
        `[${tag}] round ${id} is incomplete: ${shortfall}. ` +
          `Manifest and captures are kept at ${path.relative(root, dir)} for inspection, and ` +
          `${STABLE_INDEX} marks the stable copies from this round as "${manifest.outcome}". ` +
          `A partial round reads as a complete one everywhere downstream, so it fails here instead.` +
          (requested ? "" : ` This round declared no shot list; pass \`expect\` to openRound() or call round.requireAll().`)
      );
    }
    if (shrank) {
      console.warn(
        `\n[${tag}] !! round ${id} wrote ${shrank.now} capture(s); round ${unchanged.previousRound} wrote ` +
          `${shrank.previous}. Missing this round: ${shrank.gone.join(", ")}.\n` +
          `[${tag}]    If that was not deliberate, this round is truncated — the usual cause is a per-shot ` +
          `try/continue swallowing a navigation failure, which leaves the stable directory holding frames ` +
          `from two different bundles at once.\n` +
          `[${tag}]    This is a warning because a deliberate subset run looks identical from here. Pass ` +
          `\`expect: <shot names>\` to openRound() and it becomes a hard failure instead of a guess.`
      );
    } else if (!requested && !knownFailure) {
      console.warn(
        `[${tag}] round ${id} wrote ${captures.length} capture(s) but declared no expected shot list, so ` +
          `"every shot was taken" could not be checked. Pass \`expect: <names>\` to openRound() or call ` +
          `round.requireAll(<names>) to turn a truncated round into a failure.`
      );
    }

    return { manifest, file, pruned };
  }

  return { id, dir, stableDir, captures, save, requireAll, finalise };
}

/**
 * `node tools/archive.mjs --scan [dir...]` — walks for PNGs and reports any
 * that `assertCaptureUsable` rejects.
 *
 * `round.save()` covers every harness that archives through this module, but
 * the 0x0 PNG that prompted the validation was written to the **repo root**,
 * not to `shots/`, so it never went through `save()` at all. Several harnesses
 * still call `page.screenshot({ path })` directly. Until they all archive, this
 * is the net underneath them: cheap enough to run before handing anything to a
 * critic, and it needs no browser.
 */
/**
 * Is this path a capture somebody downstream will read as evidence?
 *
 * The bytes-per-pixel floor is a good test in the wrong hands. Run over the
 * whole repo it flagged ten files: four black `shots/system2` frames that were
 * genuinely broken, two zero-pixel strays, and **four legitimate false-colour
 * ID passes** in `shots/system3/_look/`, which are 1600x900 — above the
 * megapixel exemption — and compress to 0.010 B/px because a flat-shaded
 * region map is supposed to. Four false positives in ten flags is how a check
 * becomes something everyone learns to scroll past, which is the same failure
 * as not having one.
 *
 * The fix is not a better threshold, it is noticing that the *same* test has
 * different authority in different places. A frame at `shots/<system>/x.png`
 * or in a `rounds/` directory is a promoted capture: a critic may be handed it
 * and it should be a real render. A frame in a `_`-prefixed scratch directory
 * is a diagnostic its author is looking at right now, and "this is nearly
 * flat" is often the point of it.
 *
 * So promoted captures fail on the ratio; scratch captures are only mentioned.
 * The corollary is a convention worth having: **put diagnostic renders in a
 * `_`-prefixed subdirectory** and the flatness test will stop shouting at you.
 */
export function isPromotedCapture(p) {
  const parts = path.resolve(p).split(/[\\/]/);
  const i = parts.lastIndexOf("shots");
  if (i < 0) return false; // tools/, tmp/, repo root: nobody's evidence
  return !parts.slice(i + 1, -1).some((seg) => seg.startsWith("_"));
}

async function scan(roots) {
  /** Never legitimate, wherever it is found. */
  const broken = [];
  /** Fails the flatness heuristic. Authoritative only for promoted captures. */
  const suspect = [];
  let seen = 0;

  async function walk(p) {
    let st;
    try {
      st = await fs.stat(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (/node_modules|\.git$/.test(p)) return;
      for (const e of await fs.readdir(p)) await walk(path.join(p, e));
      return;
    }
    const named = /\.png$/i.test(p);
    // Extensionless files are checked only when they really are PNGs. That is
    // exactly the `640` case — an image written to a path that was meant to be
    // an argument — without dragging in every source file in the repo.
    const extensionless = !path.basename(p).includes(".");
    if (!named && !extensionless) return;

    let buf;
    try {
      buf = await fs.readFile(p);
    } catch {
      return;
    }
    if (!named && !pngSize(buf)) return;

    seen++;
    // Two passes, because the two classes carry different authority. The first
    // skips the flatness heuristic, so anything it rejects is certainly broken
    // whatever directory it sits in.
    try {
      assertCaptureUsable(buf, { name: p, ratio: false });
    } catch (err) {
      broken.push(`${p}\n    ${err.message}`);
      return;
    }
    try {
      assertCaptureUsable(buf, { name: p });
    } catch (err) {
      suspect.push({ p, message: err.message, promoted: isPromotedCapture(p) });
    }
  }

  for (const r of roots) await walk(r);
  console.log(`[archive] scanned ${seen} candidate file(s) under ${roots.join(", ")}`);

  const promotedSuspects = suspect.filter((s) => s.promoted);
  const scratchSuspects = suspect.filter((s) => !s.promoted);

  if (broken.length) {
    console.error(`[archive] !! ${broken.length} file(s) are not usable images at all:`);
    for (const b of broken) console.error(`  ${b}`);
  }
  if (promotedSuspects.length) {
    console.error(`[archive] !! ${promotedSuspects.length} promoted capture(s) are implausibly flat:`);
    for (const s of promotedSuspects) console.error(`  ${s.p}\n    ${s.message}`);
  }
  if (scratchSuspects.length) {
    // Named, not failed. These are usually somebody's ID pass or alpha cutout.
    console.log(
      `[archive] ${scratchSuspects.length} scratch capture(s) are very flat, which is often intentional ` +
        `for a diagnostic. Not failing on these:`
    );
    for (const s of scratchSuspects) {
      const why = s.message.startsWith(`${s.p}: `) ? s.message.slice(s.p.length + 2) : s.message;
      console.log(`  ${s.p} — ${why.split(/\.\s/)[0]}.`);
    }
  }

  if (broken.length || promotedSuspects.length) return false;
  console.log("[archive] every promoted capture is a readable image of plausible size");
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  if (process.argv.includes("--scan")) {
    const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    scan(dirs.length ? dirs : [process.cwd()]).then((ok) => process.exit(ok ? 0 : 1));
  } else {
    console.log("usage: node tools/archive.mjs --scan [dir...]");
  }
}
