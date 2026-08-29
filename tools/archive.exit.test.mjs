/**
 * `node tools/archive.exit.test.mjs`
 *
 * The completeness assertion has to survive a harness that swallows it.
 *
 * `shoot1`, `shoot2` and `shoot6` all call `round.finalise()` from inside a
 * best-effort teardown closer whose `try`/`catch` exists so that one failing
 * closer cannot leak a Chromium — and which therefore discards any error
 * `finalise()` raises, after which `process.exit(0)` runs with the code the
 * harness already had. A throw alone would have been reported and then lost.
 *
 * This test reproduces that exact shape in a child process and asserts on the
 * **exit code**, which is the only thing a caller further up — a shell
 * pipeline, another agent's script — can actually see. It has to be a child
 * process: an exit code is not observable from inside the process producing it,
 * so an in-process assertion here would be checking the wrong thing.
 *
 * Node built-ins only, matching archive.mjs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "archive-exit-"));

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
/** A 400x300 PNG with real-looking noise, so it clears every usability check. */
function realPng() {
  const w = 400;
  const h = 300;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 4;
      raw[o] = (x * 7 + y * 3) & 255;
      raw[o + 1] = (x * 13) & 255;
      raw[o + 2] = (y * 5) & 255;
      raw[o + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await fs.writeFile(path.join(tmp, "real.png"), realPng());

/**
 * A harness in miniature, reproducing the swallowing teardown verbatim: named
 * closers, each individually caught, then `process.exit(code)` with the code
 * decided before the round was closed.
 */
const HARNESS = `
import fs from "node:fs/promises";
import path from "node:path";
// A file:// URL, not a bare Windows path: the ESM loader rejects "c:\\..." as
// an unknown URL scheme. The first run of this test crashed the child on that
// import, which exited 1 — and two of the three cases "passed", because they
// expected 1. Hence the swallow assertion below, which is what caught it.
import { openRound } from ${JSON.stringify(pathToFileURL(path.join(HERE, "archive.mjs")).href)};

const tmp = process.argv[2];
const want = JSON.parse(process.argv[3]);
const write = JSON.parse(process.argv[4]);
const png = await fs.readFile(path.join(tmp, "real.png"));

const resources = { round: null };
async function shutdown(code, reason) {
  const closers = [
    ["archive round", async () => {
      const r = resources.round;
      if (!r) return;
      resources.round = null;
      await r.finalise({ outcome: reason ? "failed" : "ok", failure: reason ?? null, keep: 10 });
    }],
    ["browser", async () => {}],
  ];
  for (const [label, fn] of closers) {
    try {
      await fn();
    } catch (err) {
      // The swallow. Exactly as every harness here has it.
      console.error("[mini] failed to close " + label + ": " + (err?.message ?? err));
    }
  }
  process.exit(code);
}

resources.round = await openRound({ root: tmp, system: "mini", tag: "mini", expect: want });
for (const n of write) await resources.round.save(n, png);

if (process.argv[6] === "neverclose") {
  // The harness dies between the last capture and the close: every frame is on
  // disk, no manifest is written, and it exits 0 believing it is done.
  console.log("[mini] exiting without closing the round");
  process.exit(0);
}

const dieWith = process.argv[5] || "";
if (dieWith) {
  // The reported shape: the harness knows it failed, records the reason, and
  // still calls shutdown(0) — every harness here decides its exit code before
  // closing the round, so a late discovery cannot change it.
  console.error("[mini] " + dieWith);
  await shutdown(0, dieWith);
} else {
  console.log("[mini] believes it succeeded");
  await shutdown(0);
}
`;
const harnessPath = path.join(tmp, "mini-harness.mjs");
await fs.writeFile(harnessPath, HARNESS);

let failures = 0;
function run(name, want, write, expectCode, dieWith = "", neverClose = false) {
  const r = spawnSync(
    process.execPath,
    [harnessPath, tmp, JSON.stringify(want), JSON.stringify(write), dieWith, neverClose ? "neverclose" : ""],
    { encoding: "utf8" }
  );
  const ok = r.status === expectCode;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name} -> exit ${r.status}` +
      (ok ? "" : ` (expected ${expectCode})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`)
  );
  return r;
}

console.log("  (each case is a child process using the swallowing teardown from shoot1/shoot2/shoot6)");

run("a complete round exits 0", ["a", "b"], ["a", "b"], 0);
/* A round opened and never closed. `system4` has two of these on disk tonight —
 * captures with no `manifest.json` — and the completeness assertion cannot see
 * them, because it runs inside the close that never happened. */
run("opened and never closed exits 1, even with every capture written", ["a", "b"], ["a", "b"], 1, "", true);
const partial = run("2 of 7 written exits 1 despite the swallow and the explicit exit(0)", ["a", "b", "c", "d", "e", "f", "g"], ["a", "b"], 1);
run("zero captures exits 1", ["a", "b"], [], 1);

/* ## Vegetation's round, replayed
 *
 * `shots/system6/rounds/2026-08-29T014903Z-<hash>/manifest.json`: 3 requested,
 * 0 written, `"outcome": "failed"`, a `page.goto` failure recorded — and exit 0.
 * The harness knew and wrote it down; only the exit code lied.
 *
 * The first version of this code did not close it. Its `outcome: "failed"`
 * exemption suppressed the exit hook as well as the throw, which reproduced the
 * exact bug. Exempting a self-reported failure from the *throw* is right, so
 * the navigation error survives instead of being replaced by "round
 * incomplete"; exempting it from the *exit code* is the fault itself.
 *
 * Three more rounds on disk have the same shape: `system1` at 013258Z,
 * `system6` at 005529Z, and `system2` at 005145Z with `outcome` unset. */
const knew = run(
  "3 requested, 0 written, outcome:failed already in the manifest -> exits 1",
  ["a", "b", "c"],
  [],
  1,
  "page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at http://127.0.0.1:5119/"
);
{
  /* The harness's own reason has to survive, and the throw must not have
   * happened: the exit code is corrected, the diagnosis is not replaced. If
   * "A partial round reads as a complete one" appeared here, the assertion
   * would have thrown over a navigation error and the run would report the
   * wrong cause — which is the reason for the exemption in the first place. */
  const all = knew.stdout + knew.stderr;
  const keptCause = /ERR_HTTP_RESPONSE_CODE_FAILURE/.test(all);
  const namedInSummary = /harness reported: page\.goto/.test(knew.stderr);
  const didNotThrowOver = !/A partial round reads as a complete one/.test(all);
  const ok = keptCause && namedInSummary && didNotThrowOver;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  and the navigation error is still the cause, named in the exit summary, ` +
      `with no "incomplete" thrown over it` +
      (ok
        ? ""
        : `\n    keptCause=${keptCause} namedInSummary=${namedInSummary} didNotThrowOver=${didNotThrowOver}` +
          `\n--- stderr ---\n${knew.stderr}`)
  );
}

// The swallow must still have happened — otherwise this test would pass for
// the wrong reason, having accidentally exercised a harness that propagates.
{
  const swallowed = /failed to close archive round/.test(partial.stderr);
  const named = /missing c, d, e, f, g/.test(partial.stderr);
  const ok = swallowed && named;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  the harness did swallow the throw, and the missing shots were still named` +
      (ok ? "" : `\n--- stderr ---\n${partial.stderr}`)
  );
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "[archive] exit-code tests passed" : `[archive] ${failures} exit-code test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
