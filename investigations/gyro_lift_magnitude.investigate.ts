import { describe, it } from "vitest";
import { Vector3, Matrix3 } from "three";
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
// canonicalize a mesh so operations act on a well-shaped solid
const canon = (p: Polyhedron) => new Polyhedron(relax(p));
const kisFull = (p: Polyhedron) => canon(new Polyhedron(buildKis(p, 0, null).commit(1, true).mesh));
const rectify = (p: Polyhedron) => canon(new Polyhedron(buildTruncate(p, 0, null).commit(1, true).mesh));

// Each case yields the JOIN polyhedron that gyro is applied to (all-quad faces).
const cases: Record<string, () => Polyhedron> = {
  "join(tetra)=cube": () => kisFull(seed("tetrahedron")),
  "join(cube)=rhombicDodeca": () => kisFull(seed("cube")),
  "join(octa)": () => kisFull(seed("octahedron")),
  "join(dodeca)=rhombicTriaconta": () => kisFull(seed("dodecahedron")),
  "join(icosa)": () => kisFull(seed("icosahedron")),
  // joins of Archimedean rectifications
  "join(cuboctahedron)": () => kisFull(rectify(seed("cube"))),
  "join(icosidodecahedron)": () => kisFull(rectify(seed("dodecahedron"))),
  // joins of the rhombic joins (deeper)
  "join(rhombicDodeca)": () => kisFull(kisFull(seed("cube"))),
};

function relax(poly: Polyhedron): Mesh {
  const topo = extractTopology(poly);
  const solver = new RelaxSolver(poly.mesh.vertices, topo);
  let guard = 0;
  while (solver.advance() && guard++ < 5000) { /* iterate */ }
  return solver.mesh;
}

/** Umeyama: best rotation+uniform-scale+translation mapping src -> dst (paired). */
function umeyama(src: Vector3[], dst: Vector3[]): (p: Vector3) => Vector3 {
  const n = src.length;
  const muS = new Vector3(); const muD = new Vector3();
  for (let i = 0; i < n; i++) { muS.add(src[i]); muD.add(dst[i]); }
  muS.multiplyScalar(1 / n); muD.multiplyScalar(1 / n);
  // covariance
  const C = new Array(9).fill(0);
  let varS = 0;
  for (let i = 0; i < n; i++) {
    const s = src[i].clone().sub(muS); const d = dst[i].clone().sub(muD);
    varS += s.lengthSq();
    C[0] += d.x * s.x; C[1] += d.x * s.y; C[2] += d.x * s.z;
    C[3] += d.y * s.x; C[4] += d.y * s.y; C[5] += d.y * s.z;
    C[6] += d.z * s.x; C[7] += d.z * s.y; C[8] += d.z * s.z;
  }
  for (let k = 0; k < 9; k++) C[k] /= n;
  varS /= n;
  // SVD of 3x3 C via Jacobi eigendecomposition of C^T C (good enough here).
  const { U, S, V } = svd3(C);
  // R = U * diag(1,1,det(U V^T)) * V^T
  const detUV = det3(mul3(U, transpose3(V)));
  const D = [1, 0, 0, 0, 1, 0, 0, 0, detUV < 0 ? -1 : 1];
  const R = mul3(mul3(U, D), transpose3(V));
  const traceDS = S[0] + S[1] + (detUV < 0 ? -S[2] : S[2]);
  const scale = traceDS / varS;
  return (p: Vector3) => {
    const q = p.clone().sub(muS).applyMatrix3(toM3(R)).multiplyScalar(scale).add(muD);
    return q;
  };
}

// --- tiny 3x3 linear algebra (row-major arrays length 9) ---
function mul3(a: number[], b: number[]): number[] {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++)
    r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
function transpose3(a: number[]): number[] {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}
function det3(a: number[]): number {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
}
function toM3(a: number[]): Matrix3 {
  const m = new Matrix3();
  m.set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
  return m;
}
/** Jacobi eigen of symmetric 3x3 -> returns eigenvectors (cols) & eigenvalues. */
function jacobiSym(A: number[]): { vecs: number[]; vals: number[] } {
  let a = A.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iter = 0; iter < 100; iter++) {
    // largest off-diagonal
    let p = 0, q = 1, max = Math.abs(a[1]);
    if (Math.abs(a[2]) > max) { max = Math.abs(a[2]); p = 0; q = 2; }
    if (Math.abs(a[5]) > max) { max = Math.abs(a[5]); p = 1; q = 2; }
    if (max < 1e-14) break;
    const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi), s = Math.sin(phi);
    const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    R[p * 3 + p] = c; R[q * 3 + q] = c; R[p * 3 + q] = s; R[q * 3 + p] = -s;
    a = mul3(mul3(transpose3(R), a), R);
    const nv = mul3(v, R);
    for (let k = 0; k < 9; k++) v[k] = nv[k];
  }
  return { vecs: v, vals: [a[0], a[4], a[8]] };
}
/** SVD of general 3x3 C: C = U S V^T. */
function svd3(C: number[]): { U: number[]; S: number[]; V: number[] } {
  const CtC = mul3(transpose3(C), C);
  const { vecs: V, vals } = jacobiSym(CtC);
  // sort desc
  const idx = [0, 1, 2].sort((i, j) => vals[j] - vals[i]);
  const S = idx.map((i) => Math.sqrt(Math.max(0, vals[i])));
  const Vs = [0, 1, 2].map((row) => idx.map((i) => V[row * 3 + i])).flat();
  // U = C V S^-1
  const CV = mul3(C, Vs);
  const U = new Array(9).fill(0);
  for (let col = 0; col < 3; col++) {
    const s = S[col] > 1e-12 ? 1 / S[col] : 0;
    for (let row = 0; row < 3; row++) U[row * 3 + col] = CV[row * 3 + col] * s;
  }
  return { U, S, V: Vs };
}

describe("gyro lift investigation", () => {
  for (const [name, build] of Object.entries(cases)) {
    it(name, () => {
      const J = build();
      const Vj = J.vertices.length;
      // join edge length (edge-transitive joins: uniform)
      let eSum = 0, eCount = 0;
      for (const he of J.dcel.halfedges) {
        eSum += he.origin.position.distanceTo(he.next.origin.position); eCount++;
      }
      const e = eSum / eCount;

      // per join face: centroid + outward normal
      const faceInfo = J.dcel.faces.map((f) => {
        const c = faceCentroidHE(f);
        const nrm = faceNormalHE(f);
        if (nrm.dot(c) < 0) nrm.negate();
        return { c, nrm };
      });

      // Mean interior dihedral angle over all edges, from adjacent face normals.
      let dihedral = 0;
      {
        const norms = J.dcel.faces.map((f) => { const n = faceNormalHE(f); if (n.dot(faceCentroidHE(f)) < 0) n.negate(); return n; });
        const fidx = new Map(J.dcel.faces.map((f, i) => [f.id, i]));
        let sum = 0, cnt = 0;
        for (const he of J.dcel.halfedges) {
          if (!he.twin || he.id >= he.twin.id) continue;
          const n1 = norms[fidx.get(he.face.id)!], n2 = norms[fidx.get(he.twin.face.id)!];
          sum += Math.PI - Math.acos(Math.max(-1, Math.min(1, n1.dot(n2)))); cnt++;
        }
        dihedral = sum / cnt;
      }

      const plan = buildGyro(J, 0, J.vertices[0].clone());
      const preview = plan.commit(1, true).mesh;
      const Gpoly = new Polyhedron(relax(new Polyhedron(preview)));
      const G = Gpoly.mesh;

      // --- Join-frame lift, the frame the preview morph works in: fit the canonical
      // gyro back onto the join's original vertices, then read each q's lift above its
      // home join-face plane, normalized by |v0| = e/2 (joins are edge-transitive).
      const map = umeyama(G.vertices.slice(0, Vj), J.vertices.slice(0, Vj));
      const Gf = G.vertices.map(map);
      const jfLift: number[] = [];
      for (let i = Vj; i < Gf.length; i++) {
        const q = Gf[i];
        let best = 0, bd = Infinity;
        for (let fi = 0; fi < faceInfo.length; fi++) {
          const d = q.clone().sub(faceInfo[fi].c).length();
          if (d < bd) { bd = d; best = fi; }
        }
        jfLift.push(q.clone().sub(faceInfo[best].c).dot(faceInfo[best].nrm));
      }

      // --- Twist angle the gyro realizes. Each join vertex's star rotates about its
      // radial axis between the join and the canonical gyro. Measure that rotation, in
      // the vertex tangent plane, at every join vertex, to compare against the drag
      // arc's angular limit arcSpan = 2π/(divisor·n).
      const jadj = new Map<number, Set<number>>();
      for (const he of J.dcel.halfedges) {
        const a = he.origin.id, b = he.next.origin.id;
        (jadj.get(a) ?? jadj.set(a, new Set()).get(a)!).add(b);
      }
      const tangentTo = (v: Vector3, nrm: Vector3) => v.clone().addScaledVector(nrm, -v.dot(nrm));
      const signedAngle = (from: Vector3, to: Vector3, axis: Vector3) =>
        Math.atan2(axis.dot(new Vector3().crossVectors(from, to)), from.dot(to));
      const twistByDeg = new Map<number, number[]>(); // apex degree -> |frame twist| samples
      for (let vi = 0; vi < Vj; vi++) {
        const A = J.vertices[vi];
        const nrm = A.clone().normalize();
        const Ag = Gf[vi];
        const deg = jadj.get(vi)!.size;
        const samples: number[] = [];
        for (const j of jadj.get(vi)!) {
          const jd = tangentTo(J.vertices[j].clone().sub(A), nrm);
          const gd = tangentTo(Gf[j].clone().sub(Ag), nrm);
          if (jd.lengthSq() < 1e-9 || gd.lengthSq() < 1e-9) continue;
          samples.push(signedAngle(jd, gd, nrm));
        }
        const net = samples.reduce((a, b) => a + b, 0) / samples.length;
        (twistByDeg.get(deg) ?? twistByDeg.set(deg, []).get(deg)!).push(Math.abs(net));
      }

      // Angular sweep of the driven q vertices about the apex, in join space: from their
      // start (the edge midpoint, positions(0)) to their gyro target (positions(1), i.e.
      // the lift formula). The drag arc must span this for its limit to land the lift.
      const pos0 = plan.positions(0), pos1 = plan.positions(1);
      const gadj = new Map<number, Set<number>>();
      for (const he of Gpoly.dcel.halfedges) {
        const a = he.origin.id, b = he.next.origin.id;
        (gadj.get(a) ?? gadj.set(a, new Set()).get(a)!).add(b);
        (gadj.get(b) ?? gadj.set(b, new Set()).get(b)!).add(a);
      }
      const qSweepByApexDeg = new Map<number, number[]>();
      for (let vi = 0; vi < Vj; vi++) {
        const apex = pos0[vi];
        const nrm = apex.clone().normalize();
        const deg = jadj.get(vi)!.size;
        for (const qi of gadj.get(vi) ?? []) {
          if (qi < Vj) continue; // only q vertices
          const from = tangentTo(pos0[qi].clone().sub(apex), nrm);
          const to = tangentTo(pos1[qi].clone().sub(apex), nrm);
          if (from.lengthSq() < 1e-9 || to.lengthSq() < 1e-9) continue;
          (qSweepByApexDeg.get(deg) ?? qSweepByApexDeg.set(deg, []).get(deg)!)
            .push(Math.abs(signedAngle(from, to, nrm)));
        }
      }

      // Intrinsic measurement, entirely within the canonical gyro (avg radius ~1).
      // Mean edge length of the gyro.
      let gE = 0, gN = 0;
      for (const he of Gpoly.dcel.halfedges) { gE += he.origin.position.distanceTo(he.next.origin.position); gN++; }
      gE /= gN;

      // adjacency
      const nbr = new Map<number, Set<number>>();
      for (const he of Gpoly.dcel.halfedges) {
        const a = he.origin.id, b = he.next.origin.id;
        (nbr.get(a) ?? nbr.set(a, new Set()).get(a)!).add(b);
        (nbr.get(b) ?? nbr.set(b, new Set()).get(b)!).add(a);
      }

      const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
      // radius of originals vs q's
      const rOrig = mean(G.vertices.slice(0, Vj).map((p) => p.length()));
      const rQ = mean(G.vertices.slice(Vj).map((p) => p.length()));

      // For each q: the outward lift above the plane of its original neighbors, and the
      // base half-edge, the mean distance from q to those neighbors.
      const liftE: number[] = [];
      const liftBase: number[] = [];
      const seedNbrDist: number[] = [];
      for (let i = Vj; i < G.vertices.length; i++) {
        const q = G.vertices[i];
        const origNb = [...(nbr.get(i) ?? [])].filter((j) => j < Vj).map((j) => G.vertices[j]);
        if (origNb.length < 1) continue;
        const M = origNb.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / origNb.length);
        const outward = q.clone().normalize();
        const lift = q.clone().sub(M).dot(outward);
        liftE.push(lift / gE);
        // local half-edge scale: mean distance from q to each original neighbor
        const hb = mean(origNb.map((p) => p.distanceTo(q)));
        liftBase.push(lift / hb);
        seedNbrDist.push(hb);
      }
      const jf = mean(jfLift) / (e / 2); // FACE_LIFT analog in the join frame
      const deg = (dihedral * 180) / Math.PI;
      const deficit = (Math.PI - dihedral); // supplement of interior dihedral
      console.log(`\n=== ${name}  join V=${Vj}  dihedral=${deg.toFixed(1)}deg ===`);
      console.log(`  join-frame lift/|v0|       = ${jf.toFixed(4)}   <-- FACE_LIFT analog`);
      console.log(`  intrinsic lift/gE          = ${mean(liftE).toFixed(4)}`);
      console.log(`  tan(deficit/2)             = ${Math.tan(deficit / 2).toFixed(4)}`);
      console.log(`  (lift/|v0|)/tan(deficit/2) = ${(jf / Math.tan(deficit / 2)).toFixed(4)}`);
      console.log(`  (lift/|v0|)/cos(dih/2)     = ${(jf / Math.cos(dihedral / 2)).toFixed(4)}`);
      console.log(`  --- twist arc ---`);
      for (const [d, samples] of [...twistByDeg.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`  apex deg n=${d}: FRAME twist (orig verts) = ${((mean(samples) * 180) / Math.PI).toFixed(2)}deg`);
      }
      for (const [d, samples] of [...qSweepByApexDeg.entries()].sort((a, b) => a[0] - b[0])) {
        const sw = mean(samples);
        const swDeg = (sw * 180) / Math.PI;
        // arcSpan = 2π/(divisor·n); solve for the divisor that makes arcSpan == sweep.
        const divisor = (2 * Math.PI) / (d * sw);
        console.log(`  apex deg n=${d}: apex->q EDGE sweep = ${swDeg.toFixed(2)}deg  => divisor=${divisor.toFixed(3)}  (current div3 arcSpan=${(360 / (3 * d)).toFixed(2)}deg)`);
      }
      void rOrig; void rQ; void seedNbrDist; void liftBase;
    });
  }
});
