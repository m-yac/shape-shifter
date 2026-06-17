import { Vector3, type PerspectiveCamera, type Ray } from "three";
import { type ArcballControls } from "three/examples/jsm/controls/ArcballControls.js";
import { Polyhedron } from "../geometry/polyhedron";
import { type Mesh } from "../geometry/HalfEdge";
import { type MorphPlan, type OperationKind } from "../operations/types";
import { buildTruncate, closestIncidentEdge } from "../operations/truncate";
import { buildKis } from "../operations/kis";
import { buildSnub } from "../operations/snub";
import { buildGyro } from "../operations/gyro";
import { RelaxSolver, type Strategy } from "../solver/solver";
import { extractTopology } from "../solver/topology";
import { type Signature, describeSignature } from "../identify/configurations";
import { identify, buildGraphData, namedGraphFor } from "../identify/identify";
import { SceneView, type Marker, type MarkerKind } from "../render/sceneView";
import { Picker } from "./picker";
import { Selection } from "./selection";
import { Readout } from "../ui/readout";
import { History, type HistoryEntry } from "../history/history";
import { HistoryPanel } from "../ui/historyPanel";
import { type Screen } from "../ui/screen";
import { type GlitchOverlay } from "../ui/glitch";
import { ShapesPanel } from "../ui/shapesPanel";
import { DiscoveryPopup } from "../ui/discoveryPopup";
import { Discoveries } from "../discoveries";
import { solidTypeFor } from "../data/namedPolyhedra";
import { config } from "../config";

const DRAG_START_PIXELS = 4;
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

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
  addedToSelection: boolean; // this Cmd-drag added the handle to the selection (temp)
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

  private mode: "idle" | "pending" | "dragging" = "idle";
  private pending: Pending | null = null;
  private drag: Drag | null = null;
  private hover: Marker | null = null;
  private hoverInRange = false;
  private hoverRay: Ray | null = null;
  private hoverMulti = false; // Cmd/Ctrl held while hovering (would drag as a selection)

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
    this.shapes.setCount(this.discoveries.count);
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
    this.history.reset(initial, seedLabel);
    this.view.setPolyhedron(this.current, false);
    this.runIdentify(this.current);
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
    this.invalid = false;
    this.current = poly;
    this.selection.clear();
    this.history.reset(poly, seedLabel);
    this.view.setPolyhedron(poly, false);
    this.runIdentify(poly);
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
    this.mode = "idle";
    this.pending = null;
    this.drag = null;
    this.readout.setDrag(null); // drop any stale drag readout (e.g. undo mid-drag)
    this.selection.clear();
    this.current = entry.poly;
    this.invalid = entry.invalid;
    this.view.setPolyhedron(entry.poly, entry.invalid);
    this.refreshHighlights();
    this.runIdentify(entry.poly);
  }

  private renderHistory(): void {
    this.panel.render(this.history.list, this.history.current);
  }

  /**
   * Human-readable label for a committed operation (e.g. "Rectify", "Kis 1 face").
   * `selCount` is null when the operation affected the whole solid.
   *
   * Welding (the max end) only fully Rectifies/Joins when every element takes part.
   * On a partial selection the welded end is a HYBRID — elements with a selected
   * neighbour merge (rectify/join) while those bordering unselected ones stay cut
   * (truncate/kis) — so it reads "Truncate/Rectify N" / "Kis/Join N".
   */
  private static label(
    kind: OperationKind,
    weld: boolean,
    selCount: number | null,
  ): string {
    const partial = selCount != null;
    let base: string;
    if (kind === "truncate") {
      base = !weld ? "Truncate" : partial ? "Truncate/Rectify" : "Rectify";
    } else if (kind === "kis") {
      base = !weld ? "Kis" : partial ? "Kis/Join" : "Join";
    } else {
      base = kind === "snub" ? "Snub" : "Gyro";
      if (!weld) { base = "Partial " + base; }
    }
    if (!partial) return base;
    const onFaces = kind === "kis" || kind === "gyro";
    const noun = onFaces
      ? selCount === 1 ? "face" : "faces"
      : selCount === 1 ? "vertex" : "vertices";
    return `${base} ${selCount} ${noun}`;
  }

  /**
   * Manually (re-)run the relaxation on the current shape. With `forced` set, the
   * regularizer is locked to that single strategy instead of the automatic
   * anti-collapse escalation — letting you isolate the coplanarity (`canonical`)
   * step and watch it act. Ignored mid-drag. Refines the current state in place.
   */
  relax(forced: Strategy | null = null): void {
    if (this.mode !== "idle" || !config.solver.enabled) return;
    const topo = extractTopology(this.current);
    this.solver = new RelaxSolver(this.current.mesh.vertices, topo, forced);
    this.view.setSurfaceColor(config.render.adjustingColor);
    this.readout.setHint(`● relaxing: ${this.solver.statusLabel}`);
  }

  // ---- frame update --------------------------------------------------------
  update(): void {
    this.view.updateMarkerScales(this.camera, config.camera.startDistance);
    this.view.updateEffects(performance.now()); // advance the discovery glow pulse
    if (this.solver) {
      const working = this.solver.advance();
      this.view.showPreview({
        vertices: this.solver.mesh.vertices,
        faces: this.solver.mesh.faces,
      });
      if (working) this.readout.setHint(`● relaxing: ${this.solver.statusLabel}`);
      else this.finishSolve();
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
    const multi = IS_MAC ? e.metaKey : e.ctrlKey;
    if (multi === this.hoverMulti) return;
    this.hoverMulti = multi;
    if (this.hover) this.refreshHighlights();
  }

  private allMarkers(): Marker[] {
    return [...this.view.vertexMarkers, ...this.view.faceMarkers];
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
      multi: (IS_MAC ? e.metaKey : e.ctrlKey) && config.features.multiSelect,
      x: e.clientX,
      y: e.clientY,
    };
    this.mode = "pending";
    // Grabbing a handle suppresses camera orbit; empty space still orbits.
    if (marker) this.controls.enabled = false;
  }

  private onMove(e: PointerEvent): void {
    if (this.mode === "idle") {
      this.hoverMulti =
        (IS_MAC ? e.metaKey : e.ctrlKey) && config.features.multiSelect;
      // While the solver is relaxing, nothing is interactable yet (positions are
      // mid-flight), so suppress hover entirely.
      if (config.features.hoverHighlight && !this.solver) {
        const hit = this.picker.pickClosest(
          this.allMarkers(),
          e.clientX,
          e.clientY,
          this.canvas,
          this.camera,
          config.interaction.proximityPixelRadius,
        );
        this.hover = hit?.marker ?? null;
        this.hoverInRange =
          !!hit && hit.pixelDist <= config.interaction.hoverPixelRadius;
        this.hoverRay = this.picker.ray(e.clientX, e.clientY, this.canvas, this.camera);
      } else {
        this.hover = null;
      }
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
    this.readout.setDrag({ kind: active.plan.kind, weld, count: d.selCount, t: d.t });
    const verts = active.plan.positions(tEff);
    // Hide the big hover markers during the drag (as in the non-selection case).
    // When operating on a selection, the selection highlight "sticks around" via
    // the small drag marker + range line instead.
    this.view.showPreview({ vertices: verts, faces: active.plan.previewFaces });
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

    // Cmd/Ctrl + drag behaves like Cmd-clicking the handle first (adding it to the
    // selection) and then dragging the whole selection — but TEMPORARILY: if the
    // drag commits nothing, the add is undone on release (see onUp / the early
    // return below), so an aimless Cmd-drag doesn't leave the handle selected.
    const addedToSelection = p.multi && !this.selection.isSelected(kind, id);
    if (p.multi) this.selection.add(kind, id);

    // Decide the participating selection set (or null = affect everything).
    let sel: Set<number> | null = null;
    if (this.selection.kind === kind && this.selection.ids.size > 0) {
      if (this.selection.ids.has(id)) sel = this.selection.setFor(kind);
      else this.selection.clear(); // dragging an unselected handle drops the selection
    }

    // Build the base operation (truncate / kis). The Shift form (snub / gyro) is built
    // lazily when Shift goes down, so it can freeze the base's level at that instant.
    const base = this.buildPlan(kind, id, false, sel);
    if (!base) {
      if (addedToSelection) this.selection.toggle(kind, id); // undo the temporary add
      this.mode = "idle";
      this.pending = null;
      return;
    }
    this.solver = null; // abandon any in-progress relaxation
    this.drag = {
      base, sel,
      shift: null, shiftHeld: false, frozenWeld: false, lastRay: null,
      kind, id,
      hasSelection: sel !== null,
      selCount: sel ? sel.size : null,
      addedToSelection,
      t: 0, weld: false,
    };
    this.mode = "dragging";
    // Shift already held at grab time → enter snub/gyro immediately, frozen at t=0.
    if (p.shift) this.enterShift();
    const active = this.activeSlot(this.drag);
    const verts = active.plan.positions(0);
    this.view.showPreview({ vertices: verts, faces: active.plan.previewFaces });
    this.readout.setDrag({ kind: active.plan.kind, weld: this.drag.weld, count: this.drag.selCount, t: this.drag.t });
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
        // negligible drag → no change. A Cmd-drag's add to the selection was only
        // temporary, so undo it (the handle wasn't selected before this drag).
        if (this.drag.addedToSelection)
          this.selection.toggle(this.drag.kind, this.drag.id);
        this.view.setPolyhedron(this.current, this.invalid);
      } else {
        const active = this.activeSlot(this.drag);
        const mesh: Mesh = active.plan.commit(this.drag.t, this.drag.weld);
        const label = DragController.label(
          active.plan.kind,
          this.drag.weld,
          this.drag.selCount,
        );
        // The topology changed, so the old vertex/face ids no longer mean anything.
        this.selection.clear();
        this.commitPoly(new Polyhedron(mesh), label);
      }
    } else if (this.mode === "pending" && this.pending) {
      // a click (no drag): selection bookkeeping
      if (this.pending.multi) {
        if (this.pending.marker)
          this.selection.toggle(this.pending.marker.kind, this.pending.marker.id);
        else this.selection.clear();
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

  private commitPoly(poly: Polyhedron, label: string): void {
    this.current = poly;
    this.invalid = false;
    if (this.firstEdit) {
      this.firstEdit = false;
      this.onFirstEdit();
    }
    this.history.push(poly, label);
    this.renderHistory();
    if (config.solver.enabled) {
      // Solve on consistently-oriented topology, mutating poly's vertices in place.
      const topo = extractTopology(poly);
      this.solver = new RelaxSolver(poly.mesh.vertices, topo);
      // The "adjusting" tint (blue) signals the shape is relaxing and not yet interactable.
      this.view.setSurfaceColor(config.render.adjustingColor);
      this.readout.setHint(`● relaxing: ${this.solver.statusLabel}`);
    } else {
      this.view.setPolyhedron(poly, false);
      this.runIdentify(poly, true);
    }
  }

  private finishSolve(): void {
    if (!this.solver) return;
    this.invalid = this.solver.invalid;
    this.solver = null;
    this.view.setPolyhedron(this.current, this.invalid);
    this.runIdentify(this.current, true);
  }

  // ---- identification ------------------------------------------------------
  // `discover` is true only when the shape was just MADE (a fresh commit / solve),
  // so undo/redo, restore and seed loads never count as discovering a shape.
  private runIdentify(poly: Polyhedron, discover = false): void {
    const { name, signature } = identify(poly);
    this.lastName = name;
    this.lastSignature = signature;
    if (discover && config.discovery.enabled && !this.invalid && name) {
      const { isNew, first } = this.discoveries.add(name);
      this.shapes.setCount(this.discoveries.count);
      if (isNew) this.celebrate(name, first);
    }
    // Record the result against the current history entry (invalid states show no
    // name). This also runs for the seed root and on restore — both harmless.
    this.history.annotate(this.history.current, this.invalid ? null : name, this.invalid);
    this.renderHistory();
    this.readout.setPoly({
      poly, name, signature,
      invalid: this.invalid,
      solving: false,
    });
    if (config.features.logToConsole) {
      console.log(
        `[identify] ${this.invalid ? "INVALID — " : ""}${name ?? "Unknown"}\n${describeSignature(signature)}`,
      );
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
