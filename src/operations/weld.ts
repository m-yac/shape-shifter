import { Vector3 } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { type ColorSet, type GeomColor, edgeKey } from "../geometry/colors";

/**
 * Merge the given vertex-index pairs into single vertices (union-find), then rebuild faces
 * dropping the collapsed, now-degenerate edges. This is how the max end of the Truncate
 * drag becomes a true Rectify: each original edge carried two cut vertices that coincide at
 * the midpoint, and welding them deletes the old edge.
 *
 * Colors are threaded through: a welded vertex takes a representative member's color (the
 * welding pairs share a color by construction), surviving faces keep their color, and edges
 * are re-keyed to the new vertex indices, with collapsed edges dropped.
 */
export function weldVertexPairs(
  mesh: Mesh,
  pairs: Array<[number, number]>,
  colors: ColorSet,
): { mesh: Mesh; colors: ColorSet } {
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

  // Compact roots into new contiguous indices, averaging merged positions and
  // taking the first member's color (welded pairs share a color by construction).
  const accum = new Map<number, { sum: Vector3; count: number; index: number; color: GeomColor }>();
  let next = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let rec = accum.get(r);
    if (!rec) {
      rec = { sum: new Vector3(), count: 0, index: next++, color: colors.vertex[i] };
      accum.set(r, rec);
    }
    rec.sum.add(mesh.vertices[i]);
    rec.count++;
  }
  const vertices: Vector3[] = new Array(next);
  const vertexColor: GeomColor[] = new Array(next);
  for (const rec of accum.values()) {
    vertices[rec.index] = rec.sum.multiplyScalar(1 / rec.count);
    vertexColor[rec.index] = rec.color;
  }
  const remap = (old: number): number => accum.get(find(old))!.index;

  const faces: number[][] = [];
  const faceColor: GeomColor[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const mapped = mesh.faces[fi].map(remap);
    // drop consecutive duplicates (including the wrap-around)
    const loop: number[] = [];
    for (let i = 0; i < mapped.length; i++) {
      if (mapped[i] !== mapped[(i + 1) % mapped.length]) loop.push(mapped[i]);
    }
    if (loop.length >= 3) {
      faces.push(loop);
      faceColor.push(colors.face[fi]);
    }
  }

  // Re-key edge colors to the new vertex indices; collapsed edges vanish.
  const edge = new Map<string, GeomColor>();
  for (const [key, c] of colors.edge) {
    const [a, b] = key.split("_").map(Number);
    const ra = remap(a);
    const rb = remap(b);
    if (ra !== rb) edge.set(edgeKey(ra, rb), c);
  }

  return {
    mesh: { vertices, faces },
    colors: { vertex: vertexColor, face: faceColor, edge },
  };
}
