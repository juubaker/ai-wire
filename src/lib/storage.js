/**
 * The wire keeps its entries on the machine that reads it, so reopening the tab
 * picks up where you left off instead of resetting to the seed list.
 *
 * Same shape as the sandboxed storage API the prototype used, so the component
 * doesn't care which one it's talking to.
 */
const PREFIX = "wire:";

export const storage = {
  async get(key) {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) throw new Error(`no entry for ${key}`);
    return { key, value: raw };
  },
  async set(key, value) {
    window.localStorage.setItem(PREFIX + key, value);
    return { key, value };
  },
  async delete(key) {
    window.localStorage.removeItem(PREFIX + key);
    return { key, deleted: true };
  },
  async list(prefix = "") {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
    }
    return { keys, prefix };
  },
};
