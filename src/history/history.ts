import { type Polyhedron } from "../geometry/polyhedron";
import { type SchemeName } from "../geometry/colors";
import { type Strategy } from "../solver/solver";
import { type OpDescriptor, composeName } from "../operations/naming";

/** The view options (color scheme + regularization strategy) remembered per entry. */
export interface HistoryOptions {
  scheme: SchemeName;
  strategy: Strategy;
}

/**
 * One committed state in the edit history. The seed (root) entry has `isSeed` set and
 * uses its polyhedron name as the label; operation entries use an action label
 * ("Truncate", "Kis 1 face") with the resulting polyhedron name shown parenthetically
 * once identification finishes.
 */
export interface HistoryEntry {
  poly: Polyhedron;
  label: string;
  /** Identified name of the resulting shape (filled in after the solve). */
  name: string | null;
  /** The identified `name` when known, otherwise a name derived by prepending this
   *  operation's modifier to the nearest named ancestor ("Augmented Truncated Cube").
   *  Null while unresolved, and for invalid states. */
  displayName: string | null;
  /** The operation that produced this entry (null for the seed root). */
  op: OpDescriptor | null;
  /** True when the solver couldn't planarize this state. */
  invalid: boolean;
  isSeed: boolean;
  /** The color scheme and strategy in effect at this entry. Restored when jumping
   *  here, and changeable in place without branching. */
  options: HistoryOptions;
}

/**
 * A linear undo/redo timeline. `index` points at the current entry; entries after it
 * are the redo tail, kept until a new push overwrites them. Jumping and undo/redo only
 * move `index`; pushing a new operation truncates the tail first, so branching from an
 * earlier state discards the abandoned future.
 */
export class History {
  private entries: HistoryEntry[] = [];
  private index = -1;

  /** Begin a fresh timeline rooted at a seed. */
  reset(poly: Polyhedron, label: string, options: HistoryOptions): void {
    this.entries = [
      { poly, label, name: null, displayName: null, op: null, invalid: false, isSeed: true, options: { ...options } },
    ];
    this.index = 0;
  }

  /** Append a new operation state after the current one, dropping any redo tail.
   *  Returns the index of the new (now current) entry. */
  push(poly: Polyhedron, label: string, options: HistoryOptions, op: OpDescriptor | null): number {
    this.entries.length = this.index + 1; // discard the redo tail
    this.entries.push({
      poly, label, name: null, displayName: null, op, invalid: false, isSeed: false, options: { ...options },
    });
    this.index = this.entries.length - 1;
    return this.index;
  }

  /** Replace the whole timeline with a saved one, as the LIBRARY does when reopening a
   *  shape with its construction history. `index` becomes the current entry. */
  replaceAll(entries: HistoryEntry[], index: number): void {
    this.entries = entries;
    this.index = Math.max(0, Math.min(index, entries.length - 1));
  }

  /** Update the remembered view options on the current entry (no new entry / branch). */
  setOptions(options: HistoryOptions): void {
    const e = this.entries[this.index];
    if (e) e.options = { ...options };
  }

  /** Record the identified name / validity for an entry once known. */
  annotate(index: number, name: string | null, invalid: boolean): void {
    const e = this.entries[index];
    if (e) {
      e.name = name;
      e.invalid = invalid;
      e.displayName = composeName(this.entries, index);
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
