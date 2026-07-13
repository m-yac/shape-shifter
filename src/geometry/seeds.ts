import { Vector3 } from "three";
import { type Mesh, buildDCEL, facesAroundVertex } from "./HalfEdge";

/**
 * Seed polyhedra (the 5 Platonic solids). A face literal only needs the right vertex
 * membership; `buildDCEL` fixes winding and orientation.
 *
 * To add more seeds: append an entry and list its name in `config.seeds.enabled`.
 */

const PHI = (1 + Math.sqrt(5)) / 2;

function v(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

/** Center at origin and scale so the farthest vertex sits at radius 1. */
export function normalize(mesh: Mesh): Mesh {
  const c = new Vector3();
  for (const p of mesh.vertices) c.add(p);
  c.multiplyScalar(1 / mesh.vertices.length);
  let maxR = 0;
  for (const p of mesh.vertices) maxR = Math.max(maxR, p.distanceTo(c));
  const s = maxR > 0 ? 1 / maxR : 1;
  return {
    vertices: mesh.vertices.map((p) => p.clone().sub(c).multiplyScalar(s)),
    faces: mesh.faces.map((f) => f.slice()),
  };
}

/** The dual polyhedron: face centroids become vertices, and each vertex becomes a face,
 *  using the cyclic face order the half-edge walk already provides. */
export function dual(mesh: Mesh): Mesh {
  const dcel = buildDCEL(mesh);
  const vertices = dcel.faces.map((f) => {
    const c = new Vector3();
    let h = f.halfedge;
    const start = h;
    let n = 0;
    do {
      c.add(h.origin.position);
      n++;
      h = h.next;
    } while (h !== start);
    return c.multiplyScalar(1 / n);
  });
  const faces = dcel.vertices.map((vert) =>
    facesAroundVertex(vert).map((f) => f.id),
  );
  return { vertices, faces };
}

const tetrahedron: Mesh = {
  vertices: [v(1, 1, 1), v(1, -1, -1), v(-1, 1, -1), v(-1, -1, 1)],
  faces: [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ],
};

const cube: Mesh = {
  vertices: [
    v(-1, -1, -1),
    v(1, -1, -1),
    v(1, 1, -1),
    v(-1, 1, -1),
    v(-1, -1, 1),
    v(1, -1, 1),
    v(1, 1, 1),
    v(-1, 1, 1),
  ],
  faces: [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 2, 6, 7],
    [0, 3, 7, 4],
    [1, 2, 6, 5],
  ],
};

const octahedron: Mesh = {
  vertices: [
    v(1, 0, 0),
    v(-1, 0, 0),
    v(0, 1, 0),
    v(0, -1, 0),
    v(0, 0, 1),
    v(0, 0, -1),
  ],
  faces: [
    [0, 2, 4],
    [1, 2, 4],
    [1, 3, 4],
    [0, 3, 4],
    [0, 2, 5],
    [1, 2, 5],
    [1, 3, 5],
    [0, 3, 5],
  ],
};

const icosahedron: Mesh = {
  vertices: [
    v(-1, PHI, 0),
    v(1, PHI, 0),
    v(-1, -PHI, 0),
    v(1, -PHI, 0),
    v(0, -1, PHI),
    v(0, 1, PHI),
    v(0, -1, -PHI),
    v(0, 1, -PHI),
    v(PHI, 0, -1),
    v(PHI, 0, 1),
    v(-PHI, 0, -1),
    v(-PHI, 0, 1),
  ],
  faces: [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ],
};

// The dodecahedron is the dual of the icosahedron.
const dodecahedron: Mesh = dual(icosahedron);

const SEEDS: Record<string, Mesh> = {
  tetrahedron,
  cube,
  octahedron,
  dodecahedron,
  icosahedron,
};

/** Return a fresh, normalized copy of the named seed (or throw if unknown). */
export function getSeed(name: string): Mesh {
  const m = SEEDS[name];
  if (!m) throw new Error(`Unknown seed polyhedron: "${name}"`);
  return normalize({
    vertices: m.vertices.map((p) => p.clone()),
    faces: m.faces.map((f) => f.slice()),
  });
}

export function seedNames(): string[] {
  return Object.keys(SEEDS);
}
