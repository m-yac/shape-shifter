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
  Vector3,
} from "three";

const TUBE_UP = new Vector3(0, 1, 0);
import { type Camera } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { Polyhedron } from "../geometry/polyhedron";
import { faceCentroidOf, newellNormal } from "../geometry/polyhedron";
import { config } from "../config";

export type MarkerKind = "vertex" | "face";
export type MarkerState = "normal" | "proximity" | "hover" | "selected" | "drag";

export interface Marker {
  kind: MarkerKind;
  id: number;
  position: Vector3;
  normals: Vector3[];
  mesh: ThreeMesh;
}

/** Unique undirected edges (as index pairs) of a mesh, for the wireframe. */
function meshEdges(mesh: Mesh): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([a, b]);
      }
    }
  }
  return out;
}

/**
 * Fan-triangulated face geometry (non-indexed). Every triangle of a face is
 * given that face's single Newell normal, so a face shades uniformly with no
 * crease along the triangulation diagonal even if it is very slightly non-planar.
 */
function faceGeometryArrays(mesh: Mesh): { positions: number[]; normals: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const f of mesh.faces) {
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
      for (let k = 0; k < 3; k++) normals.push(n.x, n.y, n.z);
    }
  }
  return { positions, normals };
}

function edgePositions(mesh: Mesh): number[] {
  const pos: number[] = [];
  for (const [a, b] of meshEdges(mesh)) {
    const pa = mesh.vertices[a];
    const pb = mesh.vertices[b];
    pos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
  }
  return pos;
}

/** Color + opacity for a marker in a given state. */
function appearanceForState(
  kind: MarkerKind,
  state: MarkerState,
): { color: number; opacity: number } {
  const base =
    kind === "vertex"
      ? config.render.vertexMarkerColor
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

  vertexMarkers: Marker[] = [];
  faceMarkers: Marker[] = [];

  private faceMat: MeshStandardMaterial;
  private faceHighlightMat: MeshBasicMaterial;
  private vertexGeo = new SphereGeometry(config.render.vertexMarkerRadius, 14, 10);
  private faceGeo = new SphereGeometry(config.render.faceMarkerRadius, 14, 10);

  constructor(public readonly scene: Scene) {
    this.faceMat = new MeshStandardMaterial({
      color: config.render.faceColor,
      transparent: config.render.faceOpacity < 1,
      opacity: config.render.faceOpacity,
      // Normals are supplied per face (one Newell normal per face), so we don't
      // want flatShading recomputing per-triangle normals (that caused the crease).
      flatShading: false,
      roughness: 0.6,
      metalness: 0.0,
      side: 2, // DoubleSide
    });
    this.faceMesh = new ThreeMesh(new BufferGeometry(), this.faceMat);
    this.edges = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: config.render.edgeColor }),
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

    this.group.add(
      this.faceMesh,
      this.edges,
      this.markerGroup,
      this.dragTube,
      this.dragMarker,
      this.faceHighlight,
    );
    scene.add(this.group);
  }

  /** The polyhedron surface mesh (for ray-hit tests). */
  get surfaceMesh(): ThreeMesh {
    return this.faceMesh;
  }

  /** Rebuild everything from a committed polyhedron. */
  setPolyhedron(poly: Polyhedron, invalid: boolean): void {
    this.updateSurface(poly.mesh);
    this.faceMat.color.setHex(
      invalid ? config.render.invalidFaceColor : config.render.faceColor,
    );
    this.rebuildMarkers(poly);
    this.markerGroup.visible = true;
    this.clearEdgeHighlight();
    this.clearFaceHighlight();
    this.hideDragMarker();
  }

  /** Recolor the surface (e.g. the green "adjusting" tint while relaxing). */
  setSurfaceColor(hex: number): void {
    this.faceMat.color.setHex(hex);
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

  /** Update only the face + wireframe surface (used live and on commit). */
  private updateSurface(mesh: Mesh): void {
    const { positions, normals } = faceGeometryArrays(mesh);
    const fg = new BufferGeometry();
    fg.setAttribute("position", new Float32BufferAttribute(positions, 3));
    fg.setAttribute("normal", new Float32BufferAttribute(normals, 3));
    this.faceMesh.geometry.dispose();
    this.faceMesh.geometry = fg;

    const eg = new BufferGeometry();
    eg.setAttribute(
      "position",
      new Float32BufferAttribute(edgePositions(mesh), 3),
    );
    this.edges.geometry.dispose();
    this.edges.geometry = eg;
  }

  private rebuildMarkers(poly: Polyhedron): void {
    for (const m of this.markerGroup.children.slice()) this.markerGroup.remove(m);
    this.vertexMarkers = [];
    this.faceMarkers = [];

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
  }

  /** Show a transient morph preview (hide markers + face overlay). */
  showPreview(mesh: Mesh): void {
    this.markerGroup.visible = false;
    this.clearFaceHighlight();
    this.updateSurface(mesh);
  }

  /** Rescale markers + the drag tube so their apparent on-screen size is stable. */
  updateMarkerScales(camera: Camera, refDistance: number): void {
    for (const m of [...this.vertexMarkers, ...this.faceMarkers]) {
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
  }

  /** Make one marker visible with the given state's color + opacity. */
  showMarker(kind: MarkerKind, id: number, state: MarkerState): void {
    const arr = kind === "vertex" ? this.vertexMarkers : this.faceMarkers;
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
}
