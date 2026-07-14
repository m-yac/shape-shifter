import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron, faceCentroidOf, newellNormal } from "../src/geometry/polyhedron";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildSubdivide } from "../src/operations/subdivide";
import { buildWhirl } from "../src/operations/gyro";
import { buildVolute } from "../src/operations/snub";
import { type Mesh } from "../src/geometry/HalfEdge";
import { RelaxSolver } from "../src/solver/solver";
import { extractTopology } from "../src/solver/topology";

/** Largest out-of-plane distance of any face, relative to size. */
function planarityError(mesh: Mesh): number {
  let r = 0;
  for (const p of mesh.vertices) r = Math.max(r, p.length());
  let err = 0;
  for (const f of mesh.faces) {
    const c = faceCentroidOf(mesh.vertices, f);
    const n = newellNormal(f.map((i) => mesh.vertices[i]));
    for (const i of f) err = Math.max(err, Math.abs(mesh.vertices[i].clone().sub(c).dot(n)));
  }
  return r > 0 ? err / r : err;
}

/** What DragController.startSolve does: reset the live vertices from the polyhedron's
 *  pristine `raw` mesh, then relax from there. */
function regularizeFromRaw(poly: Polyhedron): { planar: boolean; mesh: Mesh } {
  const live = poly.mesh.vertices;
  for (let i = 0; i < live.length; i++) live[i].copy(poly.raw.vertices[i]);
  const topo = extractTopology(poly);
  const solver = new RelaxSolver(live, topo);
  let guard = 0;
  while (solver.advance() && guard++ < 5000) {
    /* iterate */
  }
  return { planar: solver.planar, mesh: solver.mesh };
}

describe("regularize-from-raw recovery", () => {
  it("keeps an untouched pristine raw copy through heavy perturbation", () => {
    const poly = new Polyhedron(buildTruncate(new Polyhedron(getSeed("cube")), 0, null).commit(0.5, false).mesh);
    const before = poly.raw.vertices.map((v) => v.clone());
    // Shove every live vertex far out of place.
    for (const v of poly.mesh.vertices) v.add(new Vector3(17, -23, 31));
    // The raw copy is independent, so it doesn't move with the live vertices.
    for (let i = 0; i < before.length; i++) {
      expect(poly.raw.vertices[i].distanceTo(before[i])).toBeLessThan(1e-9);
    }
  });

  it("recovers a well-formed truncated cube after wild drift", () => {
    const poly = new Polyhedron(buildTruncate(new Polyhedron(getSeed("cube")), 0, null).commit(0.5, false).mesh);
    // Mangle the live geometry beyond any hope of in-place relaxation.
    for (const v of poly.mesh.vertices) v.multiplyScalar(40).add(new Vector3(50, -80, 12));
    const { planar, mesh } = regularizeFromRaw(poly);
    expect(planar).toBe(true);
    expect(planarityError(mesh)).toBeLessThan(5e-3);
    const maxR = Math.max(...mesh.vertices.map((p) => p.length()));
    expect(maxR).toBeLessThan(5); // bounded, not blown up
    expect(maxR).toBeGreaterThan(0.5); // not collapsed
  });

  it("recovers a well-formed rhombic dodecahedron (join of cube) after wild drift", () => {
    const poly = new Polyhedron(buildKis(new Polyhedron(getSeed("cube")), 0, null).commit(1, true).mesh);
    for (const v of poly.mesh.vertices) v.multiplyScalar(-60).add(new Vector3(-90, 33, 70));
    const { planar, mesh } = regularizeFromRaw(poly);
    expect(planar).toBe(true);
    expect(planarityError(mesh)).toBeLessThan(5e-3);
    const maxR = Math.max(...mesh.vertices.map((p) => p.length()));
    expect(maxR).toBeLessThan(5);
    expect(maxR).toBeGreaterThan(0.5);
  });

  // The twists commit their raw drag geometry and are relaxed from it, so the seed each
  // one hands over has to be one the solver can planarize — the whirl's hexagons and the
  // volute's corner fans included.
  it("planarizes a whirled cube", () => {
    const cube = new Polyhedron(getSeed("cube"));
    const J = new Polyhedron(buildKis(cube, 0, null).commit(1, true).mesh);
    const V = cube.vertices.length;
    const poly = new Polyhedron(buildWhirl(J, V, J.vertices[V].clone()).commit(1, true).mesh);
    const { planar, mesh } = regularizeFromRaw(poly);
    expect(planar).toBe(true);
    expect(planarityError(mesh)).toBeLessThan(5e-3);
  });

  it("planarizes a voluted cube", () => {
    const cube = new Polyhedron(getSeed("cube"));
    const R = new Polyhedron(
      buildSubdivide(cube, [cube.faces[0][0], cube.faces[0][1]]).commit(1, true).mesh,
    );
    const poly = new Polyhedron(buildVolute(R, 0, cube.faces.length).commit(1, true).mesh);
    const { planar, mesh } = regularizeFromRaw(poly);
    expect(planar).toBe(true);
    expect(planarityError(mesh)).toBeLessThan(5e-3);
  });
});
