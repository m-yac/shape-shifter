import { type MarkerKind } from "../render/sceneView";
import { Readout } from "../ui/readout";

/**
 * Multi-select state for Cmd/Ctrl picking. A selection is homogeneous: it holds
 * either vertices or faces (toggling the other kind clears the first), since the
 * two drag operations act on one element type at a time.
 */
export class Selection {
  readout: Readout | null = null;
  kind: MarkerKind | null = null;
  ids = new Set<number>();

  constructor(readout: Readout | null = null) {
    this.readout = readout
  }

  toggle(kind: MarkerKind, id: number): void {
    if (this.kind !== kind) {
      this.kind = kind;
      this.ids.clear();
    }
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    if (this.ids.size === 0) this.kind = null;
    if (this.readout) {
      this.readout.updateSelection(this.ids, this.kind);
    }
  }

  /** Ensure `id` is in the selection (switching kind if needed); never removes. */
  add(kind: MarkerKind, id: number): void {
    if (this.kind !== kind) {
      this.kind = kind;
      this.ids.clear();
    }
    this.ids.add(id);
    if (this.readout) {
      this.readout.updateSelection(this.ids, this.kind);
    }
  }

  /** Union `ids` into the selection (switching kind if needed); never removes.
   *  Used by the Option gesture to accumulate whole arity groups across arities. */
  addAll(kind: MarkerKind, ids: Set<number>): void {
    if (ids.size === 0) return;
    if (this.kind !== kind) {
      this.kind = kind;
      this.ids.clear();
    }
    for (const id of ids) this.ids.add(id);
    if (this.readout) {
      this.readout.updateSelection(this.ids, this.kind);
    }
  }

  clear(): void {
    this.kind = null;
    this.ids.clear();
    if (this.readout) {
      this.readout.updateSelection(new Set(), null);
    }
  }

  /** Replace the whole selection with `ids` of `kind` (an empty set / null kind
   *  clears it). Used to select an entire arity group at once, and to restore a
   *  snapshot when an aimless multi-drag commits nothing. */
  replace(kind: MarkerKind | null, ids: Set<number>): void {
    if (!kind || ids.size === 0) {
      this.kind = null;
      this.ids = new Set();
    } else {
      this.kind = kind;
      this.ids = new Set(ids);
    }
    if (this.readout) {
      this.readout.updateSelection(this.ids, this.kind);
    }
  }

  /** The active set for a drag of the given kind; null means affect every element. */
  setFor(kind: MarkerKind): Set<number> | null {
    if (this.kind === kind && this.ids.size > 0) return new Set(this.ids);
    return null;
  }

  isSelected(kind: MarkerKind, id: number): boolean {
    return this.kind === kind && this.ids.has(id);
  }
}
