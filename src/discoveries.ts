import { config } from "./config";

/**
 * Which named shapes the user has made for the first time. The set is pre-seeded with
 * `config.discovery.preDiscovered`, the shapes the boot story says you start with, and
 * when `config.discovery.persist` is on it is restored from and saved to localStorage
 * so discoveries survive a reload.
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

  /** Total shapes known, pre-discovered and made, for the N/99 readout. */
  get count(): number {
    return this.set.size;
  }

  /** Every known shape name, for the LIBRARY browse diagram, which uses it to decide
   *  which nodes render in color. */
  snapshot(): string[] {
    return [...this.set];
  }

  /**
   * Record a discovery. Returns `isNew` (false if already known or pre-discovered) and
   * `first` (true only for the run's first real discovery, which is celebrated harder).
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
