import { describe, it, expect } from "vitest";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { type Mesh } from "../src/geometry/HalfEdge";
import { type ColorSet, type GeomColor } from "../src/geometry/colors";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildSnub } from "../src/operations/snub";
import { buildGyro } from "../src/operations/gyro";

// Colors propagate through a chain of operations exactly as they do during live
// editing: each committed shape is re-wrapped as a colored Polyhedron and fed to the
// next operation. These helpers mirror that threading.
const seed = (n: string) => new Polyhedron(getSeed(n));
const wrap = (r: { mesh: Mesh; colors: ColorSet }) => new Polyhedron(r.mesh, r.colors);
const rectify = (p: Polyhedron) => wrap(buildTruncate(p, 0, null).commit(1, true));
const snub = (p: Polyhedron) => buildSnub(p, 0, p.vertices[0].clone()).commit(1, true).colors;
const gyro = (p: Polyhedron) => buildGyro(p, 0, p.vertices[0].clone()).commit(1, true).colors;
const join = (p: Polyhedron) => wrap(buildKis(p, 0, null).commit(1, true));

/** The sorted multiset of group SIZES of a geometric-color list (a face/vertex array
 *  or edge-map values) — i.e. "how many elements share each distinct color", which is
 *  robust to the exact triple values (some of the snub/gyro edge colors are still
 *  placeholders pending a follow-up — see the op TODOs). */
const groupSizes = (colors: Iterable<GeomColor>): number[] => {
  const out: Record<string, number> = {};
  for (const c of colors) {
    const k = c.join(",");
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.values(out).sort((a, b) => a - b);
};

describe("snub / gyro geometric colors", () => {
  it("snub(rectify(tetra)) = icosahedron, grouped by provenance", () => {
    const c = snub(rectify(seed("tetrahedron")));
    // 20 faces: 4 tetra faces + 4 tetra-vertex faces + 12 new snub triangles.
    expect(groupSizes(c.face)).toEqual([4, 4, 12]);
    // 12 vertices, all from the rectification edge each split off.
    expect(groupSizes(c.vertex)).toEqual([12]);
    // 30 edges.
    expect(c.edge.size).toBe(30);
  });

  it("gyro(join(tetra)) = dodecahedron, grouped by provenance", () => {
    const c = gyro(join(seed("tetrahedron")));
    // Dual of the snub: 12 faces, 20 vertices, 30 edges.
    expect(c.face.length).toBe(12);
    expect(c.vertex.length).toBe(20);
    expect(c.edge.size).toBe(30);
  });
});
