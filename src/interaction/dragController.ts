import { Vector3, type PerspectiveCamera, type Ray } from "three";
import { type ArcballControls } from "three/examples/jsm/controls/ArcballControls.js";
import { Polyhedron } from "../geometry/polyhedron";
import {
  faceColorsRGB,
  edgeKey,
  setColorScheme,
  getColorScheme,
  schemeForMesh,
  type SchemeName,
} from "../geometry/colors";
import { type MorphPlan } from "../operations/types";
import { buildTruncate, closestIncidentEdge } from "../operations/truncate";
import { buildKis } from "../operations/kis";
import { buildSnub } from "../operations/snub";
import { buildGyro } from "../operations/gyro";
import { operationLabel, classifySelection, type OpDescriptor } from "../operations/naming";
import { RelaxSolver, type Strategy } from "../solver/solver";
import { extractTopology } from "../solver/topology";
import { type Signature, describeSignature } from "../identify/configurations";
import { identify, buildGraphData, namedGraphFor } from "../identify/identify";
import { SceneView, type Marker, type MarkerKind } from "../render/sceneView";
import { Picker } from "./picker";
import { Selection } from "./selection";
import { Readout } from "../ui/readout";
import { History, type HistoryEntry, type HistoryOptions } from "../history/history";
import { HistoryPanel } from "../ui/historyPanel";
import { type Screen } from "../ui/screen";
import { type GlitchOverlay } from "../ui/glitch";
import { ShapesPanel } from "../ui/shapesPanel";
import { DiscoveryPopup } from "../ui/discoveryPopup";
import { LibraryBrowser } from "../ui/libraryBrowser";
import { Discoveries } from "../discoveries";
import { solidTypeFor } from "../data/namedPolyhedra";
import { config } from "../config";
import { led } from "../ui/led";

const DRAG_START_PIXELS = 4;
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Whether two id sets hold exactly the same members. */
function sameIdSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// When the welded max (rectify / join) is disabled, stop the drag just short of
// it so coincident vertices / faces don't produce degenerate geometry.
const MAX_T_WITHOUT_WELD = 0.94;

interface Pending {
  marker: Marker | null;
  shift: boolean;
  multi: boolean;
  x: number;
  y: number;
}

/** One built operation: its plan plus whether its max end welds. */
interface PlanSlot {
  plan: MorphPlan;
  allowMax: boolean;
}

/** A snapshot of the selection (kind + ids), to restore on a negligible drag. */
interface SelectionSnapshot {
  kind: MarkerKind | null;
  ids: Set<number>;
}

interface Drag {
  // The base operation (truncate / kis) tracks the mouse whenever Shift is up.
  base: PlanSlot;
  sel: Set<number> | null; // participating subset, retained to (re)build the shift plan
  // The Shift form (snub / gyro) is built lazily WHEN Shift goes down, frozen at the
  // base's then-current level so the skew interpolates out of it. Rebuilt on each press.
  shift: PlanSlot | null; // null when snub/gyro is unavailable for this handle
  shiftHeld: boolean; // live Shift state; selects which plan is active
  frozenWeld: boolean; // base's weld state at Shift-press → the gyro commit weld (snub welds by skew)
  lastRay: Ray | null; // last pick ray, so a Shift toggle can re-preview in place
  kind: MarkerKind;
  id: number;
  hasSelection: boolean; // operating on a multi-select subset (drives selection feedback)
  selCount: number | null; // size of that subset (null = whole solid), for the label
  restore: SelectionSnapshot | null; // selection to put back if this multi-drag commits nothing
  t: number; // active plan's current parameter (base level when Shift up; skew when down)
  weld: boolean;
}

/**
 * Glues gestures to operations: hover → highlight; left-drag a vertex/face →
 * build & preview a morph; release → commit, relax, then identify. Cmd/Ctrl
 * drives multi-select. The camera's right-drag orbit is handled separately.
 */
export class DragController {
  private current: Polyhedron;
  private invalid = false;
  private solver: RelaxSolver | null = null;
  // The regularization objective applied to new commits, switchable via the
  // OPTIONS panel (or the debug keys). Persists until the user picks another.
  private strategy: Strategy = config.solver.defaultStrategy;
  // Press-and-hold state for the OPTIONS buttons: while held the solve keeps
  // stepping; a click still runs until `holdMinUntil` so it does something.
  private manualHold = false;
  private holdDown = false;
  private holdMinUntil = 0;
  // Rendered vertices, eased toward the solver's live vertices so the morph reads
  // smoothly. `solveStopping` = stepping is done; we're only letting the display
  // catch up before finalizing.
  private displayVerts: Vector3[] | null = null;
  private solveStopping = false;

  private mode: "idle" | "pending" | "dragging" = "idle";
  private pending: Pending | null = null;
  private drag: Drag | null = null;
  private hover: Marker | null = null;
  private hoverInRange = false;
  private hoverRay: Ray | null = null;
  private hoverMulti = false; // Cmd/Ctrl (or an arity digit) held while hovering (would drag as a selection)
  // While a digit 3–9 is held, only handles of that arity (a face's side count /
  // a vertex's degree) are hoverable/clickable, and the digit acts like Cmd/Ctrl
  // for selection. null when no digit is held.
  private arityKey: number | null = null;
  // Option/Alt held: a "same arity as whatever I'm hovering" gesture (an implicit,
  // uncapped arity digit). Unlike a digit it doesn't restrict what's hoverable.
  private altHeld = false;
  // Last idle pointer position, so toggling an arity gesture can re-pick the
  // hovered handle under a stationary cursor.
  private lastPointer: { x: number; y: number } | null = null;
  // Memoized per-vertex degree (incident-face count) for the current polyhedron,
  // rebuilt only when `this.current` changes.
  private degCache: { poly: Polyhedron; deg: number[] } | null = null;

  private readonly picker = new Picker();
  private readonly selection: Selection; // created in the constructor, wired to the readout
  private readonly history = new History();
  private readonly panel: HistoryPanel;

  private worker: Worker | null = null;
  private isoReq = 0;
  private lastName: string | null = null;
  private lastSignature: Signature | null = null;
  private firstEdit = true; // pending: the next commit is the user's first edit

  // First-time-made-shape tracking + its celebration (glow + glitch + popup).
  private readonly discoveries = new Discoveries();
  private readonly discoveryPopup: DiscoveryPopup;
  private readonly library: LibraryBrowser;

  constructor(
    initial: Polyhedron,
    seedLabel: string,
    private readonly view: SceneView,
    private readonly camera: PerspectiveCamera,
    private readonly controls: ArcballControls,
    private readonly canvas: HTMLCanvasElement,
    private readonly readout: Readout,
    screen: Screen,
    // The shared corruption overlay (boot sequence + discovery flash) and the
    // top-left SHAPES panel, so discoveries can flash the screen and bump N/250.
    private readonly glitch: GlitchOverlay,
    private readonly shapes: ShapesPanel,
    // Fired once, the first time the user commits an operation (so the SHAPES /
    // HISTORY panels can reveal themselves only after the first edit).
    private readonly onFirstEdit: () => void = () => {},
  ) {
    this.current = initial;
    this.discoveryPopup = new DiscoveryPopup(screen);
    // The full-screen LIBRARY browse diagram, opened by the OPTIONS "Browse"
    // button. It re-reads the discovered set (and copies this camera) each open.
    this.library = new LibraryBrowser(screen, this.camera, () => this.discoveries.snapshot());
    this.library.mount();
    this.shapes.bindBrowse(() => this.library.show());
    this.shapes.setCount(this.discoveries.count);
    this.shapes.setActiveStrategy(this.strategy);
    this.shapes.bindStrategy(
      (s) => this.beginStrategy(s),
      () => this.endStrategy(),
    );
    this.shapes.setActiveColorScheme(getColorScheme());
    this.shapes.bindColorScheme((name) => this.selectColorScheme(name as SchemeName));
    this.panel = new HistoryPanel(
      screen,
      (index) => this.jumpTo(index),
      () => this.readout.reservedBottomRows(),
    );
    if (config.features.isomorphismCheck) {
      this.worker = new Worker(
        new URL("../identify/isoWorker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker.onmessage = (e: MessageEvent<{ id: number; result: boolean }>) =>
        this.onIsoResult(e.data.id, e.data.result);
    }
    this.attach();
    this.selection = new Selection(this.readout);
    this.history.reset(initial, seedLabel, this.currentOptions());
    this.view.setPolyhedron(this.current, false);
    this.runIdentify(this.current);
  }

  /** The current polyhedron (live solved vertices), for saving its geometry. */
  currentPoly(): Polyhedron {
    return this.current;
  }

  /** The display name of the current shape — its identified name, or the derived
   *  history name (e.g. "Augmented Truncated Cube") when unidentified — for filenames. */
  currentName(): string | null {
    return this.history.list[this.history.current]?.displayName ?? this.lastName;
  }

  /** Force the HISTORY panel visible now (used when the intro is skipped, so all
   *  panels show without waiting for the first edit). */
  revealHistory(): void {
    this.panel.reveal();
  }

  /** Replace the whole polyhedron (e.g. loading a new seed / reset), starting a
   *  fresh history rooted at the new seed. */
  load(poly: Polyhedron, seedLabel: string): void {
    this.solver = null;
    this.shapes.setSolving(false);
    this.invalid = false;
    this.current = poly;
    this.hover = null; // drop any marker hovered on the previous mesh
    this.selection.clear();
    this.history.reset(poly, seedLabel, this.currentOptions());
    this.view.setPolyhedron(poly, false);
    this.runIdentify(poly);
  }

  /** The view options (scheme + strategy) currently in effect, for the history. */
  private currentOptions(): HistoryOptions {
    return { scheme: getColorScheme(), strategy: this.strategy };
  }

  // ---- undo / redo / jump --------------------------------------------------
  undo(): void {
    const entry = this.history.undo();
    if (entry) this.restore(entry);
  }

  redo(): void {
    const entry = this.history.redo();
    if (entry) this.restore(entry);
  }

  /** Jump to an arbitrary point in the history (driven by the panel clicks). */
  jumpTo(index: number): void {
    const entry = this.history.jumpTo(index);
    if (entry) this.restore(entry);
  }

  /** Show a previously-committed state without re-solving (it's already relaxed). */
  private restore(entry: HistoryEntry): void {
    this.solver = null; // abandon any in-progress relaxation
    this.shapes.setSolving(false);
    this.mode = "idle";
    this.pending = null;
    this.drag = null;
    // The mesh is being swapped, so any hovered marker now points at stale geometry
    // (its id may not even exist in the new mesh) — drop it before re-highlighting.
    this.hover = null;
    this.readout.setDrag(null); // drop any stale drag readout (e.g. undo mid-drag)
    this.selection.clear();
    this.current = entry.poly;
    this.invalid = entry.invalid;
    // Restore the color scheme + regularization strategy remembered for this entry
    // (before rendering, so the surface comes back with the right colors).
    setColorScheme(entry.options.scheme);
    this.shapes.setActiveColorScheme(entry.options.scheme);
    this.strategy = entry.options.strategy;
    this.shapes.setActiveStrategy(entry.options.strategy);
    this.view.setPolyhedron(entry.poly, entry.invalid);
    this.refreshHighlights();
    this.runIdentify(entry.poly);
  }

  private renderHistory(): void {
    this.panel.render(this.history.list, this.history.current);
  }

  /** Re-run the active strategy's relaxation on the current shape (debug `relaxKey`
   *  / a button re-press). Ignored mid-drag. Refines the current state in place. */
  relax(): void {
    if (this.mode !== "idle" || !config.solver.enabled) return;
    this.startSolve(this.current);
  }

  /**
   * Switch the regularization strategy used for future shapes AND re-solve the
   * current one with it now, running to convergence (the debug strategy keys).
   * The chosen button shows "half-pressed" until this solve finishes.
   */
  selectStrategy(s: Strategy): void {
    this.strategy = s;
    this.shapes.setActiveStrategy(s);
    this.history.setOptions(this.currentOptions()); // remember on this entry (no branch)
    if (this.mode !== "idle" || !config.solver.enabled) return;
    this.startSolve(this.current);
  }

  /**
   * Switch the active color SCHEME (the OPTIONS "Colors" buttons) and recolor the
   * current shape right away. The geometric element colors don't change — only how
   * they map to the palette — so no re-solve is needed. A live drag's preview reads
   * the scheme every frame, so it picks the change up on its own.
   */
  selectColorScheme(name: SchemeName): void {
    if (name === getColorScheme()) return;
    // Capture the current face colors (old scheme), switch, then fade to the new
    // scheme's colors over the same colorFadeSeconds used after an operation.
    const fromRGB = faceColorsRGB(this.current.colors.face);
    setColorScheme(name);
    this.shapes.setActiveColorScheme(name);
    this.history.setOptions(this.currentOptions()); // update this entry in place (no branch)
    if (this.mode === "idle") {
      const toRGB = faceColorsRGB(this.current.colors.face);
      this.view.setPolyhedron(this.current, this.invalid); // rebuilds edges (new scheme) + markers
      this.view.startColorFade(fromRGB, toRGB, config.render.colorFadeSeconds);
      this.refreshHighlights();
    }
  }

  /**
   * An OPTIONS strategy button was pressed: switch strategy and start stepping the
   * relaxation, which then continues every frame until `endStrategy` (release).
   * A single click still runs for at least `holdMinMs` so it does something visible.
   */
  beginStrategy(s: Strategy): void {
    this.strategy = s;
    this.shapes.setActiveStrategy(s);
    this.history.setOptions(this.currentOptions()); // remember on this entry (no branch)
    if (this.mode !== "idle" || !config.solver.enabled) return;
    this.startSolve(this.current, true);
  }

  /** The held strategy button was released — let the current step finish. */
  endStrategy(): void {
    this.holdDown = false;
  }

  /** Begin an incremental relaxation of `poly` with the active strategy. When
   *  `hold` is set it keeps stepping until the button is released (min `holdMinMs`),
   *  otherwise it runs to convergence on its own. */
  private startSolve(poly: Polyhedron, hold = false): void {
    // Snapshot the shape as it looks NOW (before the solver recenters/rescales it),
    // so the rendered geometry can ease from here into the relaxing form.
    this.displayVerts = poly.mesh.vertices.map((v) => v.clone());
    this.solveStopping = false;
    const topo = extractTopology(poly);
    this.solver = new RelaxSolver(poly.mesh.vertices, topo, this.strategy);
    // (The shape relaxes underneath the release color-fade; the active strategy
    // button shows "half-pressed" meanwhile.)
    this.shapes.setSolving(true);
    this.manualHold = hold;
    this.holdDown = hold;
    this.holdMinUntil = performance.now() + config.solver.holdMinMs;
    this.readout.setHint(`● relaxing: ${this.solver.statusLabel}`);
  }

  /** Ease the display buffer toward the solver's live vertices; returns true once
   *  it has essentially caught up (so we can finalize without a visible snap). */
  private easeDisplay(target: Vector3[]): boolean {
    let dv = this.displayVerts;
    if (!dv || dv.length !== target.length) {
      dv = this.displayVerts = target.map((v) => v.clone());
      return true;
    }
    const a = config.solver.displaySmoothing;
    let maxd = 0;
    for (let i = 0; i < dv.length; i++) {
      maxd = Math.max(maxd, target[i].distanceTo(dv[i]));
      dv[i].lerp(target[i], a);
    }
    return maxd < 2e-3; // shape size is ~1, so this is a sub-pixel gap
  }

  // ---- frame update --------------------------------------------------------
  update(): void {
    this.view.updateMarkerScales(this.camera, config.camera.startDistance);
    this.view.updateEffects(performance.now()); // advance the discovery glow pulse
    if (!this.solver) return;

    // The geometry is being updated this frame (a relaxation / canonicalization
    // step is running), so flick the activity LED.
    led.pulse();

    // While a button is physically held, keep the solver in sustain mode so it
    // doesn't damp itself to a premature stop.
    this.solver.sustain = this.holdDown;

    // Step the relaxation (unless we've already decided to stop), then render the
    // SMOOTHED display rather than the solver's raw vertices.
    const working = this.solveStopping ? false : this.solver.advance();
    const caughtUp = this.easeDisplay(this.solver.mesh.vertices);
    this.view.showPreview({
      vertices: this.displayVerts!,
      faces: this.solver.mesh.faces,
    });
    if (!this.solveStopping && working) {
      this.readout.setHint(`● relaxing: ${this.solver.statusLabel}`);
    }

    // Decide when to STOP stepping: a held button keeps going until released AND
    // past the click minimum (or fully converged); an auto solve runs to converge.
    if (!this.solveStopping) {
      if (this.manualHold) {
        const pastMin = performance.now() >= this.holdMinUntil;
        if (!working || (!this.holdDown && pastMin)) this.solveStopping = true;
      } else if (!working) {
        this.solveStopping = true;
      }
    }
    // Finalize only once the smoothed display has caught up to the frozen result.
    if (this.solveStopping && caughtUp) {
      this.manualHold = false;
      this.holdDown = false;
      this.solveStopping = false;
      this.finishSolve();
    }
  }

  // ---- listeners -----------------------------------------------------------
  private attach(): void {
    // Capture phase so we can decide (and disable orbit) BEFORE ArcballControls
    // sees the pointerdown.
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e), true);
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", (e) => this.onUp(e), true);
    this.canvas.addEventListener("pointerleave", () => {
      if (this.mode !== "idle") return; // don't disturb an in-progress drag
      this.hover = null;
      this.refreshHighlights();
    });
    // Pressing / releasing Cmd-Ctrl while hovering re-tints the preview (the
    // selection color when a drag would now treat the handle as part of the selection).
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyDown(e));
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Arity digit (3–9): while held it restricts hovering/clicking to handles of
    // that arity AND acts as a selection modifier (like Cmd/Ctrl). Tracked ahead of
    // everything else (and regardless of mode) so releasing it mid-drag can't leave
    // the filter stuck on after the drag ends. Auto-repeat keydowns are idempotent.
    if (config.features.multiSelect && e.key.length === 1 && e.key >= "3" && e.key <= "9") {
      const digit = Number(e.key);
      const next =
        e.type === "keydown" ? digit : this.arityKey === digit ? null : this.arityKey;
      if (next !== this.arityKey) {
        this.arityKey = next;
        if (this.mode === "idle") {
          // The pickable set changed: re-pick under the (stationary) cursor so the
          // highlight updates without needing a mouse move.
          if (this.lastPointer) this.updateHover(this.lastPointer.x, this.lastPointer.y);
          this.hoverMulti = this.multiHeld(e);
          this.refreshHighlights();
        }
      }
      return;
    }

    // Shift held/released DURING a drag morphs truncate↔snub / kis↔gyro live.
    if (this.mode === "dragging" && this.drag) {
      if (e.key == 'Escape') {
        this.drag.t = 0;
        this.onUp(new PointerEvent("pointerup", { button: 0 }), true);
      }
      else if (e.shiftKey !== this.drag.shiftHeld) {
        if (e.shiftKey) this.enterShift(); // freeze base level, build snub/gyro
        else this.drag.shiftHeld = false; // revert to base tracking the mouse
        if (this.drag.lastRay) this.updateDragPreview(this.drag.lastRay);
      }
      return;
    }
    if (this.mode !== "idle" || !config.features.multiSelect) return;

    // Cmd/Ctrl or Option/Alt pressed/released while hovering re-tints the preview
    // (Alt switches between the single handle and its whole arity group).
    const prevAlt = this.altHeld;
    this.altHeld = e.altKey && config.features.multiSelect;
    const multi = this.multiHeld(e);
    if (multi === this.hoverMulti && this.altHeld === prevAlt) return;
    this.hoverMulti = multi;
    if (this.hover) this.refreshHighlights();
  }

  private allMarkers(): Marker[] {
    return [...this.view.vertexMarkers, ...this.view.faceMarkers];
  }

  /** Per-vertex degree (number of incident faces = edge count on a closed solid)
   *  for the current polyhedron, memoized until it changes. */
  private vertexDegrees(): number[] {
    if (this.degCache?.poly === this.current) return this.degCache.deg;
    const deg = new Array<number>(this.current.vertices.length).fill(0);
    for (const f of this.current.faces) for (const i of f) deg[i]++;
    this.degCache = { poly: this.current, deg };
    return deg;
  }

  /** A marker's arity: a face's side count, or a vertex's degree. */
  private arityOf(m: Marker): number {
    return m.kind === "face"
      ? this.current.faces[m.id].length
      : this.vertexDegrees()[m.id];
  }

  /** The markers a pick may target right now: all of them, or — while a digit is
   *  held — only those whose arity matches it. */
  private pickable(): Marker[] {
    if (this.arityKey == null) return this.allMarkers();
    return this.allMarkers().filter((m) => this.arityOf(m) === this.arityKey);
  }

  /** Every marker id of `kind` with the given arity — the set an arity gesture
   *  selects. */
  private arityGroup(kind: MarkerKind, arity: number): Set<number> {
    const markers = kind === "vertex" ? this.view.vertexMarkers : this.view.faceMarkers;
    const ids = new Set<number>();
    for (const m of markers) if (this.arityOf(m) === arity) ids.add(m.id);
    return ids;
  }

  /**
   * The arity an active arity gesture targets for marker `m`, or null when no such
   * gesture is held. A digit 3–9 pins an explicit arity (and `m` already matches
   * it); Option/Alt instead takes the marker's OWN arity, so you select every
   * handle sharing the hovered one's arity without naming the number.
   */
  private gestureArity(m: Marker): number | null {
    if (this.arityKey != null) return this.arityKey;
    if (this.altHeld) return this.arityOf(m);
    return null;
  }

  /** Whether selection ("multi") is active: Cmd/Ctrl, Option/Alt, or an arity digit
   *  held — gated by the multiSelect feature. */
  private multiHeld(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
    return (
      ((IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey || this.arityKey != null) &&
      config.features.multiSelect
    );
  }

  /**
   * Camera-facing test (same metric the picker uses to cull occluded markers),
   * bound to the live camera. Used to restrict vertex-drag edge-snapping to edges
   * whose midpoint is in view, so you can't drag along a back/side edge.
   */
  private inView = (point: Vector3, normals: Vector3[]): boolean =>
    Picker.facesCamera(point, normals, this.camera);

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return; // left only; other buttons orbit
    if (this.solver) return; // not interactable while relaxing (orbit still works)
    this.altHeld = e.altKey && config.features.multiSelect;
    const marker = this.picker.pick(
      this.pickable(),
      e.clientX,
      e.clientY,
      this.canvas,
      this.camera,
    );
    this.pending = {
      marker,
      shift: e.shiftKey,
      multi: this.multiHeld(e),
      x: e.clientX,
      y: e.clientY,
    };
    this.mode = "pending";
    // Grabbing a handle suppresses camera orbit; empty space still orbits.
    if (marker) this.controls.enabled = false;
  }

  private onMove(e: PointerEvent): void {
    if (this.mode === "idle") {
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.altHeld = e.altKey && config.features.multiSelect;
      this.hoverMulti = this.multiHeld(e);
      this.updateHover(e.clientX, e.clientY);
      this.refreshHighlights();
      return;
    }
    if (this.mode === "pending" && this.pending) {
      const moved = Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y);
      if (moved > DRAG_START_PIXELS) this.startDrag();
    }
    if (this.mode === "dragging" && this.drag) {
      const ray = this.picker.ray(e.clientX, e.clientY, this.canvas, this.camera);
      this.updateDragPreview(ray);
    }
  }

  /** Refresh the idle hover state (nearest pickable handle + its ray) for a
   *  pointer position. Caller is responsible for refreshHighlights(). */
  private updateHover(x: number, y: number): void {
    // While the solver is relaxing, nothing is interactable yet (positions are
    // mid-flight), so suppress hover entirely.
    if (config.features.hoverHighlight && !this.solver) {
      const hit = this.picker.pickClosest(
        this.pickable(),
        x,
        y,
        this.canvas,
        this.camera,
        config.interaction.proximityPixelRadius,
      );
      this.hover = hit?.marker ?? null;
      this.hoverInRange =
        !!hit && hit.pixelDist <= config.interaction.hoverPixelRadius;
      this.hoverRay = this.picker.ray(x, y, this.canvas, this.camera);
    } else {
      this.hover = null;
    }
  }

  /** The plan the current Shift state selects (snub/gyro while Shift is held and
   *  available, otherwise the base truncate/kis). */
  private activeSlot(d: Drag): PlanSlot {
    return d.shiftHeld && d.shift ? d.shift : d.base;
  }

  /** Snap the active plan to `ray`, store the resulting t/weld, and refresh the
   *  preview, drag marker and range line. Driven by pointer moves and by Shift
   *  toggles (which re-run it against the last ray). */
  private updateDragPreview(ray: Ray): void {
    const d = this.drag!;
    d.lastRay = ray;
    const usingShift = d.shiftHeld && d.shift !== null;
    const active = this.activeSlot(d);
    const snap = active.plan.snap(ray);
    let tEff = snap.t;
    let weld: boolean;
    if (usingShift) {
      // Snub/gyro: the skew is in [0,1] and the topology is fixed.
      tEff = Math.max(0, Math.min(1, snap.t));
      if (active.plan.kind === "snub") {
        // Snub welds (full vs partial) based purely on whether the skew is extended
        // all the way to the end — where the outer and inner cut vertices coincide —
        // matching what the geometry already shows, not on the frozen base level.
        weld = tEff >= 1;
      } else {
        // Gyro: whether it welds is inherited from the base, not from reaching the end.
        weld = d.frozenWeld;
      }
    } else {
      // No end magnetism: t follows the cursor directly. Only the very end welds
      // (rectify / join); if that end is disabled, stop just short of it.
      weld = false;
      if (snap.t >= 1) {
        if (active.allowMax) weld = true;
        else tEff = MAX_T_WITHOUT_WELD;
      }
    }
    d.t = tEff;
    d.weld = weld;
    this.readout.setDrag({ kind: active.plan.kind, weld, t: d.t, selIds: d.sel, selKind: d.kind });
    const verts = active.plan.positions(tEff);
    // At the welded max, hide the edges that are about to collapse so the
    // about-to-merge faces read as a single face even before welding.
    const hiddenEdges = weld
      ? new Set(active.plan.vanishingEdges.map(([a, b]) => edgeKey(a, b)))
      : undefined;
    // Hide the big hover markers during the drag (as in the non-selection case).
    // When operating on a selection, the selection highlight "sticks around" via
    // the small drag marker + range line instead.
    this.view.showPreview(
      { vertices: verts, faces: active.plan.previewFaces },
      {
        faceColors: active.plan.previewFaceColors(tEff),
        edgeColors: active.plan.previewEdgeColors,
        hiddenEdges,
      },
    );
    const inSelection = d.hasSelection;
    this.view.setDragMarker(
      snap.point, // small sphere on the targeted vertex
      inSelection ? config.render.selectedColor : config.render.dragMarkerColor,
    );
    if (snap.highlight)
      this.view.setEdgeHighlight(
        snap.highlight.a,
        snap.highlight.b,
        inSelection ? config.render.selectedColor : config.render.dragLineColor,
      );
    else this.view.clearEdgeHighlight();
  }

  private startDrag(): void {
    const p = this.pending!;
    if (!p.marker) {
      // Left-drag on empty space does nothing (orbit is the right button).
      this.mode = "idle";
      this.pending = null;
      return;
    }
    const kind = p.marker.kind;
    const id = p.marker.id;

    // A multi-drag (Cmd/Ctrl or an arity digit) temporarily folds handles into the
    // selection and drags the whole set — but TEMPORARILY: if the drag commits
    // nothing, the prior selection is restored on release (see onUp), so an aimless
    // multi-drag doesn't leave anything selected. Snapshot it now to restore later.
    const restore: SelectionSnapshot | null = p.multi
      ? { kind: this.selection.kind, ids: new Set(this.selection.ids) }
      : null;

    // Decide the participating selection set (or null = affect everything).
    let sel: Set<number> | null = null;
    const arity = p.multi ? this.gestureArity(p.marker) : null;
    if (arity != null) {
      // Arity drag: operate on EVERY handle of this kind with the gesture's arity,
      // and select them all for the duration.
      const group = this.arityGroup(kind, arity);
      this.selection.replace(kind, group);
      sel = new Set(group);
    } else {
      if (p.multi) this.selection.add(kind, id); // Cmd-drag adds just this handle
      if (this.selection.kind === kind && this.selection.ids.size > 0) {
        if (this.selection.ids.has(id)) sel = this.selection.setFor(kind);
        else this.selection.clear(); // dragging an unselected handle drops the selection
      }
    }

    // Build the base operation (truncate / kis). The Shift form (snub / gyro) is built
    // lazily when Shift goes down, so it can freeze the base's level at that instant.
    const base = this.buildPlan(kind, id, false, sel);
    if (!base) {
      if (restore) this.selection.replace(restore.kind, restore.ids); // undo temp changes
      this.mode = "idle";
      this.pending = null;
      return;
    }
    this.solver = null; // abandon any in-progress relaxation
    this.shapes.setSolving(false);
    this.drag = {
      base, sel,
      shift: null, shiftHeld: false, frozenWeld: false, lastRay: null,
      kind, id,
      hasSelection: sel !== null,
      selCount: sel ? sel.size : null,
      restore,
      t: 0, weld: false,
    };
    this.mode = "dragging";
    // Shift already held at grab time → enter snub/gyro immediately, frozen at t=0.
    if (p.shift) this.enterShift();
    const active = this.activeSlot(this.drag);
    const verts = active.plan.positions(0);
    this.view.showPreview(
      { vertices: verts, faces: active.plan.previewFaces },
      { faceColors: active.plan.previewFaceColors(0), edgeColors: active.plan.previewEdgeColors },
    );
    this.readout.setDrag({
      kind: active.plan.kind, weld: this.drag.weld, t: this.drag.t,
      selIds: this.drag.sel, selKind: this.drag.kind,
    });
    // The drag marker is positioned on the first move (when we have a snap point).
  }

  /**
   * Shift went down mid-drag: freeze the base at its current level and build the
   * snub/gyro plan from it (apex / cut fractions seeded by `drag.t`). The skew then
   * interpolates out of that frozen state, and the welded-vs-partial form is inherited
   * from the base's current weld. A null plan (op off / wrong handle) means Shift is
   * inert and the base keeps driving.
   */
  private enterShift(): void {
    const d = this.drag!;
    d.shift = this.buildPlan(d.kind, d.id, true, d.sel, d.t);
    d.frozenWeld = d.weld;
    d.shiftHeld = true;
  }

  private buildPlan(
    kind: MarkerKind,
    id: number,
    shift: boolean,
    sel: Set<number> | null,
    baseT = 1, // snub/gyro: the frozen base level the skew interpolates out of
  ): PlanSlot | null {
    const ops = config.features.operations;
    try {
      if (kind === "vertex") {
        if (shift) {
          if (!ops.snub) return null;
          return { plan: buildSnub(this.current, id, sel, this.inView, baseT), allowMax: true };
        }
        if (!ops.truncate) return null;
        return {
          plan: buildTruncate(this.current, id, sel, this.inView),
          allowMax: ops.rectify,
        };
      } else {
        if (shift) {
          if (!ops.gyro) return null;
          return { plan: buildGyro(this.current, id, sel, this.inView, baseT), allowMax: true };
        }
        if (!ops.kis) return null;
        return { plan: buildKis(this.current, id, sel), allowMax: ops.join };
      }
    } catch (err) {
      console.warn("Operation unavailable:", err);
      return null;
    }
  }

  private onUp(e: PointerEvent, pointerStillDown: boolean = false): void {
    if (e.button !== 0) {
      this.controls.enabled = true;
      return;
    }
    this.view.clearEdgeHighlight();
    this.view.hideDragMarker();

    if (this.mode === "dragging" && this.drag) {
      this.readout.setDrag(null); // back to the "Selected …" / idle readout
      if (this.drag.t <= config.interaction.minCommitT) {
        // negligible drag → no change. A multi-drag's temporary additions to the
        // selection are undone by restoring the snapshot taken at drag start.
        if (this.drag.restore)
          this.selection.replace(this.drag.restore.kind, this.drag.restore.ids);
        this.view.setPolyhedron(this.current, this.invalid);
      } else {
        const active = this.activeSlot(this.drag);
        const { mesh, colors: finalColors } = active.plan.commit(this.drag.t, this.drag.weld);
        // `this.current` is still the pre-operation shape here (committed below), so
        // the label / op descriptor classify against the geometry that was acted on.
        const label = operationLabel(
          active.plan.kind,
          this.drag.weld,
          this.current,
          this.drag.sel,
          this.drag.kind,
        );
        const { category, n } = classifySelection(this.current, this.drag.sel, this.drag.kind);
        const op: OpDescriptor = { kind: active.plan.kind, weld: this.drag.weld, category, n };
        // Colors at release: the welded form's committed colors are taken as-is
        // (any difference from the drag's t=1 look snaps instantly); a partial
        // (un-welded) commit fades from the interpolated drag colors.
        const fromRGB = this.drag.weld
          ? faceColorsRGB(finalColors.face)
          : active.plan.previewFaceColors(this.drag.t);
        // Forming a classic Platonic solid auto-switches to its color scheme; the
        // fade below then carries the faces from the old scheme into the new one.
        const auto = schemeForMesh(mesh);
        if (auto && auto !== getColorScheme()) {
          setColorScheme(auto);
          this.shapes.setActiveColorScheme(auto);
        }
        const toRGB = faceColorsRGB(finalColors.face);
        // The topology changed, so the old vertex/face ids no longer mean anything.
        this.selection.clear();
        this.hover = null; // any hovered marker now points at the old mesh
        const poly = new Polyhedron(mesh, finalColors);
        // Render the committed geometry with the "from" colors, then start the fade.
        this.view.showPreview(
          { vertices: mesh.vertices, faces: mesh.faces },
          { faceColors: fromRGB, edgeColors: finalColors.edge },
        );
        this.view.startColorFade(fromRGB, toRGB, config.render.colorFadeSeconds);
        this.commitPoly(poly, label, op);
      }
    } else if (this.mode === "pending" && this.pending) {
      // a click (no drag): selection bookkeeping
      if (this.pending.multi) {
        const arity = this.pending.marker ? this.gestureArity(this.pending.marker) : null;
        if (!this.pending.marker) {
          this.selection.clear();
        } else if (arity != null) {
          // Arity click: toggle the WHOLE arity group of the clicked kind — select
          // them all, or clear if that exact group is already the selection.
          const k = this.pending.marker.kind;
          const group = this.arityGroup(k, arity);
          if (this.selection.kind === k && sameIdSet(this.selection.ids, group))
            this.selection.clear();
          else this.selection.replace(k, group);
        } else {
          this.selection.toggle(this.pending.marker.kind, this.pending.marker.id);
        }
      } else {
        this.selection.clear();
      }
    }
    this.mode = "idle";
    this.pending = null;
    this.drag = null;
    if (!pointerStillDown) {
      this.controls.enabled = true; // restore camera orbit
      this.refreshHighlights();
    }
  }

  private commitPoly(poly: Polyhedron, label: string, op: OpDescriptor): void {
    this.current = poly;
    this.invalid = false;
    if (this.firstEdit) {
      this.firstEdit = false;
      this.onFirstEdit();
    }
    this.history.push(poly, label, this.currentOptions(), op);
    this.renderHistory();
    if (config.solver.enabled) {
      this.startSolve(poly); // mutates poly's vertices in place across frames
    } else {
      // Keep the release color-fade running over the (un-relaxed) committed shape.
      this.view.setPolyhedron(poly, false, true);
      this.runIdentify(poly, true);
    }
  }

  private finishSolve(): void {
    if (!this.solver) return;
    this.invalid = this.solver.invalid;
    this.solver = null;
    this.shapes.setSolving(false);
    // Keep any in-progress release color-fade running on the now-relaxed shape.
    this.view.setPolyhedron(this.current, this.invalid, true);
    this.runIdentify(this.current, true);
  }

  // ---- identification ------------------------------------------------------
  // `discover` is true only when the shape was just MADE (a fresh commit / solve),
  // so undo/redo, restore and seed loads never count as discovering a shape.
  private runIdentify(poly: Polyhedron, discover = false): void {
    const { name, signature } = identify(poly);
    this.lastName = name;
    this.lastSignature = signature;
    if (discover && !this.invalid && name) {
      const { isNew, first } = this.discoveries.add(name);
      this.shapes.setCount(this.discoveries.count);
      if (config.discovery.enabled && isNew) this.celebrate(name, first);
    }
    // Record the result against the current history entry (invalid states show no
    // name). This also runs for the seed root and on restore — both harmless.
    this.history.annotate(this.history.current, this.invalid ? null : name, this.invalid);
    this.renderHistory();
    // Show the derived history name (modifier + nearest known ancestor) when the
    // shape isn't a known polyhedron; fall back to the raw identify result.
    const display = this.history.list[this.history.current]?.displayName ?? name;
    this.readout.setPoly({
      poly, name: display, signature,
      invalid: this.invalid,
      solving: false,
    });
    if (config.features.logToConsole) {
      console.log(
        `[identify] ${this.invalid ? "INVALID — " : ""}${name ?? "Unknown"}\n${describeSignature(signature)}`,
      );
      console.log(this.camera.position);
    }
    if (
      !this.invalid &&
      this.worker &&
      config.features.isomorphismCheck &&
      name &&
      poly.dcel.vertices.length <= config.identify.isomorphismMaxVertices
    ) {
      const target = namedGraphFor(name);
      if (target) {
        const id = ++this.isoReq;
        this.worker.postMessage({ id, candidate: buildGraphData(poly), target });
      }
    }
  }

  private onIsoResult(id: number, result: boolean): void {
    if (id !== this.isoReq || !result || !this.lastSignature) return;
    // this.readout.setVerified(true);
    if (config.features.logToConsole) console.log(`[identify] verified ✓ ${this.lastName}`);
  }

  /**
   * Celebrate making a named shape for the first time: a bright emissive glow on
   * the shape, a glitch flash across the screen, then a popup naming the solid
   * and its family. The very first discovery of the run is amplified.
   */
  private celebrate(name: string, first: boolean): void {
    const d = config.discovery;
    const glow = d.glowStrength * (first ? d.firstGlowMultiplier : 1);
    this.view.pulseGlow(glow, d.glowDurationS);
    const burst = Math.min(1, d.glitchBurst * (first ? d.firstGlitchMultiplier : 1));
    this.glitch.burst(burst, d.glitchDurationS);
    const type = solidTypeFor(name) ?? "Platonic solid";
    window.setTimeout(
      () => this.discoveryPopup.show(name, type, this.discoveries.count, first),
      d.popupDelayS * 1000,
    );
    if (config.features.logToConsole) {
      console.log(`[discovery]${first ? " FIRST!" : ""} ${name} (${type}) — ${this.discoveries.count}/${d.total}`);
    }
  }

  // ---- highlights ----------------------------------------------------------
  private refreshHighlights(): void {
    this.view.resetMarkerStates(); // hide all markers
    this.view.clearEdgeHighlight();
    this.view.clearFaceHighlight();

    if (this.selection.kind) {
      for (const id of this.selection.ids)
        this.view.showMarker(this.selection.kind, id, "selected");
    }

    const hovering = !!this.hover && config.features.hoverHighlight;

    // Arity gesture: hovering a handle in range previews the WHOLE arity group of
    // that kind (every matching handle lights up, and a click/drag takes them all).
    const arity = hovering ? this.gestureArity(this.hover!) : null;
    if (arity != null && this.hoverInRange) {
      const group = this.arityGroup(this.hover!.kind, arity);
      for (const id of group)
        this.view.showMarker(this.hover!.kind, id, "selected");
      if (this.mode === "idle" && !this.solver)
        this.readout.updateSelection(group, this.hover!.kind);
      return;
    }

    // "Affected" = this handle is part of the active selection — either already
    // command-clicked, or Cmd is held so a drag would add it. Those are previewed
    // in the selection color; a plain handle keeps the neutral hover look.
    const selected = hovering && this.selection.isSelected(this.hover!.kind, this.hover!.id);
    const affected = selected || (hovering && this.hoverMulti && this.hoverInRange);

    // A selection-colored Cmd-hovered handle isn't in the selection set yet, but a drag would add
    // it, so count it toward the readout's selection. Skipped while dragging/relaxing,
    // where the readout shows the live operation / status instead.
    if (this.mode === "idle" && !this.solver)
      this.syncReadoutSelection(affected && !selected ? this.hover : null);

    if (!hovering) return;

    // Within drag range → prominent; merely nearby → subtle proximity hint.
    const state = affected ? "selected" : this.hoverInRange ? "hover" : "proximity";
    this.view.showMarker(this.hover!.kind, this.hover!.id, state);

    if (this.hoverInRange && this.hoverRay) {
      this.showHoverPreview(this.hover!, this.hoverRay, affected);
    }
  }

  /**
   * Push the effective multi-selection to the readout: the committed selection plus
   * one extra Cmd-hovered handle that a drag would add. A handle of a different
   * kind would switch the selection to its kind (a drag clears the old one), so it
   * shows as a fresh selection of one.
   */
  private syncReadoutSelection(extra: Marker | null): void {
    let kind = this.selection.kind;
    let ids: Set<number>;
    if (extra && kind !== null && kind !== extra.kind) {
      kind = extra.kind;
      ids = new Set([extra.id]);
    } else {
      ids = new Set(this.selection.ids);
      if (extra) {
        kind = extra.kind;
        ids.add(extra.id);
      }
    }
    this.readout.updateSelection(ids, kind);
  }

  /**
   * Hover preview of what a drag would affect: the incident edge (vertex) or the
   * whole face (face center). `affected` marks a command-clicked / Cmd-held handle
   * — part of the active selection — and is the explicit split between rendering a
   * plain handle and a selected one. Today they differ only in color; if rectify /
   * join ever applies in the command-click case, the `affected` branch is where the
   * geometry (e.g. the vertex line length) should diverge from the plain preview.
   */
  private showHoverPreview(marker: Marker, ray: Ray, affected: boolean): void {
    // Guard against a marker left over from a previous mesh (the id may no longer
    // exist after a commit / undo swapped the geometry).
    if (marker.id >= (marker.kind === "vertex" ? this.current.vertices : this.current.faces).length)
      return;
    if (marker.kind === "vertex" && config.features.operations.truncate) {
      const e = closestIncidentEdge(this.current, marker.id, ray, this.inView);
      // While only hovering (not dragging) the line spans the FULL drag range: the
      // vertex center (e.from) → the rectify max (e.mid, the edge midpoint). It does
      // NOT shrink to the snapped cursor position; that only happens during a drag.
      // `affected` distinguishes a command-clicked / Cmd-held handle (drawn in the selection color)
      // from a plain one, and is the seam where a future rectify/join preview for
      // the selected case could use a different far endpoint (a different length).
      this.view.setEdgeHighlight(
        e.from,
        e.mid,
        affected ? config.render.selectedColor : config.render.dragLineColor,
      );
    } else if (marker.kind === "face" && config.features.operations.kis) {
      const verts = this.current.faces[marker.id].map((i) =>
        this.current.vertices[i].clone(),
      );
      this.view.setFaceHighlight(
        verts,
        affected ? config.render.selectedColor : config.render.faceHighlightColor,
      );
    }
  }
}
