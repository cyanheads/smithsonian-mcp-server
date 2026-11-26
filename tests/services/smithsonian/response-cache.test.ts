/**
 * @fileoverview Tests for ResponseCache — hits, TTL, the byte budget, success-only
 * storage, and the shared load with per-caller cancellation and deadlines.
 * @module tests/services/smithsonian/response-cache.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponseCache } from '@/services/smithsonian/response-cache.js';
import type { Caller } from '@/services/smithsonian/shared-loads.js';

const TTL_MS = 60_000;

/** How long a shared load may run from its start. */
const LOAD_DEADLINE_MS = 50_000;

/** A caller cancelled through `signal`, whose deadline is `ms` from now. */
function caller(signal?: AbortSignal, ms = 120_000): Caller {
  return { signal, deadline: Date.now() + ms };
}

/** A load that answers `value` at once and counts its runs. */
function instant<T>(value: T) {
  return vi.fn(async (_signal: AbortSignal | undefined): Promise<T> => value);
}

/**
 * A load held until `resolve()` or `reject()`, that rejects with its signal's
 * reason once that signal aborts — as a real fetch does. `signals` and `deadlines`
 * hold what each run received.
 */
function held<T>(value: T) {
  const signals: Array<AbortSignal | undefined> = [];
  const deadlines: number[] = [];
  const gate = Promise.withResolvers<T>();
  const load = vi.fn(
    (signal: AbortSignal | undefined, deadline: number) =>
      new Promise<T>((resolve, reject) => {
        signals.push(signal);
        deadlines.push(deadline);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        gate.promise.then(resolve, reject);
      }),
  );
  return {
    load,
    signals,
    deadlines,
    resolve: () => gate.resolve(value),
    reject: (error: unknown) => gate.reject(error),
  };
}

/** Resolve `key` to `value` through `cache`, counting each load it costs in `loads`. */
function through(cache: ResponseCache, loads: Map<string, number>, key: string, value: string) {
  return cache.fetch(key, TTL_MS, caller(), async () => {
    loads.set(key, (loads.get(key) ?? 0) + 1);
    return value;
  });
}

/** The error code a pending call rejected with. */
async function codeOf(pending: Promise<unknown>): Promise<number | undefined> {
  return ((await pending.catch((error: unknown) => error)) as { code?: number }).code;
}

/** The rejection of a caller that stopped waiting, as `SharedLoads` and the cache raise it. */
const CANCELLED = {
  code: JsonRpcErrorCode.RequestCancelled,
  message: 'The request was cancelled before the upstream response arrived.',
};

/** The error code and message a pending call rejected with. */
async function cancellationOf(pending: Promise<unknown>) {
  const error = (await pending.catch((e: unknown) => e)) as { code?: number; message?: string };
  return { code: error.code, message: error.message };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ResponseCache', () => {
  describe('hits and expiry', () => {
    it('answers a repeated key from the first load', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const load = instant({ rows: ['a'], rowCount: 1 });

      const first = await cache.fetch('k', TTL_MS, caller(), load);
      const second = await cache.fetch('k', TTL_MS, caller(), load);

      expect(load).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ rows: ['a'], rowCount: 1 });
      expect(second).toEqual(first);
    });

    it('hands every caller its own copy — a mutation never reaches the next caller', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const load = instant({ rows: ['a'] });

      const first = await cache.fetch('k', TTL_MS, caller(), load);
      first.rows.push('mutated by the first caller');
      const second = await cache.fetch('k', TTL_MS, caller(), load);
      second.rows.length = 0;
      const third = await cache.fetch('k', TTL_MS, caller(), load);

      expect(load).toHaveBeenCalledTimes(1);
      expect(third).toEqual({ rows: ['a'] });
    });

    it('keeps keys apart', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const loads = new Map<string, number>();

      expect(await through(cache, loads, 'a', 'A')).toBe('A');
      expect(await through(cache, loads, 'b', 'B')).toBe('B');
      expect(await through(cache, loads, 'a', 'A')).toBe('A');

      expect(loads).toEqual(
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
      );
    });

    it('rejects a caller whose signal has already aborted, even when the key is stored', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const load = instant('v');
      await cache.fetch('k', TTL_MS, caller(), load);

      expect(
        await cancellationOf(cache.fetch('k', TTL_MS, caller(AbortSignal.abort()), load)),
      ).toEqual(CANCELLED);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('answers until the TTL elapses, then loads again', async () => {
      vi.useFakeTimers();
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const load = instant('v');

      await cache.fetch('k', 1000, caller(), load);
      vi.setSystemTime(Date.now() + 999);
      await cache.fetch('k', 1000, caller(), load);
      expect(load).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 1);
      await cache.fetch('k', 1000, caller(), load);
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe('byte budget', () => {
    it('evicts the least recently used entry, not the oldest stored', async () => {
      // Each value's JSON is 10 bytes ('"aaaaaaaa"'), so three fill a 30-byte budget.
      const cache = new ResponseCache(30, LOAD_DEADLINE_MS);
      const loads = new Map<string, number>();
      await through(cache, loads, 'a', 'aaaaaaaa');
      await through(cache, loads, 'b', 'bbbbbbbb');
      await through(cache, loads, 'c', 'cccccccc');
      await through(cache, loads, 'a', 'aaaaaaaa'); // a is now the most recently used

      await through(cache, loads, 'd', 'dddddddd'); // over budget: b goes

      for (const [key, value] of [
        ['a', 'aaaaaaaa'],
        ['c', 'cccccccc'],
        ['d', 'dddddddd'],
      ] as const) {
        await through(cache, loads, key, value);
      }
      expect(loads).toEqual(
        new Map([
          ['a', 1],
          ['b', 1],
          ['c', 1],
          ['d', 1],
        ]),
      );
      await through(cache, loads, 'b', 'bbbbbbbb');
      expect(loads.get('b')).toBe(2);
    });

    it('counts UTF-8 bytes, not string length', async () => {
      // '"éééé"' is 6 UTF-16 units but 10 UTF-8 bytes; '"a"' is 3. A 12-byte budget
      // holds both only if the cache counts code units.
      const cache = new ResponseCache(12, LOAD_DEADLINE_MS);
      const loads = new Map<string, number>();
      await through(cache, loads, 'accented', 'éééé');
      await through(cache, loads, 'plain', 'a');

      await through(cache, loads, 'accented', 'éééé');

      expect(loads.get('accented')).toBe(2);
    });

    it('stores an entry exactly the size of the budget', async () => {
      const cache = new ResponseCache(10, LOAD_DEADLINE_MS);
      const loads = new Map<string, number>();

      await through(cache, loads, 'k', 'aaaaaaaa'); // 10 bytes
      await through(cache, loads, 'k', 'aaaaaaaa');

      expect(loads.get('k')).toBe(1);
    });

    it('never stores an entry larger than the whole budget, and evicts nothing for it', async () => {
      const cache = new ResponseCache(10, LOAD_DEADLINE_MS);
      const loads = new Map<string, number>();
      await through(cache, loads, 'small', 'ssss'); // 6 bytes

      expect(await through(cache, loads, 'big', 'aaaaaaaaa')).toBe('aaaaaaaaa'); // 11 bytes
      await through(cache, loads, 'big', 'aaaaaaaaa');
      await through(cache, loads, 'small', 'ssss');

      expect(loads.get('big')).toBe(2);
      expect(loads.get('small')).toBe(1);
    });

    it('releases the bytes of an expired entry', async () => {
      vi.useFakeTimers();
      // Two 6-byte entries fill a 12-byte budget exactly.
      const cache = new ResponseCache(12, LOAD_DEADLINE_MS);
      const loads = new Map<string, number>();
      await through(cache, loads, 'a', 'aaaa');
      vi.setSystemTime(Date.now() + TTL_MS);

      await through(cache, loads, 'a', 'aaaa'); // expired: loaded and stored again
      await through(cache, loads, 'b', 'bbbb');
      await through(cache, loads, 'a', 'aaaa');

      expect(loads.get('a')).toBe(2);
    });

    it('replaces an entry stored late by an abandoned load without counting it twice', async () => {
      const cache = new ResponseCache(12, LOAD_DEADLINE_MS);
      const loads = new Map<string, number>();
      // A load that ignores its signal: it resolves after its only caller left.
      const late = Promise.withResolvers<string>();
      const abandoning = new AbortController();
      const abandoned = cache.fetch('a', TTL_MS, caller(abandoning.signal), () => late.promise);
      abandoning.abort();
      expect(await codeOf(abandoned)).toBe(JsonRpcErrorCode.RequestCancelled);

      await through(cache, loads, 'a', 'aaaa'); // a fresh load stores 6 bytes
      late.resolve('zzzz'); // the late success replaces it
      await late.promise;
      await through(cache, loads, 'b', 'bbbb'); // fits only if 'a' counts 6 bytes once

      expect(await through(cache, loads, 'a', 'aaaa')).toBe('zzzz');
      expect(loads.get('a')).toBe(1);
    });
  });

  describe('success only', () => {
    it('stores nothing when the load rejects, and rejects the caller with its error', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const failure = serviceUnavailable('upstream down');
      const failing = vi.fn(async () => {
        throw failure;
      });
      const load = instant('v');

      await expect(cache.fetch('k', TTL_MS, caller(), failing)).rejects.toBe(failure);
      await cache.fetch('k', TTL_MS, caller(), load);
      await cache.fetch('k', TTL_MS, caller(), load);

      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe('shared loads', () => {
    it('runs one load for concurrent callers of a key, on its own signal', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held('v');
      const callers = [new AbortController(), new AbortController()];

      const pending = callers.map((c) => cache.fetch('k', TTL_MS, caller(c.signal), run.load));
      run.resolve();

      expect(await Promise.all(pending)).toEqual(['v', 'v']);
      expect(run.load).toHaveBeenCalledTimes(1);
      expect(run.signals[0]).toBeInstanceOf(AbortSignal);
      for (const c of callers) expect(run.signals[0]).not.toBe(c.signal);
    });

    it('rejects every waiter with a failed load, and stores nothing', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held('v');
      const failure = serviceUnavailable('upstream down');

      const first = cache.fetch('k', TTL_MS, caller(), run.load);
      const second = cache.fetch('k', TTL_MS, caller(), run.load);
      run.reject(failure);

      await expect(first).rejects.toBe(failure);
      await expect(second).rejects.toBe(failure);
      const next = instant('v');
      await cache.fetch('k', TTL_MS, caller(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects a cancelled waiter alone; the other receives the value, which is stored', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held({ title: 'kept' });
      const leaving = new AbortController();

      const cancelled = cache.fetch('k', TTL_MS, caller(leaving.signal), run.load);
      const staying = cache.fetch('k', TTL_MS, caller(), run.load);
      leaving.abort();

      expect(await cancellationOf(cancelled)).toEqual(CANCELLED);
      expect(run.signals[0]?.aborted).toBe(false);
      run.resolve();
      expect(await staying).toEqual({ title: 'kept' });
      expect(await cache.fetch('k', TTL_MS, caller(), run.load)).toEqual({ title: 'kept' });
      expect(run.load).toHaveBeenCalledTimes(1);
    });

    it('stores before any waiter resumes, so a waiter mutating its result changes nothing stored', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held({ rows: ['a'] });

      const pending = cache.fetch('k', TTL_MS, caller(), run.load);
      run.resolve();
      (await pending).rows.push('mutated');

      expect(await cache.fetch('k', TTL_MS, caller(), run.load)).toEqual({ rows: ['a'] });
    });

    it('aborts the load once the last waiter leaves, and the next caller starts a fresh one', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const first = held('v');
      const a = new AbortController();
      const b = new AbortController();

      const callA = cache.fetch('k', TTL_MS, caller(a.signal), first.load);
      const callB = cache.fetch('k', TTL_MS, caller(b.signal), first.load);
      a.abort();
      expect(first.signals[0]?.aborted).toBe(false);
      b.abort();
      expect(first.signals[0]?.aborted).toBe(true);
      expect(await codeOf(callA)).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(await codeOf(callB)).toBe(JsonRpcErrorCode.RequestCancelled);

      const second = held('v');
      const fresh = cache.fetch('k', TTL_MS, caller(), second.load);
      second.resolve();
      expect(await fresh).toBe('v');
      expect(second.load).toHaveBeenCalledTimes(1);
      expect(second.signals[0]?.aborted).toBe(false);
    });

    it('rejects a caller whose signal is already aborted without starting a load', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const load = instant('v');

      expect(await codeOf(cache.fetch('k', TTL_MS, caller(AbortSignal.abort()), load))).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
      expect(load).not.toHaveBeenCalled();
    });
  });

  describe('with a TTL of 0', () => {
    it("loads on every call, each on the caller's own signal and deadline, sharing and storing nothing", async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held('v');
      const callers = [caller(new AbortController().signal, 5_000), caller(undefined, 9_000)];

      const pending = callers.map((c) => cache.fetch('k', 0, c, run.load));
      run.resolve();
      await Promise.all(pending);
      const load = instant('v');
      await cache.fetch('k', 0, caller(), load);

      expect(run.load).toHaveBeenCalledTimes(2);
      expect(run.signals).toEqual(callers.map((c) => c.signal));
      expect(run.deadlines).toEqual(callers.map((c) => c.deadline));
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('leaves cancellation and the deadline to the load — the cache adds no rejection of its own', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const load = instant('v');

      expect(await cache.fetch('k', 0, caller(AbortSignal.abort(), 0), load)).toBe('v');
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe('caller deadlines (issue #68)', () => {
    /** The error code and reason a pending call rejected with. */
    async function failureOf(pending: Promise<unknown>) {
      const error = (await pending.catch((e: unknown) => e)) as {
        code?: number;
        data?: { reason?: string };
      };
      return { code: error.code, reason: error.data?.reason };
    }

    const EXPIRED = { code: JsonRpcErrorCode.Timeout, reason: 'retry_deadline_exceeded' };

    it('rejects a waiter Timeout alone at its deadline; the other receives the value, from one load', async () => {
      vi.useFakeTimers();
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held({ title: 'kept' });

      const early = cache.fetch('k', TTL_MS, caller(undefined, 5_000), run.load);
      const late = cache.fetch('k', TTL_MS, caller(undefined, 50_000), run.load);
      const failed = failureOf(early);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await failed).toEqual(EXPIRED);
      expect(run.signals[0]?.aborted).toBe(false);
      run.resolve();
      expect(await late).toEqual({ title: 'kept' });
      expect(run.load).toHaveBeenCalledTimes(1);
    });

    it("aborts the load at the last waiter's deadline, and the next caller starts a fresh one", async () => {
      vi.useFakeTimers();
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const first = held('v');

      const a = failureOf(cache.fetch('k', TTL_MS, caller(undefined, 5_000), first.load));
      const b = failureOf(cache.fetch('k', TTL_MS, caller(undefined, 8_000), first.load));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await a).toEqual(EXPIRED);
      expect(first.signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await b).toEqual(EXPIRED);
      expect(first.signals[0]?.aborted).toBe(true);

      const second = held('v');
      const fresh = cache.fetch('k', TTL_MS, caller(), second.load);
      second.resolve();
      expect(await fresh).toBe('v');
      expect(second.load).toHaveBeenCalledTimes(1);
    });

    it('runs a shared load on its own deadline, not the deadline of the caller that started it', async () => {
      vi.useFakeTimers();
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held('v');
      const startedAt = Date.now();

      const pending = cache.fetch('k', TTL_MS, caller(undefined, 2_000), run.load);
      run.resolve();
      await pending;

      expect(run.deadlines).toEqual([startedAt + LOAD_DEADLINE_MS]);
    });

    it.each([
      ['starts no load', false],
      ['joins no load in progress', true],
    ])('rejects a caller with no time left Timeout: it %s', async (_label, inProgress) => {
      vi.useFakeTimers();
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held('v');
      const waiting = inProgress ? cache.fetch('k', TTL_MS, caller(), run.load) : undefined;

      expect(await failureOf(cache.fetch('k', TTL_MS, caller(undefined, 0), run.load))).toEqual(
        EXPIRED,
      );
      expect(run.load).toHaveBeenCalledTimes(inProgress ? 1 : 0);
      if (!waiting) return;
      run.resolve();
      expect(await waiting).toBe('v');
    });

    it('answers a caller with no time left from a stored entry', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const load = instant('v');
      await cache.fetch('k', TTL_MS, caller(), load);

      expect(await cache.fetch('k', TTL_MS, caller(undefined, 0), load)).toBe('v');
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('rejects RequestCancelled, not Timeout, when the signal has aborted and the deadline passed', async () => {
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);

      expect(
        await failureOf(cache.fetch('k', TTL_MS, caller(AbortSignal.abort(), 0), instant('v'))),
      ).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });

    it.each([
      ['receives its value', (run: ReturnType<typeof held>) => run.resolve()],
      ['receives the load failure', (run: ReturnType<typeof held>) => run.reject(new Error('x'))],
      [
        'is cancelled',
        (_run: ReturnType<typeof held>, leaving: AbortController) => leaving.abort(),
      ],
    ])('leaves no deadline timer behind once the waiter %s', async (_label, settle) => {
      vi.useFakeTimers();
      const cache = new ResponseCache(1024, LOAD_DEADLINE_MS);
      const run = held('v');
      const leaving = new AbortController();

      const pending = cache.fetch('k', TTL_MS, caller(leaving.signal), run.load).catch(() => {});
      expect(vi.getTimerCount()).toBe(1);
      settle(run, leaving);
      await pending;

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
