import { type Polyhedron } from "../geometry/polyhedron";

/**
 * One committed state in the edit history. The seed (root) entry has `isSeed`
 * set and uses its polyhedron name directly as the label; operation entries use
 * an action label (e.g. "Truncate", "Kis 1 face") with the resulting polyhedron
 * name shown parenthetically once identification finishes.
 */
export interface HistoryEntry {
  poly: Polyhedron;
  label: string;
  /** Identified name of the resulting shape (filled in after the solve). */
  name: string | null;
  /** True when the solver couldn't planarize this state. */
  invalid: boolean;
  isSeed: boolean;
}

/**
 * A linear undo/redo timeline. `index` points at the current entry; entries
 * after it are the "redo" tail (kept until a new push overwrites them). Jumping
 * or undoing/redoing only moves `index`; pushing a new operation truncates the
 * tail first, so branching from an earlier state discards the abandoned future.
 */
export class History {
  private entries: HistoryEntry[] = [];
  private index = -1;

  /** Begin a fresh timeline rooted at a seed. */
  reset(poly: Polyhedron, label: string): void {
    this.entries = [{ poly, label, name: null, invalid: false, isSeed: true }];
    this.index = 0;
  }

  /** Append a new operation state after the current one, dropping any redo tail.
   *  Returns the index of the new (now current) entry. */
  push(poly: Polyhedron, label: string): number {
    this.entries.length = this.index + 1; // discard the redo tail
    this.entries.push({ poly, label, name: null, invalid: false, isSeed: false });
    this.index = this.entries.length - 1;
    return this.index;
  }

  /** Record the identified name / validity for an entry once known. */
  annotate(index: number, name: string | null, invalid: boolean): void {
    const e = this.entries[index];
    if (e) {
      e.name = name;
      e.invalid = invalid;
    }
  }

  /** Move to an arbitrary entry; returns it (or null if out of range). */
  jumpTo(index: number): HistoryEntry | null {
    if (index < 0 || index >= this.entries.length) return null;
    this.index = index;
    return this.entries[index];
  }

  undo(): HistoryEntry | null {
    return this.canUndo ? this.jumpTo(this.index - 1) : null;
  }

  redo(): HistoryEntry | null {
    return this.canRedo ? this.jumpTo(this.index + 1) : null;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  get current(): number {
    return this.index;
  }

  get list(): readonly HistoryEntry[] {
    return this.entries;
  }
}
