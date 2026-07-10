import { Vector3 } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { faceCentroidOf, newellNormal } from "../geometry/polyhedron";

/**
 * Nudge one cyclic RING of vertices toward a regular polygon inscribed in its own
 * best-fit circle (equal radii + equal angular spacing) using the best-fitting
 * rotation, accumulating the per-vertex targets into `disp`/`count`. Used for
 * face-regularization (a face is such a ring). Vertex-regularization needs an
 * extra global-scale coupling, so it has its own variant below.
 */
function accumulateRegularRing(
  vertices: Vector3[],
  ring: number[],
  stepFactor: number,
  disp: Vector3[],
  count: number[],
): void {
  const m = ring.length;
  if (m < 3) return;
  const c = faceCentroidOf(vertices, ring);
  const normal = newellNormal(ring.map((i) => vertices[i]));

  let e1 = vertices[ring[0]].clone().sub(c);
  e1.addScaledVector(normal, -e1.dot(normal));
  if (e1.lengthSq() < 1e-18) return;
  e1.normalize();
  const e2 = new Vector3().crossVectors(normal, e1);

  let R = 0;
  let sumSin = 0;
  let sumCos = 0;
  const step = (2 * Math.PI) / m;
  for (let k = 0; k < m; k++) {
    const d = vertices[ring[k]].clone().sub(c);
    R += d.length();
    const phi = Math.atan2(d.dot(e2), d.dot(e1));
    sumSin += Math.sin(phi - k * step);
    sumCos += Math.cos(phi - k * step);
  }
  R /= m;
  const phase = Math.atan2(sumSin, sumCos);

  for (let k = 0; k < m; k++) {
    const theta = k * step + phase;
    const target = c
      .clone()
      .addScaledVector(e1, R * Math.cos(theta))
      .addScaledVector(e2, R * Math.sin(theta));
    const vi = ring[k];
    disp[vi].add(target.sub(vertices[vi]).multiplyScalar(stepFactor));
    count[vi]++;
  }
}

/**
 * Strategy "faces" — REGULARIZE FACES.
 * Nudge every face toward a regular polygon inscribed in its own best-fit circle.
 * Shared vertices get the average of their faces' targets. Returns the largest
 * per-vertex move this pass, relative to `radius`.
 */
export function regularizeFacesStep(
  mesh: Mesh,
  stepFactor: number,
  radius: number,
): number {
  const n = mesh.vertices.length;
  const disp = Array.from({ length: n }, () => new Vector3());
  const count = new Array<number>(n).fill(0);
  for (const face of mesh.faces)
    accumulateRegularRing(mesh.vertices, face, stepFactor, disp, count);
  return applyDisp(mesh, disp, count, radius);
}

/**
 * Strategy "jumbled" — REGULARIZE VERTEX FIGURES (the dual of regularize-faces).
 *
 * NOTE: as written this does not converge — the shape wanders and its faces never
 * flatten. It is kept for the look, which is why the UI calls the strategy "Jumbled".
 * Where face-regularization makes every FACE a regular polygon, this makes every
 * VERTEX FIGURE regular: it treats each vertex's cyclic ring of neighbours as a
 * polygon and nudges those neighbours toward a regular one.
 *
 * The subtlety that makes this a FAITHFUL dual: a regular polygon face forces its
 * edges to be equal, but a vertex figure is about the DIRECTIONS the edges leave
 * the vertex, NOT the neighbour positions — the incident edges may well have
 * different lengths (e.g. the kite edges of a Catalan solid). So we regularize the
 * unit edge DIRECTIONS (making them an evenly-spaced cone) and keep each edge's own
 * length, rather than forcing the neighbours onto one circle. That lets duals with
 * two edge lengths (rhombic dodecahedron has one, the deltoidal icositetrahedron
 * has two) both relax to their proper, un-spiky form instead of being distorted.
 *
 * Note a regular vertex figure does not pin the cone's opening angle, so this
 * refines the CURRENT shape toward regular figures rather than to a unique form.
 *
 * `neighbors[v]` must list v's neighbours in cyclic order. Returns the largest
 * per-vertex move this pass, relative to `radius`.
 */
export function regularizeVerticesStep(
  mesh: Mesh,
  neighbors: number[][],
  stepFactor: number,
  radius: number,
): number {
  const verts = mesh.vertices;
  const n = verts.length;
  const disp = Array.from({ length: n }, () => new Vector3());
  const count = new Array<number>(n).fill(0);

  for (let v = 0; v < n; v++) {
    const ring = neighbors[v];
    const m = ring.length;
    if (m < 3) continue;
    const apex = verts[v];

    // Unit edge directions + their current lengths. Lengths are preserved, so
    // unequal incident edges survive; only the directions get regularized.
    const dir: Vector3[] = [];
    const len: number[] = [];
    let ok = true;
    for (let k = 0; k < m; k++) {
      const u = verts[ring[k]].clone().sub(apex);
      const L = u.length();
      if (L < 1e-9) {
        ok = false;
        break;
      }
      len.push(L);
      dir.push(u.multiplyScalar(1 / L));
    }
    if (!ok) continue;

    // The vertex figure is the polygon these directions trace on the unit sphere;
    // best-fit its circle (the cone) then place them at equal angular spacing on it.
    const c = new Vector3();
    for (const d of dir) c.add(d);
    c.multiplyScalar(1 / m);
    const axis = newellNormal(dir);

    let e1 = dir[0].clone().sub(c);
    e1.addScaledVector(axis, -e1.dot(axis));
    if (e1.lengthSq() < 1e-18) continue;
    e1.normalize();
    const e2 = new Vector3().crossVectors(axis, e1);

    let R = 0;
    let sumSin = 0;
    let sumCos = 0;
    const step = (2 * Math.PI) / m;
    for (let k = 0; k < m; k++) {
      const d = dir[k].clone().sub(c);
      R += d.length();
      const phi = Math.atan2(d.dot(e2), d.dot(e1));
      sumSin += Math.sin(phi - k * step);
      sumCos += Math.cos(phi - k * step);
    }
    R /= m;
    const phase = Math.atan2(sumSin, sumCos);

    for (let k = 0; k < m; k++) {
      const theta = k * step + phase;
      const td = c
        .clone()
        .addScaledVector(e1, R * Math.cos(theta))
        .addScaledVector(e2, R * Math.sin(theta))
        .normalize(); // regularized direction, back onto the unit sphere
      const target = apex.clone().addScaledVector(td, len[k]); // keep this edge's length
      const vi = ring[k];
      disp[vi].add(target.sub(verts[vi]).multiplyScalar(stepFactor));
      count[vi]++;
    }
  }
  return applyDisp(mesh, disp, count, radius);
}

/**
 * Strategy "edges" — CANONICAL / DUAL (midsphere).
 * Push every edge so the point on it nearest the origin is the same distance
 * from the center (i.e. all edges tangent to a common sphere). This is the
 * classic canonical form: it makes both the polyhedron AND its dual well-shaped
 * (regular vertex figures), and — crucially — it is convex by construction, so
 * unlike face-regularization it never lets a face fall coplanar with a neighbour.
 * This is the right objective for Catalan-like solids whose faces are not regular.
 */
export function canonicalStep(
  mesh: Mesh,
  edges: Array<[number, number]>,
  stepFactor: number,
  radius: number,
): number {
  const n = mesh.vertices.length;

  // Pass 1: tangent point of each edge + their mean distance (the target).
  const tangents: Vector3[] = new Array(edges.length);
  let meanT = 0;
  for (let i = 0; i < edges.length; i++) {
    const pa = mesh.vertices[edges[i][0]];
    const pb = mesh.vertices[edges[i][1]];
    const d = pb.clone().sub(pa);
    let t = -pa.dot(d) / Math.max(d.dot(d), 1e-12);
    t = Math.max(0, Math.min(1, t));
    const T = pa.clone().add(d.multiplyScalar(t));
    tangents[i] = T;
    meanT += T.length();
  }
  meanT /= edges.length || 1;

  // Pass 2: nudge each edge's endpoints so its tangent distance approaches meanT.
  const disp = Array.from({ length: n }, () => new Vector3());
  const count = new Array<number>(n).fill(0);
  for (let i = 0; i < edges.length; i++) {
    const T = tangents[i];
    const r = T.length();
    if (r < 1e-9) continue;
    const move = T.clone().multiplyScalar(((meanT - r) / r) * stepFactor);
    const [a, b] = edges[i];
    disp[a].add(move);
    count[a]++;
    disp[b].add(move);
    count[b]++;
  }
  return applyDisp(mesh, disp, count, radius);
}

/**
 * SPHERIZE — pull every vertex toward the mean radius so they sit roughly evenly on
 * a sphere around the origin, inflating a near-flat shape back to a convex blob.
 * No longer wired into the solver's strategy set, but kept as a reusable rescue step.
 */
export function spherizeStep(mesh: Mesh, stepFactor: number, radius: number): number {
  let meanR = 0;
  for (const p of mesh.vertices) meanR += p.length();
  meanR /= mesh.vertices.length;

  let maxMove = 0;
  for (const p of mesh.vertices) {
    const r = p.length();
    if (r < 1e-9) continue;
    const move = p.clone().multiplyScalar((meanR / r - 1) * stepFactor);
    maxMove = Math.max(maxMove, move.length());
    p.add(move);
  }
  return radius > 0 ? maxMove / radius : maxMove;
}

/** Minimum angle (radians) between the normals of any two adjacent faces.
 *  Near 0 means two faces have drifted (almost) coplanar. */
export function minAdjacentFaceAngle(
  mesh: Mesh,
  edgeFaces: Array<[number, number]>,
): number {
  const normals = mesh.faces.map((f) => newellNormal(f.map((i) => mesh.vertices[i])));
  let minAng = Math.PI;
  for (const [a, b] of edgeFaces) {
    const d = Math.max(-1, Math.min(1, normals[a].dot(normals[b])));
    minAng = Math.min(minAng, Math.acos(d));
  }
  return minAng;
}

/**
 * Recenter the shape at the origin and EASE its scale so the average vertex
 * distance from the origin approaches `target` (by fraction `rate` each call).
 * This keeps the apparent size stable across edits — truncating no longer keeps
 * shrinking the solid, and kissing no longer keeps growing it. Returns the
 * average distance after this step (for the convergence check).
 */
export function normalizeStep(mesh: Mesh, target: number, rate: number): number {
  const c = new Vector3();
  for (const p of mesh.vertices) c.add(p);
  c.multiplyScalar(1 / mesh.vertices.length);
  for (const p of mesh.vertices) p.sub(c);

  let avg = 0;
  for (const p of mesh.vertices) avg += p.length();
  avg /= mesh.vertices.length;
  if (avg < 1e-9) return avg;

  const factor = 1 + (target / avg - 1) * rate;
  for (const p of mesh.vertices) p.multiplyScalar(factor);
  return avg * factor;
}

function applyDisp(
  mesh: Mesh,
  disp: Vector3[],
  count: number[],
  radius: number,
): number {
  let maxMove = 0;
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (count[i] === 0) continue;
    const d = disp[i].multiplyScalar(1 / count[i]);
    maxMove = Math.max(maxMove, d.length());
    mesh.vertices[i].add(d);
  }
  return radius > 0 ? maxMove / radius : maxMove;
}
