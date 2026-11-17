import { statSync } from "node:fs";
import path from "node:path";
import type { GraphNode } from "./model.js";

export interface ListingFile {
  /** absolute path, always under the disassembly root */
  absPath: string;
  bytes: number;
}

/** The path from `units/` onward, so listings resolve under whatever the disassembly root is called. */
export function unitRelative(listing: string | null): string | undefined {
  if (!listing) return undefined;
  const i = listing.replace(/\\/g, "/").indexOf("units/");
  return i < 0 ? undefined : listing.replace(/\\/g, "/").slice(i);
}

/** The node's listing (the file its graph `listing` field names), or undefined when it has none on disk. */
export function listingFor(disassemblyRoot: string, node: GraphNode): ListingFile | undefined {
  const rel = unitRelative(node.listing);
  if (!rel) return undefined;
  const absPath = path.join(disassemblyRoot, rel);
  try {
    const st = statSync(absPath);
    return st.isFile() ? { absPath, bytes: st.size } : undefined;
  } catch {
    return undefined;
  }
}
