import { describe, it } from "vitest";
import { Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { buildKis } from "../src/operations/kis";
import { type Mesh, outgoingHalfEdges } from "../src/geometry/HalfEdge";
import { RelaxSolver } from "../src/solver/solver";
import { extractTopology } from "../src/solver/topology";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Truncation / rectification planarity investigation.
 *
 * When you truncate a solid, `truncate.ts` slides every cut vertex the SAME
 * fraction along each incident edge (`cutFrac` is per-origin-vertex). On a
 * canonical Archimedean/Platonic solid that's fine, but on a solid with
 * non-coplanar vertex stars — e.g. the triakis tetrahedron, whose degree-6
 * "big" vertices are ringed by 3 same-radius neighbours alternating with 3
 * outward-poking apexes — the exposed vertex n-gon it creates is WILDLY
 * non-planar (the app only hides it because it canonicalizes right after).
 *
 * This script measures that non-planarity and searches for a per-EDGE cut speed
 * that flattens the created faces. Key facts it establishes:
 *
 *   • The truncated ORIGINAL faces are always planar (their cut points lie on
 *     the original face's own edges, i.e. in its plane) — so all the trouble is
 *     in the exposed vertex n-gons (the "vertex figures").
 *
 *   • Parametrize each EDGE by a single collapse param s ∈ (0,1): the rectify
 *     vertex sits at v + s·(w−v). During the drag the two cut ends ride at
 *     frac = s·t (from v) and (1−s)·t (from w); at t=1 they meet and weld. Then
 *     each vertex figure at parameter t is exactly `t ×` its rectify figure
 *     (a homothety centred on v), so IF the rectify figure is planar every
 *     intermediate truncation is planar too. => solve the problem at t=1 only.
 *
 *   • Choosing s per edge so each vertex's cut points sit at equal radial depth
 *     makes the vertex figure planar. For the triakis tetra this is exact.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── canonicalize (the app's post-op relax) ───────────────────────────────────
function relax(poly: Polyhedron): Mesh {
  const topo = extractTopology(poly);
  const solver = new RelaxSolver(poly.mesh.vertices, topo);
  let guard = 0;
  while (solver.advance() && guard++ < 5000) { /* iterate */ }
  return solver.mesh;
}
const canon = (p: Polyhedron) => new Polyhedron(relax(p));
const seed = (n: string) => new Polyhedron(getSeed(n));

/** Canonical kis of a seed (kis topology, then relaxed → the Catalan solid). */
const kisCanon = (p: Polyhedron) =>
  canon(new Polyhedron(buildKis(p, 0, null).commit(0.5, false).mesh));

// ── scale-free non-planarity: max |dist to best-fit plane| / mean edge len ────
function planarity(verts: Vector3[], face: number[]): number {
  if (face.length <= 3) return 0; // triangles are always planar
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

/*
 * A self-contained truncation, mirroring src/operations/truncate.ts but with the
 * cut speed generalized from per-vertex to per-EDGE. Every vertex is truncated
 * (the preview topology the app actually shows). Each undirected edge carries a
 * collapse param s (keyed by its smaller half-edge id, oriented from that
 * half-edge's origin `v` toward its dest `w`): the cut point is v + s·(w−v).
 */
function buildTrunc(J: Polyhedron) {
  const dcel = J.dcel;

  // one cut vertex per half-edge
  const cutIndex = new Map<number, number>();
  let idx = 0;
  for (const he of dcel.halfedges) cutIndex.set(he.id, idx++);
  const vertexCount = idx;

  // undirected edge key = smaller half-edge id; store its canonical orientation
  type EdgeInfo = { key: number; v: Vector3; w: Vector3; va: number; wb: number };
  const edges: EdgeInfo[] = [];
  const edgeOfHe = new Map<number, { key: number; forward: boolean }>();
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    const key = he.id;
    edges.push({
      key,
      v: he.origin.position.clone(),
      w: he.next.origin.position.clone(),
      va: he.origin.id,
      wb: he.next.origin.id,
    });
    edgeOfHe.set(he.id, { key, forward: true });
    edgeOfHe.set(he.twin.id, { key, forward: false });
  }

  // faces: (a) one 2n-gon per original face; (b) one n-gon per vertex figure
  const origFaces: number[][] = [];
  for (const f of dcel.faces) {
    const loop: number[] = [];
    let h = f.halfedge;
    const start = h;
    do {
      loop.push(cutIndex.get(h.prev.twin!.id)!); // incoming cut
      loop.push(cutIndex.get(h.id)!); // outgoing cut
      h = h.next;
    } while (h !== start);
    origFaces.push(loop);
  }
  const vertFigures: Array<{ vid: number; face: number[] }> = [];
  for (const v of dcel.vertices) {
    vertFigures.push({ vid: v.id, face: outgoingHalfEdges(v).map((h) => cutIndex.get(h.id)!) });
  }

  // fraction (from a half-edge's own origin) given the edge's s and drag t
  const fracForHe = (heId: number, s: (key: number) => number, t: number) => {
    const { key, forward } = edgeOfHe.get(heId)!;
    return t * (forward ? s(key) : 1 - s(key));
  };

  const positions = (s: (key: number) => number, t: number): Vector3[] => {
    const out: Vector3[] = new Array(vertexCount);
    for (const he of dcel.halfedges) {
      const o = he.origin.position, d = he.next.origin.position;
      out[cutIndex.get(he.id)!] = o.clone().lerp(d, fracForHe(he.id, s, t));
    }
    return out;
  };

  return { vertexCount, edges, origFaces, vertFigures, positions };
}

// worst non-planarity over the vertex figures (the faces that can go bad)
function worstFigure(T: ReturnType<typeof buildTrunc>, s: (k: number) => number, t: number) {
  const P = T.positions(s, t);
  let m = 0;
  for (const vf of T.vertFigures) m = Math.max(m, planarity(P, vf.face));
  return m;
}
function worstOrig(T: ReturnType<typeof buildTrunc>, s: (k: number) => number, t: number) {
  const P = T.positions(s, t);
  let m = 0;
  for (const f of T.origFaces) m = Math.max(m, planarity(P, f));
  return m;
}
// smooth objective for the numeric optimizer (Σ planarity²; the minimax "worst"
// is flat and traps coordinate descent at the symmetric s=0.5 saddle).
function sseFigure(T: ReturnType<typeof buildTrunc>, s: (k: number) => number, t: number) {
  const P = T.positions(s, t);
  let e = 0;
  for (const vf of T.vertFigures) { const p = planarity(P, vf.face); e += p * p; }
  return e;
}
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);

const cases: Record<string, () => Polyhedron> = {
  "triakisTetra = kis(tetra)": () => kisCanon(seed("tetrahedron")),
  // more Catalan-ish solids with non-coplanar vertex stars, for generality
  "rhombicDodeca = kis(cube)joined?": () => kisCanon(seed("cube")),
  "triakisOcta = kis(octa)": () => kisCanon(seed("octahedron")),
};

describe("truncate / rectify planarity", () => {
  for (const [name, build] of Object.entries(cases)) {
    it(name, () => {
      const J = build();
      const T = buildTrunc(J);
      const uniform = () => 0.5; // current truncate.ts behaviour

      // vertex classes by degree (+radius) so we can read s per symmetry class
      const radius = new Map<number, number>();
      const degree = new Map<number, number>();
      for (const v of J.dcel.vertices) {
        radius.set(v.id, v.position.length());
        degree.set(v.id, outgoingHalfEdges(v).length);
      }
      const degs = [...new Set([...degree.values()])].sort((a, b) => a - b);
      console.log(`\n╔══ ${name} ══`);
      console.log(`║ V=${J.dcel.vertices.length} E=${T.edges.length} F=${J.dcel.faces.length}  vertex degrees: ${degs.map((d) => `${[...degree.values()].filter((x) => x === d).length}×deg${d}`).join(", ")}`);

      // (0) original faces stay planar regardless of s — confirm.
      console.log(`║ orig-face worst planarity @rectify (uniform s=.5): ${worstOrig(T, uniform, 1).toExponential(2)}  (expect ~0)`);

      // (1) BASELINE: uniform s=0.5. Show the vertex figures are badly non-planar,
      //     and that the error is ~constant in t (the homothety fact).
      console.log(`║ ── baseline uniform s=0.5: worst vertex-figure planarity vs t ──`);
      for (const t of [0.25, 0.5, 0.75, 1.0]) {
        console.log(`║   t=${t.toFixed(2)}  worst=${worstFigure(T, uniform, t).toFixed(4)}`);
      }

      // (2) NUMERIC GROUND TRUTH: optimize s per symmetry CLASS (edges grouped by
      //     their sorted endpoint (degree,radius) signature, oriented from the
      //     low-radius end). Per-edge coordinate descent is trapped at the s=0.5
      //     saddle — moving one of a vertex's k equivalent edges just unbalances
      //     its figure — so we move each class collectively. This is an
      //     independent check on the closed-form solution in (3).
      const classKeys = new Map<string, Array<{ key: number; flip: boolean }>>();
      for (const e of T.edges) {
        const ra = radius.get(e.va)!, rb = radius.get(e.wb)!;
        const da = degree.get(e.va)!, db = degree.get(e.wb)!;
        const label = `deg${Math.min(da, db)}(r${Math.min(ra, rb).toFixed(3)})–deg${Math.max(da, db)}(r${Math.max(ra, rb).toFixed(3)})`;
        // store s oriented from the low-radius end; flip=true means the edge's own
        // v→w is the high→low direction, so classS maps to 1−classS.
        (classKeys.get(label) ?? classKeys.set(label, []).get(label)!).push({ key: e.key, flip: ra > rb });
      }
      const labels = [...classKeys.keys()];
      const classS = new Map<string, number>(labels.map((l) => [l, 0.5]));
      const sVal = new Map<number, number>();
      const syncFromClass = () => {
        for (const [label, members] of classKeys)
          for (const m of members) sVal.set(m.key, m.flip ? 1 - classS.get(label)! : classS.get(label)!);
      };
      const sFn = (k: number) => sVal.get(k)!;
      syncFromClass();
      let step = 0.25;
      for (let round = 0; round < 200; round++) {
        for (const label of labels) {
          const cur = classS.get(label)!;
          let best = cur, bestErr = (syncFromClass(), sseFigure(T, sFn, 1));
          for (const cand of [cur - step, cur + step]) {
            if (cand <= 0.02 || cand >= 0.98) continue;
            classS.set(label, cand); syncFromClass();
            const err = sseFigure(T, sFn, 1);
            if (err < bestErr) { bestErr = err; best = cand; }
          }
          classS.set(label, best);
        }
        step *= 0.95;
      }
      syncFromClass();
      const optWorst = worstFigure(T, sFn, 1);
      const optAtHalf = worstFigure(T, sFn, 0.5); // homothety: identical to t=1
      console.log(`║ ── numeric per-class optimum (min Σplanarity² @t=1) ──`);
      console.log(`║   worst figure: ${optWorst.toExponential(2)}   (t=0.5 → ${optAtHalf.toExponential(2)}, confirms homothety)`);
      for (const label of labels) {
        console.log(`║     ${label}:  s(from low-r end)=${classS.get(label)!.toFixed(4)}`);
      }

      // (3) PROPOSED FORMULA — "equal radial depth". For each vertex v (outward
      //     radial r=v̂) choose the cut points to share a radial depth. The cut
      //     point on edge v→w is v + s·(w−v); its radial depth is
      //     |v| + s·(w−v)·r. Equalizing across a vertex's edges gives
      //         s_i = (c_v − |v|) / ((w_i − v)·r_v).
      //     The per-vertex depth offset (c_v − |v|) = δ_v is the one free knob.
      //     Solve the δ_v (one per vertex) by least squares so the two endpoints
      //     of every edge agree on its single collapse point, then read s.
      const depthDrop = (from: Vector3, to: Vector3) => {
        const r = from.clone().normalize();
        return to.clone().sub(from).dot(r); // (w−v)·v̂  (negative: edge dives inward)
      };
      // Coordinate-descent on δ_v to minimize edge disagreement:
      //   from v: s = δ_v / a_v      (a_v = (w−v)·v̂)
      //   from w: s = 1 − δ_w / a_w  (a_w = (v−w)·ŵ)
      // minimize Σ_edges ( δ_v/a_v − (1 − δ_w/a_w) )².
      const delta = new Map<number, number>(J.dcel.vertices.map((v) => [v.id, 0]));
      const incident = new Map<number, Array<{ a: number; other: number; ao: number }>>();
      for (const v of J.dcel.vertices) incident.set(v.id, []);
      for (const e of T.edges) {
        const a_v = depthDrop(e.v, e.w); // from va
        const a_w = depthDrop(e.w, e.v); // from wb
        incident.get(e.va)!.push({ a: a_v, other: e.wb, ao: a_w });
        incident.get(e.wb)!.push({ a: a_w, other: e.va, ao: a_v });
      }
      // seed δ so s≈0.5: δ_v ≈ 0.5·(mean incident a)
      for (const v of J.dcel.vertices) {
        const inc = incident.get(v.id)!;
        delta.set(v.id, 0.5 * mean(inc.map((i) => i.a)));
      }
      for (let round = 0; round < 400; round++) {
        for (const v of J.dcel.vertices) {
          // solve δ_v minimizing Σ_edges(δ_v/a − sTarget)², sTarget = 1 − δ_other/a_other
          const inc = incident.get(v.id)!;
          let num = 0, den = 0;
          for (const i of inc) {
            const sTarget = 1 - delta.get(i.other)! / i.ao;
            num += sTarget / i.a;
            den += 1 / (i.a * i.a);
          }
          if (den > 1e-12) delta.set(v.id, num / den);
        }
      }
      // read the reconciled per-edge s (average the two endpoints' opinion)
      const sRadial = new Map<number, number>();
      for (const e of T.edges) {
        const a_v = depthDrop(e.v, e.w), a_w = depthDrop(e.w, e.v);
        const sFromV = delta.get(e.va)! / a_v;
        const sFromW = 1 - delta.get(e.wb)! / a_w;
        sRadial.set(e.key, 0.5 * (sFromV + sFromW));
      }
      const sRadialFn = (k: number) => Math.max(0.02, Math.min(0.98, sRadial.get(k)!));
      console.log(`║ ── proposed "equal radial depth" s ──`);
      console.log(`║   worst figure @t=1: ${worstFigure(T, sRadialFn, 1).toFixed(4)}   orig faces: ${worstOrig(T, sRadialFn, 1).toExponential(2)}`);
      // per-class proposed s, to compare against the numeric optimum
      const pclass = new Map<string, number[]>();
      for (const e of T.edges) {
        const ra = radius.get(e.va)!, rb = radius.get(e.wb)!;
        const da = degree.get(e.va)!, db = degree.get(e.wb)!;
        const label = `deg${Math.min(da, db)}–deg${Math.max(da, db)}`;
        const sOriented = (ra <= rb) ? sRadial.get(e.key)! : 1 - sRadial.get(e.key)!;
        (pclass.get(label) ?? pclass.set(label, []).get(label)!).push(sOriented);
      }
      for (const [label, arr] of pclass) {
        console.log(`║     ${label}: s(from low-r end)=${mean(arr).toFixed(4)}`);
      }
      console.log(`╚═══`);
    });
  }
});
