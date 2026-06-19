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

/** Per-vertex degree (incident-face count = edge count on a closed solid). */
function vertexDegrees(poly: Polyhedron): number[] {
  const deg = new Array<number>(poly.vertices.length).fill(0);
  for (const f of poly.faces) for (const i of f) deg[i]++;
  return deg;
}

/** Join a list so the final separator reads ", and " (e.g. "a, b, and c"; "a, and b"). */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];
}

/**
 * Describe a homogeneous set of elements (a selection, or the participants of an
 * in-progress operation) — where "arity" is a face's side count or a vertex's
 * degree. When every element of the kind is included it reads simply "all faces"
 * / "all vertices". Otherwise an arity all of whose elements are included reads as
 * one group ("all 3-gon faces" / "all degree-4 vertices"); everything left over is
 * summed into a trailing count. `ids === null` means the whole solid. Examples:
 *   "all vertices"                  (every vertex)
 *   "all degree-4 vertices"
 *   "all 3-gon faces, all 5-gon faces, and 2 faces"
 *   "all degree-3 vertices, and 1 vertex"
 *   "2 faces"                       (no arity fully covered)
 */
function describeSet(
  poly: Polyhedron,
  ids: Set<number> | null,
  kind: MarkerKind,
): string {
  const onFaces = kind === "face";
  const elemCount = onFaces ? poly.faces.length : poly.vertices.length;
  // The whole solid → just "all faces" / "all vertices".
  if (ids === null || ids.size === elemCount) {
    return `all ${plural(onFaces ? "face" : "vertex", 2)}`;
  }

  const degrees = onFaces ? null : vertexDegrees(poly);
  const arityOf = (id: number): number =>
    onFaces ? poly.faces[id].length : degrees![id];

  // How many elements of each arity exist in the whole solid …
  const total = new Map<number, number>();
  for (let id = 0; id < elemCount; id++) {
    const a = arityOf(id);
    total.set(a, (total.get(a) ?? 0) + 1);
  }
  // … and how many are in the set.
  const selected = new Map<number, number>();
  for (const id of ids) {
    const a = arityOf(id);
    selected.set(a, (selected.get(a) ?? 0) + 1);
  }

  const fullGroups: string[] = [];
  let remainder = 0;
  for (const a of [...selected.keys()].sort((x, y) => x - y)) {
    const n = selected.get(a)!;
    if (n === total.get(a)) {
      fullGroups.push(onFaces ? `all ${a}-gon faces` : `all degree-${a} vertices`);
    } else {
      remainder += n;
    }
  }

  const parts = [...fullGroups];
  if (remainder > 0) {
    parts.push(`${remainder} ${plural(onFaces ? "face" : "vertex", remainder)}`);
  }
  return joinAnd(parts);
}

/** Whether two id sets hold exactly the same members. */
function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * The present-participle verb shown while a drag is in progress, keyed by the
 * operation and whether the drag has reached its welded max end (for snub, that's
 * the fully-extended skew; for gyro it's inherited from the base level).
 */
const DRAG_VERB: Record<OperationKind, [unwelded: string, welded: string]> = {
  truncate: ["Truncating", "Rectifying"],
  kis: ["Kis-ing", "Joining"],
  snub: ["Incompletely Snubbing", "Snubbing"],
  gyro: ["Incompletely Gyro-ing", "Gyro-ing"],
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
  // Non-null only while a drag is live. `selIds` is the participating element set
  // (null = every element of its kind / the whole solid); `selKind` is whether the
  // operation acts on vertices or faces, so the readout can describe it by arity.
  private drag: {
    kind: OperationKind;
    weld: boolean;
    t: number;
    selIds: Set<number> | null;
    selKind: MarkerKind;
  } | null = null;
  // private verified: boolean = false;
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
    // this.verified = false;
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
    this.polyEl.textContent = `${title}${status}\n${describeSignature(this.signature)}\nSHIFT: `

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
      // The affected set is summarized by arity group ("all 3-gon faces, and 2
      // faces" / "all degree-4 vertices" / "all faces"). During a live operation
      // drag the operation verb leads; otherwise it's a static "Selected …".
      // The set whose capability we report must match its kind: gyro reads face ids,
      // snub reads vertex ids. During a drag, use the drag's set/kind so a stale
      // persistent selection of the other kind can't be fed to the wrong predicate
      // (which would index out of range and throw).
      let onFaces = this.selectionKind === "face";
      let effSel = this.selection;
      let line: string;
      if (this.drag) {
        onFaces = this.drag.selKind === "face";
        effSel = this.drag.selIds ?? new Set();
        const verb =
          this.drag.t > config.interaction.minCommitT
            ? DRAG_VERB[this.drag.kind][this.drag.weld ? 1 : 0]
            : "Selected";
        line = `${verb} ${describeSet(this.poly, this.drag.selIds, this.drag.selKind)}`;
      } else {
        line = `Selected ${describeSet(this.poly, this.selection, this.selectionKind ?? "face")}`;
      }
      this.selEl.textContent = `${line}\nSHIFT: `;

      if (onFaces) {
        const gyro = document.createElement("span");
        const canDoGyro = canGyro(this.poly, effSel);
        gyro.textContent = `Gyro: ${canDoGyro ? "✓" : "X"}  `;
        if (!canDoGyro) { gyro.className = 'cannotSnubGyro'; }
        this.selEl.append(gyro);
      } else {
        const snub = document.createElement("span");
        const canDoSnub = canSnub(this.poly, effSel);
        snub.textContent = `Snub: ${canDoSnub ? "✓" : "X"}  `;
        if (!canDoSnub) { snub.className = 'cannotSnubGyro'; }
        this.selEl.append(snub);
      }
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
  setDrag(
    drag: {
      kind: OperationKind;
      weld: boolean;
      t: number;
      selIds: Set<number> | null;
      selKind: MarkerKind;
    } | null,
  ): void {
    this.drag = drag;
    this.show();
  }

  // setVerified(verified: boolean): void {
  //   this.verified = verified;
  //   this.show();
  // }

  setHint(text: string): void {
    if (!this.polyEl || !this.selEl || !config.features.textReadout) return;
    this.polyEl.textContent = text;
    this.selEl.textContent = "";
    this.polyBox.el.style.display = "";
    this.selBox.el.style.display = "none";
    this.layout();
  }
}
