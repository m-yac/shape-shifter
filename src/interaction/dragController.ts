import { Vector3, type PerspectiveCamera, type Ray } from "three";
import { type ArcballControls } from "three/examples/jsm/controls/ArcballControls.js";
import { Polyhedron } from "../geometry/polyhedron";
import {
  faceColorsRGB,
  edgeKey,
  setColorScheme,
  getColorScheme,
  schemeForMesh,
  paletteRGB,
  darkRGB,
  collapse,
  paletteSwatch,
  type GeomColor,
  type SchemeName,
} from "../geometry/colors";
import { type MorphPlan } from "../operations/types";
import { buildTruncate, closestIncidentEdge, computeCollapseFractions } from "../operations/truncate";
import { buildKis } from "../operations/kis";
import { buildSnub, buildVolute } from "../operations/snub";
import { buildGyro, buildWhirl } from "../operations/gyro";
import { buildChamfer } from "../operations/chamfer";
import { buildSubdivide } from "../operations/subdivide";
import { faceCentroidHE, faceNormalHE } from "../geometry/polyhedron";
import { type HalfEdge } from "../geometry/HalfEdge";
import { closestLineParam, distancePointToRay } from "../util/lines";
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
import { HistoryStore, deserializeHistory } from "../history/historyStore";
import { HistoryPanel } from "../ui/historyPanel";
import { type Screen } from "../ui/screen";
import { type GlitchOverlay } from "../ui/glitch";
import { ShapesPanel } from "../ui/shapesPanel";
import { DiscoveryPopup } from "../ui/discoveryPopup";
import { LibraryBrowser } from "../ui/libraryBrowser";
import { Discoveries } from "../discoveries";
import { solidTypeFor, namedPolyhedronFor, historyStepsFor } from "../data/namedPolyhedra";
import { config } from "../config";
import { led } from "../ui/led";

const DRAG_START_PIXELS = config.interaction.dragStartPixels;
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Whether two id sets hold exactly the same members. */
function sameIdSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// When the welded max (rectify / join) is disabled, stop the drag just short of
// it so coincident vertices / faces don't produce degenerate geometry.
const MAX_T_WITHOUT_WELD = config.interaction.maxTWithoutWeld;

// How far along the twist arc the cursor must move before the snub/gyro engages;
// below this, a welded release commits the plain rectify / join instead.
const TWIST_ENGAGE_T = 0.04;
// Once the base drag welds, the welded state stays latched until the cursor retreats
// back down the truncation line below this t. Hysteresis: nudging onto the arc must
// not snap back to truncating.
const WELD_UNLATCH_T = 0.75;
// Two twist handles count as the same one when their weld anchors (rectify vertex / join
// apex) sit this close. The anchor is piecewise-constant per base handle, so this keys the
// per-drag cache of built twists.
const TWIST_ANCHOR_EPS = 1e-5;

interface Pending {
  marker: Marker | null;
  shift: boolean;
  alt: boolean; // Option: additive-arity selection
  cmd: boolean; // Cmd/Ctrl: single element (or additive individual, per config)
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
  // The base operation (truncate / kis / edge op) tracks the mouse for t ∈ [0,1].
  base: PlanSlot;
  sel: Set<number> | null; // participating subset (the n-truncate / n-kis arity group)
  // The twist form (snub / gyro / whirl / volute) extending a full rectify/join: built
  // once the base drag welds, and driving the morph once the cursor moves onto its handle.
  // Null until then, and while the drag has no twist at all.
  twist: PlanSlot | null;
  // Every twist built during this drag, keyed by the base plan and weld anchor it extends,
  // with the base-return line that leads back down to it. Building one runs snub's two
  // chiral variants / gyro's planarity solve, far too costly to redo per frame — or even
  // per weld, since a drag can weld, retreat and weld again — so each distinct handle is
  // built at most once and then reused.
  twists: TwistEntry[];
  twisting: boolean; // the cursor has engaged the twist arc (snub/gyro active)
  weldLatched: boolean; // base reached the full rectify/join (latched with hysteresis)
  lastRay: Ray | null; // last pick ray, so a re-preview can run in place
  kind: MarkerKind;
  id: number;
  hasSelection: boolean; // operating on a multi-select subset (drives selection feedback)
  selCount: number | null; // size of that subset (null = whole solid), for the label
  restore: SelectionSnapshot | null; // selection to put back if this multi-drag commits nothing
  t: number; // active plan's current parameter (base t, or the arc t while twisting)
  weld: boolean;
  // Edge drags (chamfer / subdivide) only: the dragged edge, its three axes, and which
  // one is active. Moving the cursor can switch axes mid-drag (rebuilding `base`), the
  // way a vertex drag switches which incident edge it tracks. Null for vertex/face drags.
  edgeAxis: EdgeAxisState | null;
  // Twist drags only: the fixed base-return line the drag climbed to reach the weld —
  // snub's un-rectify line (rectify vertex → original vertex) or gyro's un-join line
  // (join apex → original face centroid). Once welded, this competes with the twist
  // handle for the cursor as a single stable segment, so heading back down it un-welds
  // (back to truncate / kis) instead of engaging the snub / gyro.
  baseReturnLine: { origin: Vector3; far: Vector3 } | null;
}

/** The three drag axes of an edge handle, as lines through its midpoint. */
interface EdgeAxisInfo {
  midpoint: Vector3;
  faceA: number;
  faceB: number;
  // Each axis is a half-line from the midpoint along `dir`: the direction the cursor
  // must head to select it. Chamfer axes carry the bordering face's centroid and
  // outward normal so a face turned away from the camera can be culled, as truncate
  // culls edges facing away. The subdivide (`normal`) axis has no `view` and is
  // always available.
  axes: Array<{
    which: "A" | "B" | "normal";
    dir: Vector3;
    view?: { point: Vector3; normal: Vector3 };
  }>;
}

/** The live axis state of an edge (chamfer / subdivide) drag. `slots` memoizes the built
 *  plan of each axis, so swapping back and forth between them doesn't rebuild. */
interface EdgeAxisState {
  edge: [number, number];
  info: EdgeAxisInfo;
  which: "A" | "B" | "normal";
  slots: Map<"A" | "B" | "normal", PlanSlot | null>;
}

/** One built twist handle, cached for the drag that built it (see `Drag.twists`). */
interface TwistEntry {
  base: MorphPlan; // the base plan it extends
  anchor: Vector3; // the weld point it hangs off (rectify vertex / join apex)
  slot: PlanSlot | null; // null when the twist turned out to be unavailable
  returnLine: { origin: Vector3; far: Vector3 } | null;
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
  private solveStartMs = 0; // when the current relaxation began (for the planarity warning)
  // `jumbled` only: set once the button has been held long enough for the planarity
  // warning to appear, which leaves the solve running after the button is released
  // (see `update`). Cleared by starting any new solve.
  private solveLatched = false;
  // Rendered vertices, eased toward the solver's live vertices so the morph reads
  // smoothly. `solveStopping` means stepping is done and we are only letting the
  // display catch up before finalizing.
  private displayVerts: Vector3[] | null = null;
  private solveStopping = false;

  private mode: "idle" | "pending" | "dragging" = "idle";
  private pending: Pending | null = null;
  private drag: Drag | null = null;
  private hover: Marker | null = null;
  private hoverInRange = false;
  private hoverRay: Ray | null = null;
  private hoverMulti = false; // Cmd/Ctrl held while hovering (would drag a single element)
  // Option/Alt held: hovering highlights the hovered handle's whole arity group, and a
  // click adds that group to the selection, so selections can span several arities.
  private altHeld = false;
  // Memoized per-vertex degree (incident-face count) for the current polyhedron,
  // rebuilt only when `this.current` changes.
  private degCache: { poly: Polyhedron; deg: number[] } | null = null;
  // Memoized per-half-edge truncation collapse fractions for the current
  // polyhedron (an expensive least-squares solve), rebuilt only when it changes.
  private collapseCache: { poly: Polyhedron; collapse: Map<number, number> } | null = null;

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
  // Per-shape construction histories (persisted), so the LIBRARY can reopen a shape
  // in the main view with the exact timeline that first produced it.
  private readonly historyStore = new HistoryStore();
  // A just-discovered shape whose timeline still needs persisting. The save is held
  // until its relaxation finishes (finishSolve), so the stored final entry is the
  // settled canonical geometry the LIBRARY reopens rather than the raw commit (whose
  // form is farthest from canonical for the twists).
  private pendingSave: string | null = null;
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
    // top-left SHAPES panel, so discoveries can flash the screen and bump N/99.
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
    this.library = new LibraryBrowser(
      screen,
      this.camera,
      () => this.discoveries.snapshot(),
      (name) => this.openNamed(name),
    );
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

  /** Whether the full-screen LIBRARY browse view is open (so Help shows its blurb). */
  isLibraryOpen(): boolean {
    return this.library.isOpen();
  }

  /** The display name of the current shape, used for filenames: its identified name,
   *  or the derived history name (e.g. "Augmented Truncated Cube") when unidentified. */
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

  /**
   * Open a named shape (clicked in the LIBRARY) in the main view, restoring the
   * construction history that first produced it. Falls back to the named-polyhedron
   * database for shapes with no saved timeline: the pre-discovered tetrahedron, or any
   * shape exposed by the reveal-all cheat.
   */
  openNamed(name: string): void {
    let entries: HistoryEntry[];
    let index: number;
    let fallback = false; // a database-built solid (no saved timeline), so relax it
    const saved = this.historyStore.get(name);
    if (saved) {
      entries = deserializeHistory(saved).entries;
      index = entries.length - 1;
    } else {
      // No user-made timeline (e.g. opened via reveal-all): synthesize the
      // tetrahedron-rooted construction chain from the named-polyhedron database, so it
      // still imports with a history reaching back to a tetrahedron.
      const steps = historyStepsFor(name);
      const np = namedPolyhedronFor(name);
      if (!steps || !np) return;
      const opts = { scheme: np.scheme, strategy: config.solver.defaultStrategy };
      entries = steps.map((s): HistoryEntry => {
        const id = identify(s.poly);
        return {
          poly: s.poly.clone(),
          label: s.label,
          name: id.name,
          displayName: id.name ?? s.label,
          op: null,
          invalid: false,
          isSeed: s.isSeed,
          options: { ...opts },
        };
      });
      index = entries.length - 1;
      fallback = true;
    }
    this.history.replaceAll(entries, index);
    // Render and re-identify the target entry; this also restores its color scheme and
    // strategy, and clears any in-progress drag / selection / solver.
    this.restore(this.history.list[this.history.current]);
    this.renderHistory();
    // A library open can precede the user's first edit, so reveal every panel
    // (idempotent if they already are).
    this.firstEdit = false;
    this.onFirstEdit();
    this.panel.reveal();
    // A database-built solid isn't regularized, so relax it into its canonical form.
    // A saved timeline's last state is already relaxed.
    if (fallback) this.relax();
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

  /** Debug: dump a poly's per-class geometric colors and how the active scheme paints
   *  them, so a click-loaded shape can be compared against a made one. */
  private logColors(label: string, poly: Polyhedron): void {
    const tally = (nums: GeomColor[], resolve: (g: GeomColor) => { getHexString(): string }) => {
      const out: Record<string, number> = {};
      for (const n of nums) {
        const swatch = paletteSwatch(n);
        const k = `geom[${collapse(n).join(",")}]=#${resolve(n).getHexString()}${swatch ? ` (${swatch})` : ""}`;
        out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };
    /* eslint-disable no-console */
    console.log(`[colors] ${label} — scheme=${getColorScheme()}`);
    console.log("  face:", tally(poly.colors.face, paletteRGB));
    console.log("  vert:", tally(poly.colors.vertex, paletteRGB));
    console.log("  edge:", tally([...poly.colors.edge.values()], darkRGB));
    /* eslint-enable no-console */
  }

  /** Show a previously-committed state without re-solving (it's already relaxed). */
  private restore(entry: HistoryEntry): void {
    // Navigating away drops any pending save. Harmless: reopening that shape then takes
    // the database path, which relaxes it into the same canonical form.
    this.pendingSave = null;
    this.solver = null; // abandon any in-progress relaxation
    this.shapes.setSolving(false);
    this.mode = "idle";
    this.pending = null;
    this.drag = null;
    // The mesh is being swapped, so a hovered marker's id may not even exist in the
    // new mesh; drop it before re-highlighting.
    this.hover = null;
    this.readout.setDrag(null); // drop any stale drag readout (e.g. undo mid-drag)
    this.selection.clear();
    this.current = entry.poly;
    this.invalid = entry.invalid;
    // Restore the color scheme and strategy remembered for this entry before
    // rendering, so the surface comes back with the right colors.
    setColorScheme(entry.options.scheme);
    this.shapes.setActiveColorScheme(entry.options.scheme);
    this.strategy = entry.options.strategy;
    this.shapes.setActiveStrategy(entry.options.strategy);
    this.view.setPolyhedron(entry.poly, entry.invalid);
    this.logColors(`restore "${entry.displayName ?? entry.label}"`, entry.poly);
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
   * Switch the regularization strategy used for future shapes and re-solve the current
   * one with it now, running to convergence (the debug strategy keys). The chosen
   * button shows half-pressed until this solve finishes.
   */
  selectStrategy(s: Strategy): void {
    this.strategy = s;
    this.shapes.setActiveStrategy(s);
    this.history.setOptions(this.currentOptions()); // remember on this entry (no branch)
    if (this.mode !== "idle" || !config.solver.enabled) return;
    this.startSolve(this.current);
  }

  /**
   * Switch the active color scheme (the OPTIONS Colors buttons) and recolor the current
   * shape right away. Only the mapping from geometric element colors to the palette
   * changes, so no re-solve is needed. A live drag's preview reads the scheme every
   * frame, so it picks the change up on its own.
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

  /** The held strategy button was released — let the current step finish, unless the
   *  hold latched (see `solveLatched`), in which case it keeps running. */
  endStrategy(): void {
    this.holdDown = false;
  }

  /** Begin an incremental relaxation of `poly` with the active strategy. When
   *  `hold` is set it keeps stepping until the button is released (min `holdMinMs`),
   *  otherwise it runs to convergence on its own. */
  private startSolve(poly: Polyhedron, hold = false): void {
    // Snapshot the shape as it looks now, before the solver recenters/rescales it, so
    // the rendered geometry can ease from here into the relaxing form.
    this.displayVerts = poly.mesh.vertices.map((v) => v.clone());
    this.solveStopping = false;
    // Always regularize from the operation's raw geometry (1:1 with the live vertices)
    // rather than continuing from the possibly-degenerate current state, so a wildly
    // dragged vertex or a strategy switch can't leave the shape permanently mangled.
    // The display still eases from `displayVerts` into the freshly-relaxed result, so
    // this reset isn't visible as a jump.
    const live = poly.mesh.vertices;
    for (let i = 0; i < live.length; i++) live[i].copy(poly.raw.vertices[i]);
    const topo = extractTopology(poly);
    this.solver = new RelaxSolver(poly.mesh.vertices, topo, this.strategy);
    // The shape relaxes underneath the release color-fade; the active strategy button
    // shows half-pressed meanwhile.
    this.shapes.setSolving(true);
    this.manualHold = hold;
    this.holdDown = hold;
    this.solveLatched = false;
    this.holdMinUntil = performance.now() + config.solver.holdMinMs;
    this.solveStartMs = performance.now();
    this.readout.setHint(this.solveHint());
  }

  /** Whether the faces have stayed non-planar long enough for the SHAPE panel to be
   *  showing `planarity.warnText` — the cue the user holds a Jumbled press until. */
  private planarityWarned(): boolean {
    const s = this.solver;
    return (
      !!s && !s.planar && performance.now() - this.solveStartMs > config.solver.planarity.warnAfterMs
    );
  }

  /** The SHAPE-panel hint while relaxing: the usual status, or, once the faces have
   *  stayed non-planar past the warn delay, a note that they won't flatten. It clears
   *  itself the moment they do, since the solver keeps trying. */
  private solveHint(): string {
    const s = this.solver;
    if (!s) return "";
    if (this.planarityWarned()) return `⚠ ${config.solver.planarity.warnText}`;
    return `● relaxing: ${s.statusLabel}`;
  }

  /** Ease the display buffer toward the solver's live vertices. Returns true once it
   *  has caught up close enough to finalize without a visible snap. */
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

    // Holding the Jumbled button until the planarity warning appears latches the solve,
    // so releasing leaves it jumbling instead of stopping; a shorter press jumbles the
    // shape once and settles. Only `jumbled` latches: the other strategies planarize, so
    // they'd never reach the warning, and a latch there could only strand a shape
    // mid-relaxation.
    if (this.holdDown && this.strategy === "jumbled" && this.planarityWarned()) {
      this.solveLatched = true;
    }

    // While a button is physically held — or the solve has latched — keep the solver
    // in sustain mode so it doesn't damp itself to a premature stop.
    this.solver.sustain = this.holdDown || this.solveLatched;

    // Step the relaxation (unless we've already decided to stop), then render the
    // smoothed display rather than the solver's raw vertices.
    const working = this.solveStopping ? false : this.solver.advance();
    const caughtUp = this.easeDisplay(this.solver.mesh.vertices);
    this.view.showPreview({
      vertices: this.displayVerts!,
      faces: this.solver.mesh.faces,
    });
    if (!this.solveStopping && working) {
      this.readout.setHint(this.solveHint());
    }

    // Decide when to stop stepping: a held button keeps going until released and past
    // the click minimum (or fully converged); a latched one ignores the release and only
    // stops when the solver itself finishes; an auto solve runs to convergence.
    if (!this.solveStopping) {
      if (this.manualHold && !this.solveLatched) {
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
      this.solveLatched = false;
      this.solveStopping = false;
      this.finishSolve();
    }
  }

  // ---- listeners -----------------------------------------------------------
  private attach(): void {
    // Capture phase, so orbit can be disabled before ArcballControls sees the
    // pointerdown.
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
    // Escape cancels an in-progress drag (commits nothing).
    if (this.mode === "dragging" && this.drag) {
      if (e.key == "Escape") {
        this.drag.t = 0;
        this.onUp(new PointerEvent("pointerup", { button: 0 }), true);
      }
      return;
    }
    if (this.mode !== "idle" || !config.features.multiSelect) return;

    // Option+A selects every handle of the hovered kind: like Option, but every arity
    // at once. Keyed off e.code, since Option remaps the character.
    if (e.type === "keydown" && e.altKey && e.code === "KeyA" && this.hover) {
      e.preventDefault();
      const kind = this.hover.kind;
      const markers = kind === "vertex" ? this.view.vertexMarkers : this.view.faceMarkers;
      const ids = new Set<number>();
      for (const m of markers) ids.add(m.id);
      this.selection.addAll(kind, ids);
      this.altHeld = true;
      this.refreshHighlights();
      return;
    }

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
    return this.view.allMarkers;
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

  /** Per-half-edge truncation collapse fractions for the current polyhedron,
   *  memoized until it changes (the solve is far too costly to redo per hover). */
  private collapseFractions(): Map<number, number> {
    if (this.collapseCache?.poly === this.current) return this.collapseCache.collapse;
    const collapse = computeCollapseFractions(this.current);
    this.collapseCache = { poly: this.current, collapse };
    return collapse;
  }

  /** A marker's arity: a face's side count, or a vertex's degree. */
  private arityOf(m: Marker): number {
    return m.kind === "face"
      ? this.current.faces[m.id].length
      : this.vertexDegrees()[m.id];
  }

  /** Every marker id of `kind` with the given arity — the group a default drag
   *  affects, and the group an Option gesture selects. */
  private arityGroup(kind: MarkerKind, arity: number): Set<number> {
    const markers = kind === "vertex" ? this.view.vertexMarkers : this.view.faceMarkers;
    const ids = new Set<number>();
    for (const m of markers) if (this.arityOf(m) === arity) ids.add(m.id);
    return ids;
  }

  /** The arity an active Option gesture targets for marker `m`, or null when Option
   *  isn't held: the marker's own arity, so hovering highlights, and a click adds,
   *  every handle sharing it. */
  private gestureArity(m: Marker): number | null {
    // Edges have no arity grouping (chamfer / subdivide are always global).
    if (m.kind === "edge") return null;
    return this.altHeld ? this.arityOf(m) : null;
  }

  /** The command modifier (Cmd on macOS, Ctrl elsewhere), gated by multiSelect. */
  private cmdHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
    return (IS_MAC ? e.metaKey : e.ctrlKey) && config.features.multiSelect;
  }

  /** Whether a selection modifier (Cmd/Ctrl or Option) is active, gated by the
   *  multiSelect feature. */
  private multiHeld(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
    return (this.cmdHeld(e) || e.altKey) && config.features.multiSelect;
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
      this.allMarkers(),
      e.clientX,
      e.clientY,
      this.canvas,
      this.camera,
    );
    this.pending = {
      marker,
      shift: e.shiftKey,
      alt: this.altHeld,
      cmd: this.cmdHeld(e),
      x: e.clientX,
      y: e.clientY,
    };
    this.mode = "pending";
    // Grabbing a handle suppresses camera orbit; empty space still orbits.
    if (marker) this.controls.enabled = false;
  }

  private onMove(e: PointerEvent): void {
    if (this.mode === "idle") {
      this.altHeld = e.altKey && config.features.multiSelect;
      this.hoverMulti = this.multiHeld(e);
      this.updateHover(e.clientX, e.clientY);
      this.refreshHighlights();
      return;
    }
    if (this.mode === "pending" && this.pending) {
      const moved = Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y);
      if (moved > DRAG_START_PIXELS) {
        this.startDrag(this.picker.ray(e.clientX, e.clientY, this.canvas, this.camera));
      }
    }
    if (this.mode === "dragging" && this.drag) {
      const ray = this.picker.ray(e.clientX, e.clientY, this.canvas, this.camera);
      this.updateDragPreview(ray);
    }
  }

  /** Refresh the idle hover state (nearest pickable handle + its ray) for a
   *  pointer position. Caller is responsible for refreshHighlights(). */
  private updateHover(x: number, y: number): void {
    // While the solver is relaxing the positions are mid-flight and nothing is
    // interactable, so suppress hover entirely.
    if (config.features.hoverHighlight && !this.solver) {
      const hit = this.picker.pickClosest(
        this.allMarkers(),
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

  /** The plan currently driving the morph: the twist (snub/gyro) once engaged,
   *  else the base (truncate/kis/edge op). */
  private activeSlot(d: Drag): PlanSlot {
    return d.twisting && d.twist ? d.twist : d.base;
  }

  /**
   * The twist handle this drag extends into, or null when it has none. The two weld ends
   * each carry their own handle, whichever base op reached them: a Rectify (truncate, or
   * subdivide) is extended by snub's pair of straight chiral lines at the rectify vertex,
   * a Join (kis, or chamfer) by gyro's rotation arc at the join apex. So the edge drags
   * pick up the twists too — subdivide → volute, chamfer → whirl — with the same handle
   * in the same place as the vertex/face drag that welds the same way.
   */
  private twistStyle(d: Drag): "lines" | "arc" | null {
    const ops = config.features.operations;
    if (!d.base.allowMax) return null;
    if (d.kind === "vertex") return ops.snub ? "lines" : null;
    if (d.kind === "face") return ops.gyro ? "arc" : null;
    const axis = d.edgeAxis?.which;
    if (axis === "normal") return ops.volute ? "lines" : null;
    return ops.whirl ? "arc" : null;
  }

  /**
   * Snap to `ray`, store the resulting t/weld, and refresh the preview, drag marker, range
   * line and twist arc. The base op (truncate / kis / chamfer / subdivide) tracks the
   * cursor for t ∈ [0,1]; once it welds (t=1) into a full rectify/join and the cursor moves
   * onto the twist handle, the twist plan takes over (`twisting`).
   */
  private updateDragPreview(ray: Ray): void {
    const d = this.drag!;
    d.lastRay = ray;

    // Edge drags re-pick their axis every frame, so the cursor can switch between chamfer,
    // subdivide and back mid-drag — but only up to the weld. Past it the twist handles are
    // live, and they stand off the axes in directions the *other* axes also point in, so
    // re-picking would let the cursor slide from a chamfer straight into a volute (or a
    // subdivide into a whirl), swapping the operation out from under a twist that is
    // already engaged. So the axis freezes at the weld: to reach another one you have to
    // head back down the line you came up (which un-welds and thaws the choice again).
    if (d.kind === "edge" && !d.twisting && !d.weldLatched) this.updateEdgeAxis(ray);

    const baseSnap = d.base.plan.snap(ray);
    let baseT = baseSnap.t;
    let weld = false;
    if (baseT >= 1) {
      if (d.base.allowMax) weld = true;
      else baseT = MAX_T_WITHOUT_WELD;
    }

    const style = this.twistStyle(d);
    // Latch the welded (rectify/join) state until the cursor retreats back down the
    // truncation line, so nudging onto the arc doesn't snap back to truncating. Never
    // unlatch while actively twisting: there the cursor is off on a snub line, far from
    // the base edge, so baseT is meaningless and unlatching would tear the twist plan
    // down mid-snub.
    if (weld) d.weldLatched = true;
    else if (!d.twisting && baseT < WELD_UNLATCH_T) d.weldLatched = false;

    // The twist handle is live only once the base drag has actually reached its weld: the
    // rectify / join is the shape the twist grows out of, so there is nothing to twist
    // before it. It is frozen while actively twisting, so its anchor can't jump.
    if (!style || !d.weldLatched) {
      d.twist = null;
      d.twisting = false;
    } else if (!d.twisting) {
      d.twist = this.twistFor(d, baseSnap.highlight?.b);
    }

    // Snub / volute ride straight line handles alongside the base un-rectify line. Once
    // rectified, that line and the two chiral twist lines are all equally pickable: the
    // cursor snaps to whichever is nearest, the same way a truncate drag switches between
    // incident edges.
    if (style === "lines") {
      this.updateSnubStage(d, ray, baseSnap, baseT, weld);
      this.updateArc(d); // the straight handles have no arc; clears a stale one
      return;
    }

    // Gyro / whirl ride an arc handle near the join apex. Before the join latches it is
    // just the kis (or chamfer) drag. Once latched, the un-join line (the face normal, or
    // the chamfer's inset seam, that the drag climbed) competes with the arc by ray
    // distance: dragging back down it un-joins, like snub's un-rectify line, while veering
    // onto the arc twists. The arc engages only once the cursor has moved far enough along
    // it past the join rest. A drag with no twist at all also lands here, and just shows
    // its base.
    if (!d.weldLatched || !d.twist) {
      d.twisting = false;
      d.t = weld ? 1 : baseT;
      d.weld = weld;
      this.showBasePreview(d, baseSnap, weld, true);
    } else {
      const twistSnap = d.twist.plan.snap(ray);
      const baseDist = this.baseReturnDist(d, ray);
      const twistDist = distancePointToRay(twistSnap.point, ray);
      if (twistDist <= baseDist && twistSnap.t > TWIST_ENGAGE_T) {
        this.engageTwist(d, twistSnap.t);
        this.showTwistPreview(d, twistSnap.point);
      } else {
        d.twisting = false;
        d.t = weld ? 1 : baseT;
        d.weld = weld;
        this.showBasePreview(d, baseSnap, weld, true);
      }
    }

    // Twist arc: shown once the join is latched (like snub's line hints), with a solid
    // progress arc overlaid while actively twisting.
    this.updateArc(d);

    const active = this.activeSlot(d);
    this.readout.setDrag({ kind: active.plan.kind, weld: d.weld, t: d.t, selIds: d.sel, selKind: d.kind });
  }

  /**
   * Take up the twist at the parameter its handle snapped to.
   *
   * Two of the four twists weld at their far end: a whirl's apex cuts run out onto the gyro
   * vertices they were heading for, and a volute's fans rise flush with the gap triangles
   * beside them, and either weld gives the propeller. So `t = 1` there means what it means
   * on a base drag — the welded max — and, like the rectify / join, it can be switched off,
   * in which case the drag stops just short rather than reaching coincident vertices. A
   * snub / gyro welds nothing at its end, so its `allowMax` is simply always on.
   */
  private engageTwist(d: Drag, snapT: number): void {
    let t = Math.max(0, Math.min(1, snapT));
    let weld = false;
    if (t >= 1) {
      if (d.twist!.allowMax) weld = true;
      else t = MAX_T_WITHOUT_WELD;
    }
    d.twisting = true;
    d.t = t;
    d.weld = weld;
  }

  /** The preview edges to leave undrawn: the ones the plan never draws at all (the gyro's
   *  dissolved join edges), plus, at the weld, the ones collapsing into it — so each pair
   *  of about-to-merge faces reads as the single face it is about to become. */
  private hiddenEdgeKeys(plan: MorphPlan, weld: boolean): Set<string> {
    const keys = new Set<string>();
    for (const [a, b] of plan.hiddenEdges ?? []) keys.add(edgeKey(a, b));
    if (weld) for (const [a, b] of plan.vanishingEdges) keys.add(edgeKey(a, b));
    return keys;
  }

  /**
   * The twist handle extending the base drag's weld at `anchor`: built on first use, then
   * reused for the rest of the drag. A drag can weld, retreat and weld again — or, on a
   * vertex, weld down one incident edge and then another — so the same handles are asked
   * for repeatedly, and building one is far too costly to repeat. Restoring the cached
   * base-return line alongside it keeps the two in step: each is the way back down to the
   * weld the other hangs off.
   */
  private twistFor(d: Drag, anchor: Vector3 | undefined): PlanSlot | null {
    if (!anchor) return null;
    const hit = d.twists.find(
      (e) => e.base === d.base.plan && e.anchor.distanceTo(anchor) <= TWIST_ANCHOR_EPS,
    );
    if (hit) {
      d.baseReturnLine = hit.returnLine;
      return hit.slot;
    }
    d.baseReturnLine = null;
    const slot = this.buildTwist(d, anchor); // also sets d.baseReturnLine
    d.twists.push({
      base: d.base.plan,
      anchor: anchor.clone(),
      slot,
      returnLine: d.baseReturnLine,
    });
    return slot;
  }

  /** Perpendicular distance from the cursor ray to the fixed base-return segment (or
   *  Infinity when it isn't set), used to rank it against the twist handle. */
  private baseReturnDist(d: Drag, ray: Ray): number {
    const ln = d.baseReturnLine;
    if (!ln) return Infinity;
    const dir = ln.far.clone().sub(ln.origin);
    const s = Math.max(0, Math.min(1, closestLineParam(ln.origin, dir, ray.origin, ray.direction)));
    return distancePointToRay(ln.origin.clone().addScaledVector(dir, s), ray);
  }

  /**
   * The snub stage of a vertex drag. Before the base drag latches a full rectify (or
   * before the snub plan exists) this is just the truncate drag. Once rectified, three
   * straight lines are live at once: the base un-rectify line and the two chiral snub
   * lines. The cursor snaps to the nearest, so heading back down the original edge
   * un-rectifies while veering onto either snub line twists that way.
   */
  private updateSnubStage(
    d: Drag,
    ray: Ray,
    baseSnap: ReturnType<MorphPlan["snap"]>,
    baseT: number,
    weld: boolean,
  ): void {
    if (!d.weldLatched || !d.twist) {
      d.twisting = false;
      d.t = baseT;
      d.weld = weld;
      this.showBasePreview(d, baseSnap, weld, true);
    } else {
      // Take the nearest of the un-rectify line (a single fixed segment, so the base
      // plan can't re-snap to another incident edge while the cursor rides far out a
      // snub line) and the two snub lines (the twist plan's snap has already picked the
      // nearer chirality). The snub engages only once the cursor has moved a little way
      // down its line: right at the rectify vertex, or heading back down the un-rectify
      // line, the base plan holds the plain rectify, so a release there commits that
      // rather than cancelling the drag.
      const twistSnap = d.twist.plan.snap(ray);
      const baseDist = this.baseReturnDist(d, ray);
      const twistDist = distancePointToRay(twistSnap.point, ray);
      if (twistDist <= baseDist && twistSnap.t > TWIST_ENGAGE_T) {
        this.engageTwist(d, twistSnap.t);
        this.showTwistPreview(d, twistSnap.point, twistSnap.highlight);
      } else {
        d.twisting = false;
        d.t = weld ? 1 : baseT;
        d.weld = weld;
        // At the rectify vertex, hint the nearest snub line so its availability shows,
        // as a hovered vertex highlights its nearest truncation line. Once the cursor
        // heads back down the un-rectify line, show that line instead.
        const hint = weld ? twistSnap.highlight : undefined;
        this.showBasePreview(d, baseSnap, weld, true, hint);
      }
    }
    const active = this.activeSlot(d);
    this.readout.setDrag({ kind: active.plan.kind, weld: d.weld, t: d.t, selIds: d.sel, selKind: d.kind });
  }

  /**
   * Render the base truncate/kis/edge preview at its current t (welding at the max).
   * `lineOverride` replaces the highlighted range line: at the rectify state it hints
   * the nearest snub line, while the geometry and the release still commit the plain
   * rectify.
   */
  private showBasePreview(
    d: Drag,
    snap: ReturnType<MorphPlan["snap"]>,
    weld: boolean,
    twistCapable: boolean,
    lineOverride?: { a: Vector3; b: Vector3 },
  ): void {
    const t = twistCapable ? d.t : (weld ? 1 : snap.t);
    const plan = d.base.plan;
    const hiddenEdges = this.hiddenEdgeKeys(plan, weld);
    this.view.showPreview(
      { vertices: plan.positions(t), faces: plan.previewFaces },
      { faceColors: plan.previewFaceColors(t, weld), edgeColors: plan.previewEdgeColors, hiddenEdges },
    );
    const inSel = d.hasSelection;
    this.view.setDragMarker(snap.point, inSel ? config.render.selectedColor : config.render.dragMarkerColor);
    const line = lineOverride ?? snap.highlight;
    if (line)
      this.view.setEdgeHighlight(line.a, line.b, inSel ? config.render.selectedColor : config.render.dragLineColor);
    else this.view.clearEdgeHighlight();
  }

  /**
   * Render the snub/gyro twist preview at the current parameter. `highlight` (snub) is
   * the active straight handle line, drawn with the same white tube as every other drag
   * line; when absent (gyro's arc handle) the arc replaces the straight line.
   */
  private showTwistPreview(d: Drag, ridePoint: Vector3, highlight?: { a: Vector3; b: Vector3 }): void {
    const plan = d.twist!.plan;
    const hiddenEdges = this.hiddenEdgeKeys(plan, d.weld);
    this.view.showPreview(
      { vertices: plan.positions(d.t), faces: plan.previewFaces },
      { faceColors: plan.previewFaceColors(d.t, d.weld), edgeColors: plan.previewEdgeColors, hiddenEdges },
    );
    this.view.setDragMarker(ridePoint, config.render.dragMarkerColor);
    if (highlight) this.view.setEdgeHighlight(highlight.a, highlight.b, config.render.dragLineColor);
    else this.view.clearEdgeHighlight(); // the arc replaces the straight range line
  }

  /**
   * Show / hide the twist arc handle. The arc appears once the join is latched, the
   * same moment snub's line hints appear, drawn at its full extent at reduced opacity.
   * While actively twisting, a solid progress arc (midpoint → cursor) is overlaid to
   * show how far the gyro has been rotated.
   */
  private updateArc(d: Drag): void {
    if (!d.twist || !d.twist.plan.arc || !d.weldLatched) {
      this.view.clearTwistArc();
      return;
    }
    // Match the drag range line's on-screen thickness (camera-stable, same formula).
    const a = d.twist.plan.arc();
    const camDist = this.camera.position.distanceTo(a.center);
    const radius =
      config.render.dragLineRadius * Math.max(camDist / config.camera.startDistance, 0.05);
    this.view.setTwistArc(a, config.render.twistArcHintOpacity, radius, d.twisting);
  }

  private startDrag(ray: Ray): void {
    const p = this.pending!;
    if (!p.marker) {
      // Left-drag on empty space does nothing (orbit is the right button).
      this.mode = "idle";
      this.pending = null;
      return;
    }
    const kind = p.marker.kind;
    const id = p.marker.id;

    // Edge handles drive chamfer / subdivide: always global, no modifiers. The cursor
    // picks the drag axis, which in turn selects the operation.
    if (kind === "edge") {
      this.startEdgeDrag(p.marker, ray);
      return;
    }

    // A modifier drag (Option / Cmd-Ctrl) folds handles into the selection and drags the
    // whole set, but only for the duration: if the drag commits nothing, onUp restores
    // this snapshot, so an aimless modifier-drag leaves nothing selected.
    const restore: SelectionSnapshot | null =
      p.alt || p.cmd ? { kind: this.selection.kind, ids: new Set(this.selection.ids) } : null;

    // Decide the participating selection set. The default (no modifier) drag affects
    // the dragged handle's whole arity group (degree-n vertices / n-gon faces).
    let sel: Set<number> | null;
    let persistent = false; // whether a lasting selection should survive this drag
    if (p.alt) {
      // Option: add the hovered handle's arity group to the selection and drag the
      // whole (possibly multi-arity) selection.
      this.selection.addAll(kind, this.arityGroup(kind, this.arityOf(p.marker)));
      sel = this.selection.setFor(kind);
      persistent = true;
    } else if (p.cmd && config.features.commandAddsToSelection) {
      // Command (additive mode): fold just this handle into the selection.
      this.selection.add(kind, id);
      sel = this.selection.setFor(kind);
      persistent = true;
    } else if (p.cmd) {
      // Command (default): operate on this single handle only, clearing any selection.
      this.selection.clear();
      sel = new Set([id]);
    } else if (this.selection.kind === kind && this.selection.ids.has(id)) {
      // No modifier, but dragging a member of an existing (Option-built) selection:
      // operate on the whole selection.
      sel = this.selection.setFor(kind);
      persistent = true;
    } else {
      // No modifier: default to the dragged handle's arity group; drop any selection.
      this.selection.clear();
      sel = this.arityGroup(kind, this.arityOf(p.marker));
    }
    // A group covering every element of its kind means the whole solid, which the rest
    // of the pipeline represents as null.
    const total = kind === "face" ? this.current.faces.length : this.current.vertices.length;
    if (sel && sel.size === total) sel = null;

    // Build the base operation (truncate / kis). The twist form (snub / gyro) is built
    // lazily once the drag is deep enough (see buildTwist).
    const base = this.buildPlan(kind, id, sel);
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
      twist: null, twists: [], twisting: false, weldLatched: false, lastRay: null,
      kind, id,
      hasSelection: persistent,
      selCount: sel ? sel.size : null,
      restore,
      t: 0, weld: false,
      edgeAxis: null,
      baseReturnLine: null,
    };
    this.mode = "dragging";
    const plan = base.plan;
    this.view.showPreview(
      { vertices: plan.positions(0), faces: plan.previewFaces },
      { faceColors: plan.previewFaceColors(0), edgeColors: plan.previewEdgeColors },
    );
    this.readout.setDrag({
      kind: plan.kind, weld: false, t: 0,
      selIds: this.drag.sel, selKind: this.drag.kind,
    });
    // The drag marker is positioned on the first move (when we have a snap point).
  }

  private buildPlan(kind: MarkerKind, id: number, sel: Set<number> | null): PlanSlot | null {
    const ops = config.features.operations;
    try {
      if (kind === "vertex") {
        if (!ops.truncate) return null;
        return { plan: buildTruncate(this.current, id, sel, this.inView, this.collapseFractions()), allowMax: ops.rectify };
      }
      if (!ops.kis) return null;
      return { plan: buildKis(this.current, id, sel), allowMax: ops.join };
    } catch (err) {
      console.warn("Operation unavailable:", err);
      return null;
    }
  }

  /**
   * Build the twist plan extending the base drag's full rectify/join. The base drag is
   * committed to its welded max to get the rectified/joined polyhedron, then the twist
   * that extends that weld end is built on it: a Rectify (from truncate, or subdivide) is
   * twisted by the snub — or, off a subdivide, the volute, which is the snub with the
   * vertex figures kissed back into the vertices they were cut from; a Join (from kis, or
   * chamfer) by the gyro — or, off a chamfer, the whirl, the gyro with the join apexes
   * truncated back into the faces they were collapsed from. Those two restore what the
   * weld collapsed, so they have somewhere to arrive: both weld again at the far end of
   * the twist, and both weld into the propeller, so an edge drag can run all the way from
   * one solid to its propeller in a single gesture, along either branch.
   *
   * `weldPoint` is the base drag's current max target — the rectify vertex or join apex —
   * which is both where the twist's handle sits and where the drag left the cursor.
   */
  private buildTwist(d: Drag, weldPoint: Vector3 | undefined): PlanSlot | null {
    if (!weldPoint) return null;
    try {
      const { mesh, colors } = d.base.plan.commit(1, true);
      const R = new Polyhedron(mesh, colors);
      const kind = d.base.plan.kind;
      // A snub / gyro just ends at its full twist, so its far end is always reachable. A
      // whirl / volute welds there instead, into the propeller, so that end is a weld the
      // `propeller` feature can withhold — the drag then stops just short of it.
      const twistMax = config.features.operations.propeller;

      if (kind === "truncate" || kind === "subdivide") {
        // The rectify vertex nearest where the drag ended is the dragged corner: the
        // truncated vertex's, or the subdivided edge's.
        let rVid = 0;
        let best = Infinity;
        R.vertices.forEach((p, i) => {
          const dist = p.distanceTo(weldPoint);
          if (dist < best) { best = dist; rVid = i; }
        });
        if (kind === "subdivide") {
          // The un-subdivide line: back down the radial the drag climbed, to where the
          // subdivision first put this edge's vertex (its collapse point on the edge).
          const rest = this.edgeRestPoint(d);
          d.baseReturnLine = { origin: weldPoint.clone(), far: rest.clone() };
          // A rectify keeps the original faces first and appends one figure per original
          // vertex, so the face count splits the two. That radial is also what the volute
          // reads its handle bisector back down, so it needs the camera to see it — the
          // climb has no direction of its own in the rectify vertex's tangent plane.
          return {
            plan: buildVolute(
              R, rVid, this.current.faces.length,
              rest, this.camera.position.clone(), this.inView,
            ),
            allowMax: twistMax,
          };
        }
        const originVertex = this.current.vertices[d.id].clone();
        // The un-rectify line: from the rectify vertex out to the original vertex.
        d.baseReturnLine = { origin: R.vertices[rVid].clone(), far: originVertex.clone() };
        return { plan: buildSnub(R, rVid, originVertex, this.inView), allowMax: true };
      }

      if (kind === "chamfer") {
        // The un-chamfer line: from the join apex back down the inset seam the drag swept
        // across the tracked face, to the dragged edge's midpoint where it started.
        d.baseReturnLine = {
          origin: weldPoint.clone(),
          far: d.edgeAxis!.info.midpoint.clone(),
        };
        // A join keeps the original vertices first and appends one apex per original face,
        // so the vertex count splits the two. The arc handle is the gyro's, placed the same
        // way: both drags arrive at the same join apex, so both turn the same wheel there.
        return {
          plan: buildWhirl(
            R, this.current.vertices.length, weldPoint.clone(),
            this.camera.position.clone(), this.inView,
          ),
          allowMax: twistMax,
        };
      }

      // The un-join line: from the join apex back down to the original face centroid
      // (the kis normal the drag climbed), so heading back down it un-joins.
      const loop = this.current.faces[d.id];
      const centroid = new Vector3();
      for (const vi of loop) centroid.add(this.current.vertices[vi]);
      centroid.multiplyScalar(1 / loop.length);
      d.baseReturnLine = { origin: weldPoint.clone(), far: centroid };
      return { plan: buildGyro(R, d.id, weldPoint.clone(), this.camera.position.clone(), this.inView), allowMax: true };
    } catch (err) {
      console.warn("Twist unavailable:", err);
      return null;
    }
  }

  /** Where a subdivide drag's new edge vertex rests before the drag sweeps it outward:
   *  the edge's truncation collapse point, which is what the subdivision seeds it at. */
  private edgeRestPoint(d: Drag): Vector3 {
    const [a, b] = d.edgeAxis!.edge;
    const he = this.halfEdgeFor(a, b);
    const s = (he && this.collapseFractions().get(he.id)) ?? 0.5;
    return this.current.vertices[a].clone().lerp(this.current.vertices[b], s);
  }

  /** The half-edge of the undirected edge (a,b) in the current DCEL, or null. */
  private halfEdgeFor(a: number, b: number): HalfEdge | null {
    for (const h of this.current.dcel.halfedges) {
      if (h.origin.id === a && h.next.origin.id === b) return h;
    }
    return null;
  }

  /**
   * The three drag axes of an edge handle, as lines through the edge midpoint:
   * perpendicular to the edge within each bordering face (chamfer), and along the edge
   * normal, the mean of the two face normals (subdivide).
   */
  private edgeAxes(a: number, b: number): EdgeAxisInfo | null {
    const he = this.halfEdgeFor(a, b);
    if (!he || !he.twin) return null;
    const fA = he.face;
    const fB = he.twin.face;
    const pa = this.current.vertices[a];
    const pb = this.current.vertices[b];
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const edgeDir = pb.clone().sub(pa).normalize();
    // Component of v perpendicular to the edge (within-face sweep direction).
    const perp = (v: Vector3) => v.clone().sub(edgeDir.clone().multiplyScalar(v.dot(edgeDir)));
    const outward = (f: typeof fA) => {
      const n = faceNormalHE(f);
      if (n.dot(faceCentroidHE(f)) < 0) n.negate();
      return n;
    };
    const cA = faceCentroidHE(fA);
    const cB = faceCentroidHE(fB);
    const dirA = perp(cA.clone().sub(mid));
    const dirB = perp(cB.clone().sub(mid));
    const nA = outward(fA);
    const nB = outward(fB);
    const normalDir = nA.clone().add(nB).normalize();
    return {
      midpoint: mid,
      faceA: fA.id,
      faceB: fB.id,
      axes: [
        { which: "A", dir: dirA, view: { point: cA, normal: nA } },
        { which: "B", dir: dirB, view: { point: cB, normal: nB } },
        { which: "normal", dir: normalDir },
      ],
    };
  }

  /** Begin a chamfer / subdivide drag from an edge handle: pick the nearest axis to
   *  the cursor ray, then build the corresponding operation. */
  private startEdgeDrag(marker: Marker, ray: Ray): void {
    const info = marker.edge && this.edgeAxes(marker.edge[0], marker.edge[1]);
    if (!marker.edge || !info) {
      this.mode = "idle";
      this.pending = null;
      return;
    }
    // Pick the axis whose infinite line passes nearest the cursor ray, then build the
    // matching operation. Both are re-evaluated every frame of the drag, so moving the
    // cursor can switch axes (see updateEdgeAxis).
    const which = this.pickEdgeAxis(info, ray);
    const slot = which && this.buildEdgeSlot(marker.edge, which, info);
    if (!which || !slot) {
      this.mode = "idle";
      this.pending = null;
      return;
    }

    this.solver = null;
    this.shapes.setSolving(false);
    this.drag = {
      base: slot,
      sel: null,
      twist: null,
      twists: [],
      twisting: false,
      weldLatched: false,
      lastRay: null,
      kind: "edge",
      id: marker.id,
      hasSelection: false,
      selCount: null,
      restore: null,
      t: 0,
      weld: false,
      edgeAxis: { edge: marker.edge, info, which, slots: new Map([[which, slot]]) },
      baseReturnLine: null,
    };
    this.mode = "dragging";
    const verts = slot.plan.positions(0);
    this.view.showPreview(
      { vertices: verts, faces: slot.plan.previewFaces },
      { faceColors: slot.plan.previewFaceColors(0), edgeColors: slot.plan.previewEdgeColors },
    );
    this.readout.setDrag({
      kind: slot.plan.kind, weld: false, t: 0, selIds: null, selKind: "edge",
    });
  }

  /** The edge axis whose infinite line passes nearest the cursor ray, or null when
   *  none is usable. Re-run each frame so a drag can switch axes like a vertex drag
   *  switches incident edges. */
  private pickEdgeAxis(info: EdgeAxisInfo, ray: Ray): "A" | "B" | "normal" | null {
    let best: { which: "A" | "B" | "normal"; dist: number } | null = null;
    for (const ax of info.axes) {
      if (ax.dir.lengthSq() < 1e-12) continue;
      // Skip a chamfer axis whose bordering face is turned away from the camera, the
      // face analog of truncate culling edges that face away: on a back face only the
      // other chamfer line and the subdivide line stay selectable.
      if (ax.view && !this.inView(ax.view.point, [ax.view.normal])) continue;
      // Measure to the half-line from the midpoint along `dir`, not the full line.
      // Clamping the parameter at 0 stops the region opposite an axis from snapping to
      // it, so the three axes carve the space into three regions, one around each line,
      // instead of pairing each line with its opposite.
      const s = Math.max(0, closestLineParam(info.midpoint, ax.dir, ray.origin, ray.direction));
      const point = info.midpoint.clone().add(ax.dir.clone().multiplyScalar(s));
      const dist = distancePointToRay(point, ray);
      if (!best || dist < best.dist) best = { which: ax.which, dist };
    }
    return best?.which ?? null;
  }

  /** Build the chamfer / subdivide plan for an edge axis, or null when that op is
   *  disabled or unavailable for this edge. */
  private buildEdgeSlot(
    edge: [number, number],
    which: "A" | "B" | "normal",
    info: EdgeAxisInfo,
  ): PlanSlot | null {
    const ops = config.features.operations;
    try {
      if (which === "normal") {
        if (!ops.subdivide) return null;
        // Hand over the memoized collapse fractions: subdivide seeds its edge vertices at
        // truncate's collapse points, and re-running that least-squares solve on every
        // axis switch is what a switch would otherwise cost.
        return {
          plan: buildSubdivide(this.current, edge, this.inView, this.collapseFractions()),
          allowMax: true,
        };
      }
      if (!ops.chamfer) return null;
      const track = which === "A" ? info.faceA : info.faceB;
      return { plan: buildChamfer(this.current, edge, track, this.inView), allowMax: true };
    } catch (err) {
      console.warn("Edge operation unavailable:", err);
      return null;
    }
  }

  /** The built plan for one axis of an edge drag, memoized for the drag: the cursor can
   *  cross between the three axes freely, and rebuilding each time it did would stutter. */
  private edgeSlotFor(e: EdgeAxisState, which: "A" | "B" | "normal"): PlanSlot | null {
    if (!e.slots.has(which)) e.slots.set(which, this.buildEdgeSlot(e.edge, which, e.info));
    return e.slots.get(which)!;
  }

  /** During an edge drag, switch to whichever axis is now nearest the cursor (the
   *  chamfer-A / chamfer-B / subdivide choice). Keeps the current axis if the nearest
   *  one's op is disabled. */
  private updateEdgeAxis(ray: Ray): void {
    const d = this.drag!;
    const e = d.edgeAxis;
    if (!e) return;
    const which = this.pickEdgeAxis(e.info, ray);
    if (!which || which === e.which) return;
    const slot = this.edgeSlotFor(e, which);
    if (!slot) return;
    e.which = which;
    d.base = slot;
  }

  private onUp(e: PointerEvent, pointerStillDown: boolean = false): void {
    if (e.button !== 0) {
      this.controls.enabled = true;
      return;
    }
    this.view.clearEdgeHighlight();
    this.view.hideDragMarker();
    this.view.clearTwistArc();

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
        // `this.current` is still the pre-operation shape here (it is committed below),
        // so the op descriptor classifies against the geometry that was acted on. The
        // chirality (snub / gyro only) distinguishes the two committed enantiomorphs.
        // A twist, a full rectify/join weld and a full truncation/kis (t≥0.5) all act
        // on the whole solid; only an n-truncate/n-kis (t<0.5) classifies its arity
        // subset. Edge ops (chamfer/subdivide) are always global.
        const whole =
          this.drag.kind === "edge" ||
          this.drag.twisting ||
          this.drag.weld ||
          this.drag.t >= 0.5;
        const op: OpDescriptor = {
          kind: active.plan.kind,
          weld: this.drag.weld,
          sel: whole
            ? { kind: "whole" }
            : classifySelection(this.current, this.drag.sel, this.drag.kind),
          chirality: active.plan.chirality?.(),
        };
        const label = operationLabel(op);
        // Colors at release: a welded form takes its committed colors as-is, so any
        // difference from the drag's t=1 look snaps instantly; an unwelded commit fades
        // from the interpolated drag colors.
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
        this.logColors(`commit "${label}" (weld=${this.drag.weld})`, poly);
        // Render the committed geometry with the `fromRGB` colors, then start the fade.
        this.view.showPreview(
          { vertices: mesh.vertices, faces: mesh.faces },
          { faceColors: fromRGB, edgeColors: finalColors.edge },
        );
        this.view.startColorFade(fromRGB, toRGB, config.render.colorFadeSeconds);
        this.commitPoly(poly, label, op);
      }
    } else if (this.mode === "pending" && this.pending) {
      // a click (no drag): selection bookkeeping
      const p = this.pending;
      if (!p.marker) {
        this.selection.clear(); // click on empty space clears
      } else if (p.alt) {
        // Option click: add the clicked handle's whole arity group to the selection, or
        // toggle it back off when that exact group is already the selection.
        const k = p.marker.kind;
        const group = this.arityGroup(k, this.arityOf(p.marker));
        if (this.selection.kind === k && sameIdSet(this.selection.ids, group))
          this.selection.clear();
        else this.selection.addAll(k, group);
      } else if (p.cmd && config.features.commandAddsToSelection) {
        this.selection.toggle(p.marker.kind, p.marker.id); // additive: toggle one
      } else {
        // A plain click, or a Command click in single-element (default) mode, clears the
        // selection rather than selecting one handle, so it never looks like clicking
        // can build a multi-selection. Command still acts on a single element when
        // dragged.
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
    // A prior discovery may still be waiting on its relaxation. Persist it now, with
    // whatever geometry it has settled into, before this commit grows the timeline and
    // the pending name attaches to the wrong slice of it.
    this.flushPendingSave();
    this.current = poly;
    this.invalid = false;
    if (this.firstEdit) {
      this.firstEdit = false;
      this.onFirstEdit();
    }
    this.history.push(poly, label, this.currentOptions(), op);
    this.renderHistory();
    // Identify and name right away: identification is purely combinatorial, so it works
    // before the faces have planarized. The relaxation may re-identify the settled shape
    // later, but the name and history entry are set now even if the faces never flatten.
    this.runIdentify(poly, true);
    if (config.solver.enabled) {
      this.startSolve(poly); // mutates poly's vertices in place across frames
    } else {
      // Keep the release color-fade running over the (un-relaxed) committed shape.
      this.view.setPolyhedron(poly, false, true);
    }
  }

  private finishSolve(): void {
    if (!this.solver) return;
    this.solver = null;
    this.shapes.setSolving(false);
    // Keep any in-progress release color-fade running on the now-relaxed shape.
    this.view.setPolyhedron(this.current, this.invalid, true);
    this.runIdentify(this.current, true);
    // The shape has settled into its canonical form, so persist any timeline waiting on
    // this relaxation (flagged at commit, or recognized only now that the faces have
    // flattened).
    this.flushPendingSave();
  }

  /** Persist the timeline that first produced `name` (the slice up to the current
   *  entry). No-op on re-saves, so the original construction path is kept. */
  private saveTimeline(name: string): void {
    this.historyStore.save(
      name,
      this.history.list.slice(0, this.history.current + 1),
      this.history.list[0]?.label ?? "",
    );
  }

  /** Save a discovery that was held pending its relaxation, if any. Entries hold live
   *  Polyhedron references, so this reads whatever geometry they have settled into. */
  private flushPendingSave(): void {
    if (!this.pendingSave) return;
    this.saveTimeline(this.pendingSave);
    this.pendingSave = null;
  }

  // ---- identification ------------------------------------------------------
  // `discover` is true only when the shape was just made (a fresh commit / solve), so
  // undo/redo, restore and seed loads never count as discovering a shape.
  private runIdentify(poly: Polyhedron, discover = false): void {
    const { name, signature } = identify(poly);
    this.lastName = name;
    this.lastSignature = signature;
    let justDiscovered: string | null = null;
    if (discover && !this.invalid && name) {
      const { isNew, first } = this.discoveries.add(name);
      this.shapes.setCount(this.discoveries.count);
      if (isNew) {
        this.shapes.markNew();
        justDiscovered = name;
      }
      if (config.discovery.enabled && isNew) this.celebrate(name, first);
    }
    // Record the result against the current history entry; invalid states show no name.
    this.history.annotate(this.history.current, this.invalid ? null : name, this.invalid);
    this.renderHistory();
    // Persist the timeline that just produced a brand-new shape, so the LIBRARY can
    // reopen it here with its history. When the solver will relax the fresh commit,
    // defer the save until it settles (finishSolve), so the stored final entry is the
    // canonical form rather than the raw commit. With the solver off there is no
    // relaxation to wait for and the commit geometry is already final.
    if (justDiscovered) {
      if (config.solver.enabled) this.pendingSave = justDiscovered;
      else this.saveTimeline(justDiscovered);
    }
    // Show the derived history name (modifier + nearest known ancestor) when the
    // shape isn't a known polyhedron; fall back to the raw identify result.
    const display = this.history.list[this.history.current]?.displayName ?? name;
    this.readout.setPoly({
      poly, name: display, signature,
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

    // Edge handles drive chamfer / subdivide, with no arity or multi-select. Hovering
    // one shows the handle and highlights its whole edge; modifiers don't apply.
    if (hovering && this.hover!.kind === "edge") {
      const state = this.hoverInRange ? "hover" : "proximity";
      this.view.showMarker("edge", this.hover!.id, state);
      if (this.hoverInRange && this.hoverRay) {
        this.showHoverPreview(this.hover!, this.hoverRay, false);
      }
      return;
    }

    // Option gesture: hovering a handle in range previews its whole arity group, every
    // matching handle lighting up, and a click/drag adds them to the selection.
    const arity = hovering ? this.gestureArity(this.hover!) : null;
    if (arity != null && this.hoverInRange) {
      const k = this.hover!.kind;
      const group = this.arityGroup(k, arity);
      for (const id of group) this.view.showMarker(k, id, "selected");
      if (this.mode === "idle" && !this.solver) {
        // The readout shows what a click would yield: the existing same-kind
        // selection unioned with the hovered group.
        const union = new Set(group);
        if (this.selection.kind === k) for (const id of this.selection.ids) union.add(id);
        this.readout.updateSelection(union, k);
      }
      return;
    }

    // A handle is affected when it is part of the active selection: either already
    // command-clicked, or Cmd is held so a drag would add it. Affected handles preview
    // in the selection color; a plain handle keeps the neutral hover look.
    const selected = hovering && this.selection.isSelected(this.hover!.kind, this.hover!.id);
    const affected = selected || (hovering && this.hoverMulti && this.hoverInRange);

    // A Cmd-hovered handle isn't in the selection set yet, but a drag would add it, so
    // count it toward the readout's selection. Skipped while dragging or relaxing, where
    // the readout shows the live operation / status instead.
    if (this.mode === "idle" && !this.solver)
      this.syncReadoutSelection(affected && !selected ? this.hover : null);

    if (!hovering) return;

    // Within drag range: prominent. Merely nearby: a subtle proximity hint.
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
   * Hover preview of what a drag would affect: the incident edge (vertex) or the whole
   * face (face center). `affected` marks a handle in the active selection, and splits
   * rendering a plain handle from a selected one — currently only a color difference.
   */
  private showHoverPreview(marker: Marker, ray: Ray, affected: boolean): void {
    // The id guards below reject a marker left over from a previous mesh: a commit or
    // undo may have swapped the geometry out from under it.
    if (marker.kind === "edge") {
      // Highlight the whole hovered edge (the handle drives chamfer / subdivide).
      const ops = config.features.operations;
      if (marker.edge && (ops.chamfer || ops.subdivide)) {
        const [a, b] = marker.edge;
        if (a < this.current.vertices.length && b < this.current.vertices.length) {
          this.view.setEdgeHighlight(
            this.current.vertices[a],
            this.current.vertices[b],
            affected ? config.render.selectedColor : config.render.dragLineColor,
          );
        }
      }
      return;
    }
    if (marker.id >= (marker.kind === "vertex" ? this.current.vertices : this.current.faces).length)
      return;
    if (marker.kind === "vertex" && config.features.operations.truncate) {
      const e = closestIncidentEdge(this.current, marker.id, ray, this.inView, this.collapseFractions());
      // While hovering, the line spans the full drag range: the vertex center (e.from)
      // to the rectify max (e.mid, the edge midpoint). It shrinks to the snapped cursor
      // position only during a drag.
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
