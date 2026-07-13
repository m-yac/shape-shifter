import { Vector3 } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { faceCentroidOf, newellNormal } from "../geometry/polyhedron";

/**
 * One planarization iteration: pull each face's vertices toward that face's best-fit
 * plane (centroid + Newell normal). A vertex shared by several faces receives the
 * average of their corrections. Returns the largest out-of-plane distance found this
 * pass, relative to `radius`, so the tolerance is scale-free.
 */
export function planarizeStep(
  mesh: Mesh,
  stepFactor: number,
  radius: number,
): number {
  const n = mesh.vertices.length;
  const disp = Array.from({ length: n }, () => new Vector3());
  const count = new Array<number>(n).fill(0);
  let maxDist = 0;

  for (const face of mesh.faces) {
    if (face.length <= 3) continue; // triangles are always planar
    const pts = face.map((i) => mesh.vertices[i]);
    const c = faceCentroidOf(mesh.vertices, face);
    const normal = newellNormal(pts);
    for (let k = 0; k < face.length; k++) {
      const vi = face[k];
      const signed = mesh.vertices[vi].clone().sub(c).dot(normal);
      maxDist = Math.max(maxDist, Math.abs(signed));
      disp[vi].add(normal.clone().multiplyScalar(-signed * stepFactor));
      count[vi]++;
    }
  }

  for (let i = 0; i < n; i++) {
    if (count[i] > 0) mesh.vertices[i].add(disp[i].multiplyScalar(1 / count[i]));
  }
  return radius > 0 ? maxDist / radius : maxDist;
}
