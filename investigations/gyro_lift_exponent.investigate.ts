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

// Two ways to reach the JOIN that gyro is applied to:
//  • kisRelaxed — weld to the full join, then canonicalize. Every face becomes a
//    congruent regular Catalan face with a uniform dihedral, so a single per-shape
//    lift exponent is optimal. This is what the app shows AFTER a release + relax.
//  • kisRaw — the full join straight out of `buildKis`, un-relaxed. This is the geometry
//    a LIVE drag actually carries into gyro, and the only path that exercises the
//    per-face `computeJoinHeights` in kis.ts. On a non-canonical base its faces are
//    (near-)planar quads but of VARYING shape and dihedral, so a single exponent is no
//    longer optimal — that is what the per-q analysis below is for.
const kisRelaxed = (p: Polyhedron) => canon(new Polyhedron(buildKis(p, 0, null).commit(1, true).mesh));
const kisRaw = (p: Polyhedron) => new Polyhedron(buildKis(p, 0, null).commit(1, true).mesh);
const rectify = (p: Polyhedron) => canon(new Polyhedron(buildTruncate(p, 0, null).commit(1, true).mesh));

// Relaxed joins: uniform faces, one dihedral each. The original fit was made here.
const relaxedCases: Record<string, () => Polyhedron> = {
  "join(tetra)=cube": () => kisRelaxed(seed("tetrahedron")),
  "join(cube)=rhombicDodeca": () => kisRelaxed(seed("cube")),
  "join(octa)": () => kisRelaxed(seed("octahedron")),
  "join(dodeca)=rhombicTriaconta": () => kisRelaxed(seed("dodecahedron")),
  "join(icosa)": () => kisRelaxed(seed("icosahedron")),
  "join(cuboctahedron)": () => kisRelaxed(rectify(seed("cube"))),
};

// Raw (un-relaxed) joins — the drag-time geometry. The platonic ones stay ~canonical
// (their raw join IS the Catalan) so they double as a check that the raw path matches
// the relaxed numbers; the mixed-face ones (cuboctahedron, icosidodecahedron, a Catalan
// re-joined) are genuinely non-canonical and are where a new heuristic must earn its keep.
const rawCases: Record<string, () => Polyhedron> = {
  "join(tetra)": () => kisRaw(seed("tetrahedron")),
  "join(cube)": () => kisRaw(seed("cube")),
  "join(dodeca)": () => kisRaw(seed("dodecahedron")),
  "join(cuboctahedron)": () => kisRaw(rectify(seed("cube"))),
  "join(icosidodecahedron)": () => kisRaw(rectify(seed("dodecahedron"))),
  "join(rhombicDodeca)": () => kisRaw(kisRelaxed(seed("cube"))),
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

/** The whole planarity study for one join `J`, shared by the relaxed and raw sweeps. */
function analyze(name: string, J: Polyhedron): void {
  const plan = buildGyro(J, 0, J.vertices[0].clone()) as any;
  const faces: number[][] = plan.commit(1, true).mesh.faces;
  const qs = plan._qData() as Array<{
    index: number; start: Vector3; slideFull: Vector3; liftFull: Vector3; liftExp: number; dihedral: number;
  }>;
  const V = J.vertices.length;

  // Positions for a GLOBAL (slide fraction t, lift fraction lam) applied to every q.
  const positionsAt = (t: number, lam: number): Vector3[] => {
    const out: Vector3[] = [];
    for (let i = 0; i < V; i++) out[i] = J.vertices[i].clone();
    for (const q of qs) {
      out[q.index] = q.start.clone().addScaledVector(q.slideFull, t).addScaledVector(q.liftFull, lam);
    }
    return out;
  };
  // Positions for a PER-Q lift fraction (used by the per-q schedule analysis).
  const positionsSched = (t: number, lamOf: (qIndex: number) => number): Vector3[] => {
    const out: Vector3[] = [];
    for (let i = 0; i < V; i++) out[i] = J.vertices[i].clone();
    for (const q of qs) {
      out[q.index] = q.start.clone().addScaledVector(q.slideFull, t).addScaledVector(q.liftFull, lamOf(q.index));
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
  let dsum = 0, dcnt = 0, dmin = Infinity, dmax = -Infinity;
  for (const he of J.dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    const n1 = norms[fidx.get(he.face.id)!], n2 = norms[fidx.get(he.twin.face.id)!];
    const d = Math.PI - Math.acos(Math.max(-1, Math.min(1, n1.dot(n2))));
    dsum += d; dcnt++; dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
  }
  const dihedral = dsum / dcnt;

  // Worst-over-t error for the GLOBAL lam = t^p, and the best single exponent p.
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
  const dg = (r: number) => ((r * 180) / Math.PI).toFixed(1);
  console.log(
    `\n### ${name}: dihedral=${dg(dihedral)}deg (spread ${dg(dmin)}..${dg(dmax)})  ` +
    `bestExp p=${bestP.toFixed(3)} (err ${bestPErr.toFixed(4)})  |  pFit=${pFit.toFixed(3)} (err ${errForExp(pFit).toFixed(4)})  |  ` +
    `linear p=1 (err ${errForExp(1).toFixed(4)})  |  REAL positions() err=${realErr.toFixed(4)}`,
  );

  // ── Per-q lift-schedule analysis ────────────────────────────────────────────
  // Each split gyro face (len>3) is owned by ONE original join face and carries that
  // face's two q's, so its planarity during the drag couples both q's lift schedules.
  // Optimise a per-q exponent by coordinate descent (seeded at the current heuristic),
  // then compare the optimum to `liftExponent(dihedral)` per q — this is what reveals
  // whether the raw, non-canonical regime needs a different fit from the relaxed one.
  const bigFaces = faces.filter((f) => f.length > 3);
  const facesOfQ = new Map<number, number[]>(); // q index -> indices into bigFaces
  for (let fi = 0; fi < bigFaces.length; fi++) {
    for (const v of bigFaces[fi]) if (v >= V) (facesOfQ.get(v) ?? facesOfQ.set(v, []).get(v)!).push(fi);
  }
  const tGrid: number[] = [];
  for (let t = 0.05; t < 1; t += 0.05) tGrid.push(t);

  const pMap = new Map<number, number>(qs.map((q) => [q.index, q.liftExp])); // seed = current heuristic
  const worstOf = (faceIdxs: number[]): number => {
    let m = 0;
    for (const t of tGrid) {
      const P = positionsSched(t, (qi) => Math.pow(t, pMap.get(qi)!));
      for (const fi of faceIdxs) m = Math.max(m, planarity(P, bigFaces[fi]));
    }
    return m;
  };
  const allIdx = bigFaces.map((_, i) => i);
  const worstCurrent = worstOf(allIdx); // should track REAL positions() err above

  for (let round = 0; round < 5; round++) {
    for (const q of qs) {
      const owned = facesOfQ.get(q.index) ?? [];
      if (!owned.length) continue;
      let bp = pMap.get(q.index)!, be = Infinity;
      for (let p = 0.3; p <= 1.601; p += 0.02) {
        pMap.set(q.index, p);
        const e = worstOf(owned);
        if (e < be) { be = e; bp = p; }
      }
      pMap.set(q.index, bp);
    }
  }
  const worstOpt = worstOf(allIdx);

  // Least-squares line optP = a·dihedral + b over the q's (only meaningful when the join
  // has a dihedral spread; degenerate for the uniform relaxed joins).
  let sx = 0, sy = 0, sxx = 0, sxy = 0, nq = 0;
  for (const q of qs) { const x = q.dihedral, y = pMap.get(q.index)!; sx += x; sy += y; sxx += x * x; sxy += x * y; nq++; }
  const denom = nq * sxx - sx * sx;
  const haveFit = Math.abs(denom) > 1e-6;
  const a = haveFit ? (nq * sxy - sx * sy) / denom : 0;
  const b = haveFit ? (sy - a * sx) / nq : sy / nq;

  // Error if we drove every q by the freshly-fit line instead of its own optimum —
  // i.e. how much of the per-q gain a single new linear heuristic recovers.
  const save = new Map(pMap);
  for (const q of qs) pMap.set(q.index, Math.max(0.3, Math.min(1.6, a * q.dihedral + b)));
  const worstFit = worstOf(allIdx);
  for (const [k, v] of save) pMap.set(k, v); // restore optimum for the print below

  console.log(
    `  per-q sched:  current-heuristic err=${worstCurrent.toFixed(4)}  |  per-q optimum err=${worstOpt.toFixed(4)}  |  ` +
    (haveFit ? `fresh line p=${a.toFixed(3)}·dih${b >= 0 ? "+" : ""}${b.toFixed(3)} err=${worstFit.toFixed(4)}`
             : `uniform dihedral → mean optP=${b.toFixed(3)}`),
  );

  // ── Endpoint (t=1) target analysis ──────────────────────────────────────────
  // The bestErr column below climbs to ~0.05 at t→1 on non-canonical joins, i.e. the
  // FINAL gyro pentagon is itself non-planar — no lift SCHEDULE (any exponent) can flatten
  // a non-planar endpoint. The only lever left is the q TARGET. Here we hold the slide at
  // its baked value and free each q's lift MAGNITUDE (scale on liftFull), then optimise it
  // per q to flatten the t=1 pentagons — the gyro analog of kis's computeJoinHeights. If
  // this drives the endpoint error to ~0 the new heuristic is a per-q lift magnitude; if a
  // floor remains, the slide (FACE_SLIDE) is also off on irregular faces.
  // q target = start + slideScale·slideFull + liftScale·liftFull. Scales default to 1
  // (the current baked target). Free them per q to flatten the t=1 pentagons.
  const endpoint = (slideMap: Map<number, number>, liftMap: Map<number, number>): Vector3[] => {
    const out: Vector3[] = [];
    for (let i = 0; i < V; i++) out[i] = J.vertices[i].clone();
    for (const q of qs) {
      out[q.index] = q.start.clone()
        .addScaledVector(q.slideFull, slideMap.get(q.index)!)
        .addScaledVector(q.liftFull, liftMap.get(q.index)!);
    }
    return out;
  };
  const worstEndpoint = (faceIdxs: number[], slideMap: Map<number, number>, liftMap: Map<number, number>): number => {
    const P = endpoint(slideMap, liftMap);
    let m = 0;
    for (const fi of faceIdxs) m = Math.max(m, planarity(P, bigFaces[fi]));
    return m;
  };
  const one = () => new Map<number, number>(qs.map((q) => [q.index, 1]));
  const slideM = one(), liftM = one();
  const endCurrent = worstEndpoint(allIdx, slideM, liftM);
  // Pass 1: free only the lift magnitude (the single knob gyroLiftFactor exposes today).
  for (let round = 0; round < 6; round++) {
    for (const q of qs) {
      const owned = facesOfQ.get(q.index) ?? [];
      if (!owned.length) continue;
      let bs = liftM.get(q.index)!, be = Infinity;
      for (let s = 0; s <= 2.0001; s += 0.02) {
        liftM.set(q.index, s);
        const e = worstEndpoint(owned, slideM, liftM);
        if (e < be) { be = e; bs = s; }
      }
      liftM.set(q.index, bs);
    }
  }
  const endLiftOpt = worstEndpoint(allIdx, slideM, liftM);
  const range = (m: Map<number, number>) => {
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const v of m.values()) { lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
    return `${lo.toFixed(2)}..${hi.toFixed(2)} mean ${(sum / m.size).toFixed(2)}`;
  };
  const liftRange = range(liftM);
  // Pass 2: additionally free the slide magnitude (does re-tuning BOTH baked knobs suffice,
  // or is the target DIRECTION itself wrong on irregular faces?).
  for (let round = 0; round < 8; round++) {
    for (const q of qs) {
      const owned = facesOfQ.get(q.index) ?? [];
      if (!owned.length) continue;
      for (const M of [slideM, liftM]) {
        let bs = M.get(q.index)!, be = Infinity;
        for (let s = -0.5; s <= 2.0001; s += 0.02) {
          M.set(q.index, s);
          const e = worstEndpoint(owned, slideM, liftM);
          if (e < be) { be = e; bs = s; }
        }
        M.set(q.index, bs);
      }
    }
  }
  const endBothOpt = worstEndpoint(allIdx, slideM, liftM);
  console.log(
    `  endpoint(t=1): current err=${endCurrent.toFixed(4)}  |  free lift-scale err=${endLiftOpt.toFixed(4)} (${liftRange})  |  ` +
    `free slide+lift err=${endBothOpt.toFixed(4)} (slide ${range(slideM)})`,
  );

  // Per-dihedral-bucket table of the per-q optimum vs the current heuristic.
  const buckets = new Map<string, { dih: number; opt: number[]; heur: number }>();
  for (const q of qs) {
    const key = dg(q.dihedral);
    const bkt = buckets.get(key) ?? { dih: q.dihedral, opt: [], heur: q.liftExp };
    bkt.opt.push(pMap.get(q.index)!);
    buckets.set(key, bkt);
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  if (buckets.size > 1) {
    console.log("   dihedral | count | optP(mean) | current liftExp");
    for (const [key, bkt] of [...buckets.entries()].sort((x, y) => x[1].dih - y[1].dih)) {
      console.log(`    ${key.padStart(6)}° |  ${String(bkt.opt.length).padStart(3)}  |   ${mean(bkt.opt).toFixed(3)}    |   ${bkt.heur.toFixed(3)}`);
    }
  }

  // For each GLOBAL slide fraction t, the lift fraction lam minimizing the worst face
  // non-planarity — the terminal value (t=0.9) also checks the lift MAGNITUDE (lam≈1 ⇒
  // the baked liftFull lands the face flat at t=1).
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
}

describe("gyro planarity sweep (relaxed joins)", () => {
  for (const [name, build] of Object.entries(relaxedCases)) {
    it(name, () => analyze(name, build()));
  }
});

describe("gyro planarity sweep (raw / un-relaxed joins)", () => {
  for (const [name, build] of Object.entries(rawCases)) {
    it(`RAW ${name}`, () => analyze(`RAW ${name}`, build()));
  }
});
