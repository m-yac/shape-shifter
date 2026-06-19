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
import { Polyhedron, cloneMesh } from "../geometry/polyhedron";
import { type Mesh } from "../geometry/HalfEdge";
import { RelaxSolver } from "../solver/solver";
import { extractTopology } from "../solver/topology";
import { faceGeometryArrays, edgeGeometryArrays } from "../render/sceneView";
import {
  buildDiagramGraph,
  computeVisible,
  drawableEdges,
  type DiagramGraph,
} from "../data/libraryDiagram";

/** The render side of a diagram node: its world position, group, and the
 *  materials we re-tint as its discovered / ghost / hidden state changes.
 *  `faceMat`/`edgeMat` are null for a node whose solid couldn't be built. */
interface RenderNode {
  pos: Vector3; // world position (the diagram coordinate)
  discoverable: boolean; // true once the user has actually made this shape
  group: Group;
  faceMat: MeshStandardMaterial | null;
  edgeMat: LineBasicMaterial | null;
}

/**
 * The full-screen LIBRARY browse diagram. A backlight-colored full-screen 3D map
 * of every named solid (laid out by `data/libraryDiagram`), with the box-drawing
 * frame + title drawn as a transparent overlay on top. Discovered solids render
 * in their default colors; their still-undiscovered neighbours appear as faint
 * ghosts; everything further out is hidden. Panning snaps to the nearest solid.
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

  private graph: DiagramGraph = { nodes: [], edges: [], outgoing: [] };
  private readonly nodes: RenderNode[] = [];
  private readonly arrowGroup = new Group();
  // Flat arrowhead triangles, billboarded toward the camera every frame.
  private readonly arrowheads: { mesh: ThreeMesh; dir: Vector3 }[] = [];
  private readonly raycaster = new Raycaster();
  private visibleSet = new Set<number>();

  private open = false;
  private built = false;
  private cameraInit = false;
  private snapTarget: Vector3 | null = null; // focus the pan-snap eases toward
  private raf = 0;

  // EASTER EGG: typing `config.library.revealAllCode` while open lights the whole
  // library until it's closed. `cheatBuffer` is a rolling tail of recent keys.
  private revealAll = false;
  private cheatBuffer = "";
  private readonly onCheatKey = (e: KeyboardEvent): void => {
    if (!this.open || e.key.length !== 1) return;
    this.cheatBuffer = (this.cheatBuffer + e.key.toLowerCase()).slice(-16);
    if (!this.revealAll && this.cheatBuffer.endsWith(config.library.revealAllCode)) {
      this.revealAll = true;
      this.refresh();
    }
  };

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

    // The 3D view is a full-screen canvas (its backlight-colored scene blocks
    // everything behind it); the box-drawing frame + title ride ON TOP as a
    // transparent overlay, exactly like the other on-screen dialogs. The canvas
    // is mounted into the grid (full screen) rather than inside the popup body.
    const backlight = config.theme.backlight;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "library-canvas";
    this.canvas.style.display = "none";

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
    this.graph = buildDiagramGraph();

    // Each solid is colored in its own symmetry scheme (the one the live app
    // would auto-switch to), so we briefly drive the shared scheme while baking
    // its colors, then restore whatever the main view was using.
    const savedScheme = getColorScheme();

    for (const info of this.graph.nodes) {
      const entry = libraryShapeFor(info.name);
      const group = new Group();
      group.position.set(info.coord[0], info.coord[1], info.coord[2]);
      this.scene.add(group);

      const node: RenderNode = {
        pos: group.position.clone(),
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
        console.warn(`[library] no shape found for diagram node "${info.name}"`);
      }

      this.nodes.push(node);
    }

    setColorScheme(savedScheme);
  }

  // --- visibility -----------------------------------------------------------

  /** Which node indices are discovered, given the live discovered-name set. */
  private discoveredSet(): Set<number> {
    const known = new Set(this.discoveredNames().map((n) => n.trim().toLowerCase()));
    const out = new Set<number>();
    this.graph.nodes.forEach((info, i) => {
      if (this.nodes[i].discoverable && known.has(info.name.trim().toLowerCase())) out.add(i);
    });
    return out;
  }

  /** Every discoverable node index — the "discovered" set the reveal-all cheat uses. */
  private allDiscoverableSet(): Set<number> {
    const out = new Set<number>();
    this.nodes.forEach((n, i) => {
      if (n.discoverable) out.add(i);
    });
    return out;
  }

  /** Retint every node (color / ghost / hidden) and rebuild the arrow set. */
  private refresh(): void {
    const discovered = this.revealAll ? this.allDiscoverableSet() : this.discoveredSet();
    const visible = computeVisible(this.graph, discovered);
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

    this.buildArrows(visible, discovered);
  }

  /** (Re)draw the diagram's arrows. Which edges to draw — both endpoints visible
   *  and leaving an expandable (discovered / first-hop) node — is decided by the
   *  pure `drawableEdges`; this just builds the lines + billboarded heads. */
  private buildArrows(visible: Set<number>, discovered: Set<number>): void {
    for (const child of this.arrowGroup.children.slice()) {
      this.arrowGroup.remove(child);
      disposeObject(child);
    }
    this.arrowheads.length = 0;

    const gap = config.library.shapeRadius * config.library.arrowGapFactor;
    const headLen = config.library.arrowheadLength;
    const headW = config.library.arrowheadWidth;

    for (const ei of drawableEdges(this.graph, discovered, visible)) {
      const e = this.graph.edges[ei];
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

  /** Billboard every arrowhead by spinning it about its OWN arrow axis: the tip
   *  stays exactly along the arrow direction, and the flat triangle rotates around
   *  that axis to face the camera as much as possible. So it looks flat-on from
   *  the side but foreshortens to an edge when viewed down the arrow's length. */
  private updateArrowheads(): void {
    const m = new Matrix4();
    for (const { mesh, dir } of this.arrowheads) {
      const f = dir; // tip axis, fixed (the arrow points exactly along it)
      // Facing normal: the view direction with the arrow-axis component removed,
      // so it lies in the plane the arrow is perpendicular to.
      const view = this.camera.position.clone().sub(mesh.position);
      const n = view.addScaledVector(f, -view.dot(f));
      if (n.lengthSq() < 1e-8) continue; // looking straight down the arrow
      n.normalize();
      const right = new Vector3().crossVectors(f, n).normalize();
      m.makeBasis(right, f, n); // local +Y → tip dir, local +Z (triangle normal) → camera
      mesh.quaternion.setFromRotationMatrix(m);
    }
  }

  // --- camera / panning -----------------------------------------------------

  /** Decide, at the start of a left-drag, whether it orbits or pans: a drag that
   *  lands on a visible solid (or an arrow) pans the diagram; empty space orbits. */
  private pickPanMode(e: PointerEvent): void {
    this.snapTarget = null; // a new gesture cancels any in-progress snap
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

  /** After a pan, pick the nearest node as the focus to ease toward (the actual
   *  motion is done smoothly per-frame in `stepSnap`). */
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
    this.snapTarget = best ? best.clone() : null;
  }

  /** Ease the orbit focus toward `snapTarget` (set after a pan), shifting the
   *  camera by the same step so the zoom + orientation are preserved. */
  private stepSnap(): void {
    if (!this.snapTarget) return;
    const remaining = this.snapTarget.clone().sub(this.controls.target);
    if (remaining.length() < 1e-3) {
      this.camera.position.add(remaining);
      this.controls.target.add(remaining);
      this.snapTarget = null;
      return;
    }
    const step = remaining.multiplyScalar(config.library.snapSmoothing);
    this.camera.position.add(step);
    this.controls.target.add(step);
  }

  // --- open / close ---------------------------------------------------------

  show(): void {
    if (this.open) return;
    if (!this.built) {
      this.buildDiagram();
      this.built = true;
    }
    this.open = true;
    // Reset the reveal-all cheat for each open.
    this.revealAll = false;
    this.cheatBuffer = "";
    window.addEventListener("keydown", this.onCheatKey);
    this.canvas.style.display = "block";
    this.popup.el.style.display = "";
    this.relayout();
    this.refresh();

    // On the FIRST open, start from the main view's orientation (zoomed further
    // out so a solid and its neighbours are visible at once), looking at the
    // origin. After that the two cameras are independent: the browse view keeps
    // its own position across opens rather than re-syncing to the main view.
    if (!this.cameraInit) {
      const dir = this.mainCamera.position.clone();
      if (dir.lengthSq() < 1e-9) dir.set(1, 0, 1);
      dir.normalize().multiplyScalar(config.library.startDistance);
      this.camera.position.copy(dir);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this.cameraInit = true;
    }

    const loop = () => {
      if (!this.open) return;
      this.stepSnap();
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
    this.revealAll = false;
    window.removeEventListener("keydown", this.onCheatKey);
    cancelAnimationFrame(this.raf);
    this.canvas.style.display = "none";
    this.popup.el.style.display = "none";
  }

  /** Resize the full-screen canvas + the frame overlay to the current grid. */
  private relayout(): void {
    this.popup.resize(this.screen.cols, this.screen.rows);
    this.popup.placeAt(0, 0);
    // The "[X]" masks border cells at the left of the top line.
    this.screen.place(this.closeBtn, 1, 0);
    if (!this.open) return;
    // The 3D fills the WHOLE glass; the frame overlays its outermost cells.
    const w = Math.max(1, this.screen.width);
    const h = Math.max(1, this.screen.height);
    this.renderer.setSize(w, h, true);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  mount(): void {
    this.popup.mount();
    this.popup.el.style.display = "none";
    // The full-screen 3D canvas sits in the grid, behind the frame overlay.
    this.screen.el.appendChild(this.canvas);
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
/** Canonicalized (midsphere) geometry per library solid, cached so the one-time
 *  relaxation runs only once per solid even across re-opens. */
const canonicalCache = new WeakMap<Polyhedron, Mesh>();

/** Relax a library solid into its canonical (midsphere) form so the browse
 *  diagram shows nicely-regular shapes rather than whatever raw geometry the
 *  database happened to build. Runs the "edges" strategy to convergence; the
 *  topology (and colors) are unchanged, so the existing per-vertex/edge colors
 *  still apply 1:1. */
function canonicalMesh(poly: Polyhedron): Mesh {
  const cached = canonicalCache.get(poly);
  if (cached) return cached;
  const work = cloneMesh(poly.mesh);
  const topo = extractTopology(poly);
  const solver = new RelaxSolver(work.vertices, topo, "edges");
  let guard = 0;
  while (solver.advance() && guard++ < 5000) {
    /* iterate to convergence */
  }
  const result: Mesh = { vertices: solver.mesh.vertices, faces: work.faces };
  canonicalCache.set(poly, result);
  return result;
}

function buildShapeGroup(poly: Polyhedron): BuiltShape {
  const src = canonicalMesh(poly);

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
