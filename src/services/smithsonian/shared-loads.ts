/**
 * @fileoverview One shared load per key across concurrent callers, each of whom waits on
 * its own cancellation signal and its own deadline.
 * @module services/smithsonian/shared-loads
 */

import { requestCancelled, timeout } from '@cyanheads/mcp-ts-core/errors';

/** The caller a load answers: how it is cancelled, and when it stops waiting. */
export interface Caller {
  /** Epoch milliseconds after which the caller has no time left for this value. */
  deadline: number;
  signal: AbortSignal | undefined;
}

/**
 * Produces the value for one key, finishing by `deadline` (epoch milliseconds). A shared
 * load runs on the signal and deadline {@link SharedLoads} gives it, never a caller's.
 */
export type Load<T> = (signal: AbortSignal | undefined, deadline: number) => Promise<T>;

/** One load in progress, shared by every caller of its key. */
interface Flight {
  controller: AbortController;
  promise: Promise<unknown>;
  /** Callers still waiting. The load is aborted when this reaches 0. */
  waiters: number;
}

/**
 * Runs one load per key for every concurrent caller of the key. A load runs on a
 * controller this owns, with a deadline `loadDeadlineMs` after its start: it outlives the
 * caller that started it whenever another caller is still waiting, so it takes neither
 * that caller's signal nor its deadline.
 *
 * Each caller waits on its own signal and its own remaining time, and rejects alone when
 * either ends first. The load is aborted the moment its last caller leaves, and the key is
 * free for a fresh load from then on. A load that rejects rejects every caller still
 * waiting, with the same error. Whatever the load must leave behind (a stored entry) it
 * does before it resolves, so no caller resumes ahead of it.
 */
export class SharedLoads {
  private readonly flights = new Map<string, Flight>();
  private readonly loadDeadlineMs: number;

  /** @param loadDeadlineMs How long a shared load may run, from its start. */
  constructor(loadDeadlineMs: number) {
    this.loadDeadlineMs = loadDeadlineMs;
  }

  /** Whether a load for `key` is in progress, with a caller still waiting on it. */
  has(key: string): boolean {
    return this.flights.has(key);
  }

  /**
   * Join the load in progress for `key`, or start one with `load`. A caller whose signal
   * has already aborted, or who has no time left, starts and joins nothing.
   *
   * @throws McpError `RequestCancelled` when the caller's signal aborts before the value
   *   arrives, and `Timeout` (`reason: 'retry_deadline_exceeded'`) when its deadline does;
   *   otherwise whatever the load rejects with.
   */
  async run<T>(key: string, caller: Caller, load: Load<T>): Promise<T> {
    if (caller.signal?.aborted) throw cancelled();
    const remainingMs = caller.deadline - Date.now();
    if (remainingMs <= 0) throw expired();
    const flight = this.flights.get(key) ?? this.start(key, load);
    return (await this.wait(key, flight, caller.signal, remainingMs)) as T;
  }

  private start<T>(key: string, load: Load<T>): Flight {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      waiters: 0,
      promise: load(controller.signal, Date.now() + this.loadDeadlineMs).finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }),
    };
    this.flights.set(key, flight);
    return flight;
  }

  /**
   * Wait on `flight` until it settles, `signal` aborts, or `remainingMs` runs out —
   * whichever comes first ends the wait and disarms the other two. Every waiter attaches
   * its own handlers to the shared promise, so the load's rejection is always handled,
   * including after the last waiter has left.
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
}

/** The rejection for a caller that stopped waiting — the code an unshared cancelled fetch raises. */
export function cancelled() {
  return requestCancelled('The request was cancelled before the upstream response arrived.');
}

/**
 * The rejection for a caller whose deadline passed — the code and reason an unshared read
 * cut by its retry deadline raises, so a caller matches one shape for both.
 */
function expired() {
  return timeout("The upstream response did not arrive before the call's deadline.", {
    reason: 'retry_deadline_exceeded',
  });
}
