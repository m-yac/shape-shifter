import { Vector3 } from "three";
import {
  type Mesh,
  type DCEL,
  type HEFace,
  buildDCEL,
  faceVertices,
} from "./HalfEdge";
import { type ColorSet, uniformColors } from "./colors";

/** Centroid of a face given the mesh vertex array and the face's index loop. */
export function faceCentroidOf(vertices: Vector3[], loop: number[]): Vector3 {
  const c = new Vector3();
  for (const i of loop) c.add(vertices[i]);
  return c.multiplyScalar(1 / loop.length);
}

/**
 * Newell's method normal for a (possibly non-planar) polygon — robust and
 * area-weighted. Returns a unit vector.
 */
export function newellNormal(points: Vector3[]): Vector3 {
  const n = new Vector3();
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const nxt = points[(i + 1) % points.length];
    n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
    n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
    n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
  }
  const len = n.length();
  return len > 1e-12 ? n.multiplyScalar(1 / len) : new Vector3(0, 0, 1);
}

export function faceCentroidHE(f: HEFace): Vector3 {
  const verts = faceVertices(f).map((v) => v.position);
  const c = new Vector3();
  for (const p of verts) c.add(p);
  return c.multiplyScalar(1 / verts.length);
}

export function faceNormalHE(f: HEFace): Vector3 {
  return newellNormal(faceVertices(f).map((v) => v.position));
}

/** Approximate "radius" (max distance from centroid) — used for scale-relative
 *  tolerances and to keep the overall size stable through edits. */
export function meshRadius(mesh: Mesh): number {
  const c = new Vector3();
  for (const p of mesh.vertices) c.add(p);
  c.multiplyScalar(1 / mesh.vertices.length);
  let r = 0;
  for (const p of mesh.vertices) r = Math.max(r, p.distanceTo(c));
  return r;
}

export function cloneMesh(mesh: Mesh): Mesh {
  return {
    vertices: mesh.vertices.map((p) => p.clone()),
    faces: mesh.faces.map((f) => f.slice()),
  };
}

/**
 * A committed polyhedron: the plain Mesh plus its lazily-built half-edge view.
 * Treat it as immutable — operations and the solver produce new meshes which
 * are wrapped in a new Polyhedron.
 */
export class Polyhedron {
  readonly mesh: Mesh;
  /** Per-vertex/edge/face palette colors (see geometry/colors.ts). Defaults to
   *  the generic seed coloring (faces 0, vertices 1, edges 2) when not supplied. */
  readonly colors: ColorSet;
  /** The operation's direct, never-regularized output — a pristine copy of the
   *  geometry as committed, with a 1:1 vertex-index correspondence to `mesh`.
   *  `mesh.vertices` get mutated in place by the relaxation solver, but `raw` is
   *  left untouched so a re-solve (strategy switch, big drift) can always rebuild
   *  the solver's base from a clean, well-defined starting form. */
  readonly raw: Mesh;
  private _dcel: DCEL | null = null;

  constructor(mesh: Mesh, colors?: ColorSet, raw?: Mesh) {
    this.mesh = mesh;
    this.colors = colors ?? uniformColors(mesh, 1, 2, 0);
    this.raw = raw ?? cloneMesh(mesh);
  }

  get dcel(): DCEL {
    if (!this._dcel) this._dcel = buildDCEL(this.mesh);
    return this._dcel;
  }

  get vertices(): Vector3[] {
    return this.mesh.vertices;
  }

  get faces(): number[][] {
    return this.mesh.faces;
  }

  clone(): Polyhedron {
    return new Polyhedron(
      cloneMesh(this.mesh),
      {
        vertex: this.colors.vertex.slice(),
        face: this.colors.face.slice(),
        edge: new Map(this.colors.edge),
      },
      cloneMesh(this.raw),
    );
  }
}
