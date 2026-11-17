import path from "node:path";
import { DEFAULT_WORK_UNIT_OPTIONS } from "./graph/workunits.js";

// Where the disassembly tree (navigation/callgraph.json, units/...) lives. This server is
// relocated between projects, so the root is configurable rather than hard-coded:
//   --disassembly-root <dir>   or   REVERSER_DISASSEMBLY_ROOT=<dir>
// Required: a tree built from the binaries by scripts/build_callgraph.py; startup stops when neither is given.
// The progress graph (implementations + annotations) lives in --progress-root /
// REVERSER_PROGRESS_ROOT, default: <disassembly_root>/../reimplementation/progress
// (never inside the generated tree). The document in it is named after the
// tree, <disassembly_root dir name>.progress.json (alpha.progress.json, beta.progress.json): node ids overlap
// between games, so two trees sharing a progress root must never share a document.
// Source files claiming to implement a module are searched under --implementation-root /
// REVERSER_IMPLEMENTATION_ROOT, default: the parent of the progress root (<disassembly_root>/../reimplementation).
// Work units (next_work) are sized by --work-budget-lines / REVERSER_WORK_BUDGET_LINES (default 600: split anything
// bigger) and --work-trivial-lines / REVERSER_WORK_TRIVIAL_LINES (default 20: smaller leaf callees stay with their caller).
// --dashboard serves the progress dashboard at / and MCP over streamable HTTP at /mcp on 127.0.0.1 instead of stdio,
// on a free port unless --port <n> picks one.
// --compare <dir> / REVERSER_COMPARE_ROOT names a second generated tree (another game, or another build): the server
// then also offers the compare tools (counterpart, compare) and resources, and the dashboard a Compare page. Games are
// told apart by directory name, so the two trees' directory names must differ.
// --game-name <text> / REVERSER_GAME_NAME titles the dashboard's Overview ("Example Game"); optional.

export interface Config {
  disassemblyRoot: string;
  progressRoot: string;
  /** <progressRoot>/<disassembly root dir name>.progress.json */
  progressFile: string;
  implementationRoot: string;
  workBudgetLines: number;
  workTrivialLines: number;
  /** --dashboard: serve HTTP on 127.0.0.1 (MCP at /mcp, dashboard at /) instead of stdio; port 0 = any free port */
  dashboard?: { port: number } | undefined;
  /** --compare: the other tree; `name` is its directory name, as tools and documents call that game */
  compare?: { root: string; name: string } | undefined;
  /** --game-name: shown as the dashboard Overview's title; undefined = no title */
  gameName?: string | undefined;
}

export const GAME_NAME_MAX = 120;

/** --game-name / REVERSER_GAME_NAME: trimmed; given but empty or longer than GAME_NAME_MAX stops startup. */
function gameName(argv: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  // a bare trailing --game-name must not fall back to the environment unnoticed
  const raw = flag(argv, "game-name") ?? (argv.includes("--game-name") ? "" : env.REVERSER_GAME_NAME);
  if (raw === undefined) return undefined;
  const name = raw.trim();
  if (!name) throw new Error("--game-name / REVERSER_GAME_NAME must be a title like \"Example Game\", got an empty value");
  if (name.length > GAME_NAME_MAX) throw new Error(`--game-name / REVERSER_GAME_NAME is ${name.length} characters; keep it to ${GAME_NAME_MAX}`);
  return name;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Decimal positive whole number; operator configuration, so a bad value stops startup instead of being guessed. */
export function lineCount(raw: string | undefined, fallback: number, name: string, envName: string): number {
  if (raw === undefined) return fallback;
  const t = raw.trim();
  const n = /^\d+$/.test(t) ? Number(t) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`--${name} / ${envName} must be a positive whole number of lines (decimal), got "${raw}"`);
  return n;
}

/** The progress document of one tree: named after the tree so trees sharing a progress root never share it. */
export function progressFileFor(progressRoot: string, disassemblyRoot: string): string {
  return path.join(progressRoot, `${path.basename(path.resolve(disassemblyRoot))}.progress.json`);
}

/** --dashboard and --port; operator configuration, so anything odd stops startup. */
function dashboard(argv: readonly string[]): Config["dashboard"] {
  if (argv.some((a) => a.startsWith("--dashboard="))) throw new Error("--dashboard takes no value; choose the port with --port <n>");
  const raw = flag(argv, "port");
  if (!argv.includes("--dashboard")) {
    if (raw !== undefined) throw new Error("--port only applies with --dashboard");
    return undefined;
  }
  if (raw === undefined) return { port: 0 };
  const t = raw.trim();
  const port = /^\d+$/.test(t) ? Number(t) : Number.NaN;
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error(`--port must be a decimal port number 0-65535 (0 = any free port), got "${raw}"`);
  return { port };
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Config {
  const rootGiven = flag(argv, "disassembly-root") ?? env.REVERSER_DISASSEMBLY_ROOT;
  if (rootGiven === undefined || !rootGiven.trim()) throw new Error("--disassembly-root / REVERSER_DISASSEMBLY_ROOT must name the generated tree to serve (a directory built by scripts/build_callgraph.py)");
  const disassemblyRoot = path.resolve(cwd, rootGiven);
  const progressRaw =
    flag(argv, "progress-root") ??
    env.REVERSER_PROGRESS_ROOT ??
    path.join(disassemblyRoot, "..", "reimplementation", "progress");
  const progressRoot = path.resolve(cwd, progressRaw);
  const implRaw = flag(argv, "implementation-root") ?? env.REVERSER_IMPLEMENTATION_ROOT ?? path.dirname(progressRoot);
  // a bare trailing --compare must not fall back to the environment unnoticed
  const compareRaw = flag(argv, "compare") ?? (argv.includes("--compare") ? "" : env.REVERSER_COMPARE_ROOT);
  let compare: Config["compare"];
  if (compareRaw !== undefined) {
    if (!compareRaw.trim()) throw new Error("--compare / REVERSER_COMPARE_ROOT must name a generated tree directory, got an empty value");
    const root = path.resolve(cwd, compareRaw);
    const name = path.basename(root);
    if (name === path.basename(disassemblyRoot)) throw new Error(`--compare ${root} has the same directory name as the disassembly root (${name}); the two games are told apart by directory name, so they must differ`);
    compare = { root, name };
  }
  return {
    disassemblyRoot,
    progressRoot,
    progressFile: progressFileFor(progressRoot, disassemblyRoot),
    implementationRoot: path.resolve(cwd, implRaw),
    workBudgetLines: lineCount(flag(argv, "work-budget-lines") ?? env.REVERSER_WORK_BUDGET_LINES, DEFAULT_WORK_UNIT_OPTIONS.budgetLines, "work-budget-lines", "REVERSER_WORK_BUDGET_LINES"),
    workTrivialLines: lineCount(flag(argv, "work-trivial-lines") ?? env.REVERSER_WORK_TRIVIAL_LINES, DEFAULT_WORK_UNIT_OPTIONS.trivialLines, "work-trivial-lines", "REVERSER_WORK_TRIVIAL_LINES"),
    dashboard: dashboard(argv),
    compare,
    gameName: gameName(argv, env),
  };
}
