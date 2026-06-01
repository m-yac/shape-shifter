import { config } from "./config";

/**
 * Tracks which named shapes the user has MADE for the first time. The set is
 * pre-seeded with `config.discovery.preDiscovered` (the shapes the boot story
 * says you start with) and, when `config.discovery.persist` is on, restored
 * from / saved to localStorage so discoveries survive a reload.
 *
 * `add` returns whether the name was new and whether it was the very first real
 * discovery of the run (so the celebration can be made extra strong).
 */
export class Discoveries {
  private readonly set = new Set<string>();
  private realCount = 0; // discoveries beyond the pre-discovered starters

  constructor() {
    for (const n of config.discovery.preDiscovered) this.set.add(n);
    if (config.discovery.persist) {
      try {
        const raw = localStorage.getItem(config.discovery.storageKey);
        if (raw) {
          for (const n of JSON.parse(raw) as string[]) {
            if (!this.set.has(n)) this.realCount++;
            this.set.add(n);
          }
        }
      } catch {
        /* corrupt / unavailable storage: just start fresh */
      }
    }
  }

  has(name: string): boolean {
    return this.set.has(name);
  }

  /** Total shapes known (pre-discovered + made), for the "N/250" readout. */
  get count(): number {
    return this.set.size;
  }

  /**
   * Record a (possibly new) discovery. Returns `isNew` (false if already known
   * or pre-discovered) and `first` (true only for the first real discovery).
   */
  add(name: string): { isNew: boolean; first: boolean } {
    if (this.set.has(name)) return { isNew: false, first: false };
    const first = this.realCount === 0;
    this.set.add(name);
    this.realCount++;
    this.persist();
    return { isNew: true, first };
  }

  private persist(): void {
    if (!config.discovery.persist) return;
    try {
      localStorage.setItem(config.discovery.storageKey, JSON.stringify([...this.set]));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }
}
