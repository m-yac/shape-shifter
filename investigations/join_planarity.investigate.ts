import { describe, it } from "vitest";
import { Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { faceCentroidHE, faceNormalHE } from "../src/geometry/polyhedron";
import { buildKis, joinHeight, computeJoinHeights } from "../src/operations/kis";
import { type Mesh } from "../src/geometry/HalfEdge";
import { RelaxSolver } from "../src/solver/solver";
import { extractTopology } from "../src/solver/topology";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Kis / Join planarity investigation — the DUAL of truncate_planarity.
 *
 * Kis raises a pyramid of height h_f on every face; at Join two pyramid
 * triangles straddling a shared edge merge into one quad `[P1, apex_f, P2,
 * apex_g]`. On a canonical solid a single symmetric join height (h_f = h_g,
 * the max over a face's edges — the old kis.ts behaviour) welds every quad flat.
 * On a solid with non-coplanar structure (e.g. the triakis tetrahedron, i.e.
 * kis(tetra) relaxed) those quads come out badly non-planar — the exact dual of
 * truncate's non-planar vertex figures.
 *
 * The quad is planar iff P1, P2, apex_f, apex_g are coplanar, i.e. the triple
 * product R(h_f,h_g) = (apex_f−P1)·((P2−P1)×(apex_g−P1)) = 0. This is bilinear
 * in the two apex heights. Dual to truncate (one radial-depth δ per vertex,
 * least-squares over edges), we solve one height h_f per FACE by least squares
 * over the join quads (`computeJoinHeights`). This script measures the residual
 * non-planarity of the welded Join quads under (a) the symmetric max height and
 * (b) the solved per-face heights, and confirms the triakis tetra is exact.
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
 * A self-contained Join, mirroring src/operations/kis.ts: every face is kissed;
 * each face f raises an apex c_f + h_f·n_f, and adjacent apexes weld with the
 * shared base edge into a quad `[P1, apex_f, P2, apex_g]`.
 */
function buildJoin(J: Polyhedron) {
  const dcel = J.dcel;
  const V = dcel.vertices.length;
  const cen = new Map<number, Vector3>();
  const nrm = new Map<number, Vector3>();
  const apex = new Map<number, number>();
  let idx = V;
  for (const f of dcel.faces) {
    cen.set(f.id, faceCentroidHE(f));
    nrm.set(f.id, faceNormalHE(f));
    apex.set(f.id, idx++);
  }
  const vertexCount = idx;

  // one quad per undirected edge
  const quads: number[][] = [];
  for (const he of dcel.halfedges) {
    if (he.id >= he.twin!.id) continue;
    quads.push([he.origin.id, apex.get(he.face.id)!, he.next.origin.id, apex.get(he.twin!.face.id)!]);
  }

  const positions = (h: Map<number, number>): Vector3[] => {
    const out: Vector3[] = new Array(vertexCount);
    for (let i = 0; i < V; i++) out[i] = dcel.vertices[i].position.clone();
    for (const f of dcel.faces) out[apex.get(f.id)!] = cen.get(f.id)!.clone().add(nrm.get(f.id)!.clone().multiplyScalar(h.get(f.id)!));
    return out;
  };
  return { cen, nrm, quads, positions };
}

// symmetric per-face height: max join height over its edges (old kis.ts).
function symmetricHeights(J: Polyhedron): Map<number, number> {
  const B = buildJoin(J);
  const h = new Map<number, number>();
  for (const f of J.dcel.faces) {
    let hj = 0;
    let he = f.halfedge;
    const start = he;
    do {
      const g = he.twin!.face;
      const solved = joinHeight(
        he.origin.position, he.next.origin.position,
        B.cen.get(f.id)!, B.nrm.get(f.id)!, B.cen.get(g.id)!, B.nrm.get(g.id)!,
      );
      if (solved && solved > 1e-6) hj = Math.max(hj, solved);
      he = he.next;
    } while (he !== start);
    if (hj <= 1e-6) hj = 0.5 * B.cen.get(f.id)!.distanceTo(f.halfedge.origin.position);
    h.set(f.id, hj);
  }
  return h;
}

function worstQuad(B: ReturnType<typeof buildJoin>, h: Map<number, number>) {
  const P = B.positions(h);
  let m = 0;
  for (const q of B.quads) m = Math.max(m, planarity(P, q));
  return m;
}
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);

const cases: Record<string, () => Polyhedron> = {
  "triakisTetra = kis(tetra)": () => kisCanon(seed("tetrahedron")),
  "triakisOcta? = kis(cube)": () => kisCanon(seed("cube")),
  "tetrakisHexa? = kis(octa)": () => kisCanon(seed("octahedron")),
  // a canonical control: cube's join quads should be flat either way
  "cube (canonical control)": () => seed("cube"),
};

describe("kis / join planarity", () => {
  for (const [name, build] of Object.entries(cases)) {
    it(name, () => {
      const J = build();
      const B = buildJoin(J);
      const sym = symmetricHeights(J);
      const solved = computeJoinHeights(J);

      const degs = J.dcel.faces.map((f) => { let n = 0, he = f.halfedge; const s = he; do { n++; he = he.next; } while (he !== s); return n; });
      console.log(`\n╔══ ${name} ══`);
      console.log(`║ V=${J.dcel.vertices.length} E=${B.quads.length} F=${J.dcel.faces.length}  face sides: ${[...new Set(degs)].sort().map((d) => `${degs.filter((x) => x === d).length}×${d}gon`).join(", ")}`);
      console.log(`║ symmetric max height   → worst join-quad planarity: ${worstQuad(B, sym).toFixed(5)}`);
      console.log(`║ solved per-face height → worst join-quad planarity: ${worstQuad(B, solved).toExponential(3)}`);
      // heights per face-arity class, symmetric vs solved
      const byDeg = new Map<number, { sym: number[]; sol: number[] }>();
      J.dcel.faces.forEach((f, i) => {
        const g = byDeg.get(degs[i]) ?? byDeg.set(degs[i], { sym: [], sol: [] }).get(degs[i])!;
        g.sym.push(sym.get(f.id)!); g.sol.push(solved.get(f.id)!);
      });
      for (const [d, g] of byDeg) console.log(`║   ${d}gon: h_sym≈${mean(g.sym).toFixed(4)}  h_solved≈${mean(g.sol).toFixed(4)}`);
      console.log(`╚═══`);
    });
  }
});
