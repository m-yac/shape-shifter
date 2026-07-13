import { Vector3 } from "three";

/**
 * The plain, serializable representation of a committed polyhedron: vertex positions plus
 * faces, where each face is a loop of vertex indices. Operations and the solver work on
 * this form; the half-edge structure below is read-only derived data for topology queries.
 */
export interface Mesh {
  vertices: Vector3[];
  /** Each face: vertex indices in order. Winding is made consistent + outward. */
  faces: number[][];
}

// ---------------------------------------------------------------------------
//  Half-edge (DCEL) types — derived from a Mesh for adjacency queries.
// ---------------------------------------------------------------------------

export interface HEVertex {
  id: number;
  position: Vector3;
  /** One half-edge whose origin is this vertex. */
  halfedge: HalfEdge;
}

export interface HEFace {
  id: number;
  /** One half-edge belonging to this face. */
  halfedge: HalfEdge;
}

export interface HalfEdge {
  id: number;
  origin: HEVertex;
  twin: HalfEdge | null;
  next: HalfEdge;
  prev: HalfEdge;
  face: HEFace;
}

export interface DCEL {
  vertices: HEVertex[];
  faces: HEFace[];
  halfedges: HalfEdge[];
}

// ---------------------------------------------------------------------------
//  Orientation: make all face windings consistent and outward-facing. Required for
//  twin-matching to work and for normals to point outward.
// ---------------------------------------------------------------------------

function undirectedKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** Signed volume; positive when faces wind CCW as seen from outside. */
function signedVolume(vertices: Vector3[], faces: number[][]): number {
  let v = 0;
  for (const f of faces) {
    const p0 = vertices[f[0]];
    for (let i = 1; i < f.length - 1; i++) {
      const a = vertices[f[i]];
      const b = vertices[f[i + 1]];
      v += p0.dot(new Vector3().crossVectors(a, b));
    }
  }
  return v / 6;
}

/**
 * Returns faces re-wound so that (a) every shared edge is traversed in opposite
 * directions by its two faces (manifold-consistent) and (b) normals point
 * outward. Works for closed orientable manifolds (all our polyhedra).
 */
export function orientFaces(mesh: Mesh): number[][] {
  const faces = mesh.faces.map((f) => f.slice());
  const n = faces.length;

  // undirected edge -> list of face indices that touch it
  const edgeFaces = new Map<string, number[]>();
  for (let fi = 0; fi < n; fi++) {
    const f = faces[fi];
    for (let i = 0; i < f.length; i++) {
      const key = undirectedKey(f[i], f[(i + 1) % f.length]);
      (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push(fi);
    }
  }

  /** Does face `fi` contain the directed edge a->b? */
  const hasDirected = (fi: number, a: number, b: number): boolean => {
    const f = faces[fi];
    for (let i = 0; i < f.length; i++) {
      if (f[i] === a && f[(i + 1) % f.length] === b) return true;
    }
    return false;
  };

  const visited = new Array<boolean>(n).fill(false);
  // The mesh may (in theory) be disconnected; loop over all components.
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    visited[start] = true;
    const queue = [start];
    while (queue.length) {
      const fi = queue.shift()!;
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const neighbors = edgeFaces.get(undirectedKey(a, b)) ?? [];
        for (const nf of neighbors) {
          if (nf === fi || visited[nf]) continue;
          // For consistency the neighbor must traverse this edge as b->a.
          // If it also has a->b, its winding is flipped relative to us: reverse it.
          if (hasDirected(nf, a, b)) faces[nf].reverse();
          visited[nf] = true;
          queue.push(nf);
        }
      }
    }
  }

  // Flip globally if the result encloses negative volume (inward normals).
  if (signedVolume(mesh.vertices, faces) < 0) {
    for (const f of faces) f.reverse();
  }
  return faces;
}

// ---------------------------------------------------------------------------
//  DCEL construction.
// ---------------------------------------------------------------------------

/** Build a half-edge structure from a Mesh, fixing face orientation first. */
export function buildDCEL(mesh: Mesh): DCEL {
  const faces = orientFaces(mesh);

  const vertices: HEVertex[] = mesh.vertices.map((p, id) => ({
    id,
    position: p,
    halfedge: null as unknown as HalfEdge, // filled below
  }));

  const heFaces: HEFace[] = [];
  const halfedges: HalfEdge[] = [];
  // directed (origin,dest) -> halfedge, for twin matching
  const byDirected = new Map<string, HalfEdge>();

  for (let fi = 0; fi < faces.length; fi++) {
    const loop = faces[fi];
    const face: HEFace = { id: fi, halfedge: null as unknown as HalfEdge };
    heFaces.push(face);

    const ring: HalfEdge[] = [];
    for (let i = 0; i < loop.length; i++) {
      const origin = vertices[loop[i]];
      const he: HalfEdge = {
        id: halfedges.length,
        origin,
        twin: null,
        next: null as unknown as HalfEdge,
        prev: null as unknown as HalfEdge,
        face,
      };
      halfedges.push(he);
      ring.push(he);
      if (!origin.halfedge) origin.halfedge = he;
    }
    // link the ring
    for (let i = 0; i < ring.length; i++) {
      ring[i].next = ring[(i + 1) % ring.length];
      ring[i].prev = ring[(i - 1 + ring.length) % ring.length];
    }
    face.halfedge = ring[0];

    // register directed edges for twin matching
    for (let i = 0; i < ring.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      byDirected.set(`${a}->${b}`, ring[i]);
    }
  }

  // match twins
  for (const he of halfedges) {
    const a = he.origin.id;
    const b = he.next.origin.id;
    he.twin = byDirected.get(`${b}->${a}`) ?? null;
  }

  return { vertices, faces: heFaces, halfedges };
}

// ---------------------------------------------------------------------------
//  Topology queries.
// ---------------------------------------------------------------------------

/** Outgoing half-edges around a vertex, in rotational (cyclic) order. */
export function outgoingHalfEdges(v: HEVertex): HalfEdge[] {
  const out: HalfEdge[] = [];
  let h = v.halfedge;
  const start = h;
  let guard = 0;
  do {
    out.push(h);
    if (!h.twin) break; // boundary (not expected for closed polyhedra)
    h = h.twin.next;
    if (++guard > 1000) break;
  } while (h !== start);
  return out;
}

/** Vertices around a face, in order. */
export function faceVertices(f: HEFace): HEVertex[] {
  const out: HEVertex[] = [];
  let h = f.halfedge;
  const start = h;
  do {
    out.push(h.origin);
    h = h.next;
  } while (h !== start);
  return out;
}

export function vertexDegree(v: HEVertex): number {
  return outgoingHalfEdges(v).length;
}

export function faceOrder(f: HEFace): number {
  let h = f.halfedge;
  const start = h;
  let n = 0;
  do {
    n++;
    h = h.next;
  } while (h !== start);
  return n;
}

/** Faces around a vertex in cyclic order (drives the vertex configuration). */
export function facesAroundVertex(v: HEVertex): HEFace[] {
  return outgoingHalfEdges(v).map((h) => h.face);
}

/** Unique undirected edges as vertex-id pairs. */
export function edgePairs(dcel: DCEL): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id < he.twin.id) {
      out.push([he.origin.id, he.next.origin.id]);
    }
  }
  return out;
}

/** Euler-characteristic style counts. */
export function counts(dcel: DCEL): { V: number; E: number; F: number } {
  return {
    V: dcel.vertices.length,
    E: dcel.halfedges.length / 2,
    F: dcel.faces.length,
  };
}
