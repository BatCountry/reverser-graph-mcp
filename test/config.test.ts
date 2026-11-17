import path from "node:path";
import { describe, expect, test } from "vitest";
import { GAME_NAME_MAX, loadConfig } from "../src/config.js";

const cwd = "/work/proj";
const ROOT = { REVERSER_DISASSEMBLY_ROOT: "generated/alpha" }; // the root is required; argv still beats it

describe("loadConfig", () => {
  test("the disassembly root is required: absent, empty or blank stops startup, naming the flag and the variable", () => {
    const msg = "--disassembly-root / REVERSER_DISASSEMBLY_ROOT must name the generated tree to serve";
    expect(() => loadConfig([], {}, cwd)).toThrow(msg);
    expect(() => loadConfig(["--disassembly-root="], {}, cwd)).toThrow(msg);
    expect(() => loadConfig(["--disassembly-root", "  "], {}, cwd)).toThrow(msg);
    expect(() => loadConfig([], { REVERSER_DISASSEMBLY_ROOT: "" }, cwd)).toThrow(msg);
    expect(() => loadConfig([], { REVERSER_DISASSEMBLY_ROOT: " \t" }, cwd)).toThrow(msg);
    expect(() => loadConfig(["--port", "1"], { REVERSER_PROGRESS_ROOT: "/q" }, cwd)).toThrow(msg);
  });
  test("a given root resolves against the working directory, with a sibling progress dir", () => {
    expect(loadConfig(["--disassembly-root", "generated/alpha"], {}, cwd)).toEqual({
      disassemblyRoot: "/work/proj/generated/alpha",
      progressRoot: "/work/proj/generated/reimplementation/progress",
      progressFile: "/work/proj/generated/reimplementation/progress/alpha.progress.json",
      implementationRoot: "/work/proj/generated/reimplementation",
      workBudgetLines: 600,
      workTrivialLines: 20,
    });
  });
  test("env overrides default", () => {
    const c = loadConfig([], { REVERSER_DISASSEMBLY_ROOT: "reversing/disassembly" }, cwd);
    expect(c.disassemblyRoot).toBe("/work/proj/reversing/disassembly");
    expect(c.progressRoot).toBe("/work/proj/reversing/reimplementation/progress");
  });
  test("argv beats env, both flag spellings", () => {
    expect(loadConfig(["--disassembly-root", "/abs/d"], { REVERSER_DISASSEMBLY_ROOT: "x" }, cwd).disassemblyRoot).toBe("/abs/d");
    expect(loadConfig(["--disassembly-root=/abs/e"], {}, cwd).disassemblyRoot).toBe("/abs/e");
  });
  test("progress root is independently configurable", () => {
    expect(loadConfig(["--progress-root", "p"], ROOT, cwd).progressRoot).toBe(path.resolve(cwd, "p"));
    expect(loadConfig([], { ...ROOT, REVERSER_PROGRESS_ROOT: "/q" }, cwd).progressRoot).toBe("/q");
  });
  test("the progress document is named after the tree, so two games sharing a progress root never share it", () => {
    const beta = loadConfig(["--disassembly-root", "generated/beta", "--progress-root", "p"], {}, cwd);
    const alpha = loadConfig(["--disassembly-root", "generated/alpha/", "--progress-root", "p"], {}, cwd);
    expect(beta.progressFile).toBe("/work/proj/p/beta.progress.json");
    expect(alpha.progressFile).toBe("/work/proj/p/alpha.progress.json");
    expect(loadConfig([], { REVERSER_DISASSEMBLY_ROOT: "reversing/disassembly" }, cwd).progressFile).toBe("/work/proj/reversing/reimplementation/progress/disassembly.progress.json");
  });
  test("implementation root follows the progress root unless set", () => {
    expect(loadConfig(["--progress-root", "/p/prog"], ROOT, cwd).implementationRoot).toBe("/p");
    expect(loadConfig(["--implementation-root=src/impl"], ROOT, cwd).implementationRoot).toBe("/work/proj/src/impl");
    expect(loadConfig([], { ...ROOT, REVERSER_IMPLEMENTATION_ROOT: "/i" }, cwd).implementationRoot).toBe("/i");
  });
  test("a root flag with no value falls back to the environment, then stops startup", () => {
    expect(loadConfig(["--disassembly-root"], ROOT, cwd).disassemblyRoot).toBe("/work/proj/generated/alpha");
    expect(() => loadConfig(["--disassembly-root"], {}, cwd)).toThrow("--disassembly-root / REVERSER_DISASSEMBLY_ROOT must name");
  });
  test("work unit sizes: flag (both spellings) beats env beats default", () => {
    expect(loadConfig(["--work-budget-lines", "400"], { ...ROOT, REVERSER_WORK_BUDGET_LINES: "900" }, cwd).workBudgetLines).toBe(400);
    expect(loadConfig(["--work-budget-lines=450"], ROOT, cwd).workBudgetLines).toBe(450);
    expect(loadConfig([], { ...ROOT, REVERSER_WORK_BUDGET_LINES: "900" }, cwd).workBudgetLines).toBe(900);
    expect(loadConfig(["--work-trivial-lines", "8"], { ...ROOT, REVERSER_WORK_TRIVIAL_LINES: "30" }, cwd).workTrivialLines).toBe(8);
    expect(loadConfig([], { ...ROOT, REVERSER_WORK_TRIVIAL_LINES: "30" }, cwd).workTrivialLines).toBe(30);
    expect(loadConfig(["--work-trivial-lines"], { ...ROOT, REVERSER_WORK_TRIVIAL_LINES: "31" }, cwd).workTrivialLines).toBe(31);
    expect(loadConfig([], { ...ROOT, REVERSER_WORK_BUDGET_LINES: " 1 " }, cwd).workBudgetLines).toBe(1);
  });
  test.each(["0", "-1", "abc", "1.5", "", "  ", "0x10", "1e3", "+5", "Infinity", "NaN", "9007199254740993"])("rejects work line count %j at startup", (bad) => {
    expect(() => loadConfig(["--work-budget-lines", bad], ROOT, cwd)).toThrow(/--work-budget-lines \/ REVERSER_WORK_BUDGET_LINES must be a positive whole number/);
    expect(() => loadConfig([], { ...ROOT, REVERSER_WORK_TRIVIAL_LINES: bad }, cwd)).toThrow(/--work-trivial-lines \/ REVERSER_WORK_TRIVIAL_LINES must be a positive whole number/);
  });
});

describe("--dashboard / --port", () => {
  const dash = (...argv: string[]) => loadConfig(argv, ROOT, cwd).dashboard;
  test("absent means stdio", () => {
    expect(dash()).toBeUndefined();
    expect(dash("--port")).toBeUndefined(); // a flag with no value falls back, as every other flag does
  });
  test("a free port unless --port picks one (both spellings, anywhere in argv)", () => {
    expect(dash("--dashboard")).toEqual({ port: 0 });
    expect(dash("--dashboard", "--port", "8765")).toEqual({ port: 8765 });
    expect(dash("--port=8765", "--disassembly-root", "x", "--dashboard")).toEqual({ port: 8765 });
  });
  test.each([
    ["0", 0],
    ["1", 1],
    ["65535", 65535],
    [" 8765 ", 8765],
    ["08080", 8080],
  ])("accepts --port %j", (raw, port) => {
    expect(dash("--dashboard", "--port", raw)).toEqual({ port });
  });
  test.each(["", "  ", "65536", "-1", "+80", "1.5", "0x50", "1e3", "Infinity", "NaN", "abc", "127.0.0.1:80", "99999999999999999999"])("rejects --port %j at startup", (bad) => {
    expect(() => dash("--dashboard", "--port", bad)).toThrow(/--port must be a decimal port number 0-65535/);
  });
  test("--port without --dashboard, or a value on --dashboard, stops startup", () => {
    expect(() => dash("--port", "8765")).toThrow("--port only applies with --dashboard");
    expect(() => dash("--dashboard=true")).toThrow("--dashboard takes no value");
    expect(() => dash("--dashboard=8765")).toThrow("--dashboard takes no value");
  });
});

describe("--compare", () => {
  const cmp = (argv: string[], env: Record<string, string> = {}) => loadConfig(argv, { ...ROOT, ...env }, cwd).compare;
  test("absent: no compare mode", () => {
    expect(cmp([])).toBeUndefined();
  });
  test("flag, flag=value and env name the other tree, relative to the working directory", () => {
    expect(cmp(["--compare", "generated/beta"])).toEqual({ root: "/work/proj/generated/beta", name: "beta" });
    expect(cmp(["--compare=/t/beta/"])).toEqual({ root: "/t/beta", name: "beta" });
    expect(cmp([], { REVERSER_COMPARE_ROOT: "../x/beta" })).toEqual({ root: "/work/x/beta", name: "beta" });
    expect(cmp(["--compare", "a/beta"], { REVERSER_COMPARE_ROOT: "b/other" })?.name).toBe("beta");
  });
  test.each([
    [["--compare"], {}, "must name a generated tree directory"],
    [["--compare"], { REVERSER_COMPARE_ROOT: "generated/beta" }, "must name a generated tree directory"],
    [["--compare", " "], {}, "must name a generated tree directory"],
    [["--compare="], {}, "must name a generated tree directory"],
    [[], { REVERSER_COMPARE_ROOT: "" }, "must name a generated tree directory"],
    [["--compare", "elsewhere/alpha"], {}, "has the same directory name as the disassembly root (alpha)"],
    [["--disassembly-root", "x/beta", "--compare", "y/beta"], {}, "has the same directory name"],
  ])("%j %j stops startup", (argv, env, message) => {
    expect(() => cmp(argv as string[], env as Record<string, string>)).toThrow(message);
  });
});

describe("--game-name", () => {
  const name = (argv: string[], env: NodeJS.ProcessEnv = {}) => loadConfig(argv, { ...ROOT, ...env }, cwd).gameName;
  test("absent: no title", () => {
    expect(name([])).toBeUndefined();
  });
  test("flag, flag=value and env give the title, trimmed; the flag beats the env", () => {
    expect(name(["--game-name", "Example Game"])).toBe("Example Game");
    expect(name(["--game-name=Other Game"])).toBe("Other Game");
    expect(name([], { REVERSER_GAME_NAME: "  Third Game\t" })).toBe("Third Game");
    expect(name(["--game-name", "Fourth Game"], { REVERSER_GAME_NAME: "x" })).toBe("Fourth Game");
  });
  test("up to GAME_NAME_MAX characters after trimming", () => {
    expect(name(["--game-name", ` ${"x".repeat(GAME_NAME_MAX)} `])).toHaveLength(GAME_NAME_MAX);
    expect(() => name(["--game-name", "x".repeat(GAME_NAME_MAX + 1)])).toThrow(`is ${GAME_NAME_MAX + 1} characters; keep it to ${GAME_NAME_MAX}`);
  });
  test.each([
    [["--game-name", ""], {}],
    [["--game-name", "   "], {}],
    [["--game-name="], {}],
    [[], { REVERSER_GAME_NAME: "" }],
    [["--game-name"], { REVERSER_GAME_NAME: "from env" }], // a bare trailing flag never falls back to the env
  ])("empty: %j %j stops startup", (argv, env) => {
    expect(() => name(argv, env)).toThrow("got an empty value");
  });
});
