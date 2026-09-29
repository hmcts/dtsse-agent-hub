export interface SharedLoadOptions {
  /** How long a settled load keeps answering after it resolves. */
  ttlMs: number;
  now?: () => number;
}

interface Entry<V> {
  promise: Promise<V>;
  /** `undefined` while the load is in flight. */
  expiresAt: number | undefined;
}

/**
 * One load per key for every caller that asks while it is in flight or within `ttlMs` of it resolving. Every open
 * stream in a pod handles each hub event on its own chain, so the callers for one event arrive spread out rather than
 * together; the TTL is what lets a stream still busy with an earlier event reuse the load. A rejected load is
 * forgotten at once, so the next caller retries.
 */
export function sharedLoads<K, V>(load: (key: K) => Promise<V>, { ttlMs, now = Date.now }: SharedLoadOptions): (key: K) => Promise<V> {
  const entries = new Map<K, Entry<V>>();

  function sweep(at: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= at) {
        entries.delete(key);
      }
    }
  }

  return (key) => {
    sweep(now());
    const cached = entries.get(key);
    if (cached !== undefined) {
      return cached.promise;
    }
    const entry: Entry<V> = { promise: load(key), expiresAt: undefined };
    entries.set(key, entry);
    entry.promise.then(
      () => {
        entry.expiresAt = now() + ttlMs;
      },
      () => {
        entries.delete(key);
      }
    );
    return entry.promise;
  };
}
