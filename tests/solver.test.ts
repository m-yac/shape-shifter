import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { buildKis } from "../src/operations/kis";
import { buildGyro } from "../src/operations/gyro";
import { buildSnub } from "../src/operations/snub";
import { type Mesh } from "../src/geometry/HalfEdge";
import { RelaxSolver } from "../src/solver/solver";
import { extractTopology } from "../src/solver/topology";
import { minAdjacentFaceAngle } from "../src/solver/regularize";
import { faceCentroidOf, newellNormal } from "../src/geometry/polyhedron";

function runToCompletion(poly: Polyhedron): { planar: boolean; mesh: Mesh } {
  const topo = extractTopology(poly);
  const solver = new RelaxSolver(poly.mesh.vertices, topo);
  let guard = 0;
  while (solver.advance() && guard++ < 5000) {
    /* iterate */
  }
  return { planar: solver.planar, mesh: solver.mesh };
}

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

describe("relaxation solver", () => {
  it("keeps the cube valid, planar and regular", () => {
    const { planar, mesh } = runToCompletion(new Polyhedron(getSeed("cube")));
    expect(planar).toBe(true);
    expect(planarityError(mesh)).toBeLessThan(1e-3);
  });

  it("does NOT collapse the rhombic dodecahedron (join of cube) to coplanar", () => {
    const join = new Polyhedron(buildKis(new Polyhedron(getSeed("cube")), 0, null).commit(1, true).mesh);
    const topo = extractTopology(join);
    const { planar, mesh } = runToCompletion(join);
    expect(planar).toBe(true);
    // faces stay flat ...
    expect(planarityError(mesh)).toBeLessThan(5e-3);
    // ... and adjacent faces stay well away from coplanar (true dihedral ~120°,
    // i.e. normal angle ~60°). No flattening.
    const minAngleDeg = (minAdjacentFaceAngle(mesh, topo.edgeFaces) * 180) / Math.PI;
    expect(minAngleDeg).toBeGreaterThan(30);
  });

  it("relaxes the welded gyro of the cube to a valid, planar solid (dodecahedron)", () => {
    // The gyro starting geometry is rough (no closed-form coplanar distance); this is
    // the real check that the relaxer can finish it into a valid, planar solid.
    const cube = new Polyhedron(getSeed("cube"));
    const gyro = new Polyhedron(buildGyro(cube, 0, cube.vertices[0].clone()).commit(1, true).mesh);
    const { planar, mesh } = runToCompletion(gyro);
    expect(planar).toBe(true);
    expect(planarityError(mesh)).toBeLessThan(5e-3);
  });

  it("relaxes the welded snub of the octahedron to a valid, planar solid (icosahedron)", () => {
    const octa = new Polyhedron(getSeed("octahedron"));
    const snub = new Polyhedron(buildSnub(octa, 0, octa.vertices[0].clone()).commit(1, true).mesh);
    const { planar, mesh } = runToCompletion(snub);
    expect(planar).toBe(true);
    expect(planarityError(mesh)).toBeLessThan(5e-3);
  });

  it("does NOT collapse the tetrakis hexahedron (kis of cube)", () => {
    const kis = new Polyhedron(buildKis(new Polyhedron(getSeed("cube")), 0, null).commit(0.5, false).mesh);
    const topo = extractTopology(kis);
    const { planar, mesh } = runToCompletion(kis);
    expect(planar).toBe(true);
    // true tetrakis hexahedron dihedral ~143°, i.e. normal angle ~37°
    const minAngleDeg = (minAdjacentFaceAngle(mesh, topo.edgeFaces) * 180) / Math.PI;
    expect(minAngleDeg).toBeGreaterThan(20);
    // a non-degenerate solid keeps a sensible bounding radius
    const maxR = Math.max(...mesh.vertices.map((p: Vector3) => p.length()));
    expect(maxR).toBeGreaterThan(0.9);
  });
});
