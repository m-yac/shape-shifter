import {
  Scene,
  Group,
  Mesh as ThreeMesh,
  LineSegments,
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  LineBasicMaterial,
  MeshBasicMaterial,
  SphereGeometry,
  CylinderGeometry,
  TubeGeometry,
  CatmullRomCurve3,
  Color,
  Vector3,
} from "three";

const TUBE_UP = new Vector3(0, 1, 0);
import { type Camera } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { type TwistArc } from "../operations/types";
import { Polyhedron } from "../geometry/polyhedron";
import { faceCentroidOf, newellNormal } from "../geometry/polyhedron";
import {
  edgeKey,
  type GeomColor,
  paletteRGB,
  faceColorsRGB,
  darkRGB,
  faceColorsRGBLight,
  darkRGBLight,
} from "../geometry/colors";
import { config } from "../config";

/** Options for a live preview render (drag / solve frames). */
export interface PreviewOpts {
  /** Per-face RGB to display (length = mesh.faces). Omit to keep current colors. */
  faceColors?: Color[];
  /** Geometric colors per edge (keyed by edgeKey). Omit to keep current colors. */
  edgeColors?: Map<string, GeomColor>;
  /** Undirected edge keys to omit from the wireframe (vanishing-at-weld edges). */
  hiddenEdges?: Set<string>;
}

export type MarkerKind = "vertex" | "face" | "edge";
export type MarkerState = "normal" | "proximity" | "hover" | "selected" | "drag";

export interface Marker {
  kind: MarkerKind;
  id: number;
  position: Vector3;
  normals: Vector3[];
  mesh: ThreeMesh;
  /** For an "edge" marker: its two endpoint vertex indices (the dragged edge). */
  edge?: [number, number];
}

/** Unique undirected edges (as index pairs) of a mesh, for the wireframe. */
function meshEdges(mesh: Mesh, hidden?: Set<string>): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key) || hidden?.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
  }
  return out;
}

/** Number of triangle-vertices (fan-triangulated) a face of `n` sides emits. */
function faceVertexCount(n: number): number {
  return 3 * (n - 2);
}

/**
 * Fan-triangulated face geometry (non-indexed). Every triangle of a face is
 * given that face's single Newell normal, so a face shades uniformly with no
 * crease along the triangulation diagonal even if it is very slightly non-planar.
 * Each triangle vertex also receives its face's RGB color (per-face coloring).
 */
export function faceGeometryArrays(
  mesh: Mesh,
  faceColors: Color[],
): { positions: number[]; normals: number[]; colors: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    const col = faceColors[fi] ?? paletteRGB(undefined);
    const n = newellNormal(f.map((i) => mesh.vertices[i]));
    // Orient outward (same centroid convention as the markers / highlights): the
    // solid is centered at the origin, so a face's outward direction is its
    // centroid direction. Operations like truncate emit some faces with reversed
    // winding (e.g. the freshly exposed vertex n-gons); without this their normal
    // would point inward and the face would shade as if lit from behind. We also
    // reverse the triangle winding to match, so winding and normal always agree.
    const loop = n.dot(faceCentroidOf(mesh.vertices, f)) < 0 ? [...f].reverse() : f;
    if (loop !== f) n.negate();
    const p0 = mesh.vertices[loop[0]];
    for (let i = 1; i < loop.length - 1; i++) {
      const a = mesh.vertices[loop[i]];
      const b = mesh.vertices[loop[i + 1]];
      positions.push(p0.x, p0.y, p0.z, a.x, a.y, a.z, b.x, b.y, b.z);
      for (let k = 0; k < 3; k++) {
        normals.push(n.x, n.y, n.z);
        colors.push(col.r, col.g, col.b);
      }
    }
  }
  return { positions, normals, colors };
}

/** Wireframe positions + per-edge color (from `edgeColors` palette indices). The
 *  resolver maps an index to RGB; defaults to the dark palette (the screen look),
 *  but the _light.png export passes `darkRGBLight`. */
export function edgeGeometryArrays(
  mesh: Mesh,
  edgeColors: Map<string, GeomColor>,
  hidden?: Set<string>,
  resolve: (c: GeomColor | undefined) => Color = darkRGB,
): { positions: number[]; colors: number[] } {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const [a, b] of meshEdges(mesh, hidden)) {
    const pa = mesh.vertices[a];
    const pb = mesh.vertices[b];
    positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    const c = resolve(edgeColors.get(edgeKey(a, b)));
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  return { positions, colors };
}

/** Color + opacity for a marker in a given state. */
function appearanceForState(
  kind: MarkerKind,
  state: MarkerState,
): { color: number; opacity: number } {
  const base =
    kind === "vertex"
      ? config.render.vertexMarkerColor
      : kind === "edge"
        ? config.render.edgeMarkerColor
        : config.render.faceMarkerColor;
  switch (state) {
    case "proximity":
      return { color: base, opacity: config.render.markerProximityOpacity };
    case "hover":
      return { color: config.render.hoverColor, opacity: 1 };
    case "selected":
      return { color: config.render.selectedColor, opacity: 1 };
    case "drag":
      return { color: config.render.dragColor, opacity: 1 };
    default:
      return { color: base, opacity: 1 };
  }
}

/**
 * Owns all the Three.js objects representing the current polyhedron: the face
 * mesh, the wireframe, and the pickable vertex / face-center markers. During a
 * drag it shows a live preview mesh (markers hidden); on commit it rebuilds.
 */
export class SceneView {
  private group = new Group();
  private faceMesh: ThreeMesh;
  private edges: LineSegments;
  private markerGroup = new Group();
  private dragTube: ThreeMesh;
  private dragA = new Vector3();
  private dragB = new Vector3();
  private dragMarker: ThreeMesh;
  private faceHighlight: ThreeMesh;
  // The gyro rotation-arc handle: a white tube (matching the drag range line) bent
  // along the arc the swept spoke rides. `twistArc` is the full-extent arc drawn at a
  // reduced opacity; `twistArcProgress` is the solid sub-arc (midpoint → cursor) shown
  // while actively twisting, indicating how far the gyro has been rotated.
  private twistArc: ThreeMesh;
  private twistArcProgress: ThreeMesh;

  vertexMarkers: Marker[] = [];
  faceMarkers: Marker[] = [];
  edgeMarkers: Marker[] = [];

  private faceMat: MeshStandardMaterial;
  private faceHighlightMat: MeshBasicMaterial;

  // Transient emissive "glow" pulse (used on a new-shape discovery). The bloom
  // pass turns the raised emissive into a bright halo. 0 duration => inactive.
  private glowStart = 0;
  private glowDur = 0;
  private glowPeak = 0;

  // Per-face display colors (one RGB per current face) and the triangle-vertex
  // count of each face, so the color buffer can be rewritten in place during a
  // fade without rebuilding positions.
  private displayFaceColors: Color[] = [];
  private faceVertCounts: number[] = [];
  // Palette index per displayed edge (keyed by edgeKey); drawn via the dark palette.
  private displayEdgeColors: Map<string, GeomColor> = new Map();
  // Active face-color fade (release → final colors). null when idle.
  private colorFade: { from: Color[]; to: Color[]; start: number; durMs: number } | null = null;
  private vertexGeo = new SphereGeometry(config.render.vertexMarkerRadius, 14, 10);
  private faceGeo = new SphereGeometry(config.render.faceMarkerRadius, 14, 10);
  private edgeGeo = new SphereGeometry(config.render.edgeMarkerRadius, 14, 10);

  constructor(public readonly scene: Scene) {
    this.faceMat = new MeshStandardMaterial({
      // Per-face colors come from the geometry's vertex-color attribute; `color`
      // stays white so it acts as a neutral multiplier.
      color: config.render.faceColor,
      vertexColors: true,
      transparent: config.render.faceOpacity < 1,
      opacity: config.render.faceOpacity,
      // Normals are supplied per face (one Newell normal per face), so we don't
      // want flatShading recomputing per-triangle normals (that caused the crease).
      flatShading: false,
      roughness: 0.6,
      metalness: 0.0,
      side: 2, // DoubleSide
      // Emissive starts dark; pulseGlow() drives emissiveIntensity for the
      // discovery flash (its color tracks the current face color, so the shape
      // appears to brighten from within).
      emissive: new Color(config.render.faceColor),
      emissiveIntensity: 0,
    });
    this.faceMesh = new ThreeMesh(new BufferGeometry(), this.faceMat);
    this.edges = new LineSegments(
      new BufferGeometry(),
      // Per-edge colors (dark palette) come from the geometry color attribute.
      new LineBasicMaterial({ color: 0xffffff, vertexColors: true }),
    );
    this.edges.visible = config.render.showEdges;

    // White tube for the drag "range" line (current point → max). Unit cylinder
    // (radius 1, height 1 along +Y); positioned/scaled per drag and per frame.
    this.dragTube = new ThreeMesh(
      new CylinderGeometry(1, 1, 1, 16),
      new MeshBasicMaterial({
        color: config.render.dragLineColor,
        // transparent so it joins the same render pass as the (transparent) faces;
        // the high renderOrder + no depth test then keep it drawn last, on top.
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.dragTube.visible = false;
    this.dragTube.renderOrder = 10;

    // Small sphere on the vertex currently targeted by the drag.
    this.dragMarker = new ThreeMesh(
      new SphereGeometry(config.render.dragMarkerRadius, 14, 10),
      new MeshBasicMaterial({
        color: config.render.dragMarkerColor,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.dragMarker.visible = false;
    this.dragMarker.renderOrder = 9;

    // Translucent overlay over a hovered face.
    this.faceHighlightMat = new MeshBasicMaterial({
      color: config.render.faceHighlightColor,
      transparent: true,
      opacity: config.render.faceHighlightOpacity,
      side: 2, // DoubleSide
      depthWrite: false,
    });
    this.faceHighlight = new ThreeMesh(new BufferGeometry(), this.faceHighlightMat);
    this.faceHighlight.visible = false;
    this.faceHighlight.renderOrder = 1;

    // Twist arc: a white tube drawn on top, styled exactly like the drag range line.
    this.twistArc = new ThreeMesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        color: config.render.dragLineColor,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.twistArc.visible = false;
    this.twistArc.renderOrder = 10;
    // The solid progress sub-arc, drawn on top of the full-extent arc.
    this.twistArcProgress = new ThreeMesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        color: config.render.dragLineColor,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.twistArcProgress.visible = false;
    this.twistArcProgress.renderOrder = 11;

    this.group.add(
      this.faceMesh,
      this.edges,
      this.markerGroup,
      this.dragTube,
      this.dragMarker,
      this.faceHighlight,
      this.twistArc,
      this.twistArcProgress,
    );
    scene.add(this.group);
  }

  /** The polyhedron surface mesh (for ray-hit tests). */
  get surfaceMesh(): ThreeMesh {
    return this.faceMesh;
  }

  /**
   * Rebuild everything from a committed polyhedron. By default this snaps the
   * face colors to the polyhedron's committed colors; pass `keepFade` (used when
   * finishing a relax that is still color-fading) to leave an active fade running.
   */
  setPolyhedron(poly: Polyhedron, _invalid: boolean, keepFade = false): void {
    if (!keepFade) this.colorFade = null;
    const colors =
      this.colorFade ? this.displayFaceColors : faceColorsRGB(poly.colors.face);
    this.updateSurface(poly.mesh, colors, poly.colors.edge);
    this.rebuildMarkers(poly);
    this.markerGroup.visible = true;
    this.clearEdgeHighlight();
    this.clearFaceHighlight();
    this.hideDragMarker();
    this.clearTwistArc();
  }

  /**
   * Temporarily swap the surface to the "light" export look (light face palette,
   * dark legible edges, opaque faces, no emissive glow, markers hidden) and return
   * a closure that restores the on-screen look exactly. Used by the _light.png save.
   * Builds throwaway geometry and keeps the live geometry aside, so it never
   * disturbs the display state (colors, fades, vertex counts).
   */
  applyExportLight(poly: Polyhedron): () => void {
    const oldFaceGeo = this.faceMesh.geometry;
    const oldEdgeGeo = this.edges.geometry;
    const oldOpacity = this.faceMat.opacity;
    const oldTransparent = this.faceMat.transparent;
    const oldEmissive = this.faceMat.emissiveIntensity;
    const oldMarkers = this.markerGroup.visible;

    const fa = faceGeometryArrays(poly.mesh, faceColorsRGBLight(poly.colors.face));
    const fg = new BufferGeometry();
    fg.setAttribute("position", new Float32BufferAttribute(fa.positions, 3));
    fg.setAttribute("normal", new Float32BufferAttribute(fa.normals, 3));
    fg.setAttribute("color", new Float32BufferAttribute(fa.colors, 3));
    this.faceMesh.geometry = fg;

    const ea = edgeGeometryArrays(poly.mesh, poly.colors.edge, undefined, darkRGBLight);
    const eg = new BufferGeometry();
    eg.setAttribute("position", new Float32BufferAttribute(ea.positions, 3));
    eg.setAttribute("color", new Float32BufferAttribute(ea.colors, 3));
    this.edges.geometry = eg;

    this.faceMat.opacity = config.render.light.faceOpacity;
    this.faceMat.transparent = config.render.light.faceOpacity < 1;
    this.faceMat.emissiveIntensity = 0;
    this.markerGroup.visible = false;

    return () => {
      this.faceMesh.geometry.dispose();
      this.faceMesh.geometry = oldFaceGeo;
      this.edges.geometry.dispose();
      this.edges.geometry = oldEdgeGeo;
      this.faceMat.opacity = oldOpacity;
      this.faceMat.transparent = oldTransparent;
      this.faceMat.emissiveIntensity = oldEmissive;
      this.markerGroup.visible = oldMarkers;
    };
  }

  /** Start a face-color fade from `from` to `to` over `seconds`. The geometry is
   *  expected to already show `from` (caller renders the committed mesh first). */
  startColorFade(from: Color[], to: Color[], seconds: number): void {
    this.displayFaceColors = from.map((c) => c.clone());
    this.colorFade = { from, to, start: performance.now(), durMs: Math.max(1, seconds * 1000) };
    this.writeFaceColors();
  }

  /** Start an emissive glow pulse that peaks at `strength` and fades over
   *  `seconds` (used for the new-shape discovery flash). */
  pulseGlow(strength: number, seconds: number): void {
    this.faceMat.emissive.copy(this.faceMat.color);
    this.glowPeak = strength;
    this.glowStart = performance.now();
    this.glowDur = Math.max(1, seconds * 1000);
  }

  /** Advance time-based visual effects (color fade + glow pulse). Call per frame. */
  updateEffects(nowMs: number): void {
    this.advanceColorFade(nowMs);
    if (this.glowDur <= 0) return;
    const t = (nowMs - this.glowStart) / this.glowDur;
    if (t >= 1) {
      this.faceMat.emissiveIntensity = 0;
      this.glowDur = 0;
      return;
    }
    // Quick attack, gentle decay.
    const env = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    this.faceMat.emissiveIntensity = this.glowPeak * Math.max(0, env);
  }

  /** Step an in-progress face-color fade and rewrite the color buffer in place. */
  private advanceColorFade(nowMs: number): void {
    const f = this.colorFade;
    if (!f) return;
    const k = Math.min(1, (nowMs - f.start) / f.durMs);
    const ease = k * k * (3 - 2 * k); // smoothstep
    for (let i = 0; i < this.displayFaceColors.length; i++) {
      const from = f.from[i] ?? paletteRGB(undefined);
      const to = f.to[i] ?? paletteRGB(undefined);
      this.displayFaceColors[i] = from.clone().lerp(to, ease);
    }
    this.writeFaceColors();
    if (k >= 1) this.colorFade = null;
  }

  /** Show the small sphere on the vertex currently targeted by the drag. */
  setDragMarker(point: Vector3, color: number = config.render.dragMarkerColor): void {
    (this.dragMarker.material as MeshBasicMaterial).color.setHex(color);
    this.dragMarker.position.copy(point);
    this.dragMarker.visible = true;
  }

  hideDragMarker(): void {
    this.dragMarker.visible = false;
  }

  /** Update the face + wireframe surface (used live and on commit). Records the
   *  per-face colors + triangle counts so a fade can rewrite colors in place. */
  private updateSurface(
    mesh: Mesh,
    faceColors: Color[],
    edgeColors: Map<string, GeomColor>,
    hiddenEdges?: Set<string>,
  ): void {
    this.displayFaceColors = faceColors;
    this.displayEdgeColors = edgeColors;
    this.faceVertCounts = mesh.faces.map((f) => faceVertexCount(f.length));
    const { positions, normals, colors } = faceGeometryArrays(mesh, faceColors);
    const fg = new BufferGeometry();
    fg.setAttribute("position", new Float32BufferAttribute(positions, 3));
    fg.setAttribute("normal", new Float32BufferAttribute(normals, 3));
    fg.setAttribute("color", new Float32BufferAttribute(colors, 3));
    this.faceMesh.geometry.dispose();
    this.faceMesh.geometry = fg;

    const edge = edgeGeometryArrays(mesh, edgeColors, hiddenEdges);
    const eg = new BufferGeometry();
    eg.setAttribute("position", new Float32BufferAttribute(edge.positions, 3));
    eg.setAttribute("color", new Float32BufferAttribute(edge.colors, 3));
    this.edges.geometry.dispose();
    this.edges.geometry = eg;
  }

  /** Rewrite just the color attribute in place from `displayFaceColors`. */
  private writeFaceColors(): void {
    const attr = this.faceMesh.geometry.getAttribute("color") as
      | Float32BufferAttribute
      | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    let o = 0;
    for (let fi = 0; fi < this.faceVertCounts.length; fi++) {
      const c = this.displayFaceColors[fi] ?? paletteRGB(undefined);
      for (let k = 0; k < this.faceVertCounts[fi]; k++) {
        arr[o++] = c.r;
        arr[o++] = c.g;
        arr[o++] = c.b;
      }
    }
    attr.needsUpdate = true;
  }

  private rebuildMarkers(poly: Polyhedron): void {
    for (const m of this.markerGroup.children.slice()) this.markerGroup.remove(m);
    this.vertexMarkers = [];
    this.faceMarkers = [];
    this.edgeMarkers = [];

    const makeMarker = (kind: MarkerKind, geo: SphereGeometry, pos: Vector3) => {
      const app = appearanceForState(kind, "normal");
      const mat = new MeshBasicMaterial({
        color: app.color,
        transparent: true,
        opacity: app.opacity,
        depthWrite: false,
      });
      const mesh = new ThreeMesh(geo, mat);
      mesh.position.copy(pos);
      mesh.visible = false; // markers only appear on hover / proximity
      mesh.renderOrder = 3;
      this.markerGroup.add(mesh);
      return mesh;
    };

    // Per-face Newell normals, oriented OUTWARD (the solid is centered at the
    // origin, so a face's outward direction is its centroid direction). The
    // stored winding isn't guaranteed outward, hence the flip — same reasoning
    // as setFaceHighlight. The picker uses these to cull faces that point away.
    const faceNormals = poly.faces.map((f) => {
      const n = newellNormal(f.map((i) => poly.vertices[i]));
      const c = faceCentroidOf(poly.vertices, f);
      if (n.dot(c) < 0) n.negate();
      return n;
    });

    if (config.render.showVertexMarkers) {
      poly.vertices.forEach((p, id) => {
        const mesh = makeMarker("vertex", this.vertexGeo, p);
        this.vertexMarkers.push({
          kind: "vertex", id,
          position: p.clone(), mesh,
          normals: poly.faces
            .map((f, fi) => (f.includes(id) ? faceNormals[fi] : null))
            .filter((n): n is Vector3 => n !== null) });
      });
    }
    if (config.render.showFaceMarkers) {
      poly.faces.forEach((f, id) => {
        const c = faceCentroidOf(poly.vertices, f);
        const mesh = makeMarker("face", this.faceGeo, c);
        this.faceMarkers.push({
          kind: "face", id,
          position: c, mesh,
          normals: [faceNormals[id]] });
      });
    }
    if (config.render.showEdgeMarkers) {
      // One handle per undirected edge, at its midpoint. The two faces sharing the
      // edge give its facing test (for culling) and its drag-axis normals.
      const facesByEdge = new Map<string, number[]>();
      poly.faces.forEach((f, fi) => {
        for (let i = 0; i < f.length; i++) {
          const a = f[i];
          const b = f[(i + 1) % f.length];
          const key = a < b ? `${a}_${b}` : `${b}_${a}`;
          (facesByEdge.get(key) ?? facesByEdge.set(key, []).get(key)!).push(fi);
        }
      });
      let eid = 0;
      for (const [key, fis] of facesByEdge) {
        const [a, b] = key.split("_").map(Number);
        const mid = poly.vertices[a].clone().add(poly.vertices[b]).multiplyScalar(0.5);
        const mesh = makeMarker("edge", this.edgeGeo, mid);
        this.edgeMarkers.push({
          kind: "edge", id: eid++,
          position: mid, mesh,
          normals: fis.map((fi) => faceNormals[fi]),
          edge: [a, b],
        });
      }
    }
  }

  /** Show a transient morph preview (hide markers + face overlay). `faceColors`
   *  overrides the per-face colors (drag); omit to keep the current colors (solve
   *  frames, where a fade may be running). `hiddenEdges` drops vanishing edges. */
  showPreview(mesh: Mesh, opts?: PreviewOpts): void {
    this.markerGroup.visible = false;
    this.clearFaceHighlight();
    this.updateSurface(
      mesh,
      opts?.faceColors ?? this.displayFaceColors,
      opts?.edgeColors ?? this.displayEdgeColors,
      opts?.hiddenEdges,
    );
  }

  /** Rescale markers + the drag tube so their apparent on-screen size is stable. */
  updateMarkerScales(camera: Camera, refDistance: number): void {
    for (const m of [...this.vertexMarkers, ...this.faceMarkers, ...this.edgeMarkers]) {
      const d = camera.position.distanceTo(m.mesh.position);
      m.mesh.scale.setScalar(Math.max(d / refDistance, 0.05));
    }
    if (this.dragMarker.visible) {
      const d = camera.position.distanceTo(this.dragMarker.position);
      this.dragMarker.scale.setScalar(Math.max(d / refDistance, 0.05));
    }
    if (this.dragTube.visible) {
      const dir = this.dragB.clone().sub(this.dragA);
      const len = dir.length();
      if (len < 1e-6) {
        this.dragTube.visible = false;
        return;
      }
      const mid = this.dragA.clone().add(this.dragB).multiplyScalar(0.5);
      const d = camera.position.distanceTo(mid);
      const radius = config.render.dragLineRadius * Math.max(d / refDistance, 0.05);
      this.dragTube.position.copy(mid);
      this.dragTube.quaternion.setFromUnitVectors(TUBE_UP, dir.normalize());
      this.dragTube.scale.set(radius, len, radius);
    }
  }

  /** Hide every marker (they only show on hover / when selected). */
  resetMarkerStates(): void {
    for (const m of this.vertexMarkers) m.mesh.visible = false;
    for (const m of this.faceMarkers) m.mesh.visible = false;
    for (const m of this.edgeMarkers) m.mesh.visible = false;
  }

  /** The marker list for a kind. */
  private markersFor(kind: MarkerKind): Marker[] {
    return kind === "vertex"
      ? this.vertexMarkers
      : kind === "edge"
        ? this.edgeMarkers
        : this.faceMarkers;
  }

  /** Make one marker visible with the given state's color + opacity. */
  showMarker(kind: MarkerKind, id: number, state: MarkerState): void {
    const arr = this.markersFor(kind);
    const m = arr.find((x) => x.id === id);
    if (!m) return;
    m.mesh.visible = true;
    const app = appearanceForState(kind, state);
    const mat = m.mesh.material as MeshBasicMaterial;
    mat.color.setHex(app.color);
    mat.opacity = app.opacity;
  }

  /** Translucent overlay over a hovered face (lifted slightly off the surface). */
  setFaceHighlight(points: Vector3[], color: number = config.render.faceHighlightColor): void {
    this.faceHighlightMat.color.setHex(color);
    const n = newellNormal(points);
    // Ensure the lift is OUTWARD (away from the origin) regardless of the face's
    // stored winding, otherwise the overlay sinks behind the surface and vanishes.
    const c = new Vector3();
    for (const p of points) c.add(p);
    c.multiplyScalar(1 / points.length);
    if (n.dot(c) < 0) n.negate();
    const off = 0.006; // lift off the surface to avoid z-fighting
    const pos: number[] = [];
    const p0 = points[0].clone().addScaledVector(n, off);
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i].clone().addScaledVector(n, off);
      const b = points[i + 1].clone().addScaledVector(n, off);
      pos.push(p0.x, p0.y, p0.z, a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    this.faceHighlight.geometry.dispose();
    this.faceHighlight.geometry = g;
    this.faceHighlight.visible = true;
  }

  clearFaceHighlight(): void {
    this.faceHighlight.visible = false;
  }

  /** Show the drag range line between two world points (sized in updateMarkerScales). */
  setEdgeHighlight(a: Vector3, b: Vector3, color: number = config.render.dragLineColor): void {
    (this.dragTube.material as MeshBasicMaterial).color.setHex(color);
    this.dragA.copy(a);
    this.dragB.copy(b);
    this.dragTube.visible = true;
  }

  clearEdgeHighlight(): void {
    this.dragTube.visible = false;
  }

  /**
   * Draw the gyro rotation arc: a tube (radius `tubeRadius`, matching the drag range
   * line) bent along the arc `a.ref` sweeps ±`a.halfSweepRad` around `a.center`/
   * `a.axis` (the apex + its tangent-plane normal), so both chiralities are shown at
   * `opacity`. When `showProgress` is set, a solid (full-opacity) sub-arc is overlaid
   * from the midpoint (zero twist) out to `a.ride` — how far the gyro has been rotated.
   */
  setTwistArc(a: TwistArc, opacity: number, tubeRadius: number, showProgress: boolean): void {
    const segs = Math.max(2, config.render.twistArcSegments);
    const r = a.ref.clone().sub(a.center);
    const axis = a.axis.clone().normalize();
    const tubeFor = (from: number, to: number, count: number): TubeGeometry => {
      const steps = Math.max(2, count);
      const pts: Vector3[] = [];
      for (let i = 0; i <= steps; i++) {
        const ang = from + ((to - from) * i) / steps;
        pts.push(r.clone().applyAxisAngle(axis, ang).add(a.center));
      }
      return new TubeGeometry(new CatmullRomCurve3(pts), steps, tubeRadius, 8, false);
    };
    // Full extent (both chiralities) at reduced opacity.
    this.twistArc.geometry.dispose();
    this.twistArc.geometry = tubeFor(-a.halfSweepRad, a.halfSweepRad, segs);
    (this.twistArc.material as MeshBasicMaterial).opacity = opacity;
    this.twistArc.visible = true;
    // Solid progress sub-arc from the midpoint to the current ride.
    if (showProgress) {
      const ride = a.ride.clone().sub(a.center);
      const swept = Math.atan2(axis.dot(new Vector3().crossVectors(r, ride)), r.dot(ride));
      const count = Math.round((segs * Math.abs(swept)) / (2 * a.halfSweepRad || 1));
      this.twistArcProgress.geometry.dispose();
      this.twistArcProgress.geometry = tubeFor(0, swept, count);
      (this.twistArcProgress.material as MeshBasicMaterial).opacity = 1;
      this.twistArcProgress.visible = true;
    } else {
      this.twistArcProgress.visible = false;
    }
  }

  clearTwistArc(): void {
    this.twistArc.visible = false;
    this.twistArcProgress.visible = false;
  }
}
