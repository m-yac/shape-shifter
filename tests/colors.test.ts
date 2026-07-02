import { describe, it, expect } from "vitest";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { type Mesh } from "../src/geometry/HalfEdge";
import { type ColorSet } from "../src/geometry/colors";
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
const join = (p: Polyhedron) => wrap(buildKis(p, 0, null).commit(1, true));
const snub = (p: Polyhedron) => buildSnub(p, 0, p.vertices[0].clone()).commit(1, true).colors;
const gyro = (p: Polyhedron) => buildGyro(p, 0, p.vertices[0].clone()).commit(1, true).colors;

/** Histogram of a geometric-color list (a face/vertex array, or edge-map values). */
const tally = (nums: Iterable<number>): Record<number, number> => {
  const out: Record<number, number> = {};
  for (const n of nums) out[n] = (out[n] ?? 0) + 1;
  return out;
};

// The seed's geometric colors are face 0, vertex 1, edge 2 (see `seedColors`); every
// operation layers c+1/c+2/c+3 colors on top. The active color SCHEME then decides how
// those indices display, so the exact indices are the "provenance" a scheme reads —
// e.g. under the tetrahedral scheme they reveal where each element came from.
describe("snub / gyro geometric colors", () => {
  // The Conway snub and gyro are duals, built here as the twist extensions of a
  // rectification / join. Their element colors must be the face<->vertex dual of each
  // other; the snub rules are literally the dual of the gyro's (a split vertex takes
  // the rectification EDGE it slid off, like a gyro face takes its join edge, etc.).
  it("snub(rectify(tetra)) = icosahedron, colored by provenance", () => {
    const c = snub(rectify(seed("tetrahedron")));
    // 4 original tetra faces (0) + 4 tetra-vertex faces (1) + 12 new snub triangles (5).
    expect(tally(c.face)).toEqual({ 0: 4, 1: 4, 5: 12 });
    // Every vertex ← the rectification edge it split off (the octahedron's edge, c 3).
    expect(tally(c.vertex)).toEqual({ 3: 12 });
    // 6 split edges ← the split vertex's color (2); 24 other new edges ← c+1 (4).
    expect(tally(c.edge.values())).toEqual({ 2: 6, 4: 24 });
  });

  it("snub(rectify(cube)) = snub cube, colored by provenance", () => {
    const c = snub(rectify(seed("cube")));
    // 6 cube faces (0) + 8 cube-vertex faces (1) + 24 new snub triangles (5).
    expect(tally(c.face)).toEqual({ 0: 6, 1: 8, 5: 24 });
    expect(tally(c.vertex)).toEqual({ 3: 24 });
    expect(tally(c.edge.values())).toEqual({ 2: 12, 4: 48 });
  });

  it("gyro(join(tetra)) = dodecahedron is the face<->vertex dual of the snub", () => {
    const s = snub(rectify(seed("tetrahedron")));
    const g = gyro(join(seed("tetrahedron")));
    // Duality swaps faces and vertices and keeps edges.
    expect(tally(g.face)).toEqual(tally(s.vertex));
    expect(tally(g.vertex)).toEqual(tally(s.face));
    expect(tally(g.edge.values())).toEqual(tally(s.edge.values()));
  });
});
