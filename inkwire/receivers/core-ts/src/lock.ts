const tails = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every earlier call with the same `key` has finished, so a read-check-write (an
 * If-Match test, a slug check) cannot interleave with another write in this process. One process
 * only: a store shared by several processes needs its own conditional write.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
