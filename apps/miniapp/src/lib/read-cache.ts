// Each caller scopes its in-memory cache to a login or to the public endpoints.
type Entry = { promise: Promise<unknown>; expires: number; version: number; invalidated: boolean };

const ttl = 30_000;
const day = 86_400_000;
let nextVersion = 1;

export class ReadCache {
  private entries = new Map<string, Entry>();

  version(path: string): number {
    const entry = this.entries.get(path);
    return entry && Date.now() < entry.expires ? entry.version : 0;
  }

  invalidate(matches: (path: string) => boolean) {
    for (const [path, entry] of this.entries) {
      if (matches(path)) {
        entry.invalidated = true;
        this.entries.delete(path);
      }
    }
  }

  read<T>(path: string, fetch: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(path);
    if (existing && (!existing.version || now < existing.expires)) return existing.promise as Promise<T>;

    for (const [key, entry] of this.entries) {
      if (entry.version && (entry.expires <= now || this.entries.size >= 64)) this.entries.delete(key);
    }
    const midnight = (Math.floor((now + 8 * 3_600_000) / day) + 1) * day - 8 * 3_600_000;
    const entry: Entry = { promise: Promise.resolve(), expires: 0, version: 0, invalidated: false };
    const promise = fetch().then(result => {
      // A write completed while the old read was in flight. Join its replacement, if any.
      if (entry.invalidated) return this.read(path, fetch);
      entry.version = nextVersion++;
      entry.expires = Math.min(midnight, Date.now() + ttl);
      return result;
    }).catch((error: unknown) => {
      if (this.entries.get(path) === entry) this.entries.delete(path);
      throw error;
    });
    entry.promise = promise;
    this.entries.set(path, entry);
    return promise;
  }
}
