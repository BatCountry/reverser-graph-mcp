import { randomBytes } from "node:crypto";

// Process-wide TTL cache for query results that are offered to clients as resource handles.
// McpServer instances are created per connection by serveStdio, so state lives at module level.

export interface CachedDocument {
  title: string;
  description: string;
  mimeType: string;
  text: string;
}

interface Slot {
  doc: CachedDocument;
  expiresAt: number;
  ttlMs: number;
}

/** Cheap, easily recomputed lookups. */
export const TTL_SHORT_MS = 10 * 60_000;
/** Expensive walks/traces and anything a slow client is likely to come back to. */
export const TTL_LONG_MS = 60 * 60_000;

export class TtlCache {
  private slots = new Map<string, Slot>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 2000,
  ) {}

  /** Store a document and return its opaque handle. Re-putting identical `key` refreshes the TTL. */
  put(doc: CachedDocument, ttlMs: number, key?: string): string {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`ttlMs must be a positive finite number, got ${ttlMs}`);
    this.sweep();
    const handle = key ?? randomBytes(6).toString("hex");
    this.slots.set(handle, { doc, ttlMs, expiresAt: this.now() + ttlMs });
    while (this.slots.size > this.maxEntries) {
      // Map iterates in insertion order: evict oldest first.
      const oldest = this.slots.keys().next();
      if (oldest.done) break;
      this.slots.delete(oldest.value);
    }
    return handle;
  }

  /** Returns undefined if unknown or expired. A hit slides the expiry forward by the original TTL. */
  get(handle: string): CachedDocument | undefined {
    const slot = this.slots.get(handle);
    if (!slot) return undefined;
    const t = this.now();
    if (slot.expiresAt <= t) {
      this.slots.delete(handle);
      return undefined;
    }
    slot.expiresAt = t + slot.ttlMs;
    return slot.doc;
  }

  get size(): number {
    this.sweep();
    return this.slots.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, s] of this.slots) if (s.expiresAt <= t) this.slots.delete(k);
  }
}

export const queryCache = new TtlCache();
