/**
 * `node tools/archive.test.mjs`
 *
 * Covers `assertCaptureUsable`, because a check that has never been observed
 * rejecting anything is indistinguishable from no check. The first case is a
 * byte-for-byte reconstruction of the 65-byte 0x0 PNG that a harness actually
 * wrote into the repo root, which is the reason this validation exists.
 *
 * Node built-ins only, matching archive.mjs.
 */
import zlib from "node:zlib";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertCaptureUsable, clearShortRoundsForTesting, isPromotedCapture, openRound, pngSize } from "./archive.mjs";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A structurally valid PNG of any size, optionally with real-looking noise. */
function makePng(width, height, { flat = true } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  if (!flat) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = y * stride + 1 + x * 4;
        raw[o] = (x * 7 + y * 3) & 255;
        raw[o + 1] = (x * 13) & 255;
        raw[o + 2] = (y * 5) & 255;
        raw[o + 3] = 255;
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let failures = 0;
function check(name, fn, shouldThrow, expectInMessage = "") {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  const ok =
    shouldThrow === !!threw && (!expectInMessage || (threw?.message ?? "").toLowerCase().includes(expectInMessage.toLowerCase()));
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}` +
      (ok ? "" : ` — expected ${shouldThrow ? `a throw mentioning "${expectInMessage}"` : "no throw"}, got ${threw ? `"${threw.message}"` : "no throw"}`)
  );
}

const zeroByZero = makePng(0, 0);
console.log(`  (the 0x0 PNG reconstruction is ${zeroByZero.length} bytes; the one found in the repo was 65)`);

check("a 0x0 PNG is rejected", () => assertCaptureUsable(zeroByZero, { name: "t" }), true, "no pixels");
check("a zero-width PNG is rejected", () => assertCaptureUsable(makePng(0, 1080), { name: "t" }), true, "no pixels");
check("a zero-height PNG is rejected", () => assertCaptureUsable(makePng(1920, 0), { name: "t" }), true, "no pixels");
check("HTML written to a .png path is rejected", () => assertCaptureUsable(Buffer.from("<!doctype html><title>404</title>"), { name: "t" }), true, "not a PNG");
check("an empty file is rejected", () => assertCaptureUsable(Buffer.alloc(0), { name: "t" }), true, "not a PNG");
check("a truncated write is rejected", () => assertCaptureUsable(makePng(1920, 1080, { flat: false }).subarray(0, 5000), { name: "t" }), true, "below the");
check("a solid-colour 1920x1080 frame is rejected", () => assertCaptureUsable(makePng(1920, 1080), { name: "t" }), true, "flat colour");
check(
  "the wrong viewport is rejected",
  () => assertCaptureUsable(makePng(1280, 720, { flat: false }), { name: "t", expect: { width: 1920, height: 1080 } }),
  true,
  "was requested"
);
check("a real-looking 1920x1080 capture passes", () => assertCaptureUsable(makePng(1920, 1080, { flat: false }), { name: "t", expect: { width: 1920, height: 1080 } }), false);
check("a real-looking capture passes without a declared viewport", () => assertCaptureUsable(makePng(1280, 720, { flat: false }), { name: "t" }), false);

const s = pngSize(makePng(640, 360, { flat: false }));
check("pngSize reads IHDR", () => { if (s.width !== 640 || s.height !== 360) throw new Error(`got ${s.width}x${s.height}`); }, false);

check(
  "the flatness test can be waived, and the structural tests still apply",
  () => assertCaptureUsable(makePng(1920, 1080), { name: "t", ratio: false }),
  false
);
check(
  "waiving flatness does not waive zero dimensions",
  () => assertCaptureUsable(makePng(1920, 0), { name: "t", ratio: false }),
  true,
  "no pixels"
);

/* Where a capture lives decides whether the flatness heuristic is allowed to
 * fail a run. Getting this wrong in either direction is expensive: too strict
 * and four legitimate ID passes fail every scan, too loose and a black frame
 * reaches a critic. */
for (const [p, want] of [
  ["shots/system2/cooler.png", true],
  ["shots/system2/rounds/2026-08-28T175859Z-abc/cooler.png", true],
  ["shots/system3/_look/nzid.png", false],
  ["shots/system3/_scratch/rounds/x.png", false],
  ["tools/perf-out/x.png", false],
  ["100", false],
]) {
  check(`isPromotedCapture(${p}) === ${want}`, () => {
    if (isPromotedCapture(p) !== want) throw new Error(`got ${!want}`);
  }, false);
}

/* ## The completeness contract
 *
 * Three agents lost a round tonight to a harness that wrote some of its shots
 * and exited 0. These cases are the ones that would have caught each of them,
 * and the last two are the escape hatches — without them the assertion would
 * either destroy the evidence of a failed run or mask its actual cause. */
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
const real = makePng(400, 300, { flat: false });

async function round(opts) {
  return openRound({ root: tmp, system: `s${Math.random().toString(36).slice(2, 8)}`, tag: "test", ...opts });
}
async function acheck(name, fn, shouldThrow, expectInMessage = "") {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  const ok =
    shouldThrow === !!threw && (!expectInMessage || (threw?.message ?? "").toLowerCase().includes(expectInMessage.toLowerCase()));
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}` +
      (ok ? "" : ` — expected ${shouldThrow ? `a throw mentioning "${expectInMessage}"` : "no throw"}, got ${threw ? `"${threw.message}"` : "no throw"}`)
  );
}

await acheck(
  "a round that writes every requested shot succeeds",
  async () => {
    const r = await round({ expect: ["a", "b"] });
    await r.save("a", real);
    await r.save("b", real);
    await r.finalise({});
  },
  false
);

await acheck(
  "2 of 7 written fails, which is the shoot6 fault",
  async () => {
    const r = await round({ expect: ["a", "b", "c", "d", "e", "f", "g"] });
    await r.save("a", real);
    await r.save("b", real);
    await r.finalise({});
  },
  true,
  "wrote 2/7"
);

await acheck(
  "a manifest with zero PNGs fails even with no declared shot list",
  async () => {
    const r = await round({});
    await r.finalise({});
  },
  true,
  "no captures at all"
);

await acheck(
  "requireAll() declares the list after the round is open",
  async () => {
    const r = await round({});
    r.requireAll(["a", "b", "c"]);
    await r.save("a", real);
    await r.finalise({});
  },
  true,
  "missing b, c"
);

await acheck(
  "a harness that already knows it failed still gets its manifest, without a second error",
  async () => {
    const r = await round({ expect: ["a", "b"] });
    await r.save("a", real);
    await r.finalise({ failed: "page.goto timed out" });
  },
  false
);

await acheck(
  "the pre-existing outcome:failed convention also suppresses the throw",
  async () => {
    const r = await round({ expect: ["a", "b"] });
    await r.save("a", real);
    // shoot1 and shoot6 both call finalise() this way from their shutdown path.
    await r.finalise({ outcome: "failed", failure: "page.goto timed out" });
  },
  false
);

/* Six harnesses have not declared a shot list, and the fault happened three
 * times tonight, so the previous round's manifest stands in. It can only ever
 * warn: a deliberate `--only=` run is indistinguishable from a truncated one
 * from inside finalise(). */
/** Runs `fn` with console.warn captured, and returns what it said. */
async function quietly(fn) {
  const said = [];
  const realWarn = console.warn;
  console.warn = (m) => said.push(String(m));
  try {
    await fn();
  } finally {
    console.warn = realWarn;
  }
  return said;
}

/** Opens a round in `system`, writes `names`, finalises. Returns the manifest. */
async function roundOf(system, names) {
  let manifest = null;
  let threw = null;
  const said = await quietly(async () => {
    try {
      const r = await openRound({ root: tmp, system, tag: "test" });
      for (const n of names) await r.save(n, real);
      ({ manifest } = await r.finalise({}));
    } catch (err) {
      threw = err;
    }
  });
  return { manifest, threw, said };
}

{
  await roundOf("shrinktest", ["a", "b", "c"]);
  const { manifest, threw, said } = await roundOf("shrinktest", ["a"]);
  check(
    "a round that shrinks from 3 shots to 1 warns, names the missing shots, and does not throw",
    () => {
      if (threw) throw new Error(`threw: ${threw.message}`);
      if (manifest.shrankSincePreviousRound?.gone?.join() !== "b,c") {
        throw new Error(`gone=${JSON.stringify(manifest.shrankSincePreviousRound)}`);
      }
      if (!said.some((w) => w.includes("Missing this round: b, c"))) {
        throw new Error(`no warning naming the missing shots; got ${JSON.stringify(said)}`);
      }
    },
    false
  );

  /* A suffix change renames every shot without dropping one. That must not
   * warn, or the check fires every time somebody flips a flag — and a warning
   * that is wrong whenever a flag changes is one nobody reads. */
  await roundOf("renametest", ["a", "b", "c"]);
  const renamed = await roundOf("renametest", ["a_v2", "b_v2", "c_v2"]);
  check(
    "renaming every shot without dropping any does not report a truncation",
    () => {
      if (renamed.manifest.shrankSincePreviousRound !== null) {
        throw new Error(`reported ${JSON.stringify(renamed.manifest.shrankSincePreviousRound)}`);
      }
    },
    false
  );
}

/* The artefact has to survive the throw. A check that fails the run *and*
 * deletes the round nobody can now inspect has traded a silent failure for a
 * louder one. */
{
  const r = await round({ expect: ["a", "b"] });
  await r.save("a", real);
  let manifest = null;
  try {
    await r.finalise({});
  } catch {
    manifest = JSON.parse(await fs.readFile(path.join(r.dir, "manifest.json"), "utf8"));
  }
  check(
    "the failing round still leaves a manifest recording the shortfall",
    () => {
      if (!manifest) throw new Error("finalise did not throw");
      if (manifest.complete !== false) throw new Error(`complete=${manifest.complete}`);
      if (manifest.outcome !== "incomplete") throw new Error(`outcome=${manifest.outcome}`);
      if (manifest.missing?.join() !== "b") throw new Error(`missing=${manifest.missing}`);
      if (manifest.written !== 1) throw new Error(`written=${manifest.written}`);
    },
    false
  );
  const index = JSON.parse(await fs.readFile(path.join(r.stableDir, "stable.json"), "utf8"));
  check(
    "and marks its stable copies incomplete, so the well-known path is not silently trusted",
    () => {
      if (index["a.png"]?.outcome !== "incomplete") throw new Error(`outcome=${index["a.png"]?.outcome}`);
    },
    false
  );
}

await fs.rm(tmp, { recursive: true, force: true });

/* Four of the rounds above were deliberately left short, and archive.mjs
 * installs a process `exit` hook that forces a non-zero code when any round
 * finished short — so without this, this suite exits 1 on its own success. It
 * did, the first time. That the run before it looked green was the pipeline
 * trap: it was `| tail`-ed, and `tail` succeeds always.
 *
 * The exit-code behaviour is asserted in archive.exit.test.mjs, which needs a
 * child process for it anyway. */
clearShortRoundsForTesting();

console.log(failures === 0 ? "[archive] tests passed" : `[archive] ${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
