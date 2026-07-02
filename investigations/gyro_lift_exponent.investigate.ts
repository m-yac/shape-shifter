import { describe, it } from "vitest";
import { Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { buildKis } from "../src/operations/kis";
import { buildTruncate } from "../src/operations/truncate";
import { buildGyro } from "../src/operations/gyro";
import { type Mesh } from "../src/geometry/HalfEdge";
import { RelaxSolver } from "../src/solver/solver";
import { extractTopology } from "../src/solver/topology";
import { faceNormalHE, faceCentroidHE } from "../src/geometry/polyhedron";

const seed = (n: string) => new Polyhedron(getSeed(n));

function relax(poly: Polyhedron): Mesh {
  const topo = extractTopology(poly);
  const solver = new RelaxSolver(poly.mesh.vertices, topo);
  let guard = 0;
  while (solver.advance() && guard++ < 5000) { /* iterate */ }
  return solver.mesh;
}
const canon = (p: Polyhedron) => new Polyhedron(relax(p));
const kisFull = (p: Polyhedron) => canon(new Polyhedron(buildKis(p, 0, null).commit(1, true).mesh));
const rectify = (p: Polyhedron) => canon(new Polyhedron(buildTruncate(p, 0, null).commit(1, true).mesh));

const cases: Record<string, () => Polyhedron> = {
  "join(tetra)=cube": () => kisFull(seed("tetrahedron")),
  "join(cube)=rhombicDodeca": () => kisFull(seed("cube")),
  "join(octa)": () => kisFull(seed("octahedron")),
  "join(dodeca)=rhombicTriaconta": () => kisFull(seed("dodecahedron")),
  "join(icosa)": () => kisFull(seed("icosahedron")),
  "join(cuboctahedron)": () => kisFull(rectify(seed("cube"))),
};

/** Newell normal + centroid best-fit plane; return max |dist| of face verts, in units
 *  of the face's mean edge length (scale-free). */
function planarity(verts: Vector3[], face: number[]): number {
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

describe("gyro planarity sweep", () => {
  for (const [name, build] of Object.entries(cases)) {
    it(name, () => {
      const J = build();
      const plan = buildGyro(J, 0, J.vertices[0].clone()) as any;
      const faces: number[][] = plan.commit(1, true).mesh.faces;
      const qs = plan._qData() as Array<{ index: number; start: Vector3; slideFull: Vector3; liftFull: Vector3 }>;
      const V = J.vertices.length;

      // Positions for arbitrary (slide fraction t, lift fraction lam).
      const positionsAt = (t: number, lam: number): Vector3[] => {
        const out: Vector3[] = [];
        for (let i = 0; i < V; i++) out[i] = J.vertices[i].clone();
        for (const q of qs) {
          out[q.index] = q.start.clone()
            .addScaledVector(q.slideFull, t)
            .addScaledVector(q.liftFull, lam);
        }
        return out;
      };
      const maxPlan = (t: number, lam: number): number => {
        const P = positionsAt(t, lam);
        let m = 0;
        for (const f of faces) if (f.length > 3) m = Math.max(m, planarity(P, f));
        return m;
      };

      // Mean interior dihedral of the join.
      const norms = J.dcel.faces.map((f) => { const n = faceNormalHE(f); if (n.dot(faceCentroidHE(f)) < 0) n.negate(); return n; });
      const fidx = new Map(J.dcel.faces.map((f, i) => [f.id, i]));
      let dsum = 0, dcnt = 0;
      for (const he of J.dcel.halfedges) {
        if (!he.twin || he.id >= he.twin.id) continue;
        const n1 = norms[fidx.get(he.face.id)!], n2 = norms[fidx.get(he.twin.face.id)!];
        dsum += Math.PI - Math.acos(Math.max(-1, Math.min(1, n1.dot(n2)))); dcnt++;
      }
      const dihedral = dsum / dcnt;

      // Worst-over-t error for lam = t^p, and the best exponent p.
      const errForExp = (p: number): number => {
        let m = 0;
        for (let t = 0.05; t < 1; t += 0.05) m = Math.max(m, maxPlan(t, Math.pow(t, p)));
        return m;
      };
      let bestP = 1, bestPErr = Infinity;
      for (let p = 0.3; p <= 1.2; p += 0.01) {
        const e = errForExp(p);
        if (e < bestPErr) { bestPErr = e; bestP = p; }
      }
      // Actual error using the real (per-q) schedule now baked into plan.positions.
      let realErr = 0;
      for (let t = 0.05; t < 1; t += 0.05) {
        const P = plan.positions(t);
        for (const f of faces) if (f.length > 3) realErr = Math.max(realErr, planarity(P, f));
      }
      const pFit = 0.79 * dihedral - 0.85;
      console.log(`\n### ${name}: dihedral=${((dihedral * 180) / Math.PI).toFixed(1)}deg  bestExp p=${bestP.toFixed(3)} (err ${bestPErr.toFixed(4)})  |  pFit=${pFit.toFixed(3)} (err ${errForExp(pFit).toFixed(4)})  |  linear p=1 (err ${errForExp(1).toFixed(4)})  |  REAL positions() err=${realErr.toFixed(4)}`);

      // For each slide fraction t, find the lift fraction lam in [0,1.5] minimizing the
      // worst face non-planarity.
      console.log(`=== ${name} ===`);
      console.log("   t   |  bestLam  bestErr  |  linErr(lam=t)  |  sqrtErr(lam=sqrt t)");
      const ts = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
      for (const t of ts) {
        let bestLam = 0, bestErr = Infinity;
        for (let lam = 0; lam <= 1.5001; lam += 0.005) {
          const e = maxPlan(t, lam);
          if (e < bestErr) { bestErr = e; bestLam = lam; }
        }
        const linErr = maxPlan(t, t);
        const sqrtErr = maxPlan(t, Math.sqrt(t));
        console.log(
          `  ${t.toFixed(2)} |  ${bestLam.toFixed(3)}   ${bestErr.toFixed(4)}  |  ${linErr.toFixed(4)}        |  ${sqrtErr.toFixed(4)}`,
        );
      }
    });
  }
});
