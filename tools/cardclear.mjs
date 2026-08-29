/**
 * Verifies the GPU is actually clear of browser processes before a measurement.
 *
 * WHY THIS EXISTS
 * ---------------
 * A harness reported clean shutdown and left fifteen Chromium processes alive.
 * Any measurement started after that report is contended, and nothing in the
 * report says so.
 *
 * THE FAILURE THIS TOOL IS BUILT AGAINST
 * --------------------------------------
 * `wmic` does not exist on current Windows builds. A check written as
 * `wmic process where "name='chrome.exe'" get commandline` therefore fails to
 * run and prints nothing — which is indistinguishable from finding nothing.
 * **The check returns all-clear by failing to look**, and that is the worst
 * available outcome because it is silent and it is reassuring.
 *
 * So this does two things a naive check does not:
 *
 *  1. It uses `Get-CimInstance Win32_Process`, which is the supported
 *     replacement, and
 *  2. it runs a **negative control first**: it queries for a process it knows is
 *     running (this very `node`) and requires a non-zero count. If the control
 *     returns zero, the query mechanism is broken and the tool exits non-zero
 *     saying so, rather than reporting a clear card.
 *
 * A detector that has not been shown to detect is not a detector.
 *
 * Usage:
 *   node tools/cardclear.mjs           report only, exit 1 if anything is up
 *   node tools/cardclear.mjs --kill    also kill browsers under ms-playwright
 *
 * `--kill` is deliberately narrow: it matches only command lines containing
 * `ms-playwright`, so it cannot touch the user's own browser, and it never
 * touches `node.exe`, which would destroy the other agents on this tree.
 */
import { execFileSync } from "node:child_process";

const KILL = process.argv.includes("--kill");

function ps(script) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    return { __error: err.message ?? String(err) };
  }
}

/**
 * Seconds since a process started, or null if unreadable.
 *
 * Returns null rather than NaN deliberately. NaN propagates through
 * `Math.max`, survives every comparison as `false`, and made the first version
 * of this tool print "wide spread -> probably leaked" from *no data at all* —
 * a confident verdict manufactured out of an unparseable date.
 */
function ageOf(started) {
  if (!started) return null;
  const t = new Date(started).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 1000);
}

/** Returns {rows:[{pid,name,cmd,ageS}]} or {__error}. */
function query(nameList) {
  const filter = nameList.map((n) => `Name='${n}'`).join(" or ");
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      `Select-Object ProcessId,Name,CommandLine,@{N='Started';E={$_.CreationDate.ToString('o')}} | ` +
      `ConvertTo-Json -Compress -Depth 3`
  );
  if (typeof out !== "string") return out;
  const text = out.trim();
  if (!text) return { rows: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { __error: `unparseable PowerShell output: ${text.slice(0, 200)}` };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return {
    rows: arr
      .filter((r) => r && r.ProcessId)
      .map((r) => ({
        pid: r.ProcessId,
        name: r.Name,
        cmd: r.CommandLine ?? "",
        ageS: ageOf(r.Started),
      })),
  };
}

// ---- negative control ----------------------------------------------------
// This process is node. If the query cannot see it, the query is broken and any
// "card is clear" it produces is meaningless.
const control = query(["node.exe"]);
if (control.__error) {
  console.error(`FAIL  process query is broken: ${control.__error}`);
  console.error("      Treat the card as CONTENDED. Do not start a measurement.");
  process.exit(1);
}
if (control.rows.length === 0) {
  console.error("FAIL  negative control found zero node.exe processes, but this tool IS node.");
  console.error("      The query mechanism cannot see processes, so it cannot report a clear card.");
  console.error("      Treat the card as CONTENDED. Do not start a measurement.");
  process.exit(1);
}
console.log(`ok    control: query sees ${control.rows.length} node.exe process(es), so it can see processes`);

// ---- the actual check ----------------------------------------------------
const BROWSERS = ["chrome.exe", "chromium.exe", "msedge.exe", "firefox.exe", "headless_shell.exe"];
const found = query(BROWSERS);
if (found.__error) {
  console.error(`FAIL  browser query failed: ${found.__error}`);
  process.exit(1);
}

/*
 * `CommandLine` is null for processes this session cannot read. Those cannot be
 * classified, and folding them into "user's own browser" would accept contention
 * that might be a harness -- the same consequential direction as the NaN verdict
 * above, so they are counted separately and reported as UNREADABLE.
 */
const unreadable = found.rows.filter((r) => !r.cmd);
const readable = found.rows.filter((r) => r.cmd);
const playwright = readable.filter((r) => /ms-playwright|playwright/i.test(r.cmd));
const other = readable.filter((r) => !/ms-playwright|playwright/i.test(r.cmd));

// Renderer/GPU child processes matter as much as the parent: a leaked GPU
// process holds VRAM whether or not its parent is still around.
const gpuChildren = found.rows.filter((r) => /--type=(gpu-process|renderer)/.test(r.cmd));

console.log("");
const byName = new Map();
for (const r of found.rows) byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
console.log(
  `browser processes alive: ${found.rows.length}` +
    ` (${[...byName].map(([n, c]) => `${c} ${n}`).join(", ")})`
);
console.log(`  playwright-launched:  ${playwright.length}${playwright.length ? `  pids ${playwright.map((r) => r.pid).join(",")}` : ""}`);
console.log(`  user / other:         ${other.length}${other.length ? `  pids ${other.map((r) => r.pid).join(",")}` : ""}`);
console.log(`  of which gpu/renderer children: ${gpuChildren.length}`);
if (unreadable.length) {
  console.log(`  UNREADABLE command line:  ${unreadable.length}  pids ${unreadable.map((r) => r.pid).join(",")}`);
  console.log("        cannot be classified as harness or user; treat as possible contention");
}

/*
 * Age is what separates "a harness is running right now" from "a harness leaked
 * these an hour ago". A count cannot: one live Playwright Chromium is typically
 * four to six processes, so eight alive is equally consistent with one healthy
 * run and with two dead ones. Before taking an exclusive window, the question is
 * not "is anything alive" but "is anything alive that nobody is using", and only
 * the start time answers it.
 */
const ages = found.rows.map((r) => r.ageS).filter((a) => a != null);
if (found.rows.length && ages.length < found.rows.length) {
  console.log(
    `  age: UNKNOWN for ${found.rows.length - ages.length} of ${found.rows.length} process(es) — ` +
      "not inferring leak-versus-live from partial data"
  );
}
if (ages.length) {
  const oldest = Math.max(...ages);
  const newest = Math.min(...ages);
  const fmt = (s) => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(0)} s`);
  console.log(`  age: newest ${fmt(newest)}, oldest ${fmt(oldest)}, spread ${fmt(oldest - newest)}`);
  if (oldest - newest < 120) {
    console.log("        tight spread -> consistent with ONE live harness, not a leak");
  } else {
    console.log(
      "        wide spread -> MORE THAN ONE COHORT. That is two live harnesses OR a leak,\n" +
        "        and age cannot tell them apart. Check against what is scheduled before killing anything."
    );
  }
}

if (KILL && playwright.length) {
  const pids = playwright.map((r) => r.pid);
  console.log(`\nkilling ${pids.length} playwright-launched process(es) by pid...`);
  ps(`Stop-Process -Id ${pids.join(",")} -Force -ErrorAction SilentlyContinue`);
  const after = query(BROWSERS);
  const left = (after.rows ?? []).filter((r) => /ms-playwright|playwright/i.test(r.cmd));
  console.log(`after kill: ${left.length} playwright process(es) remain`);
  if (left.length) {
    console.error("FAIL  processes survived the kill; investigate before measuring.");
    process.exit(1);
  }
}

const remaining = KILL ? other : found.rows;
console.log("");
if (remaining.length === 0) {
  console.log("PASS  card is clear of browser processes.");
  process.exit(0);
}
if (playwright.length && !KILL) {
  console.error(`FAIL  ${playwright.length} harness browser(s) still alive. Re-run with --kill.`);
  process.exit(1);
}
console.error(
  `FAIL  ${remaining.length} non-harness browser process(es) alive. These are probably the user's own\n` +
    "      browser and this tool will not kill them. Ask before measuring, or accept the contention\n" +
    "      and record it alongside the numbers."
);
process.exit(1);
