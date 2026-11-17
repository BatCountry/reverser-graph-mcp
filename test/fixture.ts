import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A miniature disassembly tree shaped like the generated one (navigation/callgraph.json, units/<file>/functions/<id>.asm).
//
//   R(MAIN-root:0006) -> A(module-0001:0010) -> B(module-0001:0020) -> C(module-0002:0030) -> D(module-0002:0040)
//   R -> A -> C                (shorter alternative)      R2(MAIN-root:0100) -> C
//   X(module-0004:0060) <-> Y(module-0004:0070)  (cycle nobody enters), Y -> D
//   Z(module-0005:0001) isolated function, ADDR(module-0002:0099) an address-only node

const node = (id: string, kind = "function", entrypoint = false) => {
  const [space, off] = id.split(":");
  const start = space === "MAIN-root";
  return {
    id, kind, space, address: parseInt(off!, 16), file_offset: parseInt(off!, 16) + 0x100, source_file: start ? "MAIN.EXE" : "MAIN.OVR",
    // generated under another directory name than the fixture root: paths resolve from their units/ suffix
    listing: kind === "function" ? `alpha/units/${start ? "main" : "play"}/functions/${id.replace(":", "_")}.asm` : null, entrypoint,
  };
};
const edge = (source: string, target: string, offset: string, conditions: Array<{ direction: string; expression: string; offset: string }> = []) => ({
  source, target, instruction: `lcall 0x2000, 0x${target.split(":")[1]}`, instruction_offset: offset, returns: true, conditions,
});

/** A's listing in the generator's format: 4-hex offset in its space, two spaces, bytes, instruction. */
export const LISTING_A = ["; module-0001:0010", "0010  55          push bp", "0011  7401        je 0x14", "0012  e80b00      call 0x20", "0014  e81900      call 0x30", "0017  cb          retf"].join("\n");

export const IDS = {
  R: "MAIN-root:0006", R2: "MAIN-root:0100", A: "module-0001:0010", B: "module-0001:0020", C: "module-0002:0030", D: "module-0002:0040",
  X: "module-0004:0060", Y: "module-0004:0070", Z: "module-0005:0001", ADDR: "module-0002:0099",
} as const;

export function graphJson() {
  const ids = Object.values(IDS);
  return {
    scope: "fixture",
    counts: {},
    aliases: { "0016:0020": IDS.A },
    nodes: Object.fromEntries(ids.map((id) => [id, node(id, id === IDS.ADDR ? "address" : "function", id === IDS.R)])),
    edges: [
      edge(IDS.R, IDS.A, "MAIN-root:0010"),
      edge(IDS.A, IDS.B, "module-0001:0012", [{ direction: "taken", expression: "ZF=1", offset: "module-0001:0011" }]),
      edge(IDS.B, IDS.C, "module-0001:0022"),
      edge(IDS.A, IDS.C, "module-0001:0014"),
      edge(IDS.C, IDS.D, "module-0002:0032"),
      edge(IDS.R2, IDS.C, "MAIN-root:0104"),
      edge(IDS.X, IDS.Y, "module-0004:0062"),
      edge(IDS.Y, IDS.X, "module-0004:0072"),
      edge(IDS.Y, IDS.D, "module-0004:0074"),
      edge(IDS.C, IDS.ADDR, "module-0002:0034"),
    ],
  };
}

export interface Fixture {
  root: string;
  disassembly: string;
  progress: string;
  /** the document the server writes for this tree: <progress>/disassembly.progress.json */
  progressFile: string;
  implementation: string;
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "rpg-fixture-"));
  const disassembly = path.join(root, "reversing", "disassembly");
  const functions = path.join(disassembly, "units", "play", "functions");
  mkdirSync(path.join(disassembly, "navigation"), { recursive: true });
  writeFileSync(path.join(disassembly, "navigation", "callgraph.json"), JSON.stringify(graphJson()));
  mkdirSync(functions, { recursive: true });
  writeFileSync(path.join(functions, "module-0001_0010.asm"), `${LISTING_A}\n`);
  writeFileSync(path.join(functions, "module-0002_0030.asm"), "; module-0002:0030\n0030  c3          ret\n");

  const implementation = path.join(root, "reversing", "reimplementation");
  const progress = path.join(implementation, "progress");
  mkdirSync(path.join(implementation, "src"), { recursive: true });
  writeFileSync(path.join(implementation, "src", "render.cpp"), `/* Implements: module-0001:0010 */\nvoid draw_frame() {}\n`);
  writeFileSync(path.join(implementation, "src", "other.cpp"), `/* Implements: module-0001:0020, module-0002:0030 */\nvoid other_fn() {}\n`);
  writeFileSync(path.join(implementation, "src", "bare.cpp"), `void nothing() {}\n`);
  mkdirSync(path.join(implementation, "alt"), { recursive: true });
  writeFileSync(path.join(implementation, "alt", "render.cpp"), `/* Implements: module-0001:0010 */\nvoid draw_frame() {}\n`);
  return { root, disassembly, progress, progressFile: path.join(progress, "disassembly.progress.json"), implementation };
}
