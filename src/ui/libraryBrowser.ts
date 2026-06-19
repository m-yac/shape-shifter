import {
  Scene,
  Group,
  WebGLRenderer,
  PerspectiveCamera,
  HemisphereLight,
  DirectionalLight,
  Mesh as ThreeMesh,
  LineSegments,
  Line,
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  MeshBasicMaterial,
  LineBasicMaterial,
  LineDashedMaterial,
  Color,
  Vector2,
  Vector3,
  Matrix4,
  Raycaster,
  WebGLRenderTarget,
  HalfFloatType,
  MOUSE,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { config } from "../config";
import { Screen, Popup } from "./screen";
import { makeActionButton } from "./controls";
import { libraryShapeFor } from "../data/libraryShapes";
import { faceColorsRGB, getColorScheme, setColorScheme } from "../geometry/colors";
import { Polyhedron } from "../geometry/polyhedron";
import { faceGeometryArrays, edgeGeometryArrays } from "../render/sceneView";

// Direction letters → unit grid step (y up, x right, z toward the viewer).
const DIRV: Record<string, [number, number, number]> = {
  u: [0, 1, 0],
  d: [0, -1, 0],
  r: [1, 0, 0],
  l: [-1, 0, 0],
  f: [0, 0, 1],
  b: [0, 0, -1],
};

/** A single parsed arrow: where it points (in grid steps) and how it's drawn.
 *  Grammar: a run of (direction letter + per-axis span) pairs, then optional
 *  ":" (dashed) and "^" (arrowhead). Each letter carries its OWN span, so
 *  "d3r2" steps (+2 x, -3 y) — allowing non-45° lines — and a missing number
 *  means 1 ("u^" = up one with an arrowhead). */
interface ParsedArrow {
  step: Vector3;
  dashed: boolean;
  arrowhead: boolean;
}

function parseArrow(tokenGroup: string): ParsedArrow[] {
  const out: ParsedArrow[] = [];
  // One config string may bundle several tokens, e.g. "f4r4, b2r2".
  for (const tok of tokenGroup.split(/[\s,]+/).filter(Boolean)) {
    const dashed = tok.includes(":");
    const arrowhead = tok.includes("^");
    const step = new Vector3();
    let matched = false;
    // Each (letter, optional digits) pair contributes its own span on its axis.
    for (const m of tok.matchAll(/([udlrfb])(\d*)/gi)) {
      const v = DIRV[m[1].toLowerCase()];
      if (!v) continue;
      const span = m[2] ? parseInt(m[2], 10) : 1;
      step.add(new Vector3(v[0] * span, v[1] * span, v[2] * span));
      matched = true;
    }
    if (matched) out.push({ step, dashed, arrowhead });
  }
  return out;
}

const coordKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

type RawEntry = readonly [number, number, number, string, readonly string[]];

/** An edge of the diagram between two existing nodes (with its drawn style). */
interface DiagramEdge {
  from: number;
  to: number;
  dashed: boolean;
  arrowhead: boolean;
}

/** A placed solid: its grid coordinate, its render group, and the materials we
 *  re-tint as its discovered / ghost / hidden state changes. */
interface DiagramNode {
  coord: Vector3; // grid coordinate (integer-ish)
  pos: Vector3; // world position
  name: string;
  discoverable: boolean; // true once the user has actually made this shape
  group: Group;
  faceMat: MeshStandardMaterial | null;
  edgeMat: LineBasicMaterial | null;
}

/**
 * The full-screen LIBRARY browse diagram. A black panel (with the box-drawing
 * frame + title kept) holding an OrbitControls-driven 3D map of every named
 * solid, laid out on the grid from `config.library.diagram`. Discovered solids
 * render in their default colors; their still-undiscovered neighbours appear as
 * white 25%-opacity ghosts; everything further out is hidden. Panning snaps the
 * view to the nearest solid.
 */
export class LibraryBrowser {
  private readonly popup: Popup;
  private readonly closeBtn: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;

  private readonly nodes: DiagramNode[] = [];
  private readonly edges: DiagramEdge[] = [];
  private readonly incident: number[][] = []; // node index → edge indices
  private readonly arrowGroup = new Group();
  // Flat arrowhead triangles, billboarded toward the camera every frame.
  private readonly arrowheads: { mesh: ThreeMesh; dir: Vector3 }[] = [];
  private readonly raycaster = new Raycaster();
  private visibleSet = new Set<number>();

  private open = false;
  private built = false;
  private raf = 0;

  constructor(
    private readonly screen: Screen,
    // The main view's camera, copied as the browse start position each open.
    private readonly mainCamera: PerspectiveCamera,
    // Read fresh on each open so newly-made shapes light up.
    private readonly discoveredNames: () => string[],
  ) {
    this.popup = new Popup(screen, {
      cols: screen.cols,
      rows: screen.rows,
      title: config.ui.titles.library,
    });
    this.popup.el.classList.add("library-popup");
    this.popup.el.style.display = "none";

    // Backlight-colored backdrop that blocks everything behind the panel (the
    // same color as the main 3D background); the frame text sits above it and
    // the 3D canvas fills the inset body.
    const backlight = config.theme.backlight;
    this.popup.el.style.background = backlight;
    this.popup.body.style.background = backlight;
    this.popup.body.style.overflow = "hidden";

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.popup.body.appendChild(this.canvas);

    // A standard "[X]" action button sitting on the left of the top border.
    this.closeBtn = makeActionButton("X", () => this.close()).el;
    this.closeBtn.classList.add("library-close");
    this.popup.el.appendChild(this.closeBtn);

    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(
      config.theme.pixelateRender
        ? 1 / config.theme.pixelSize
        : Math.min(window.devicePixelRatio, 2),
    );
    if (config.theme.pixelateRender) this.canvas.style.imageRendering = "pixelated";
    this.renderer.setClearColor(new Color(backlight), 1);
    this.scene.background = new Color(backlight);

    this.camera = new PerspectiveCamera(config.camera.fov, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = config.camera.minDistance;
    this.controls.maxDistance = config.camera.maxDistance * 4;
    // After a pan/orbit gesture, snap the focus to the nearest solid.
    this.controls.addEventListener("end", () => this.snapToNearest());
    // Left-drag on EMPTY space orbits; left-drag that lands on a solid or an
    // arrow pans instead (decided per gesture in `pickPanMode`, run on the
    // capture phase so it sets the button mode before OrbitControls reads it).
    this.controls.mouseButtons.LEFT = MOUSE.ROTATE;
    this.canvas.addEventListener("pointerdown", (e) => this.pickPanMode(e), true);

    // Lighting mirrors the main scene so the little solids shade the same way.
    this.scene.add(new HemisphereLight(0xffffff, 0x404050, 1.0));
    const key = new DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.5);
    fill.position.set(-4, -2, -3);
    this.scene.add(fill);

    this.scene.add(this.arrowGroup);

    // The same glass-bloom post-processing as the main view (see main.ts), so
    // the little solids glow identically. Sized in `relayout`.
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new Vector2(1, 1),
      config.theme.bloom.intensity * config.theme.bloom.scale_3d,
      config.theme.bloom.radius,
      config.theme.bloom.threshold,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // The diagram (which builds ~30 solids) is constructed lazily on first open,
    // so it never slows app startup.

    // Recreate the panel + renderer size whenever the screen relays out (only
    // matters while open, but cheap to keep in sync).
    screen.onLayout(() => this.relayout());
  }

  // --- diagram construction -------------------------------------------------

  private buildDiagram(): void {
    const diagram = config.library.diagram as unknown as RawEntry[];
    const byCoord = new Map<string, number>();

    // Each solid is colored in its own symmetry scheme (the one the live app
    // would auto-switch to), so we briefly drive the shared scheme while baking
    // its colors, then restore whatever the main view was using.
    const savedScheme = getColorScheme();

    for (const [x, y, z, name] of diagram) {
      const coord = new Vector3(x, y, z);
      const idx = this.nodes.length;
      byCoord.set(coordKey(x, y, z), idx);

      const entry = libraryShapeFor(name);
      const group = new Group();
      group.position.copy(coord);
      this.scene.add(group);

      const node: DiagramNode = {
        coord,
        pos: group.position.clone(),
        name,
        discoverable: entry !== null,
        group,
        faceMat: null,
        edgeMat: null,
      };

      if (entry) {
        setColorScheme(entry.scheme);
        const built = buildShapeGroup(entry.poly);
        group.add(built.group);
        node.faceMat = built.faceMat;
        node.edgeMat = built.edgeMat;
      } else if (config.features.logToConsole) {
        console.warn(`[library] no shape found for diagram node "${name}"`);
      }

      this.nodes.push(node);
      this.incident.push([]);
    }

    setColorScheme(savedScheme);

    // Resolve every arrow to an edge between two existing nodes.
    diagram.forEach(([x, y, z, , arrows], from) => {
      for (const tokenGroup of arrows) {
        for (const a of parseArrow(tokenGroup)) {
          const tx = x + a.step.x;
          const ty = y + a.step.y;
          const tz = z + a.step.z;
          const to = byCoord.get(coordKey(tx, ty, tz));
          if (to === undefined) {
            if (config.features.logToConsole)
              console.warn(`[library] arrow from "${this.nodes[from].name}" points to empty ${coordKey(tx, ty, tz)}`);
            continue;
          }
          const ei = this.edges.length;
          this.edges.push({ from, to, dashed: a.dashed, arrowhead: a.arrowhead });
          this.incident[from].push(ei);
          this.incident[to].push(ei);
        }
      }
    });
  }

  // --- visibility -----------------------------------------------------------

  /** Which node indices are discovered, given the live discovered-name set. */
  private discoveredSet(): Set<number> {
    const known = new Set(this.discoveredNames().map((n) => n.trim().toLowerCase()));
    const out = new Set<number>();
    this.nodes.forEach((n, i) => {
      if (n.discoverable && known.has(n.name.trim().toLowerCase())) out.add(i);
    });
    return out;
  }

  private other(e: DiagramEdge, node: number): number {
    return e.from === node ? e.to : e.from;
  }

  /**
   * Visible nodes = discovered solids, their immediate neighbours, and any node
   * reached from such a neighbour by a SOLID ARROWHEAD edge — but only when that
   * neighbour was itself reached from a discovered solid by a SOLID line.
   */
  private computeVisible(discovered: Set<number>): Set<number> {
    const visible = new Set<number>(discovered);
    const solidNeighbors = new Set<number>();

    for (const d of discovered) {
      for (const ei of this.incident[d]) {
        const e = this.edges[ei];
        const n1 = this.other(e, d);
        visible.add(n1);
        if (!e.dashed) solidNeighbors.add(n1);
      }
    }
    for (const n1 of solidNeighbors) {
      for (const ei of this.incident[n1]) {
        const e = this.edges[ei];
        if (e.arrowhead && !e.dashed) visible.add(this.other(e, n1));
      }
    }
    return visible;
  }

  /** Retint every node (color / ghost / hidden) and rebuild the arrow set. */
  private refresh(): void {
    const discovered = this.discoveredSet();
    const visible = this.computeVisible(discovered);
    this.visibleSet = visible;

    this.nodes.forEach((node, i) => {
      const show = visible.has(i);
      node.group.visible = show;
      if (!show || !node.faceMat || !node.edgeMat) return;
      if (discovered.has(i)) {
        // Full default colors at default opacity.
        node.faceMat.vertexColors = true;
        node.faceMat.color.set(0xffffff);
        node.faceMat.opacity = config.render.faceOpacity;
        node.faceMat.transparent = config.render.faceOpacity < 1;
        node.faceMat.needsUpdate = true;
        node.edgeMat.vertexColors = true;
        node.edgeMat.color.set(0xffffff);
        node.edgeMat.opacity = 1;
        node.edgeMat.transparent = false;
        node.edgeMat.needsUpdate = true;
      } else {
        // Undiscovered ghost: all white at 25% opacity.
        node.faceMat.vertexColors = false;
        node.faceMat.color.set(config.library.ghostColor);
        node.faceMat.opacity = config.library.ghostOpacity;
        node.faceMat.transparent = true;
        node.faceMat.needsUpdate = true;
        node.edgeMat.vertexColors = false;
        node.edgeMat.color.set(config.library.ghostColor);
        node.edgeMat.opacity = config.library.ghostOpacity;
        node.edgeMat.transparent = true;
        node.edgeMat.needsUpdate = true;
      }
    });

    this.buildArrows(visible);
  }

  /** (Re)draw the arrows between currently-visible nodes. */
  private buildArrows(visible: Set<number>): void {
    for (const child of this.arrowGroup.children.slice()) {
      this.arrowGroup.remove(child);
      disposeObject(child);
    }
    this.arrowheads.length = 0;

    const gap = config.library.shapeRadius * config.library.arrowGapFactor;
    const headLen = config.library.arrowheadLength;
    const headW = config.library.arrowheadWidth;

    for (const e of this.edges) {
      if (!visible.has(e.from) || !visible.has(e.to)) continue;
      const a = this.nodes[e.from].pos;
      const b = this.nodes[e.to].pos;
      const dir = b.clone().sub(a).normalize();
      // Inset both ends so the line runs between the solids, not through them.
      const start = a.clone().addScaledVector(dir, gap);
      const tip = b.clone().addScaledVector(dir, -gap); // where the arrow points
      // The line stops at the BASE of the arrowhead (or at `tip` when there is
      // none), so the head's tip lands exactly on `tip` with no overlap.
      const lineEnd = e.arrowhead ? tip.clone().addScaledVector(dir, -headLen) : tip;

      const geo = new BufferGeometry().setFromPoints([start, lineEnd]);
      const mat = e.dashed
        ? new LineDashedMaterial({ color: config.library.arrowColor, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.85 })
        : new LineBasicMaterial({ color: config.library.arrowColor, transparent: true, opacity: 0.85 });
      const line = new Line(geo, mat);
      if (e.dashed) line.computeLineDistances();
      this.arrowGroup.add(line);

      if (e.arrowhead) {
        // A flat triangle with its tip at the local origin and its base behind
        // along -Y; positioned at `tip` and billboarded each frame (see
        // updateArrowheads), so its tip stays on `tip` regardless of orientation.
        const tg = new BufferGeometry().setFromPoints([
          new Vector3(0, 0, 0),
          new Vector3(-headW / 2, -headLen, 0),
          new Vector3(headW / 2, -headLen, 0),
        ]);
        const head = new ThreeMesh(
          tg,
          new MeshBasicMaterial({ color: config.library.arrowColor, transparent: true, opacity: 0.9, side: 2 }),
        );
        head.position.copy(tip);
        this.arrowGroup.add(head);
        this.arrowheads.push({ mesh: head, dir });
      }
    }
  }

  /** Billboard every arrowhead toward the camera, but YAW ONLY (its facing
   *  normal is horizontal — the camera direction flattened into the xz plane).
   *  So it turns to face you as you orbit around, yet seen from straight above or
   *  below it foreshortens to an edge instead of staying flat-on. */
  private updateArrowheads(): void {
    const m = new Matrix4();
    for (const { mesh, dir } of this.arrowheads) {
      // Facing normal: toward the camera but with no vertical component.
      const view = this.camera.position.clone().sub(mesh.position);
      const n = new Vector3(view.x, 0, view.z);
      if (n.lengthSq() < 1e-8) n.set(0, 0, 1); // camera directly above/below
      n.normalize();
      // Tip axis = the arrow direction projected into the (vertical) billboard
      // plane — the plane perpendicular to the horizontal facing normal.
      const f = dir.clone().addScaledVector(n, -dir.dot(n));
      if (f.lengthSq() < 1e-8) continue; // arrow runs along the facing normal
      f.normalize();
      const right = new Vector3().crossVectors(f, n).normalize();
      m.makeBasis(right, f, n); // local +Y → tip dir, local +Z (triangle normal) → camera (yaw)
      mesh.quaternion.setFromRotationMatrix(m);
    }
  }

  // --- camera / panning -----------------------------------------------------

  /** Decide, at the start of a left-drag, whether it orbits or pans: a drag that
   *  lands on a visible solid (or an arrow) pans the diagram; empty space orbits. */
  private pickPanMode(e: PointerEvent): void {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Line.threshold = 0.12;
    const hits = this.raycaster.intersectObjects(this.hitTargets(), true);
    this.controls.mouseButtons.LEFT = hits.length > 0 ? MOUSE.PAN : MOUSE.ROTATE;
  }

  /** The currently-visible solids' groups + the arrows, for hit-testing. */
  private hitTargets(): Object3D[] {
    const out: Object3D[] = [this.arrowGroup];
    this.nodes.forEach((n, i) => {
      if (this.visibleSet.has(i)) out.push(n.group);
    });
    return out;
  }

  /** Snap the orbit focus to the nearest node, keeping zoom and orientation. */
  private snapToNearest(): void {
    const target = this.controls.target;
    let best: Vector3 | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (!n.group.visible) continue;
      const d = n.pos.distanceToSquared(target);
      if (d < bestD) {
        bestD = d;
        best = n.pos;
      }
    }
    if (!best) return;
    const delta = best.clone().sub(target);
    this.camera.position.add(delta);
    this.controls.target.copy(best);
    this.controls.update();
  }

  // --- open / close ---------------------------------------------------------

  show(): void {
    if (this.open) return;
    if (!this.built) {
      this.buildDiagram();
      this.built = true;
    }
    this.open = true;
    this.popup.el.style.display = "";
    this.relayout();
    this.refresh();

    // Start with the main view's ORIENTATION but zoomed further out (so a solid
    // and its neighbours are visible at once), looking at the origin (Tetrahedron).
    const dir = this.mainCamera.position.clone();
    if (dir.lengthSq() < 1e-9) dir.set(1, 0, 1);
    dir.normalize().multiplyScalar(config.library.startDistance);
    this.camera.position.copy(dir);
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    const loop = () => {
      if (!this.open) return;
      this.controls.update();
      this.updateArrowheads();
      this.composer.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    cancelAnimationFrame(this.raf);
    this.popup.el.style.display = "none";
  }

  /** Resize the panel + renderer to the current grid. */
  private relayout(): void {
    this.popup.resize(this.screen.cols, this.screen.rows);
    this.popup.placeAt(0, 0);
    // The "X" masks three border cells at the left of the top line.
    this.screen.place(this.closeBtn, 1, 0);
    if (!this.open) return;
    const w = Math.max(1, (this.screen.cols - 2) * this.screen.colW);
    const h = Math.max(1, (this.screen.rows - 2) * this.screen.rowH);
    this.renderer.setSize(w, h, true);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  mount(): void {
    this.popup.mount();
    this.popup.el.style.display = "none";
  }
}

// --- shape group builder ----------------------------------------------------

interface BuiltShape {
  group: Group;
  faceMat: MeshStandardMaterial;
  edgeMat: LineBasicMaterial;
}

/**
 * A small Group holding a solid's face mesh + wireframe, normalized to
 * config.library.shapeRadius and centered. The geometry is built by the SAME helpers the main
 * view uses (`render/sceneView`), so the colors match exactly; we just bake them
 * into the color attribute and then flip the materials between "colored" and
 * "white ghost" by toggling `vertexColors` + `color`. The caller sets the active
 * color scheme before calling, so `faceColorsRGB` resolves the solid's own scheme.
 */
function buildShapeGroup(poly: Polyhedron): BuiltShape {
  const src = poly.mesh;

  // Center + scale to config.library.shapeRadius, then reuse the shared geometry builders.
  const center = new Vector3();
  for (const v of src.vertices) center.add(v);
  center.multiplyScalar(1 / Math.max(1, src.vertices.length));
  let maxR = 0;
  for (const v of src.vertices) maxR = Math.max(maxR, v.distanceTo(center));
  const s = maxR > 0 ? config.library.shapeRadius / maxR : config.library.shapeRadius;
  const mesh = {
    vertices: src.vertices.map((v) => v.clone().sub(center).multiplyScalar(s)),
    faces: src.faces,
  };

  const fa = faceGeometryArrays(mesh, faceColorsRGB(poly.colors.face));
  const fg = new BufferGeometry();
  fg.setAttribute("position", new Float32BufferAttribute(fa.positions, 3));
  fg.setAttribute("normal", new Float32BufferAttribute(fa.normals, 3));
  fg.setAttribute("color", new Float32BufferAttribute(fa.colors, 3));
  const faceMat = new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: config.render.faceOpacity,
    roughness: 0.6,
    metalness: 0.0,
    side: 2,
  });
  const faceMesh = new ThreeMesh(fg, faceMat);

  const ea = edgeGeometryArrays(mesh, poly.colors.edge);
  const eg = new BufferGeometry();
  eg.setAttribute("position", new Float32BufferAttribute(ea.positions, 3));
  eg.setAttribute("color", new Float32BufferAttribute(ea.colors, 3));
  const edgeMat = new LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true });
  const edges = new LineSegments(eg, edgeMat);

  const group = new Group();
  group.add(faceMesh, edges);
  return { group, faceMat, edgeMat };
}

/** Dispose a Line / Mesh's geometry + material(s). */
function disposeObject(obj: Object3D): void {
  const o = obj as unknown as { geometry?: { dispose(): void }; material?: unknown };
  o.geometry?.dispose();
  const m = o.material;
  if (Array.isArray(m)) m.forEach((x) => (x as { dispose(): void }).dispose());
  else if (m) (m as { dispose(): void }).dispose();
}
