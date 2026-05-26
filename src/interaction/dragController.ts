import { Vector3, type PerspectiveCamera, type Ray } from "three";
import { type ArcballControls } from "three/examples/jsm/controls/ArcballControls.js";
import { Polyhedron } from "../geometry/polyhedron";
import { type Mesh } from "../geometry/HalfEdge";
import { type MorphPlan } from "../operations/types";
import { buildTruncate, closestIncidentEdge } from "../operations/truncate";
import { buildKis } from "../operations/kis";
import { buildSnub } from "../operations/snub";
import { buildGyro } from "../operations/gyro";
import { RelaxSolver } from "../solver/solver";
import { extractTopology } from "../solver/topology";
import { type Signature, describeSignature } from "../identify/configurations";
import { identify, buildGraphData, namedGraphFor } from "../identify/identify";
import { SceneView, type Marker, type MarkerKind } from "../render/sceneView";
import { Picker } from "./picker";
import { Selection } from "./selection";
import { Readout } from "../ui/readout";
import { config } from "../config";

const DRAG_START_PIXELS = 4;
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

// A release with t below this is treated as no change (there's no longer a
// magnetic snap-to-zero, so this just avoids committing a negligible drag).
const MIN_COMMIT_T = 1e-3;
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

interface Drag {
  plan: MorphPlan;
  kind: MarkerKind;
  id: number;
  allowMax: boolean;
  hasSelection: boolean; // operating on a multi-select subset (drives green feedback)
  addedToSelection: boolean; // this Cmd-drag added the handle to the selection (temp)
  t: number;
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
  private readonly selection = new Selection();

  private worker: Worker | null = null;
  private isoReq = 0;
  private lastName: string | null = null;
  private lastSignature: Signature | null = null;

  constructor(
    initial: Polyhedron,
    private readonly view: SceneView,
    private readonly camera: PerspectiveCamera,
    private readonly controls: ArcballControls,
    private readonly canvas: HTMLCanvasElement,
    private readonly readout: Readout,
  ) {
    this.current = initial;
    if (config.features.isomorphismCheck) {
      this.worker = new Worker(
        new URL("../identify/isoWorker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker.onmessage = (e: MessageEvent<{ id: number; result: boolean }>) =>
        this.onIsoResult(e.data.id, e.data.result);
    }
    this.attach();
    this.view.setPolyhedron(this.current, false);
    this.runIdentify(this.current);
  }

  /** Replace the whole polyhedron (e.g. loading a new seed / reset). */
  load(poly: Polyhedron): void {
    this.solver = null;
    this.invalid = false;
    this.current = poly;
    this.selection.clear();
    this.view.setPolyhedron(poly, false);
    this.runIdentify(poly);
  }

  // ---- frame update --------------------------------------------------------
  update(): void {
    this.view.updateMarkerScales(this.camera, config.camera.startDistance);
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
    // Pressing / releasing Cmd-Ctrl while hovering re-tints the preview (green when
    // a drag would now treat the handle as part of the selection).
    window.addEventListener("keydown", (e) => this.onModifierChange(e));
    window.addEventListener("keyup", (e) => this.onModifierChange(e));
  }

  private onModifierChange(e: KeyboardEvent): void {
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
      const snap = this.drag.plan.snap(ray);
      // No end magnetism: t follows the cursor directly. Only the very end welds
      // (rectify / join); if that end is disabled, stop just short of it.
      let tEff = snap.t;
      let weld = false;
      if (snap.t >= 1) {
        if (this.drag.allowMax) weld = true;
        else tEff = MAX_T_WITHOUT_WELD;
      }
      this.drag.t = tEff;
      this.drag.weld = weld;
      const verts = this.drag.plan.positions(tEff);
      // Hide the big hover markers during the drag (as in the non-selection case).
      // When operating on a selection, the green "sticks around" via the small drag
      // marker + range line instead.
      this.view.showPreview({ vertices: verts, faces: this.drag.plan.previewFaces });
      const green = this.drag.hasSelection;
      this.view.setDragMarker(
        snap.point, // small sphere on the targeted vertex
        green ? config.render.selectedColor : config.render.dragMarkerColor,
      );
      if (snap.highlight)
        this.view.setEdgeHighlight(
          snap.highlight.a,
          snap.highlight.b,
          green ? config.render.selectedColor : config.render.dragLineColor,
        );
      else this.view.clearEdgeHighlight();
    }
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

    const built = this.buildPlan(kind, id, p.shift, sel);
    if (!built) {
      if (addedToSelection) this.selection.toggle(kind, id); // undo the temporary add
      this.mode = "idle";
      this.pending = null;
      return;
    }
    this.solver = null; // abandon any in-progress relaxation
    this.drag = {
      ...built, kind, id,
      hasSelection: sel !== null,
      addedToSelection,
      t: 0, weld: false,
    };
    this.mode = "dragging";
    const verts = this.drag.plan.positions(0);
    this.view.showPreview({ vertices: verts, faces: this.drag.plan.previewFaces });
    // The drag marker is positioned on the first move (when we have a snap point).
  }

  private buildPlan(
    kind: MarkerKind,
    id: number,
    shift: boolean,
    sel: Set<number> | null,
  ): { plan: MorphPlan; allowMax: boolean } | null {
    const ops = config.features.operations;
    try {
      if (kind === "vertex") {
        if (shift) {
          if (!ops.snub) return null;
          return { plan: buildSnub(this.current, id, sel), allowMax: false };
        }
        if (!ops.truncate) return null;
        return {
          plan: buildTruncate(this.current, id, sel, this.inView),
          allowMax: ops.rectify,
        };
      } else {
        if (shift) {
          if (!ops.gyro) return null;
          return { plan: buildGyro(this.current, id, sel), allowMax: false };
        }
        if (!ops.kis) return null;
        return { plan: buildKis(this.current, id, sel), allowMax: ops.join };
      }
    } catch (err) {
      console.warn("Operation unavailable:", err);
      return null;
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.button !== 0) {
      this.controls.enabled = true;
      return;
    }
    this.view.clearEdgeHighlight();
    this.view.hideDragMarker();

    if (this.mode === "dragging" && this.drag) {
      if (this.drag.t <= MIN_COMMIT_T) {
        // negligible drag → no change. A Cmd-drag's add to the selection was only
        // temporary, so undo it (the handle wasn't selected before this drag).
        if (this.drag.addedToSelection)
          this.selection.toggle(this.drag.kind, this.drag.id);
        this.view.setPolyhedron(this.current, this.invalid);
      } else {
        const mesh: Mesh = this.drag.plan.commit(this.drag.t, this.drag.weld);
        // The topology changed, so the old vertex/face ids no longer mean anything.
        this.selection.clear();
        this.commitPoly(new Polyhedron(mesh));
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
    this.controls.enabled = true; // restore camera orbit
    this.refreshHighlights();
  }

  private commitPoly(poly: Polyhedron): void {
    this.current = poly;
    this.invalid = false;
    if (config.solver.enabled) {
      // Solve on consistently-oriented topology, mutating poly's vertices in place.
      const topo = extractTopology(poly);
      this.solver = new RelaxSolver(poly.mesh.vertices, topo);
      // Green "adjusting" tint signals the shape is relaxing and not yet interactable.
      this.view.setSurfaceColor(config.render.adjustingColor);
      this.readout.setHint(`● relaxing: ${this.solver.statusLabel}`);
    } else {
      this.view.setPolyhedron(poly, false);
      this.runIdentify(poly);
    }
  }

  private finishSolve(): void {
    if (!this.solver) return;
    this.invalid = this.solver.invalid;
    this.solver = null;
    this.view.setPolyhedron(this.current, this.invalid);
    this.runIdentify(this.current);
  }

  // ---- identification ------------------------------------------------------
  private runIdentify(poly: Polyhedron): void {
    const { name, signature } = identify(poly);
    this.lastName = name;
    this.lastSignature = signature;
    this.readout.show({
      name,
      signature,
      verified: false,
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
    this.readout.show({
      name: this.lastName,
      signature: this.lastSignature,
      verified: true,
      invalid: false,
      solving: false,
    });
    if (config.features.logToConsole) console.log(`[identify] verified ✓ ${this.lastName}`);
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
    if (!this.hover || !config.features.hoverHighlight) return;

    // "Affected" = this handle is part of the green selection — either already
    // command-clicked, or Cmd is held so a drag would add it. Those are previewed
    // green; a plain handle keeps the neutral hover look.
    const selected = this.selection.isSelected(this.hover.kind, this.hover.id);
    const affected = selected || (this.hoverMulti && this.hoverInRange);
    // Within drag range → prominent; merely nearby → subtle proximity hint.
    const state = affected ? "selected" : this.hoverInRange ? "hover" : "proximity";
    this.view.showMarker(this.hover.kind, this.hover.id, state);

    if (this.hoverInRange && this.hoverRay) {
      this.showHoverPreview(this.hover, this.hoverRay, affected);
    }
  }

  /**
   * Hover preview of what a drag would affect: the incident edge (vertex) or the
   * whole face (face center). `affected` marks a command-clicked / Cmd-held handle
   * — part of the green selection — and is the explicit split between rendering a
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
      // `affected` distinguishes a command-clicked / Cmd-held handle (drawn green)
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
