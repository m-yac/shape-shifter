import { describe, it, expect } from "vitest";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron, faceCentroidOf, newellNormal } from "../src/geometry/polyhedron";
import { buildDCEL } from "../src/geometry/HalfEdge";
import { buildChamfer } from "../src/operations/chamfer";
import { buildSubdivide } from "../src/operations/subdivide";
import { computeSignature, signaturesEqual, type Signature } from "../src/identify/configurations";
import { NAMED } from "../src/data/namedPolyhedra";

const cube = () => new Polyhedron(getSeed("cube"));
const octahedron = () => new Polyhedron(getSeed("octahedron"));

/** The signature of a named-database entry, by name. */
const namedSig = (name: string): Signature =>
  computeSignature(NAMED.find((n) => n.name === name)!.poly.dcel);

/** A representative undirected edge + one bordering face of a polyhedron. */
const anyEdge = (p: Polyhedron): { edge: [number, number]; face: number } => {
  const he = p.dcel.halfedges[0];
  return { edge: [he.origin.id, he.next.origin.id], face: he.face.id };
};

describe("chamfer", () => {
  it("intermediate chamfer of the cube matches the chamfered cube", () => {
    const { edge, face } = anyEdge(cube());
    const sig = computeSignature(
      buildDCEL(buildChamfer(cube(), edge, face).commit(0.5, false).mesh),
    );
    expect(sig).toMatchObject({ V: 32, E: 48, F: 18 });
    expect(sig.faceConfigs).toEqual({ "3.3.3.3.3.3": 12, "3.3.3.3": 6 });
    expect(signaturesEqual(sig, namedSig("Chamfered cube"))).toBe(true);
  });

  it("intermediate chamfer of the octahedron matches the chamfered octahedron", () => {
    const { edge, face } = anyEdge(octahedron());
    const sig = computeSignature(
      buildDCEL(buildChamfer(octahedron(), edge, face).commit(0.5, false).mesh),
    );
    expect(sig).toMatchObject({ V: 30, E: 48, F: 20 });
    expect(signaturesEqual(sig, namedSig("Chamfered octahedron"))).toBe(true);
  });

  it("welded chamfer of the cube is the rhombic dodecahedron (V=14 E=24 F=12)", () => {
    const { edge, face } = anyEdge(cube());
    const sig = computeSignature(
      buildDCEL(buildChamfer(cube(), edge, face).commit(1, true).mesh),
    );
    expect(sig).toMatchObject({ V: 14, E: 24, F: 12 });
    expect(sig.faceConfigs).toEqual({ "3.4.3.4": 12 });
  });
});

// A chamfer whose hexagons bow out of plane self-intersects visibly around small
// faces (the truncated dodecahedron's triangles used to blow their hexagons up by
// several edge lengths). Both invariants below break together when that regresses.
describe("chamfer stays planar on solids with mixed face sizes", () => {
  const cases = [
    "Cube", "Truncated dodecahedron", "Truncated cube",
    "Truncated tetrahedron", "Truncated icosahedron",
  ];

  for (const name of cases) {
    it(`${name}: hexagons stay planar and original vertices hold still`, () => {
      const poly = NAMED.find((n) => n.name === name)!.poly;
      const { edge, face } = anyEdge(poly);
      const plan = buildChamfer(poly, edge, face);
      const V = poly.dcel.vertices.length;

      // Scale-free tolerance: a fraction of the mean original edge length. 5% is the
      // worst residual `computeJoinHeights` leaves on these (the truncated
      // icosahedron); the bug this guards against bowed hexagons by >500%.
      let sum = 0, count = 0;
      for (const he of poly.dcel.halfedges) {
        if (!he.twin || he.id >= he.twin.id) continue;
        sum += he.origin.position.distanceTo(he.next.origin.position);
        count++;
      }
      const meanEdge = sum / count;

      for (const t of [0.25, 0.5, 0.75, 1]) {
        const pos = plan.positions(t);

        for (let i = 0; i < V; i++)
          expect(pos[i].distanceTo(poly.dcel.vertices[i].position)).toBeLessThan(1e-9);

        for (const f of plan.previewFaces) {
          if (f.length <= 3) continue;
          const pts = f.map((i) => pos[i]);
          const c = faceCentroidOf(pts, f.map((_, i) => i));
          const n = newellNormal(pts);
          for (const p of pts)
            expect(Math.abs(p.clone().sub(c).dot(n))).toBeLessThan(0.05 * meanEdge);
        }
      }
    });
  }
});

describe("subdivide", () => {
  it("intermediate subdivision of the cube matches the subdivided cube", () => {
    const { edge } = anyEdge(cube());
    const sig = computeSignature(
      buildDCEL(buildSubdivide(cube(), edge).commit(0.5, false).mesh),
    );
    expect(sig).toMatchObject({ V: 20, E: 48, F: 30 });
    expect(sig.faceConfigs).toEqual({ "6.6.6.6": 6, "3.6.6": 24 });
    expect(signaturesEqual(sig, namedSig("Subdivided cube"))).toBe(true);
  });

  it("intermediate subdivision of the octahedron matches the subdivided octahedron", () => {
    const { edge } = anyEdge(octahedron());
    const sig = computeSignature(
      buildDCEL(buildSubdivide(octahedron(), edge).commit(0.5, false).mesh),
    );
    expect(sig).toMatchObject({ V: 18, E: 48, F: 32 });
    expect(signaturesEqual(sig, namedSig("Subdivided octahedron"))).toBe(true);
  });

  it("welded subdivision rectifies (cube → cuboctahedron)", () => {
    const { edge } = anyEdge(cube());
    const sig = computeSignature(
      buildDCEL(buildSubdivide(cube(), edge).commit(1, true).mesh),
    );
    expect(sig).toMatchObject({ V: 12, E: 24, F: 14 });
    expect(signaturesEqual(sig, namedSig("Cuboctahedron"))).toBe(true);
  });
});
