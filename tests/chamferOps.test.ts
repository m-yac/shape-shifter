import { describe, it, expect } from "vitest";
import { Ray, Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron, faceCentroidOf, newellNormal } from "../src/geometry/polyhedron";
import { buildDCEL, faceVertices } from "../src/geometry/HalfEdge";
import { buildChamfer } from "../src/operations/chamfer";
import { buildSubdivide } from "../src/operations/subdivide";
import { computeSignature, signaturesEqual, type Signature } from "../src/identify/configurations";
import { NAMED } from "../src/data/namedPolyhedra";
import { edgeKey } from "../src/geometry/colors";

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

/** Worst reflex corner of a polygon, in degrees (0 = convex). */
function concavity(pts: Vector3[]): number {
  const n = newellNormal(pts);
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    const turn = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(b));
    const sin = turn.dot(n) / (b.distanceTo(a) * c.distanceTo(b) || 1);
    if (sin < 0) worst = Math.max(worst, (Math.asin(Math.min(1, -sin)) * 180) / Math.PI);
  }
  return worst;
}

// The dual of the chamfer bug: raising edge MIDPOINTS along the edge normal left the
// triakis icosahedron's degree-10 vertex figures 35° concave and 11% non-planar.
// Placing the new vertex at truncate's collapse point instead fixes both — and the
// drag must still push those vertices outward, which the rescale preserves.
describe("subdivide stays planar and convex", () => {
  const cases = [
    "Cube", "Triakis icosahedron", "Triakis octahedron",
    "Subdivided dodecahedron", "Truncated dodecahedron",
  ];

  for (const name of cases) {
    it(`${name}: no concave faces, and edge vertices sweep outward`, () => {
      const poly = NAMED.find((n) => n.name === name)!.poly;
      const { edge } = anyEdge(poly);
      const plan = buildSubdivide(poly, edge);
      const E = plan.positions(0).length - poly.dcel.vertices.length;

      // Faces stay convex all the way through the drag, and at the Rectify weld.
      const meshes = [0.25, 0.5, 0.75, 1]
        .map((t) => ({ verts: plan.positions(t), faces: plan.previewFaces }))
        .concat([{ verts: plan.commit(1, true).mesh.vertices, faces: plan.commit(1, true).mesh.faces }]);
      for (const { verts, faces } of meshes) {
        for (const f of faces) {
          if (f.length <= 3) continue;
          expect(concavity(f.map((i) => verts[i]))).toBeLessThan(1e-6);
        }
      }

      // A central polygon's vertices lie ON the original face's edges, so it is as
      // planar as that face was — no worse. (A couple of database solids have very
      // slightly non-planar faces, which is why this is relative, not absolute.
      // Vertex figures separately inherit the collapse solve's small residual.)
      const outOfPlane = (pts: Vector3[]) => {
        const c = faceCentroidOf(pts, pts.map((_, i) => i));
        const n = newellNormal(pts);
        return Math.max(...pts.map((p) => Math.abs(p.clone().sub(c).dot(n))));
      };
      let inputWorst = 0;
      for (const f of poly.dcel.faces) {
        const pts = faceVertices(f).map((v) => v.position);
        if (pts.length > 3) inputWorst = Math.max(inputWorst, outOfPlane(pts));
      }
      for (const t of [0.5, 1]) {
        const pos = plan.positions(t);
        const scale = pos[0].length() / plan.positions(0)[0].length(); // the drag's rescale
        for (const f of plan.previewFaces) {
          if (f.length <= 3) continue;
          expect(outOfPlane(f.map((i) => pos[i]))).toBeLessThan(scale * inputWorst + 1e-9);
        }
      }

      // The gesture's invariant: every edge vertex moves strictly outward with t.
      let prev = plan.positions(0);
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const pos = plan.positions(t);
        for (let i = 0; i < E; i++) expect(pos[i].length()).toBeGreaterThan(prev[i].length());
        prev = pos;
      }
    });
  }
});

// dragController welds only on `t >= 1` exactly, so snap MUST be able to return it.
// (An earlier draft inverted the drag's rescale numerically and always landed a hair
// short, which silently disabled the Rectify weld on every solid.)
describe("subdivide's drag can always reach the weld", () => {
  it("dragging past the far end yields exactly t=1, on every named solid", () => {
    const short: string[] = [];
    for (const entry of NAMED) {
      const { edge } = anyEdge(entry.poly);
      const plan = buildSubdivide(entry.poly, edge);

      // Aim the cursor well past where the drag ends, viewed from the side.
      const axis = plan.positions(0)[0].clone().normalize();
      const perp = new Vector3(1, 0, 0).cross(axis);
      if (perp.lengthSq() < 1e-6) perp.set(0, 1, 0).cross(axis);
      const far = plan.positions(1)[0].clone().addScaledVector(axis, 10);
      const eye = far.clone().addScaledVector(perp.normalize(), 5);

      const { t } = plan.snap(new Ray(eye, far.clone().sub(eye).normalize()));
      if (t !== 1) short.push(`${entry.name} stopped at t=${t}`);
    }
    expect(short).toEqual([]);
  });

  it("hides exactly the edges the Rectify weld removes", () => {
    const edgesOf = (faces: number[][]) => {
      const s = new Set<string>();
      for (const f of faces)
        for (let i = 0; i < f.length; i++) s.add(edgeKey(f[i], f[(i + 1) % f.length]));
      return s;
    };
    const bad: string[] = [];
    for (const entry of NAMED) {
      const plan = buildSubdivide(entry.poly, anyEdge(entry.poly).edge);
      const preview = edgesOf(plan.previewFaces);
      const welded = edgesOf(plan.commit(1, true).mesh.faces);
      const hidden = new Set(plan.vanishingEdges.map(([a, b]) => edgeKey(a, b)));
      const removed = [...preview].filter((k) => !welded.has(k));
      // Every dissolving fan spoke is hidden, and nothing that survives is.
      if (removed.some((k) => !hidden.has(k))) bad.push(`${entry.name}: a dissolving edge stayed visible`);
      if ([...hidden].some((k) => welded.has(k))) bad.push(`${entry.name}: hid a surviving edge`);
    }
    expect(bad).toEqual([]);
  });

  it("snap tracks the dragged vertex mid-drag", () => {
    const poly = NAMED.find((n) => n.name === "Triakis icosahedron")!.poly;
    const plan = buildSubdivide(poly, anyEdge(poly).edge);
    const perp = new Vector3(1, 0, 0).cross(plan.positions(0)[0]).normalize();
    for (const t0 of [0.25, 0.5, 0.75]) {
      const target = plan.positions(t0)[0];
      const eye = target.clone().addScaledVector(perp, 5);
      const { t } = plan.snap(new Ray(eye, target.clone().sub(eye).normalize()));
      expect(t).toBeCloseTo(t0, 10);
    }
  });
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
