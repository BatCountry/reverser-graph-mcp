import { z } from "zod";
import type { Correspondence } from "../compare/correspond.js";
import type { Context } from "../graph/tools.js";
import type { ProgressContext } from "../progress/tools.js";

/** JSON clients sometimes send 33 instead of "33". Accepted by the schema so the parser can explain that numbers need a hex marker. */
export const numberish = z.union([z.string(), z.number()]);
export const asText = (v: string | number | undefined) => (v === undefined ? undefined : String(v));

/** Lazily-built shared state; the call graph loads on first use so reference lookups work without a disassembly tree. */
export interface ToolDeps {
  graphContext: () => Context;
  progressContext: () => ProgressContext;
  /** compare mode (--compare): the two games' names (this tree first) and their correspondence, built on first use */
  compare?: { names: readonly [string, string]; correspondence: () => Correspondence };
}
