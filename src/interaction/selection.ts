import { type MarkerKind } from "../render/sceneView";

/**
 * Multi-select state for Cmd/Ctrl picking. A selection is homogeneous: it holds
 * either vertices or faces (toggling the other kind clears the first), since the
 * two drag operations act on one element type at a time.
 */
export class Selection {
  kind: MarkerKind | null = null;
  ids = new Set<number>();

  toggle(kind: MarkerKind, id: number): void {
    if (this.kind !== kind) {
      this.kind = kind;
      this.ids.clear();
    }
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    if (this.ids.size === 0) this.kind = null;
  }

  /** Ensure `id` is in the selection (switching kind if needed); never removes. */
  add(kind: MarkerKind, id: number): void {
    if (this.kind !== kind) {
      this.kind = kind;
      this.ids.clear();
    }
    this.ids.add(id);
  }

  clear(): void {
    this.kind = null;
    this.ids.clear();
  }

  /** The active set for a drag of the given kind (null = "affect everything"). */
  setFor(kind: MarkerKind): Set<number> | null {
    if (this.kind === kind && this.ids.size > 0) return new Set(this.ids);
    return null;
  }

  isSelected(kind: MarkerKind, id: number): boolean {
    return this.kind === kind && this.ids.has(id);
  }
}
