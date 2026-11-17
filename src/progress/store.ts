import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ImplementationRecord {
  module: string;
  /** path of the implementing file relative to the implementation root */
  file: string;
  function: string;
  recordedAt: string;
}

export interface AnnotationReference {
  reference_type: "module" | "freeform";
  reference_content: string;
}

export interface AnnotationRecord {
  module: string;
  annotation_type: "behavioral" | "functional";
  description: string;
  references: AnnotationReference[];
  recordedAt: string;
}

interface ProgressFile {
  version: 1;
  implementations: ImplementationRecord[];
  annotations: AnnotationRecord[];
}

const EMPTY: ProgressFile = { version: 1, implementations: [], annotations: [] };

/** JSON progress graph in one file (Config.progressFile), re-read on every call so several servers can share it. */
export class ProgressStore {
  constructor(readonly file: string) {}

  private read(): ProgressFile {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, implementations: [], annotations: [] };
      throw error;
    }
    // written only by this class; version-checked so a future format fails loudly instead of being clobbered
    const parsed: ProgressFile = JSON.parse(text);
    if (parsed.version !== 1) throw new Error(`Unsupported progress file version ${String(parsed.version)} in ${this.file}`);
    return parsed;
  }

  private write(data: ProgressFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);
  }

  /** Changes whenever progress.json is rewritten (atomic rename gives a new inode even within one mtime tick); "absent" before the first write. */
  changeToken(): string {
    try {
      const st = statSync(this.file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
  }

  /** Re-registering the same module/file/function updates its timestamp instead of duplicating. */
  addImplementation(rec: Omit<ImplementationRecord, "recordedAt">, now = new Date()): { created: boolean } {
    return { created: this.addImplementations([rec], now).created === 1 };
  }

  /** Several records in one write (a whole work unit); returns how many were new rather than refreshed. */
  addImplementations(recs: ReadonlyArray<Omit<ImplementationRecord, "recordedAt">>, now = new Date()): { created: number } {
    const data = this.read();
    let created = 0;
    for (const rec of recs) {
      const i = data.implementations.findIndex((r) => r.module === rec.module && r.file === rec.file && r.function === rec.function);
      const record = { ...rec, recordedAt: now.toISOString() };
      if (i >= 0) data.implementations[i] = record;
      else {
        data.implementations.push(record);
        created++;
      }
    }
    this.write(data);
    return { created };
  }

  addAnnotation(rec: Omit<AnnotationRecord, "recordedAt">, now = new Date()): void {
    this.addAnnotations([rec], now);
  }

  /** Several annotations in one write. */
  addAnnotations(recs: ReadonlyArray<Omit<AnnotationRecord, "recordedAt">>, now = new Date()): void {
    const data = this.read();
    for (const rec of recs) data.annotations.push({ ...rec, recordedAt: now.toISOString() });
    this.write(data);
  }

  implementationsFor(module: string): ImplementationRecord[] {
    return this.read().implementations.filter((r) => r.module === module);
  }

  annotationsFor(module: string): AnnotationRecord[] {
    return this.read().annotations.filter((r) => r.module === module);
  }

  /** modules (ids) that have at least one implementation */
  implementedModules(): Set<string> {
    return new Set(this.read().implementations.map((r) => r.module));
  }

  /** every record, one read (the dashboard needs both lists consistent with each other) */
  snapshot(): { implementations: ImplementationRecord[]; annotations: AnnotationRecord[] } {
    const { implementations, annotations } = this.read();
    return { implementations, annotations };
  }
}

// ---------------------------------------------------------------- implementation file validation

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".venv"]);
const MAX_FILES_SCANNED = 20_000;

/** Files under `root` whose path ends with `name` (a basename or a trailing relative path). */
export function findImplementationFiles(root: string, name: string): string[] {
  const wanted = name.replace(/\\/g, "/").replace(/^\/+/, "");
  const hits: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned > MAX_FILES_SCANNED) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else {
        scanned++;
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (rel === wanted || rel.endsWith(`/${wanted}`)) hits.push(full);
      }
    }
  };
  walk(root);
  return hits;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Anything shaped like a node id (`SPACE:hhhh`, optionally `work:`-prefixed), for naming what a comment does say. */
const NODE_TOKEN = /(?<![\w:-])(?:work:)?[a-z][\w-]*:[0-9a-f]{4}(?![\w:-])/gi;

export type ImplementsCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * A file implements `module` when it holds a block comment `/* Implements: ... *\/` naming that module,
 * and mentions `functionName`. Names are matched as whole tokens (MAIN_OVR-0020:1a2c must not match MAIN_OVR-0020:1a2c0,
 * and work:MAIN_OVR-0020:1a2c is not the node MAIN_OVR-0020:1a2c). For a work unit id pass its function `members`:
 * the comment may then name the work unit itself or every one of those members.
 */
export function checkImplementsComment(source: string, module: string, functionName: string, fileLabel: string, members: readonly string[] = []): ImplementsCheck {
  const blocks = [...source.matchAll(/\/\*[\s*]*Implements:([\s\S]*?)\*\//g)].map((m) => m[1]!);
  const names = (id: string) => {
    const token = new RegExp(`(?<![\\w:-])${escapeRegExp(id)}(?![\\w:-])`, "i");
    return blocks.some((b) => token.test(b));
  };
  if (blocks.length === 0) {
    return { ok: false, error: `${fileLabel} has no \`/* Implements: ... */\` comment. Add one naming ${module} (and the function ${functionName}) next to the implementation, then call again.` };
  }
  if (!names(module)) {
    const missing = members.filter((m) => !names(m));
    if (members.length === 0 || missing.length > 0) {
      const named = [...new Set(blocks.flatMap((b) => b.match(NODE_TOKEN) ?? []))];
      const it = named.length ? ` It names: ${named.join(", ")}.` : "";
      return members.length === 0
        ? { ok: false, error: `No \`/* Implements: ... */\` comment in ${fileLabel} names ${module}.${it} Add the module name to the comment.` }
        : { ok: false, error: `No \`/* Implements: ... */\` comment in ${fileLabel} names ${module} or all of its members; missing ${missing.length} of ${members.length}: ${missing.join(", ")}.${it} Add ${module} itself, or the missing members, to the comment.` };
    }
  }
  if (!new RegExp(`\\b${escapeRegExp(functionName)}\\b`).test(source)) {
    return { ok: false, error: `${fileLabel} does not contain the function name "${functionName}". Pass the exact identifier of the function that holds the implementation.` };
  }
  return { ok: true };
}
