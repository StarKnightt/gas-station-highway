/**
 * Audits every harness for readiness and navigation timeouts that are shorter
 * than a cold load.
 *
 * WHY THIS EXISTS
 * ---------------
 * A cold load of this scene is **221-302 s**, measured repeatedly, because the
 * driver spends ~92% of it compiling shaders. Playwright's *default* timeout is
 * 30 s and several harnesses here chose 120 s.
 *
 * **A timeout shorter than the thing being measured converts "slow" into
 * "failed" and destroys the number.** Worse, it destroys it in the most
 * misleading way available: a healthy build reports "never became ready" with an
 * empty page console, which reads exactly like a shader link failure and has
 * been diagnosed as one more than once.
 *
 * There is a second, subtler fault this checks for. `page.waitForFunction`
 * defaults to `polling: "raf"`, and **requestAnimationFrame does not fire while
 * the main thread is blocked**. So a rAF-polled readiness wait is starved during
 * precisely the window it exists to observe: it cannot see the stall, and then
 * it blames the page for not answering.
 *
 * THRESHOLDS, AND WHY
 * -------------------
 *   >= 420 s   ok        Film's figure, ~1.4x the worst cold load observed
 *   300-420 s  thin      survives the median cold load, not the tail
 *   < 300 s    FATAL     shorter than cold loads already measured here
 *   absent     FATAL     inherits Playwright's 30 s default, ~10x too short
 *
 * Usage:  node tools/timeoutaudit.mjs [--fix-report]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = path.join(ROOT, "tools");

/** Worst cold load measured on this project, in ms. Everything is judged against it. */
const WORST_COLD_MS = 302_500;
const SAFE_MS = 420_000;
const THIN_MS = 300_000;
/** Playwright's default action/navigation timeout when none is given. */
const PLAYWRIGHT_DEFAULT_MS = 30_000;

/**
 * Module-level numeric constants, so `timeout: READY_TIMEOUT_MS` resolves.
 *
 * The first version of this scanner read numeric literals only, and reported
 * `tiers.mjs` — which passes an explicit 420 s — as inheriting Playwright's 30 s
 * default. It would have published a fatal count inflated by every harness that
 * did the tidy thing and named its constant. A scanner that punishes good style
 * and calls it a defect is worse than no scanner.
 */
function constantsOf(text) {
  const map = new Map();
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9_]+)\s*(?:;|,|\n)/g)) {
    map.set(m[1], Number(m[2].replace(/_/g, "")));
  }
  // `const X = 7 * 60 * 1000` and similar: evaluate a pure arithmetic literal
  // expression, which is the other common way these are written.
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9_\s*+/()-]+?)\s*(?:;|\n)/g)) {
    if (map.has(m[1])) continue;
    const expr = m[2].replace(/_/g, "");
    if (!/^[\d\s*+/()-]+$/.test(expr) || !/[\d]/.test(expr)) continue;
    try {
      const v = Function(`"use strict";return (${expr});`)();
      if (typeof v === "number" && Number.isFinite(v)) map.set(m[1], v);
    } catch {
      /* not an arithmetic literal; ignore */
    }
  }
  return map;
}

/**
 * Pulls a timeout out of an options blob. Accepts a numeric literal or an
 * identifier resolvable from module constants; returns `{ ms, unresolved }` so an
 * identifier the scanner cannot resolve is reported as *unknown* rather than
 * silently graded as absent.
 */
function readTimeout(blob, consts) {
  if (!blob) return { ms: null, unresolved: null };
  const m = /timeout\s*:\s*([0-9_]+|[A-Za-z_$][\w$.]*)/.exec(blob);
  if (!m) return { ms: null, unresolved: null };
  const raw = m[1];
  if (/^[0-9_]+$/.test(raw)) return { ms: Number(raw.replace(/_/g, "")), unresolved: null };
  if (consts.has(raw)) return { ms: consts.get(raw), unresolved: null };
  return { ms: null, unresolved: raw };
}

function readPolling(blob) {
  if (!blob) return null;
  const m = /polling\s*:\s*(["']?[\w]+["']?)/.exec(blob);
  return m ? m[1].replace(/["']/g, "") : null;
}

/**
 * True when a `waitForFunction` argument list has exactly two arguments and the
 * second is an object literal — i.e. the options were passed in the `arg`
 * position and the real options defaulted to 30 s.
 *
 * Splits on top-level commas only, tracking bracket depth, so commas inside the
 * predicate body, inside nested objects, or inside strings do not count as
 * argument separators.
 */
function isTwoArgWithOptions(args) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === quote && args[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  const trimmed = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  return trimmed.length === 2 && trimmed[1].startsWith("{");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Finds the balanced argument list starting at the `(` at `open`.
 * A regex cannot do this reliably: these calls contain nested objects, arrow
 * functions and strings, and a greedy match runs past the end of the call.
 */
function argsOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1, Math.min(open + 600, text.length));
}

/**
 * Blanks comments while preserving line numbering.
 *
 * Necessary because these harnesses document themselves with usage examples, and
 * a scanner that reads a documented example as a live call site reports the
 * documentation as the defect. `firstload.mjs:23` — a `waitForFunction` inside a
 * header comment showing callers what to do — was flagged as inheriting a 30 s
 * default until this existed.
 *
 * Block comments become the same number of newlines rather than being deleted,
 * so every reported line number still points at the right line. Only
 * whole-line `//` comments are stripped, which sidesteps the `http://` problem
 * without needing to tokenise strings.
 */
function blankComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");
}

function scanFile(file) {
  const text = blankComments(fs.readFileSync(file, "utf8"));
  const consts = constantsOf(text);
  const findings = [];

  const record = (kind, index, t, polling, snippet, positional = false) => {
    findings.push({ kind, line: lineOf(text, index), timeout: t.ms, unresolved: t.unresolved, polling, snippet, positional });
  };

  // ---- readiness waits ----------------------------------------------------
  // Any waitForFunction whose body mentions a readiness flag. Matching on the
  // flag rather than on the call means a harness that waits for something else
  // entirely is not judged against a cold-load threshold.
  // `framesRendered` waits are deliberately NOT in this class: they run after
  // readiness by construction, so they are never waiting on a cold init and a
  // 120 s budget for them is correct rather than fatal. Grading them alongside
  // readiness reported `tiers.mjs` as broken for doing the right thing.
  const READY_FLAGS = /__SCENE_READY|__BOOT|getElementById\(["']loading["']\)/;
  for (const m of text.matchAll(/\bwaitForFunction\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = argsOf(text, open);
    if (!READY_FLAGS.test(args)) continue;

    // ---- the positional trap ------------------------------------------
    // Playwright's signature is `waitForFunction(pageFunction, arg, options)`.
    // A two-argument call passing an options object puts it in the `arg`
    // position, where it is handed to the page function as data and the real
    // options default. **The source says 240_000 and the runtime uses 30_000.**
    //
    // This cannot be found by reading the literal — the number is right there
    // and is simply never used — so it defeats the rest of this scanner and,
    // worse, defeats careful human review: an auditor reads eight times the
    // margin that exists. Detected structurally instead, by counting
    // top-level commas outside the function body.
    const positional = isTwoArgWithOptions(args);
    record(
      "readiness",
      m.index,
      readTimeout(args, consts),
      readPolling(args),
      args.replace(/\s+/g, " ").slice(0, 70),
      positional
    );
  }

  // ---- navigation ---------------------------------------------------------
  for (const m of text.matchAll(/\.goto\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = argsOf(text, open);
    record("goto", m.index, readTimeout(args, consts), null, args.replace(/\s+/g, " ").slice(0, 70), false);
  }

  // ---- blanket defaults, which can rescue an otherwise-bare call ----------
  const defaults = [];
  for (const m of text.matchAll(/setDefault(?:Navigation)?Timeout\s*\(\s*([0-9_]+)/g)) {
    defaults.push({ line: lineOf(text, m.index), ms: Number(m[1].replace(/_/g, "")) });
  }

  return { findings, defaults };
}

function grade(ms, hasDefault, unresolved, positional) {
  // The positional trap outranks the literal: whatever the source says, the
  // effective timeout is Playwright's default.
  if (positional) return { verdict: "FATAL", effective: PLAYWRIGHT_DEFAULT_MS, inherited: true, positional: true };
  // An identifier the scanner could not resolve is UNKNOWN, never a pass and
  // never a fatal. Guessing either way would be the same failure this tool
  // exists to find: reporting a verdict about something never measured.
  if (unresolved) return { verdict: "UNKNOWN", effective: null, inherited: false, unresolved };
  const effective = ms ?? hasDefault ?? PLAYWRIGHT_DEFAULT_MS;
  const inherited = ms == null;
  if (effective >= SAFE_MS) return { verdict: "ok", effective, inherited };
  if (effective >= THIN_MS) return { verdict: "thin", effective, inherited };
  return { verdict: "FATAL", effective, inherited };
}

function main() {
  const files = fs
    .readdirSync(TOOLS)
    .filter((f) => f.endsWith(".mjs") && f !== "timeoutaudit.mjs")
    .map((f) => path.join(TOOLS, f));

  const rows = [];
  for (const file of files) {
    const { findings, defaults } = scanFile(file);
    if (findings.length === 0) continue;
    const blanket = defaults.length ? Math.max(...defaults.map((d) => d.ms)) : null;
    for (const f of findings) {
      const g = grade(f.timeout, blanket, f.unresolved, f.positional);
      rows.push({ file: path.basename(file), ...f, ...g, blanket });
    }
  }

  // A rAF-polled readiness wait is a separate fault from a short one, and a
  // harness can have both. Reported separately so fixing one does not look like
  // fixing the other.
  const starved = rows.filter((r) => r.kind === "readiness" && (r.polling === null || r.polling === "raf"));
  const bad = rows.filter((r) => r.verdict === "FATAL");
  const thin = rows.filter((r) => r.verdict === "thin");
  const unknown = rows.filter((r) => r.verdict === "UNKNOWN");

  console.log("=".repeat(92));
  console.log(`HARNESS TIMEOUT AUDIT — judged against a ${(WORST_COLD_MS / 1000).toFixed(0)} s worst cold load`);
  console.log("=".repeat(92));

  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n${label}`);
    const byFile = new Map();
    for (const r of list) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
    for (const [file, list2] of [...byFile].sort()) {
      console.log(`  ${file}`);
      for (const r of list2) {
        const t = r.positional
          ? `POSITIONAL BUG: options in the arg slot -> effective 30s (source says ${r.timeout ? (r.timeout / 1000).toFixed(0) + "s" : "?"})`
          : r.unresolved
          ? `unresolved identifier ${r.unresolved}`
          : r.inherited
          ? `inherited ${(r.effective / 1000).toFixed(0)}s${r.blanket ? " (setDefaultTimeout)" : " (Playwright default)"}`
          : `${(r.effective / 1000).toFixed(0)}s`;
        console.log(`    :${String(r.line).padEnd(5)} ${r.kind.padEnd(9)} ${t}`);
      }
    }
  };

  // Readiness and navigation are NOT the same risk, and grading them together
  // overstates the problem by roughly 3x.
  //
  // `src/main.ts` calls `game.start()` without awaiting it at top level, so the
  // module finishes evaluating immediately and the `load` event fires long
  // before init completes. A `goto` with `waitUntil: "load"` therefore does NOT
  // wait for the ~280 s cold init, and a 60 s navigation timeout on it is
  // benign. 41 of the 45 goto sites here use "load", 30 use
  // "domcontentloaded", 4 use "commit" — all early.
  //
  // The readiness waits are the real class: they wait for `__SCENE_READY`,
  // which is exactly the thing that takes 221-302 s cold.
  const badReady = bad.filter((r) => r.kind === "readiness");
  const badGoto = bad.filter((r) => r.kind === "goto");

  show(`FATAL — readiness waits shorter than a measured cold load (${badReady.length} site(s)):`, badReady);
  console.log(
    `
ADVISORY — ${badGoto.length} navigation timeout(s) are also under ${(SAFE_MS / 1000).toFixed(0)}s, but
` +
      `  src/main.ts does not await start() at top level, so 'load' fires before init.
` +
      `  These do not fail on a slow init. Raise them for tidiness, not for correctness.`
  );
  show(`THIN — survives the median cold load but not the tail (${thin.length} site(s)):`, thin);
  show(`UNKNOWN — timeout is an identifier this scanner could not resolve (${unknown.length} site(s)):`, unknown);

  if (starved.length) {
    console.log(`\nSTARVED POLLING — readiness waits on rAF, which does not fire while the main`);
    console.log(`thread is blocked, so the poll is starved during the stall it exists to observe`);
    console.log(`(${starved.length} site(s)). Use polling: 500.`);
    const byFile = new Map();
    for (const r of starved) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r.line);
    }
    for (const [file, lines] of [...byFile].sort()) console.log(`  ${file}  :${lines.join(", :")}`);
  }

  console.log(`\n${"-".repeat(92)}`);
  console.log(
    `${rows.length} timed site(s) across ${new Set(rows.map((r) => r.file)).size} harness(es): ` +
      `${badReady.length} FATAL readiness, ${badGoto.length} advisory goto, ${thin.length} thin, ` +
      `${unknown.length} unknown, ${starved.length} starved-polling.`
  );
  if (badReady.length) {
    console.log(`\nA healthy build hitting one of these reports "never became ready" with an empty`);
    console.log(`page console, which is indistinguishable from a shader link failure.`);
    process.exitCode = 1;
  }
}

main();
