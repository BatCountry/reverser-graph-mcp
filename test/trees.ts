import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { Correspondence, type Side } from "../src/compare/correspond.js";
import { CallGraph } from "../src/graph/model.js";
import { DEFAULT_WORK_UNIT_OPTIONS } from "../src/graph/workunits.js";

// Miniature generated trees for comparing two games. Each function is given as instruction texts; `{name}` stands for
// the address of another function in the same tree (and makes a call edge), `@k` for the k-th instruction of the
// function itself, so the same code can be laid out at different addresses. `space` defaults to MAIN-root, `file`
// (the node's source_file) to MAIN.EXE. `links` adds link edges (callgraph.json `link`) from the instruction at an
// index to functions by name, e.g. `int 0x66` to the handlers drivers install: `{ 1: { link: "interrupt", to: ["AD"] } }`.
export type Fn = { at: number; code: string[]; space?: string; file?: string; links?: Record<number, { link: "runs" | "loads" | "interrupt"; to: string[] }> };

export const fnId = (at: number, space = "MAIN-root") => `${space}:${at.toString(16).padStart(4, "0")}`;

export function writeTree(dir: string, fns: Record<string, Fn>, extraNodes: Record<string, object> = {}, programs?: Record<string, string[]>): string {
  const id = (name: string) => fnId(fns[name]!.at, fns[name]!.space);
  const nodes: Record<string, object> = { ...extraNodes };
  const edges: object[] = [];
  mkdirSync(path.join(dir, "navigation"), { recursive: true });
  mkdirSync(path.join(dir, "units", "main", "functions"), { recursive: true });
  for (const [name, fn] of Object.entries(fns)) {
    const fid = id(name);
    const space = fn.space ?? "MAIN-root";
    nodes[fid] = { id: fid, kind: "function", space, address: fn.at, file_offset: fn.at, source_file: fn.file ?? "MAIN.EXE", listing: `units/main/functions/${fid.replace(":", "_")}.asm`, entrypoint: false };
    const lines = [`; ${fid}`];
    fn.code.forEach((raw, i) => {
      const addr = fn.at + i * 2;
      const callee = /\{(\w+)\}/.exec(raw)?.[1];
      const text = raw.replace(/\{(\w+)\}/, (_m, n: string) => `0x${fns[n]!.at.toString(16)}`).replace(/@(\d+)/, (_m, k: string) => `0x${(fn.at + Number(k) * 2).toString(16)}`);
      if (callee) edges.push({ source: fid, target: id(callee), instruction: text, instruction_offset: fnId(addr, space), returns: true, conditions: [] });
      for (const to of fn.links?.[i]?.to ?? []) edges.push({ source: fid, target: id(to), instruction: text, instruction_offset: fnId(addr, space), returns: true, conditions: [], link: fn.links![i]!.link });
      lines.push(`${addr.toString(16).padStart(4, "0")}  9090          ${text}`);
    });
    writeFileSync(path.join(dir, "units", "main", "functions", `${fid.replace(":", "_")}.asm`), `${lines.join("\n")}\n`);
  }
  writeFileSync(path.join(dir, "navigation", "callgraph.json"), JSON.stringify({ nodes, edges, aliases: {}, ...(programs ? { programs } : {}) }));
  return dir;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the test file. */
export function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// alpha and beta: two builds of one program. M, L, K, G1, G2 have code no other function has (seeds); X, P, C, Y are
// changed and must be found through their matched neighbours; S1/S2 are identical stubs on both sides.
export const ALPHA: Record<string, Fn> = {
  M: { at: 0x10, code: ["push bp", "call {X}", "call {L}", "inc dx", "call {P}", "ret"] },
  X: { at: 0x40, code: ["mov ax, 1", "add ax, 2", "ret"] },
  L: { at: 0x60, code: ["mov cx, 7", "ret"] },
  P: { at: 0x80, code: ["xor ax, ax", "ret"] },
  C: { at: 0xa0, code: ["call {K}", "inc si", "ret"] },
  K: { at: 0xc0, code: ["mov bx, 9", "ret"] },
  G1: { at: 0xe0, code: ["call {Y}", "mov si, 1", "ret"] },
  G2: { at: 0x100, code: ["call {Y}", "mov si, 2", "ret"] },
  Y: { at: 0x120, code: ["mov ax, 5", "mov bx, 6", "ret"] },
  S1: { at: 0x140, code: ["nop", "ret"] },
  S2: { at: 0x150, code: ["nop", "ret"] },
};

export const BETA = (y2: string[]): Record<string, Fn> => ({
  M: { at: 0x210, code: ["push bp", "call {X}", "call {L}", "inc dx", "call {P}", "ret"] },
  X: { at: 0x240, code: ["mov ax, 1", "add ax, 3", "ret"] },
  L: { at: 0x260, code: ["mov cx, 7", "ret"] },
  P: { at: 0x280, code: ["xor bx, bx", "xor ax, ax", "ret"] },
  C: { at: 0x2a0, code: ["call {K}", "dec si", "dec si", "ret"] },
  K: { at: 0x2c0, code: ["mov bx, 9", "ret"] },
  G1: { at: 0x2e0, code: ["call {Y1}", "mov si, 1", "ret"] },
  G2: { at: 0x300, code: ["call {Y2}", "mov si, 2", "ret"] },
  Y1: { at: 0x320, code: ["mov ax, 5", "mov bx, 7", "ret"] },
  Y2: { at: 0x330, code: y2 },
  S1: { at: 0x340, code: ["nop", "ret"] },
  S2: { at: 0x350, code: ["nop", "ret"] },
});

/** The two games compared; `y2` is the code of beta's Y2, which competes with Y1 for alpha's Y. */
export function twoGames(y2 = ["mov cx, 5", "mov dx, 6", "ret"], alpha = ALPHA, beta = BETA(y2)): Correspondence {
  const root = tempRoot("rpg-corr-");
  const side = (name: string, fns: Record<string, Fn>): Side => {
    const dir = writeTree(path.join(root, name), fns);
    return { name, disassemblyRoot: dir, graph: CallGraph.load(dir) };
  };
  return new Correspondence(side("alpha", alpha), side("beta", beta), DEFAULT_WORK_UNIT_OPTIONS);
}

