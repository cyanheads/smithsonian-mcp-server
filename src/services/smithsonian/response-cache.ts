/**
 * @fileoverview Bounded in-process cache for upstream responses, with one shared
 * fetch per key across concurrent callers.
 * @module services/smithsonian/response-cache
 */

import { type Caller, cancelled, type Load, SharedLoads } from './shared-loads.js';

interface Entry {
  /** UTF-8 length of `json`, the unit of the byte budget. */
  bytes: number;
  /** Epoch milliseconds at which the entry stops answering. */
  expiresAt: number;
  json: string;
}

const encoder = new TextEncoder();

/**
 * Response cache keyed by request URL. Entries are stored as JSON text under one
 * byte budget, counted as UTF-8, and evicted least recently used first.
 *
 * Holding text rather than the value means every hit is a fresh parse, so no
 * caller can mutate what another receives, and the budget counts exactly what is
 * held.
 */
export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private readonly loads: SharedLoads;
  private readonly maxBytes: number;
  private storedBytes = 0;

  /**
   * @param maxBytes The byte budget of stored entries.
   * @param loadDeadlineMs How long a shared load may run, from its start. Its own, because
   *   it outlives the caller that started it whenever another caller is still waiting.
   */
  constructor(maxBytes: number, loadDeadlineMs: number) {
    this.maxBytes = maxBytes;
    this.loads = new SharedLoads(loadDeadlineMs);
  }

  /**
   * Resolve `key` from a stored entry younger than `ttlMs`, or by `load`, which
   * runs once for every concurrent caller of the key. `load` resolves only with a
   * validated success: the cache keeps whatever it resolves.
   *
   * A `ttlMs` of 0 bypasses the cache: `load` runs on the caller's own signal and
   * deadline, unshared and unstored. Otherwise a miss joins the key's load in progress
   * or starts one through {@link SharedLoads}, on a controller the cache owns, with a
   * deadline `loadDeadlineMs` after its start, never on a caller's signal or deadline. A
   * caller whose signal aborts, or whose deadline passes, rejects alone, and the load is
   * aborted once no caller is left waiting on it. A caller with no time left starts and
   * joins nothing. A load that rejects rejects every waiter and stores nothing; one that
   * resolves is stored when its JSON fits the budget, before any waiter's continuation
   * runs, so no caller can mutate it first. A stored entry answers any caller whose
   * signal has not aborted, deadline or not: it costs nothing.
   *
   * @throws McpError `RequestCancelled` when the caller's signal aborts before the value
   *   arrives, and `Timeout` (`reason: 'retry_deadline_exceeded'`) when its deadline does.
   */
  async fetch<T>(key: string, ttlMs: number, caller: Caller, load: Load<T>): Promise<T> {
    if (ttlMs === 0) return await load(caller.signal, caller.deadline);
    if (caller.signal?.aborted) throw cancelled();

    const json = this.read(key);
    if (json !== undefined) return JSON.parse(json) as T;

    return await this.loads.run(key, caller, async (signal, deadline) => {
      const value = await load(signal, deadline);
      this.store(key, JSON.stringify(value), ttlMs);
      return value;
    });
  }

  /** The stored JSON for `key`, refreshed as most recently used, or undefined when absent or expired. */
  private read(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Map order is insertion order: re-inserting moves the key to the most recently used end.
    this.entries.delete(key);
    if (Date.now() >= entry.expiresAt) {
      this.storedBytes -= entry.bytes;
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.json;
  }

  /**
   * Store `json` under `key`, evicting least recently used entries until it fits.
   * An entry larger than the whole budget is not stored and evicts nothing.
   */
  private store(key: string, json: string, ttlMs: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.storedBytes -= previous.bytes;
    }
    const bytes = encoder.encode(json).byteLength;
    if (bytes > this.maxBytes) return;
    for (const [oldest, entry] of this.entries) {
      if (this.storedBytes + bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.storedBytes -= entry.bytes;
    }
    this.entries.set(key, { bytes, expiresAt: Date.now() + ttlMs, json });
    this.storedBytes += bytes;
  }
}
