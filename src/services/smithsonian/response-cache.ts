/**
 * @fileoverview Bounded in-process cache for upstream responses, with one shared
 * fetch per key across concurrent callers.
 * @module services/smithsonian/response-cache
 */

import { requestCancelled, timeout } from '@cyanheads/mcp-ts-core/errors';

/** What a load hands back: the value its callers receive, and whether it may be stored. */
export interface Loaded<T> {
  /**
   * False for an answer that is not a validated success. Every caller waiting on
   * the load still receives it; the cache does not keep it.
   */
  storable: boolean;
  value: T;
}

/** The caller a fetch answers: how it is cancelled, and when it stops waiting. */
export interface Caller {
  /** Epoch milliseconds after which the caller has no time left for this value. */
  deadline: number;
  signal: AbortSignal | undefined;
}

/**
 * Fetches the value for one key, finishing by `deadline` (epoch milliseconds). Runs on
 * the cache's own signal and its own load deadline while the cache is on, and on the
 * caller's signal and deadline when it is off.
 */
export type Load<T> = (signal: AbortSignal | undefined, deadline: number) => Promise<Loaded<T>>;

interface Entry {
  /** UTF-8 length of `json`, the unit of the byte budget. */
  bytes: number;
  /** Epoch milliseconds at which the entry stops answering. */
  expiresAt: number;
  json: string;
}

/** One load in progress, shared by every caller of its key. */
interface Flight {
  controller: AbortController;
  promise: Promise<unknown>;
  /** Callers still waiting. The load is aborted when this reaches 0. */
  waiters: number;
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
  private readonly flights = new Map<string, Flight>();
  private readonly loadDeadlineMs: number;
  private readonly maxBytes: number;
  private storedBytes = 0;

  /**
   * @param maxBytes The byte budget of stored entries.
   * @param loadDeadlineMs How long a shared load may run, from its start. Its own, because
   *   it outlives the caller that started it whenever another caller is still waiting.
   */
  constructor(maxBytes: number, loadDeadlineMs: number) {
    this.maxBytes = maxBytes;
    this.loadDeadlineMs = loadDeadlineMs;
  }

  /**
   * Resolve `key` from a stored entry younger than `ttlMs`, or by `load`, which
   * runs once for every concurrent caller of the key.
   *
   * A `ttlMs` of 0 bypasses the cache: `load` runs on the caller's own signal and
   * deadline, unshared and unstored. Otherwise a miss joins the key's load in progress
   * or starts one on a controller the cache owns, with a deadline `loadDeadlineMs` after
   * its start, never on a caller's signal or deadline. A caller whose signal
   * aborts, or whose deadline passes, rejects alone, and the load is aborted once no
   * caller is left waiting on it. A caller with no time left starts and joins nothing.
   * A load that rejects rejects every waiter and stores nothing; one that resolves is
   * stored when it is `storable` and its JSON fits the budget. A stored entry answers
   * any caller whose signal has not aborted, deadline or not: it costs nothing.
   *
   * @throws McpError `RequestCancelled` when the caller's signal aborts before the value
   *   arrives, and `Timeout` (`reason: 'retry_deadline_exceeded'`) when its deadline does.
   */
  async fetch<T>(key: string, ttlMs: number, caller: Caller, load: Load<T>): Promise<T> {
    if (ttlMs === 0) return (await load(caller.signal, caller.deadline)).value;
    if (caller.signal?.aborted) throw cancelled();

    const json = this.read(key);
    if (json !== undefined) return JSON.parse(json) as T;

    const remainingMs = caller.deadline - Date.now();
    if (remainingMs <= 0) throw expired();
    const flight = this.flights.get(key) ?? this.start(key, ttlMs, load);
    return (await this.wait(key, flight, caller.signal, remainingMs)) as T;
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
   * Start the shared load for `key`. A storable value is serialized into the cache
   * before any waiter's continuation runs, so no caller can mutate it first.
   */
  private start<T>(key: string, ttlMs: number, load: Load<T>): Flight {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      waiters: 0,
      promise: load(controller.signal, Date.now() + this.loadDeadlineMs)
        .then(({ storable, value }) => {
          if (storable) this.store(key, JSON.stringify(value), ttlMs);
          return value;
        })
        .finally(() => {
          if (this.flights.get(key) === flight) this.flights.delete(key);
        }),
    };
    this.flights.set(key, flight);
    return flight;
  }

  /**
   * Wait on `flight` until it settles, `signal` aborts, or `remainingMs` runs out —
   * whichever comes first ends the wait and disarms the other two. Every waiter
   * attaches its own handlers to the shared promise, so the load's rejection is always
   * handled, including after the last waiter has left.
   */
  private wait(
    key: string,
    flight: Flight,
    signal: AbortSignal | undefined,
    remainingMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      flight.waiters++;
      const stopWaiting = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const leave = (error: unknown) => {
        stopWaiting();
        flight.waiters--;
        reject(error);
        if (flight.waiters > 0) return;
        flight.controller.abort();
        // A caller arriving after this starts a fresh load rather than joining an aborted one.
        if (this.flights.get(key) === flight) this.flights.delete(key);
      };
      const onAbort = () => leave(cancelled());
      const timer = setTimeout(() => leave(expired()), remainingMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(
        (value) => {
          stopWaiting();
          resolve(value);
        },
        (error: unknown) => {
          stopWaiting();
          reject(error);
        },
      );
    });
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

/** The rejection for a caller that stopped waiting — the code an uncached cancelled fetch raises. */
function cancelled() {
  return requestCancelled('The request was cancelled before the upstream response arrived.');
}

/**
 * The rejection for a caller whose deadline passed — the code and reason an uncached read
 * cut by its retry deadline raises, so a caller matches one shape for both.
 */
function expired() {
  return timeout("The upstream response did not arrive before the call's deadline.", {
    reason: 'retry_deadline_exceeded',
  });
}
