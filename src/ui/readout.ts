import { type Signature, describeSignature } from "../identify/configurations";
import { type MarkerKind } from "../render/sceneView";
import { type OperationKind } from "../operations/types";
import { config } from "../config";
import { Polyhedron } from "../geometry/polyhedron";
import { canSnub } from "../operations/snub";
import { canGyro } from "../operations/gyro";
import { Screen, Popup, fadeIn } from "./screen";

// Columns by which the wrapped (continuation) lines of a readout box hang-indent.
// A long faces/vertices configuration list that overflows the screen wraps and
// the continuation lines sit indented under their label. Whole cells keep the
// indent on the character grid (see setupWrap below).
const READOUT_INDENT_COLS = 2;

/** "vertex"/"vertices" or "face"/"faces" agreeing with `n`. */
function plural(element: "vertex" | "face", n: number): string {
  if (n === 1) return element;
  return element === "vertex" ? "vertices" : "faces";
}

/** Whether two id sets hold exactly the same members. */
function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * The present-participle verb shown while a drag is in progress, keyed by the
 * operation and whether the drag has reached its welded max end. Snub/gyro read
 * the same regardless of weld.
 */
const DRAG_VERB: Record<OperationKind, [unwelded: string, welded: string]> = {
  truncate: ["Truncating", "Rectifying"],
  kis: ["Kis-ing", "Joining"],
  snub: ["Partially Snubbing", "Snubbing"],
  gyro: ["Partially Gyro-ing", "Gyro-ing"],
};

/**
 * Minimal bottom-left text overlay: the polyhedron's name, a ✓ when verified by
 * isomorphism, validity, and the configuration signature. (Visuals are deferred,
 * so identification surfaces here and in the console rather than as real UI.)
 */
export class Readout {
  private readonly polyBox: Popup; // "POLYHEDRON" frame, bottom-left
  private readonly selBox: Popup; //  "SELECTION" frame, top-left (only while selecting)
  private polyRows = 0; //            current height of the POLYHEDRON box, in rows
  private polyEl: HTMLElement | null;
  private selEl: HTMLElement | null;
  private poly: Polyhedron | null = null;
  private name: string | null = null;
  private signature: Signature | null = null;
  private selection: Set<number> = new Set();
  private selectionKind: MarkerKind | null = null;
  // Non-null only while a drag is live; `count` is the participating subset size,
  // or null when the operation affects every element of its kind (the whole solid).
  private drag: { kind: OperationKind; weld: boolean; count: number | null, t: number } | null = null;
  private verified: boolean = false;
  private invalid: boolean = false;
  private solving: boolean = false;
  // The top-left SELECTION box stays hidden until the first edit (like the SHAPES
  // and HISTORY panels), so a fresh launch isn't cluttered before you've acted.
  private selectionEnabled: boolean = false;

  constructor(
    private readonly screen: Screen,
    // Rows occupied by the top-left SHAPES panel; the SELECTION box starts just
    // below it rather than overlapping it.
    private readonly reservedTopRows: () => number = () => 0,
  ) {
    // Each readout block lives in the body of its own box-drawing popup (matching
    // the HISTORY panel). Each frame hugs its content and re-fits into its corner
    // on every layout: the polyhedron info bottom-left, the selection info top-left.
    this.polyBox = new Popup(screen, { cols: 12, rows: 5, title: config.ui.titles.polyhedron });
    this.polyBox.mount();
    this.polyEl = document.createElement("div");
    this.polyEl.className = "popup-resize";
    this.setupWrap(this.polyEl);
    this.polyBox.body.appendChild(this.polyEl);

    this.selBox = new Popup(screen, { cols: 12, rows: 4, title: config.ui.titles.selection });
    this.selBox.mount();
    this.selEl = document.createElement("div");
    this.selEl.className = "popup-resize";
    this.setupWrap(this.selEl);
    this.selBox.body.appendChild(this.selEl);

    this.polyBox.el.style.display = "none"; // nothing to show until setPoly()
    this.selBox.el.style.display = "none"; //  shown only while something is selected
    screen.onLayout(() => this.layout());
  }

  /** Fade the bottom-left POLYHEDRON box in (its first appearance after the intro). */
  fadeIn(): void {
    fadeIn(this.polyBox.el);
  }

  /** Allow the top-left SELECTION box to appear (called on the user's first edit
   *  / on intro skip). Until then, selections don't surface a popup. */
  enableSelection(): void {
    this.selectionEnabled = true;
  }

  /** Hide both frames (no polyhedron, or the readout feature is off). */
  private hide(): void {
    this.polyBox.el.style.display = "none";
    this.selBox.el.style.display = "none";
  }

  /** Re-fit each visible frame to its content and pin it to its corner. */
  private layout(): void {
    if (this.polyBox.el.style.display !== "none" && this.polyEl) {
      this.polyRows = this.fit(this.polyBox, this.polyEl, "bl");
    }
    if (this.selBox.el.style.display !== "none" && this.selEl) {
      this.fit(this.selBox, this.selEl, "tl");
    }
  }

  /** Let a readout body wrap once it would overflow the screen, with a hanging
   *  indent so continuation lines sit under their label. A negative text-indent
   *  cancels the padding on the first line (flush left), and both are whole cells
   *  so the wrapped text stays on the character grid. The actual wrap width is the
   *  max-width set per-layout in fit(). */
  private setupWrap(el: HTMLElement): void {
    const indent = READOUT_INDENT_COLS * this.screen.colW;
    el.style.whiteSpace = "pre-wrap";
    el.style.paddingLeft = `${indent}px`;
    el.style.textIndent = `${-indent}px`;
  }

  /** Size a popup to hug `el` (white-space pre-wrap with width:max-content, so
   *  offsetWidth is its widest line until it hits the max-width cap) plus a
   *  one-cell frame, and pin it to a screen corner. Returns its row count. */
  private fit(popup: Popup, el: HTMLElement, corner: "tl" | "bl"): number {
    const s = this.screen;
    // Cap the body so a long config list wraps before the box runs off-screen.
    // The +READOUT_INDENT_COLS accounts for the hanging-indent padding, so the
    // framed box still reaches the full screen width.
    el.style.maxWidth = `${(s.cols - 2 - READOUT_INDENT_COLS) * s.colW}px`;
    const cols = Math.min(s.cols, Math.max(3, Math.ceil(el.offsetWidth / s.colW) + 2));
    const rows = Math.min(s.rows, Math.max(3, Math.ceil(el.offsetHeight / s.rowH) + 2));
    popup.resize(cols, rows);
    const topRow = corner === "tl" ? this.reservedTopRows() : s.rows - rows;
    popup.placeAt(0, topRow);
    return rows;
  }

  /** Rows occupied by the bottom-left POLYHEDRON box (0 while hidden), so other
   *  corner panels (e.g. HISTORY) can cap their height to avoid overlapping it. */
  reservedBottomRows(): number {
    return this.polyBox.el.style.display === "none" ? 0 : this.polyRows;
  }

  clear(): void {
    this.poly = null;
    this.name = null;
    this.signature = null;
    this.selection = new Set();
    this.selectionKind = null;
    this.drag = null;
    this.verified = false;
    this.invalid = false;
    this.solving = false;
    this.hide();
  }

  show(): void {
    if (!this.polyEl || !this.selEl || !config.features.textReadout || !this.poly || !this.signature) {
      this.hide();
      return;
    }
    const title = this.invalid
      ? "X invalid (faces won't planarize)"
      : (this.name ?? "Unnamed non-uniform polyhedron");
    const status = this.solving ? "  …relaxing" : "";
    this.polyEl.textContent = `${title}${status}\n${describeSignature(this.signature)}\n`

    let snub = document.createElement("span");
    let gyro = document.createElement("span");
    let canDoSnub = canSnub(this.poly, new Set());
    let canDoGyro = canGyro(this.poly, new Set());
    snub.textContent = `Snub: ${canDoSnub ? "✓" : "X"}  `;
    gyro.textContent = `Gyro: ${canDoGyro ? "✓" : "X"}  `;
    if (!canDoSnub) { snub.className = 'cannotSnubGyro'; }
    if (!canDoGyro) { gyro.className = 'cannotSnubGyro'; }
    this.polyEl.append(snub);
    this.polyEl.append(gyro);
    this.polyBox.el.style.display = "";

    if (this.selectionEnabled && (this.drag || this.selection.size > 0)) {
      let onFaces = this.selectionKind === "face";
      let verb = "Selected";
      let count = this.selection.size;
      if (this.drag) {
        if (this.drag.t > config.interaction.minCommitT) {
          onFaces = this.drag.kind === "kis" || this.drag.kind === "gyro";
          verb = DRAG_VERB[this.drag.kind][this.drag.weld ? 1 : 0];
        }
        count =
        this.drag.count ?? (onFaces ? this.poly.faces.length : this.poly.vertices.length);
      }
      const noun = plural(onFaces ? "face" : "vertex", count);
      this.selEl.textContent = `${verb} ${count} ${noun}\n`;

      let snub = document.createElement("span");
      let gyro = document.createElement("span");
      let canDoSnub = canSnub(this.poly, this.selection);
      let canDoGyro = canGyro(this.poly, this.selection);
      snub.textContent = `Snub: ${canDoSnub ? "✓" : "X"}  `;
      gyro.textContent = `Gyro: ${canDoGyro ? "✓" : "X"}  `;
      if (!canDoSnub) { snub.className = 'cannotSnubGyro'; }
      if (!canDoGyro) { gyro.className = 'cannotSnubGyro'; }
      if (!onFaces) { this.selEl.append(snub); }
      if ( onFaces) { this.selEl.append(gyro); }
      this.selBox.el.style.display = "";
    }
    else {
      this.selEl.textContent = "";
      this.selBox.el.style.display = "none";
    }

    this.layout();
  }

  setPoly(opts: {
    poly: Polyhedron | null;
    name: string | null;
    signature: Signature;
    invalid: boolean;
    solving: boolean;
  }): void {
    this.poly      = opts.poly;
    this.name      = opts.name;
    this.signature = opts.signature;
    this.invalid   = opts.invalid;
    this.solving   = opts.solving;
    this.show();
  }

  updateSelection(selection: Set<number>, kind: MarkerKind | null): void {
    // Called on every hover move, so skip the (graph-traversing) re-render when the
    // effective selection is unchanged.
    if (kind === this.selectionKind && sameSet(selection, this.selection)) return;
    this.selection = selection;
    this.selectionKind = kind;
    this.show();
  }

  /** Reflect an in-progress drag (or pass null when the drag ends). */
  setDrag(drag: { kind: OperationKind; weld: boolean; count: number | null, t: number } | null): void {
    this.drag = drag;
    this.show();
  }

  setVerified(verified: boolean): void {
    this.verified = verified;
    this.show();
  }

  setHint(text: string): void {
    if (!this.polyEl || !this.selEl || !config.features.textReadout) return;
    this.polyEl.textContent = text;
    this.selEl.textContent = "";
    this.polyBox.el.style.display = "";
    this.selBox.el.style.display = "none";
    this.layout();
  }
}
