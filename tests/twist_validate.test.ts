import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { buildDCEL, counts } from "../src/geometry/HalfEdge";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildSnub } from "../src/operations/snub";
import { buildGyro } from "../src/operations/gyro";
import { computeSignature } from "../src/identify/configurations";

const seed = (n: string) => new Polyhedron(getSeed(n));
const sig = (mesh: { vertices: any; faces: number[][] }) => computeSignature(buildDCEL(mesh));

describe("staged truncate/kis", () => {
  it("cube: t=0.5 = truncated cube, t=1 = cuboctahedron", () => {
    const t = buildTruncate(seed("cube"), 0, null);
    expect(sig(t.commit(0.5, false).mesh)).toMatchObject({ V: 24, E: 36, F: 14 });
    expect(sig(t.commit(1, true).mesh)).toMatchObject({ V: 12, E: 24, F: 14 });
  });
  it("cube: kis t=1 = rhombic dodecahedron", () => {
    expect(sig(buildKis(seed("cube"), 0, null).commit(1, true).mesh)).toMatchObject({ V: 14, E: 24, F: 12 });
  });
});

describe("snub twist (extends a rectification)", () => {
  const rectify = (s: string) => new Polyhedron(buildTruncate(seed(s), 0, null).commit(1, true).mesh);
  it("rectify(tetra)=octahedron -> snub -> icosahedron", () => {
    const R = rectify("tetrahedron");
    const s = sig(buildSnub(R, 0, R.vertices[0].clone()).commit(1, false).mesh);
    expect(s).toMatchObject({ V: 12, E: 30, F: 20 });
    expect(s.vertexConfigs).toEqual({ "3.3.3.3.3": 12 });
    expect(s.faceConfigs).toEqual({ "5.5.5": 20 });
  });
  it("rectify(cube)=cuboctahedron -> snub -> snub cube", () => {
    const R = rectify("cube");
    const c = counts(buildDCEL(buildSnub(R, 0, R.vertices[0].clone()).commit(1, false).mesh));
    expect(c).toEqual({ V: 24, E: 60, F: 38 });
  });
});

describe("gyro twist (extends a join)", () => {
  const join = (s: string) => new Polyhedron(buildKis(seed(s), 0, null).commit(1, true).mesh);
  it("join(tetra)=cube -> gyro -> dodecahedron", () => {
    const J = join("tetrahedron");
    const s = sig(buildGyro(J, 0, J.vertices[0].clone()).commit(1, true).mesh);
    expect(s).toMatchObject({ V: 20, E: 30, F: 12 });
    expect(s.vertexConfigs).toEqual({ "5.5.5": 20 });
    expect(s.faceConfigs).toEqual({ "3.3.3.3.3": 12 });
  });
  it("join(cube)=rhombic dodeca -> gyro -> pentagonal icositetrahedron", () => {
    const J = join("cube");
    const c = counts(buildDCEL(buildGyro(J, 0, J.vertices[0].clone()).commit(1, true).mesh));
    expect(c).toEqual({ V: 38, E: 60, F: 24 });
  });
});

// Max distance of a face's vertices from their best-fit (Newell normal + centroid)
// plane, in units of the face's mean edge length. 0 for a planar face.
function nonPlanarity(verts: Vector3[], face: number[]): number {
  const c = new Vector3();
  for (const i of face) c.add(verts[i]);
  c.multiplyScalar(1 / face.length);
  const nrm = new Vector3();
  for (let i = 0; i < face.length; i++) {
    const a = verts[face[i]], b = verts[face[(i + 1) % face.length]];
    nrm.x += (a.y - b.y) * (a.z + b.z);
    nrm.y += (a.z - b.z) * (a.x + b.x);
    nrm.z += (a.x - b.x) * (a.y + b.y);
  }
  if (nrm.lengthSq() < 1e-20) return 0;
  nrm.normalize();
  let maxd = 0, edge = 0;
  for (let i = 0; i < face.length; i++) {
    maxd = Math.max(maxd, Math.abs(verts[face[i]].clone().sub(c).dot(nrm)));
    edge += verts[face[i]].distanceTo(verts[face[(i + 1) % face.length]]);
  }
  edge /= face.length;
  return edge > 1e-9 ? maxd / edge : 0;
}

// The gyro splits each join quad into pentagons; only the t=1 end is exactly planar,
// but gyro.ts's `liftExponent` schedule advances the lift ahead of the slide so the
// intermediate faces stay near-planar rather than creasing along the old join edges.
describe("gyro faces stay ~planar through the drag", () => {
  const join = (s: string) => new Polyhedron(buildKis(seed(s), 0, null).commit(1, true).mesh);
  for (const s of ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"]) {
    it(`join(${s})`, () => {
      const J = join(s);
      const plan = buildGyro(J, 0, J.vertices[0].clone());
      const faces = plan.commit(1, true).mesh.faces;
      let worst = 0;
      for (let t = 0.05; t < 1; t += 0.05) {
        const P = plan.positions(t);
        for (const f of faces) if (f.length > 3) worst = Math.max(worst, nonPlanarity(P, f));
      }
      // Under 2% of edge length everywhere. A linear lift (∝ t) instead creases the
      // sharp cube join at ~4.4%.
      expect(worst).toBeLessThan(0.02);
    });
  }
});
