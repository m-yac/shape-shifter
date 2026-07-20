import { Vector3, Matrix3, Ray, Color } from "three";
import {
  type Mesh,
  type DCEL,
  type HEFace,
  type HalfEdge,
  outgoingHalfEdges,
} from "../geometry/HalfEdge";
import { type Polyhedron, faceNormalHE, faceCentroidHE } from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey } from "../geometry/colors";
import { type MorphPlan, type TwistArc } from "./types";
import { type InViewTest } from "./truncate";
import { combine, dualRule, lerpFaceColors, recolorPropellor, stagedFaceColors } from "./colorUtil";
import { config } from "../config";

const BLACK: GeomColor = [0, 0, 0];

// At the full gyro each new edge-midpoint vertex slides `gyroFaceSlide` of the way along
// the line joining the midpoints of its quad's two opposite edges, and lifts outward off
// the face. The lift is not a fixed fraction of the edge: it scales with cot(dihedral/2)
// of the join edge the vertex sits over, so a sharp join folds up much more than a
// nearly-flat one (see config.operations.gyroLiftFactor).
const FACE_SLIDE = config.operations.gyroFaceSlide;

/**
 * The exponent `p` in a q vertex's lift schedule `lift(t) = t^p`. The in-plane slide runs
 * linearly (0→1); were the lift linear too (`p = 1`) the two split half-quads would fold
 * along the old join edge and crease at every intermediate step, flattening only at t=1.
 * Running the lift ahead of the slide (`p < 1`) keeps each split face near-planar
 * throughout the drag; the sharper the join edge the q sits over, the more the lift
 * must lead, so `p` grows with the join `dihedral` (in radians), clamped to [0.3, 1.6]:
 * 90° cube → p≈0.52, 120° → 0.68, 144° → 0.80. The line is gentler than the per-shape
 * optimum fit in investigations/gyro_lift_exponent.investigate.ts, which sits near the
 * top of the band on the sharpest joins.
 */
export function liftExponent(dihedral: number): number {
  return Math.max(0.3, Math.min(1.6, 0.30 * dihedral + 0.05));
}

/** cot(dihedral/2) of the (convex) join edge `he`, given its face's outward normal.
 *  Falls back to 1 (a right-angle valley) if the edge has no neighbour or is flat. */
function cotHalfDihedral(he: HalfEdge, outwardNormal: Vector3): number {
  if (!he.twin) return 1;
  const nt = faceNormalHE(he.twin.face);
  if (nt.dot(faceCentroidHE(he.twin.face)) < 0) nt.negate();
  const dihedral = Math.PI - Math.acos(Math.max(-1, Math.min(1, outwardNormal.dot(nt))));
  const half = dihedral / 2;
  const s = Math.sin(half);
  return s > 1e-6 ? Math.cos(half) / s : 0;
}

function faceHalfEdges(f: HEFace): HalfEdge[] {
  const out: HalfEdge[] = [];
  let h = f.halfedge;
  const start = h;
  do {
    out.push(h);
    h = h.next;
  } while (h !== start);
  return out;
}

/** Proper 2-coloring of the vertices of a join (adjacent vertices differ). A join's
 *  graph is bipartite (original vertices vs face-centre apexes), so no conflict. */
function twoColorVertices(dcel: DCEL): Map<number, 0 | 1> {
  const color = new Map<number, 0 | 1>();
  color.set(0, 0);
  const queue = [0];
  while (queue.length) {
    const vid = queue.shift()!;
    const c = color.get(vid)!;
    for (const h of outgoingHalfEdges(dcel.vertices[vid])) {
      const n = h.next.origin.id;
      if (!color.has(n)) {
        color.set(n, (c ^ 1) as 0 | 1);
        queue.push(n);
      }
    }
  }
  return color;
}

/** One peripheral (q) vertex of a gyred face: its new index and the two orthogonal
 *  displacements that carry it from its edge midpoint to the full gyro. Keeping the
 *  motion split lets `positions` schedule the in-plane slide and the out-of-plane lift on
 *  separate curves, so the split faces stay near-planar all through the drag rather than
 *  only at t=1 (see `liftExponent`). */
interface QVert {
  index: number;
  start: Vector3; // the edge midpoint (t=0)
  slideFull: Vector3; // full in-plane slide toward the opposite edge (t=1)
  liftFull: Vector3; // full outward lift off the join face (t=1)
  liftExp: number; // exponent p in this q's lift schedule lift(t) = t^p (see liftExponent)
  dihedral: number; // interior dihedral (rad) of the join edge this q sits over
}

/**
 * The whirl overlay of a gyro variant: the gyro with each join apex truncated back into
 * the face it was collapsed from. Only built when `buildGyro` is given an `apexStart`
 * (see `buildWhirl`); the gyro's own vertices, faces and handle are untouched.
 */
interface WhirlData {
  vertexCount: number;
  /** gyro vertex index → whirl vertex index (−1 for the apexes, which are cut away). */
  remap: number[];
  /** One cut per apex spoke, riding out from the apex along the (moving) gyro edge to it. */
  cuts: Array<{ index: number; apex: number; q: number }>;
  faces: number[][];
  faceColor: GeomColor[];
  faceStart: GeomColor[];
  /** Index in `faces` where the apex rings begin: everything before is a welded gyro face
   *  (a propellor blade at the weld); each ring is one of X's own faces, kept. */
  keptFaceStart: number;
  vertexColor: GeomColor[];
  edgeColor: Map<string, GeomColor>;
  /** The spoke remnants (cut → its q), which run out to zero length at the propellor. */
  spokes: Array<[number, number]>;
  /** Vertex count after that weld: the cuts are the tail of the index space, and each
   *  merges into its q, so the survivors are exactly the leading `weldCount`. */
  weldCount: number;
  /** whirl vertex index → propellor index (a cut maps onto the q it welds into). */
  weldMap: number[];
}

/**
 * Gyro as a twist extension of a join. Given the join `poly` (all quad faces), each
 * original vertex, together with the inner halves of its edges, rotates about its radial
 * axis; a new vertex appears at every edge midpoint and each quad splits in two, giving
 * the gyro (the dual of snub). The topology (tiling + weld across every join edge) is
 * the classic gyro's, independent of the intermediate rotation, which the post-release
 * relaxer regularizes.
 *
 * `apexPos` is the join apex the base drag ended on; it selects the local neighbourhood
 * the arc is drawn in.
 *
 * With `apexStart` the plan is a **whirl** instead: the same gyro, but the join's apex
 * vertices (those with index ≥ `apexStart`, since a join keeps the original vertices
 * first and appends one apex per original face) are truncated back into the faces they
 * were collapsed from, growing in as the twist runs. Truncating a join's apexes *is* the
 * chamfer — the join's rhombi each have two apex corners, so they open into hexagons —
 * which is why the whirl extends a chamfer drag exactly as the gyro extends a kis drag.
 * Unlike the plain gyro, that twist ends in a weld: at t=1 each cut has slid the whole way
 * onto the gyro vertex it was heading for, and welding the two gives the propellor (see
 * `propellorFrom`), which is also where a volute's twist ends.
 */
export function buildGyro(
  poly: Polyhedron,
  _draggedFid: number,
  apexPos: Vector3,
  cameraPos: Vector3 | null = null,
  _inView: InViewTest | null = null,
  apexStart: number | null = null,
): MorphPlan {
  const dcel = poly.dcel;
  const V = dcel.vertices.length;
  const old = poly.colors;
  const C = config.colors.operations;
  const color = twoColorVertices(dcel);
  /** Whirl only: a join vertex that was a face apex, so the twist truncates it. */
  const isApex = (i: number) => apexStart !== null && i >= apexStart && i < V;

  // Welded max: dissolve every original edge (shared by two faces of the join). Built
  // before the variants, and independent of chirality, so the per-variant target solver
  // below can weld the preview into the gyro faces it needs to flatten.
  const dissolve = new Set<string>();
  const dissolveList: Array<[number, number]> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    dissolve.add(edgeKey(he.origin.id, he.next.origin.id));
    dissolveList.push([he.origin.id, he.next.origin.id]);
  }

  function buildVariant(startColor: 0 | 1): {
    previewFaces: number[][];
    vertexCount: number;
    vertexColor: GeomColor[];
    faceColor: GeomColor[];
    faceStart: GeomColor[];
    edgeColor: Map<string, GeomColor>;
    qverts: QVert[];
    /** q index → the join edge it sits on (whirl reads this to find each apex's spokes). */
    qSourceEdge: Map<number, [number, number]>;
  } {
    // Colors mirror snub (its dual): each snub rule, dualized (vertex↔face), read against
    // the join's own stored colors (`old`): oldFace = old.face, oldVertex = old.vertex,
    // oldEdge = old.edge. A gyro face is the dual of a snub split vertex
    // (dualRule(snub.newVertex)); a q vertex is the dual of a snub gap face
    // (dualRule(snub.newFace)).
    //
    // A finished gyro face is welded from a big half (owning face f) and a triangle half
    // of a neighbour, across a dissolved join edge. `ea`/`eb` are the join edge the half
    // welds across and `fid` its own parent face, so the two halves agree (on the
    // symmetric solids the faces across a join edge share a color) and the merged face
    // reads as one color from t=0.
    const gyroFaceColor = (ea: number, eb: number, fid: number): GeomColor =>
      combine(dualRule(C.snub.newVertex), {
        oldEdge: old.edge.get(edgeKey(ea, eb)) ?? BLACK,
        oldFace: old.face[fid],
      });
    const previewFaces: number[][] = [];
    const faceColor: GeomColor[] = [];
    const faceStart: GeomColor[] = [];
    const vertexColor: GeomColor[] = [];
    for (let i = 0; i < V; i++) vertexColor[i] = old.vertex[i];
    const ownerFace = new Map<number, number>();
    const centerEdges = new Map<string, GeomColor>();
    const qverts: QVert[] = [];
    const qNormal = new Map<number, Vector3>(); // q index -> its home face's outward normal
    const qSourceEdge = new Map<number, [number, number]>(); // q index -> the join edge it sits on
    let idx = V;

    for (const f of dcel.faces) {
      const bh = faceHalfEdges(f);
      const m = bh.length; // = 4 for a join
      const n = m / 2;

      let s = 0;
      for (let i = 0; i < m; i++) if (color.get(bh[i].origin.id) === startColor) { s = i; break; }
      const P: number[] = [];
      for (let i = 0; i < m; i++) P.push(bh[(s + i) % m].origin.id);

      const hasCenter = n >= 3;
      const center = hasCenter ? idx++ : -1;
      if (hasCenter) {
        vertexColor[center] = old.face[f.id];
        ownerFace.set(center, f.id);
      }
      // Outward normal of this quad: the lift direction, shared by both its q's so the
      // raise has no in-plane component (a per-vertex radial axis would tilt the two q's
      // toward opposite corners, reading as an unwanted twist).
      const faceNormal = faceNormalHE(f);
      if (faceNormal.dot(faceCentroidHE(f)) < 0) faceNormal.negate();
      const qIdx: number[] = [];
      // Center→q spoke / quad-split edges are the dual of a snub center split edge (the
      // new edge a split rectify vertex opens): snub colors that the rectify vertex, so
      // gyro colors this the join face. (The q↔original edges, the dual of snub's
      // inner/outer edges, are colored in the edge pass below.)
      const spokeColor: GeomColor = old.face[f.id];
      for (let j = 0; j < n; j++) {
        const q = idx++;
        qIdx.push(q);
        // q_j sits at the midpoint of boundary edge (P[2j-1], P[2j]). Projected onto the
        // quad it slides straight along the line joining that midpoint to the midpoint of
        // the opposite edge (P[2j+1], P[2j+2]), and lifts outward along the face normal.
        // The chirality lives entirely in the topology (which opposite-edge pair each
        // variant's 2-colouring picks), so the motion is a straight slide, no in-plane
        // rotation; the relaxer then settles the pentagons into the true gyro.
        const a = dcel.vertices[P[(2 * j - 1 + m) % m]].position;
        const pivot = dcel.vertices[P[2 * j]].position;
        const oppA = dcel.vertices[P[(2 * j + 1) % m]].position;
        const oppB = dcel.vertices[P[(2 * j + 2) % m]].position;
        const mid = a.clone().add(pivot).multiplyScalar(0.5);
        const oppMid = oppA.clone().add(oppB).multiplyScalar(0.5);
        const v0 = mid.clone().sub(pivot);
        // Lift height: gyroLiftFactor · cot(dihedral/2) · |v0|, for the join edge
        // (a, pivot) this q sits over. The dihedral is between the two join faces meeting
        // along that edge: the sharper the valley, the more the q rises to fold the quads
        // into a flat pentagon, and a near-flat edge barely lifts at all.
        const boundary = bh[(s + ((2 * j - 1 + m) % m)) % m];
        const cotHalf = cotHalfDihedral(boundary, faceNormal);
        const slideFull = oppMid.clone().sub(mid).multiplyScalar(FACE_SLIDE);
        const liftFull = faceNormal.clone()
          .multiplyScalar(config.operations.gyroLiftFactor * cotHalf * v0.length());
        // Lift schedule exponent from this q's join-edge dihedral (recovered from
        // cot(dihedral/2)): sharper edges lift earlier so the split face stays flat.
        const dihedral = 2 * Math.atan2(1, cotHalf);
        const liftExp = liftExponent(dihedral);
        qverts.push({ index: q, start: mid.clone(), slideFull, liftFull, liftExp, dihedral });
        qNormal.set(q, faceNormal);
        // A q vertex is the dual of a snub gap triangle (snub.newFace): the join edge it
        // sits on maps to snub's rectify edge, and the join face f it borders to the
        // rectify vertex the gap opened at.
        vertexColor[q] = combine(dualRule(C.snub.newFace), {
          oldFace: old.face[f.id],
          oldEdge: old.edge.get(edgeKey(P[(2 * j - 1 + m) % m], P[2 * j])) ?? BLACK,
        });
        ownerFace.set(q, f.id);
        qSourceEdge.set(q, [P[(2 * j - 1 + m) % m], P[2 * j]]);
      }
      if (hasCenter) {
        for (const q of qIdx) centerEdges.set(edgeKey(center, q), spokeColor);
      } else {
        centerEdges.set(edgeKey(qIdx[0], qIdx[1]), old.face[f.id]);
      }

      for (let j = 0; j < n; j++) {
        const pent = hasCenter
          ? [center, qIdx[j], P[2 * j], P[2 * j + 1], qIdx[(j + 1) % n]]
          : [qIdx[j], P[2 * j], P[2 * j + 1], qIdx[(j + 1) % n]];
        previewFaces.push(pent);
        // Big half: welds across join edge (P[2j],P[2j+1]).
        faceColor.push(gyroFaceColor(P[2 * j], P[2 * j + 1], f.id));
        faceStart.push(old.face[f.id]);
        previewFaces.push([qIdx[(j + 1) % n], P[2 * j + 1], P[(2 * j + 2) % m]]);
        // Triangle half: welds across join edge (P[2j+1],P[2j+2]).
        faceColor.push(gyroFaceColor(P[2 * j + 1], P[(2 * j + 2) % m], f.id));
        // This triangle-half welds (across its dissolved join edge P[2j+1]→P[2j+2]) into
        // the big half of the neighbour face to form one gyro face. Start it at that
        // neighbour's colour, the colour of the face the merged gyro face is splitting,
        // rather than its own face's, so the merged face fades as one colour from t=0
        // instead of showing a seam along the dissolved join edge.
        const triBoundary = bh[(s + 2 * j + 1) % m];
        const triNeighbor = triBoundary.twin ? triBoundary.twin.face.id : f.id;
        faceStart.push(old.face[triNeighbor]);
      }
    }

    const edgeColor = new Map(old.edge);
    for (const [k, c] of centerEdges) edgeColor.set(k, c);
    for (const loop of previewFaces) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const key = edgeKey(a, b);
        if (edgeColor.has(key)) continue;
        // A q↔original-join-vertex edge is a gyro inner/outer edge: the dual of snub's
        // boundary edge. Dually the boundary's adjacent rotated face becomes the original
        // join vertex endpoint (oldVertex), and its gap-triangle vertex becomes the join
        // face this edge borders (oldFace = the q's owner face).
        const q = qSourceEdge.has(a) ? a : qSourceEdge.has(b) ? b : -1;
        const orig = a < V ? a : b < V ? b : -1;
        if (q >= 0 && orig >= 0) {
          const [ea, eb] = qSourceEdge.get(q)!;
          edgeColor.set(key, combine(dualRule(C.snub.snubEdge), {
            oldVertex: old.vertex[orig],
            oldFace: old.face[ownerFace.get(q)!],
            // The join edge this edge runs along (dual of snub's oldEdge; unused by the
            // current rule, but the natural source should it want oldEdge).
            oldEdge: old.edge.get(edgeKey(ea, eb)) ?? BLACK,
          }));
          continue;
        }
        const fid = ownerFace.get(a) ?? ownerFace.get(b);
        // Any remaining new edge (e.g. center↔q spokes not pre-set) → the join face.
        if (fid !== undefined) edgeColor.set(key, old.face[fid]);
      }
    }

    // Re-solve each q's target so the welded gyro faces land planar at t=1 even on a
    // non-canonical (un-relaxed) join; the lift schedule is unchanged.
    solveGyroTargets(qverts, qNormal, previewFaces, faceColor);

    return {
      previewFaces, vertexCount: idx, vertexColor, faceColor, faceStart, edgeColor,
      qverts, qSourceEdge,
    };
  }

  /**
   * Per-q target solve that keeps the finished gyro faces planar on a raw, un-relaxed
   * join: the gyro analog of kis's `computeJoinHeights`.
   *
   * The heuristic q target (edge midpoint + a fixed slide toward the opposite edge + a
   * cot(dihedral/2) lift) lands a flat pentagon only on a canonical join, whose quads
   * are congruent. On a non-canonical join (mixed face types, e.g. the join of a
   * cuboctahedron) it leaves the t=1 pentagon ~5% of an edge non-planar, and no lift
   * schedule can flatten a non-planar endpoint. So each q moves to the point best lying
   * on the planes of its incident gyro faces: for each welded pentagon at q, require q
   * on the best-fit plane of that face's other vertices (a linear residual nᵢ·(q−cᵢ)=0)
   * and least-squares them with a Tikhonov pull (λ) toward the heuristic seed, which
   * pins the free edge-tangent direction and the underdetermined canonical case. The
   * faces couple through shared q's, so it is Gauss-Seidel, like computeJoinHeights.
   *
   * The solved target is split back into an in-plane `slideFull` and an along-normal
   * `liftFull`: the drag still runs the slide linearly and leads the lift on t^liftExp,
   * keeping the invariant that the lift has no in-plane component.
   */
  function solveGyroTargets(
    qverts: QVert[],
    qNormal: Map<number, Vector3>,
    previewFaces: number[][],
    faceColor: GeomColor[],
  ): void {
    const bigFaces = weldedFaces(previewFaces, faceColor).faces.filter((f) => f.length > 3);
    if (!qverts.length) return;
    const incident = new Map<number, number[][]>(); // q index -> welded faces touching it
    for (const f of bigFaces) for (const v of f) if (v >= V) (incident.get(v) ?? incident.set(v, []).get(v)!).push(f);

    const seed = new Map<number, Vector3>();
    const cur = new Map<number, Vector3>();
    for (const q of qverts) {
      const target = q.start.clone().add(q.slideFull).add(q.liftFull);
      seed.set(q.index, target);
      cur.set(q.index, target.clone());
    }
    const posOf = (vid: number): Vector3 => (vid < V ? dcel.vertices[vid].position : cur.get(vid)!);
    const LAMBDA = 0.1; // Tikhonov weight vs the unit-normal data terms

    for (let round = 0; round < 60; round++) {
      for (const q of qverts) {
        const faces = incident.get(q.index);
        if (!faces || !faces.length) continue;
        // Normal equations (Σnnᵀ + λI)·q = Σn(n·c) + λ·seed, symmetric 3×3.
        const s = seed.get(q.index)!;
        let m00 = LAMBDA, m01 = 0, m02 = 0, m11 = LAMBDA, m12 = 0, m22 = LAMBDA;
        const rhs = s.clone().multiplyScalar(LAMBDA);
        for (const f of faces) {
          // Best-fit plane of this face's other vertices (Newell normal + centroid).
          const nrm = new Vector3();
          const c = new Vector3();
          let cnt = 0;
          const others = f.filter((v) => v !== q.index); // keeps cyclic order
          for (let i = 0; i < others.length; i++) {
            const a = posOf(others[i]);
            const b = posOf(others[(i + 1) % others.length]);
            nrm.x += (a.y - b.y) * (a.z + b.z);
            nrm.y += (a.z - b.z) * (a.x + b.x);
            nrm.z += (a.x - b.x) * (a.y + b.y);
            c.add(a);
            cnt++;
          }
          if (nrm.lengthSq() < 1e-20 || cnt === 0) continue;
          nrm.normalize();
          c.multiplyScalar(1 / cnt);
          const d = nrm.dot(c);
          m00 += nrm.x * nrm.x; m01 += nrm.x * nrm.y; m02 += nrm.x * nrm.z;
          m11 += nrm.y * nrm.y; m12 += nrm.y * nrm.z; m22 += nrm.z * nrm.z;
          rhs.addScaledVector(nrm, d);
        }
        // Solve the SPD 3×3 (always invertible, given the λI). Matrix3.set is row-major.
        const inv = new Matrix3().set(m00, m01, m02, m01, m11, m12, m02, m12, m22).invert();
        cur.set(q.index, rhs.clone().applyMatrix3(inv));
      }
    }

    // Split each solved target back into slide (in-plane) + lift (along the face normal).
    for (const q of qverts) {
      const target = cur.get(q.index)!;
      const nrm = qNormal.get(q.index)!;
      const disp = target.clone().sub(q.start);
      const liftMag = disp.dot(nrm);
      q.liftFull = nrm.clone().multiplyScalar(liftMag);
      q.slideFull = disp.sub(q.liftFull); // in-plane remainder
    }
  }

  const variants = ([0, 1] as const).map((startColor) => buildVariant(startColor));

  function weldedFaces(faces: number[][], faceColorsIn: GeomColor[]): { faces: number[][]; faceColors: GeomColor[] } {
    const occ = new Map<string, Array<{ fi: number; i: number }>>();
    for (let fi = 0; fi < faces.length; fi++) {
      const loop = faces[fi];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (a < V && b < V && dissolve.has(edgeKey(a, b))) {
          (occ.get(edgeKey(a, b)) ?? occ.set(edgeKey(a, b), []).get(edgeKey(a, b))!).push({ fi, i });
        }
      }
    }
    const consumed = new Set<number>();
    const out: number[][] = [];
    const outColors: GeomColor[] = [];
    for (const list of occ.values()) {
      if (list.length !== 2) continue;
      const [F, G] = list;
      consumed.add(F.fi);
      consumed.add(G.fi);
      const lf = faces[F.fi];
      const lg = faces[G.fi];
      const a = lf[F.i];
      const b = lf[(F.i + 1) % lf.length];
      const fRest: number[] = [];
      for (let k = 2; k < lf.length; k++) fRest.push(lf[(F.i + k) % lf.length]);
      const gRest: number[] = [];
      for (let k = 2; k < lg.length; k++) gRest.push(lg[(G.i + k) % lg.length]);
      out.push([a, ...gRest, b, ...fRest]);
      // Both halves were colored from the shared join edge they weld across (see
      // gyroFaceColor), so they already agree on the merged face's color.
      outColors.push(faceColorsIn[F.fi]);
    }
    for (let fi = 0; fi < faces.length; fi++) {
      if (!consumed.has(fi)) {
        out.push(faces[fi].slice());
        outColors.push(faceColorsIn[fi]);
      }
    }
    return { faces: out, faceColors: outColors };
  }

  /**
   * Truncate the join apexes of one gyro variant: the whirl (see `buildGyro`'s
   * `apexStart`).
   *
   * A join is bipartite, so an apex's neighbours are exactly the vertices of the face it
   * was collapsed from, and every join edge carries exactly one q vertex — so an apex of
   * degree n has n spokes in the gyro, one per corner of its original face. Cutting each
   * spoke turns the apex into an n-gon and grows each incident gyro pentagon into a
   * hexagon (a pentagon has exactly one apex corner, since apexes contribute 2E corners
   * across 2E pentagons).
   *
   * Each cut rides out along its spoke, reaching the q itself at the full twist, where it
   * welds into it: that weld is the propellor (see `propellorFrom`). Cutting along the
   * spoke (rather than straight back down the join edge toward the original vertex, where
   * the chamfer's inset seam would have sat) is what keeps the hexagons flat: the two cuts
   * replacing a pentagon's apex corner land on that pentagon's own two edges, so the
   * hexagon is exactly as planar as the pentagon gyro already worked to flatten. The n-gon
   * is planar in turn because an apex's spokes are symmetric about it, so equal fractions
   * along them ring it evenly.
   *
   * Built on the *welded* gyro faces rather than the split halves: the halves' shared
   * join edges dissolve anyway (the drag hides them), and a corner's two cuts are only
   * well-defined once its neighbours in the loop are its real gyro neighbours (the q's).
   */
  function buildWhirlData(va: ReturnType<typeof buildVariant>): WhirlData {
    // The single q sitting on each join edge, so an apex can find its spokes.
    const qOnEdge = new Map<string, number>();
    for (const [q, [a, b]] of va.qSourceEdge) qOnEdge.set(edgeKey(a, b), q);

    // The apexes are cut away; everything else keeps its identity, re-indexed.
    const remap: number[] = new Array(va.vertexCount).fill(-1);
    let n = 0;
    for (let i = 0; i < va.vertexCount; i++) if (!isApex(i)) remap[i] = n++;

    // One cut vertex per (apex, spoke). `outgoingHalfEdges` walks the apex's join edges
    // in cyclic order, which is also the cyclic order of its spokes in the gyro (the two
    // gyro faces meeting at a spoke weld across the join edges flanking it), so the ring
    // is the n-gon's loop, wound outward exactly as truncate winds an exposed n-gon.
    const cuts: WhirlData["cuts"] = [];
    const cutOf = new Map<string, number>(); // `${apex}_${q}` → whirl vertex index
    const rings = new Map<number, number[]>(); // apex → its cut ring
    for (const v of dcel.vertices) {
      if (!isApex(v.id)) continue;
      const ring: number[] = [];
      for (const h of outgoingHalfEdges(v)) {
        const w = h.next.origin;
        const q = qOnEdge.get(edgeKey(v.id, w.id));
        if (q === undefined) throw new Error(`whirl: join edge ${v.id}-${w.id} carries no q vertex`);
        const index = n++;
        cutOf.set(`${v.id}_${q}`, index);
        cuts.push({ index, apex: v.id, q });
        ring.push(index);
      }
      rings.set(v.id, ring);
    }

    // Edges: an apex→q spoke survives as its cut→q remnant, keeping the gyro edge's
    // color (as truncate keeps an edge remnant's color); everything else is re-keyed.
    // The dissolved join edges are dropped, as gyro's own commit drops them.
    const gyroEdge = new Map(va.edgeColor);
    for (const [a, b] of dissolveList) gyroEdge.delete(edgeKey(a, b));
    const edgeColor = new Map<string, GeomColor>();
    for (const [key, c] of gyroEdge) {
      const [a, b] = key.split("_").map(Number);
      const apex = isApex(a) ? a : isApex(b) ? b : -1;
      if (apex < 0) {
        if (remap[a] >= 0 && remap[b] >= 0) edgeColor.set(edgeKey(remap[a], remap[b]), c);
        continue;
      }
      const q = apex === a ? b : a;
      edgeColor.set(edgeKey(cutOf.get(`${apex}_${q}`)!, remap[q]), c);
    }

    // Vertices: kept ones carry over; each cut takes the apex it was cut off from (whose
    // color is its original face's) and the spoke it slid along.
    const vertexColor: GeomColor[] = new Array(n);
    for (let i = 0; i < va.vertexCount; i++) {
      if (remap[i] >= 0) vertexColor[remap[i]] = va.vertexColor[i];
    }
    for (const v of dcel.vertices) {
      if (!isApex(v.id)) continue;
      for (const h of outgoingHalfEdges(v)) {
        const q = qOnEdge.get(edgeKey(v.id, h.next.origin.id))!;
        vertexColor[cutOf.get(`${v.id}_${q}`)!] = combine(C.truncate.newVertex, {
          oldVertex: va.vertexColor[v.id],
          oldEdge: gyroEdge.get(edgeKey(v.id, q)) ?? BLACK,
        }, "truncate.newVertex");
      }
    }

    // Faces: every gyro face's apex corner becomes its two cuts (pentagon → hexagon),
    // and each apex contributes its new n-gon.
    const welded = weldedFaces(va.previewFaces, va.faceColor);
    const weldedStart = weldedFaces(va.previewFaces, va.faceStart).faceColors;
    const faces: number[][] = [];
    const faceColor: GeomColor[] = [];
    const faceStart: GeomColor[] = [];
    for (let fi = 0; fi < welded.faces.length; fi++) {
      const loop = welded.faces[fi];
      const out: number[] = [];
      for (let i = 0; i < loop.length; i++) {
        const c = loop[i];
        if (!isApex(c)) {
          out.push(remap[c]);
          continue;
        }
        const cIn = cutOf.get(`${c}_${loop[(i - 1 + loop.length) % loop.length]}`)!;
        const cOut = cutOf.get(`${c}_${loop[(i + 1) % loop.length]}`)!;
        out.push(cIn, cOut);
        // (cIn, cOut) is both an edge of this face and one of the new n-gon's sides — an
        // n-gon perimeter edge, taking the apex and the face it borders.
        edgeColor.set(edgeKey(cIn, cOut), combine(C.truncate.newEdge, {
          oldVertex: va.vertexColor[c],
          oldFace: welded.faceColors[fi],
        }, "truncate.newEdge"));
      }
      faces.push(out);
      faceColor.push(welded.faceColors[fi]);
      faceStart.push(weldedStart[fi]);
    }
    const keptFaceStart = faces.length; // the apex rings (X's faces) follow
    for (const [apex, ring] of rings) {
      faces.push(ring.slice());
      // The n-gon takes the apex's own color, which is the color of the original face it
      // was collapsed from — so the face it re-opens into is the face it was.
      const c = combine(C.truncate.newFace, { oldVertex: va.vertexColor[apex] }, "truncate.newFace");
      faceColor.push(c);
      faceStart.push(c); // it grows out of the apex, so it never changes color
    }

    // The propellor weld: every cut runs out into its q. The cuts were indexed last, so
    // the survivors are the leading block and the map only has to redirect the tail.
    const weldCount = n - cuts.length;
    const weldMap: number[] = new Array(n);
    for (let i = 0; i < weldCount; i++) weldMap[i] = i;
    const spokes: Array<[number, number]> = [];
    for (const c of cuts) {
      weldMap[c.index] = remap[c.q];
      spokes.push([c.index, remap[c.q]]);
    }

    return {
      vertexCount: n, remap, cuts, faces, faceColor, faceStart, keptFaceStart, vertexColor,
      edgeColor, spokes, weldCount, weldMap,
    };
  }

  /**
   * Propellor: the whirl at its limit, where every cut has ridden the whole way out along
   * its spoke and coincides with the q there.
   *
   * Welding the two together costs each hexagon its two cut corners — the apex corner the
   * whirl opened up closes again, but onto the q's rather than back onto the apex — so the
   * hexagons become quads, while each apex's n-gon is left ringed by the q's its cuts slid
   * onto. That is Conway's propellor: the original faces, plus two quads per edge.
   *
   * The topology comes straight from the weld (a cut merging into its q leaves the q; the
   * hexagons lose their two cut corners to become quads; the n-gons stay). Coloring is then
   * handed to `recolorPropellor`, so a propellor reached this way (off X's join) comes out
   * identical to one reached as a volute (off X's rectification): X's own faces are the
   * apex rings (indices ≥ `keptFaceStart`), X's own vertices are the join's original
   * vertices (the leading `apexStart` indices, unmoved by the whirl), and every new element
   * is recolored from those.
   */
  function propellorFrom(w: WhirlData): {
    faces: number[][];
    faceColor: GeomColor[];
    vertexColor: GeomColor[];
    edgeColor: Map<string, GeomColor>;
  } {
    const faces: number[][] = [];
    for (const loop of w.faces) {
      const out: number[] = [];
      for (const v of loop) {
        const m = w.weldMap[v];
        if (out.length && out[out.length - 1] === m) continue; // the corner just closed
        out.push(m);
      }
      if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
      faces.push(out);
    }
    const edgeColor = new Map<string, GeomColor>();
    for (const [key, c] of w.edgeColor) {
      const [a, b] = key.split("_").map(Number);
      const [x, y] = [w.weldMap[a], w.weldMap[b]];
      if (x === y) continue; // a spoke, run out to zero length
      edgeColor.set(edgeKey(x, y), c);
    }
    const keptFaceIds = new Set<number>();
    for (let fi = w.keptFaceStart; fi < faces.length; fi++) keptFaceIds.add(fi);
    // X's vertices are the join's original vertices: indices [0, apexStart), which the whirl
    // leaves in place (only the apexes were cut, and they sit after them).
    const keptVertIds = new Set<number>();
    for (let i = 0; apexStart !== null && i < apexStart; i++) keptVertIds.add(i);
    const recolored = recolorPropellor(
      faces,
      { vertex: w.vertexColor.slice(0, w.weldCount), face: w.faceColor.slice(), edge: edgeColor },
      keptFaceIds,
      keptVertIds,
    );
    return { faces, faceColor: recolored.face, vertexColor: recolored.vertex, edgeColor: recolored.edge };
  }

  // The whirl overlay of each chirality (null for a plain gyro), and the propellor each
  // welds into — precomputed so the live preview's t=1 end and the committed weld read from
  // the one recolored source (its faces align 1:1 with the whirl's, by index).
  const whirls = apexStart === null ? null : variants.map(buildWhirlData);
  const propellors = whirls ? whirls.map(propellorFrom) : null;

  // ---- Handle: a rotation arc about the join apex the drag ended on.
  //
  // The apex vertex stays put, but its edges to the new midpoint vertices (the q's, the
  // only real edges of the gyro) rotate about it as the gyro forms, and that rotation is
  // the gyro's twist. The handle is a circular arc swept about the apex through the same
  // angle (see `arcSpan`), so riding it out to its limit carries those edges to the
  // finished gyro. It extends ±arcSpan about its midpoint, so dragging across the middle
  // chooses the chirality and either gyro is reachable; the midpoint (zero twist) is the
  // join rest the cursor snaps back onto.
  //
  // The gyro and the whirl place the arc the same way — the frame below is all either
  // needs, and neither reads the drag it extends.
  let apexVid = 0;
  let bestD = Infinity;
  for (const v of dcel.vertices) {
    const d = v.position.distanceTo(apexPos);
    if (d < bestD) { bestD = d; apexVid = v.id; }
  }
  const apex = dcel.vertices[apexVid].position.clone();
  const apexNormal = apex.clone().normalize(); // outward (solid centred at the origin)
  // Component of `v` in the plane through the apex normal to `axis`.
  const tangentTo = (v: Vector3, axis: Vector3) =>
    v.clone().addScaledVector(axis, -v.dot(axis));
  // Signed angle (about `axis`) rotating `from` onto `to`.
  const signedAngle = (from: Vector3, to: Vector3, axis: Vector3) =>
    Math.atan2(axis.dot(new Vector3().crossVectors(from, to)), from.dot(to));

  // The apex's spokes — used to size the arc (its radius is a fraction of the mean spoke
  // length), to count the original face's sides, and as a fallback reference direction.
  const spokeVecs = outgoingHalfEdges(dcel.vertices[apexVid])
    .map((h) => h.next.origin.position.clone().sub(apex))
    .filter((r) => r.lengthSq() > 1e-10);
  const n = Math.max(1, spokeVecs.length); // = sides of the original face

  // The arc's plane, and the direction its midpoint (zero twist) sits in.
  //
  // The apex's spokes turn about the apex normal as the gyro forms, so the arc lies in the
  // apex's tangent plane — the plane that rotation actually happens in. Its midpoint faces
  // away from the camera, so the arc always presents its full width rather than
  // foreshortening to a sliver the cursor jumps across.
  const arcAxis = apexNormal.clone();
  let refDir = tangentTo(cameraPos ? apex.clone().sub(cameraPos) : new Vector3(), arcAxis);
  // Falls back to a spoke when that direction is degenerate: the camera looking straight
  // down the apex normal, or no camera at all (e.g. in tests).
  if (refDir.lengthSq() < 1e-10)
    refDir = tangentTo(spokeVecs[0] ?? new Vector3(1, 0, 0), arcAxis);
  if (refDir.lengthSq() < 1e-10) refDir = new Vector3(1, 0, 0);

  const inPlane = spokeVecs
    .map((r) => tangentTo(r, arcAxis))
    .filter((r) => r.lengthSq() > 1e-10);
  const lengths = inPlane.length ? inPlane : spokeVecs;
  const arcRadius =
    (lengths.reduce((s, r) => s + r.length(), 0) / Math.max(1, lengths.length)) *
    config.operations.gyroArcRadiusFraction;
  const radius = refDir.normalize().multiplyScalar(arcRadius); // midpoint offset from apex

  // Each direction reaches this far: 360/(divisor·n) degrees (short of 360/(2n), a 2nd
  // join). The two directions are the two chiralities.
  const arcSpan = (2 * Math.PI) / (config.operations.twistArcDivisor * n);
  // Dead-zone at the midpoint: within it the cursor snaps to the plain join (zero twist),
  // so the handle rests at the join the way snub's rests at the rectify.
  const REST_T = 0.06;

  // Live twist state. `sign` is which way along the arc (chirality); `curT` is the
  // fraction of arcSpan reached.
  let curT = 0;
  let sign = 1;
  const variantIndex = () => (sign >= 0 ? 0 : 1);

  // Each new vertex moves from its edge midpoint by an in-plane slide toward the opposite
  // edge and an outward lift off the join face. Driving both on the same fraction `t` (a
  // straight line to the target) is planar only at t=1; in between, the two half-quads
  // of each split face fold along the old edge and crease. Running the lift ahead of the
  // slide (`t^liftExp`, exponent < 1 for sharp joins) flattens the fold continuously, so
  // the faces stay approximately planar all through the drag (see liftExponent).
  function gyroPositions(t: number): Vector3[] {
    const va = variants[variantIndex()];
    const out: Vector3[] = new Array(va.vertexCount);
    for (let i = 0; i < V; i++) out[i] = dcel.vertices[i].position.clone();
    for (const q of va.qverts) {
      out[q.index] = q.start.clone()
        .addScaledVector(q.slideFull, t)
        .addScaledVector(q.liftFull, t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, q.liftExp));
    }
    return out;
  }

  /** Whirl: the gyro's positions with each apex cut away, replaced by the ring of cuts
   *  riding out along its spokes (the apex itself never moves), so the face it was
   *  collapsed from re-opens in step with the twist. The cut rides the same `t` as the
   *  twist, so it arrives on its q exactly as the gyro finishes: the propellor weld. */
  function positions(t: number): Vector3[] {
    const g = gyroPositions(t);
    const w = whirls?.[variantIndex()];
    if (!w) return g;
    const out: Vector3[] = new Array(w.vertexCount);
    for (let i = 0; i < g.length; i++) if (w.remap[i] >= 0) out[w.remap[i]] = g[i];
    for (const c of w.cuts) out[c.index] = g[c.apex].clone().lerp(g[c.q], t);
    return out;
  }

  function previewFaceColors(t: number, weld?: boolean): Color[] {
    const w = whirls?.[variantIndex()];
    // A gyro ends at the full gyro, so its faces simply fade from the join's colors into
    // the gyro's across the drag.
    if (!w) {
      const va = variants[variantIndex()];
      return lerpFaceColors(va.faceStart, va.faceColor, t);
    }
    // A whirl runs between two welds, so it reads like a base drag: the join at t=0, the
    // whirl's own colors at t=0.5 (the shape an intermediate release commits), and the
    // propellor at t=1. Losing its two cut corners keeps a hexagon the same face, but the
    // weld recolors it (recolorPropellor), so the second half fades into the propellor's
    // colors — the same ones commit lands on.
    return stagedFaceColors(w.faceStart, w.faceColor, propellors![variantIndex()].faceColor, t, weld);
  }

  // Where the arc's swept tip sits at signed twist `sg·t` (t=0 at the midpoint).
  function ridePoint(sg: number, t: number): Vector3 {
    return radius.clone().applyAxisAngle(arcAxis, sg * arcSpan * t).add(apex);
  }

  // Intersect the cursor ray with the arc's plane. The twist is the hit's angle relative to
  // the arc midpoint, clamped to ±arcSpan, its sign the chirality, scaled by how far out the
  // cursor is (its radial distance vs the arc radius). So the snap interpolates from the
  // arc's midpoint (the join rest point, when the cursor is at the apex centre) out to the
  // true angular position as the cursor reaches the arc, which keeps the marker from leaping
  // to an arc end while the cursor still climbs from the join up to the arc. Near the
  // midpoint the dead-zone snaps it to the plain join.
  function snap(ray: Ray): { t: number; point: Vector3 } {
    const denom = ray.direction.dot(arcAxis);
    if (Math.abs(denom) >= 1e-6) {
      const s = apex.clone().sub(ray.origin).dot(arcAxis) / denom;
      const hit = tangentTo(ray.origin.clone().addScaledVector(ray.direction, s).sub(apex), arcAxis);
      const d = hit.length();
      if (d > 1e-9) {
        const ang = signedAngle(radius, hit, arcAxis);
        sign = ang >= 0 ? 1 : -1;
        const reach = Math.min(1, d / arcRadius); // 0 at the apex centre, 1 at the arc
        const t = reach * Math.min(1, Math.abs(ang) / arcSpan);
        curT = t < REST_T ? 0 : t;
      }
    }
    return { t: curT, point: ridePoint(sign, curT) };
  }

  function arc(): TwistArc {
    return {
      center: apex.clone(),
      ref: radius.clone().add(apex),
      ride: ridePoint(sign, curT),
      axis: arcAxis.clone(),
      halfSweepRad: arcSpan,
    };
  }

  function commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet } {
    const w = whirls?.[variantIndex()];
    if (w) {
      // The whirl is already built on the welded gyro faces, so a plain commit takes its
      // topology as it stands. At the twist's own weld the cuts have reached their q's, so
      // there is one weld left to do: the propellor.
      if (weld) {
        const p = propellors![variantIndex()];
        return {
          mesh: { vertices: positions(1).slice(0, w.weldCount), faces: p.faces.map((f) => f.slice()) },
          colors: {
            vertex: p.vertexColor.map((c) => c.slice()),
            face: p.faceColor.map((c) => c.slice()),
            edge: new Map(p.edgeColor),
          },
        };
      }
      return {
        mesh: { vertices: positions(t), faces: w.faces.map((f) => f.slice()) },
        colors: { vertex: w.vertexColor.slice(), face: w.faceColor.slice(), edge: new Map(w.edgeColor) },
      };
    }
    const va = variants[variantIndex()];
    const { faces, faceColors } = weldedFaces(va.previewFaces, va.faceColor);
    const edge = new Map(va.edgeColor);
    for (const [a, b] of dissolveList) edge.delete(edgeKey(a, b));
    return { mesh: { vertices: positions(t), faces }, colors: { vertex: va.vertexColor.slice(), face: faceColors, edge } };
  }

  return {
    kind: apexStart === null ? "gyro" : "whirl",
    // The whirl previews the welded gyro faces directly (its apex cuts are only defined
    // there), so it has no split halves to hide seams between.
    get previewFaces() {
      return whirls?.[variantIndex()].faces ?? variants[variantIndex()].previewFaces;
    },
    get previewEdgeColors() {
      return whirls?.[variantIndex()].edgeColor ?? variants[variantIndex()].edgeColor;
    },
    // The gyro previews each join quad as two halves, whose shared join edge is dissolved
    // from the start: never a real edge, so hidden throughout. The whirl's spokes are real
    // edges the whole way and only vanish at the propellor weld.
    get hiddenEdges() { return whirls ? [] : dissolveList; },
    get vanishingEdges() { return whirls?.[variantIndex()].spokes ?? []; },
    positions,
    previewFaceColors,
    snap,
    commit,
    arc,
    chirality: () => (variantIndex() === 0 ? "R" : "L"),
    // Test-only: the current variant's q-vertex motion decomposition, so a test can
    // rebuild positions for an arbitrary (slide, lift) pair and probe face planarity.
    _qData: () => variants[variantIndex()].qverts.map((q) => ({
      index: q.index,
      start: q.start.clone(),
      slideFull: q.slideFull.clone(),
      liftFull: q.liftFull.clone(),
      liftExp: q.liftExp,
      dihedral: q.dihedral,
    })),
  } as MorphPlan & {
    _qData(): Array<{ index: number; start: Vector3; slideFull: Vector3; liftFull: Vector3; liftExp: number; dihedral: number }>;
  };
}

/**
 * Whirl as a twist extension of a chamfer, the way gyro extends a kis.
 *
 * A chamfer welds into the join by collapsing each face onto its apex, so the whirl is
 * the gyro of that join with those apexes truncated straight back into the faces they
 * came from: the gyro's pentagons become hexagons and each apex re-opens into its
 * original n-gon (cube → 6 squares + 24 hexagons). Everything else — the twist, its two
 * chiralities, the arc handle at the apex the chamfer drag ended on — is the gyro's,
 * unchanged; only the apex faces are new.
 *
 * @param poly      the join (as the chamfer's weld produced it): original vertices first,
 *                  then one apex per original face, which is what `apexStart` splits.
 * @param apexStart the index of the first apex vertex = the original solid's vertex count
 * @param cameraPos where the arc handle faces away from, exactly as the gyro's does: the
 *                  two drags reach the same apex, so they get the same handle there.
 */
export function buildWhirl(
  poly: Polyhedron,
  apexStart: number,
  apexPos: Vector3,
  cameraPos: Vector3 | null = null,
  inView: InViewTest | null = null,
): MorphPlan {
  return buildGyro(poly, -1, apexPos, cameraPos, inView, apexStart);
}
