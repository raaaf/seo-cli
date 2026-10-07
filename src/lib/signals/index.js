import { getFresh, putSignal } from './store.js';

// Adapter: { name, ttlDays, validate(value), fetch(key, ctx) }. A fresh,
// well-formed cache entry is returned without calling the adapter; an adapter
// error is thrown to the caller.
export async function fetchSignal(adapter, key, ctx = {}) {
  const cached = getFresh(adapter.name, key, adapter.ttlDays, new Date(), { validate: adapter.validate });
  if (cached) return cached;
  const value = await adapter.fetch(key, ctx);
  // A failed cache write must not throw away a value that was already paid for.
  try {
    putSignal(adapter.name, key, value, new Date(), { ttlDays: adapter.ttlDays });
  } catch (e) {
    console.warn(`Signal ${adapter.name} could not be cached (${e.message}), continuing with the fetched value`);
  }
  return value;
}
