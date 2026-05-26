import { Vector3 } from "three";
import { type Mesh } from "../geometry/HalfEdge";

/**
 * Merge the given vertex-index pairs into single vertices (union-find), then
 * rebuild faces dropping the collapsed (now-degenerate) edges. This is how the
 * "max" end of the Truncate drag becomes a true Rectify: each original edge
 * carried two cut vertices that coincide at the midpoint, and welding them
 * deletes the old edge — exactly "new vertices combine along old edges".
 */
export function weldVertexPairs(mesh: Mesh, pairs: Array<[number, number]>): Mesh {
  const n = mesh.vertices.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const [a, b] of pairs) union(a, b);

  // Compact roots into new contiguous indices, averaging merged positions.
  const accum = new Map<number, { sum: Vector3; count: number; index: number }>();
  let next = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let rec = accum.get(r);
    if (!rec) {
      rec = { sum: new Vector3(), count: 0, index: next++ };
      accum.set(r, rec);
    }
    rec.sum.add(mesh.vertices[i]);
    rec.count++;
  }
  const vertices: Vector3[] = new Array(next);
  for (const rec of accum.values()) {
    vertices[rec.index] = rec.sum.multiplyScalar(1 / rec.count);
  }
  const remap = (old: number): number => accum.get(find(old))!.index;

  const faces: number[][] = [];
  for (const f of mesh.faces) {
    const mapped = f.map(remap);
    // drop consecutive duplicates (including the wrap-around)
    const loop: number[] = [];
    for (let i = 0; i < mapped.length; i++) {
      if (mapped[i] !== mapped[(i + 1) % mapped.length]) loop.push(mapped[i]);
    }
    if (loop.length >= 3) faces.push(loop);
  }
  return { vertices, faces };
}
