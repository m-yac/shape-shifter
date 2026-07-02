import { Vector3, Ray, Color } from "three";
import {
  type Mesh,
  type DCEL,
  type HEFace,
  type HalfEdge,
  outgoingHalfEdges,
} from "../geometry/HalfEdge";
import { type Polyhedron, faceNormalHE, faceCentroidHE } from "../geometry/polyhedron";
import { type ColorSet, edgeKey } from "../geometry/colors";
import { type MorphPlan, type TwistArc } from "./types";
import { type InViewTest } from "./truncate";
import { faceMax, faceMaxPlus1, lerpFaceColors } from "./colorUtil";
import { config } from "../config";

// At the full gyro each new edge-midpoint vertex slides `gyroFaceSlide` of the way
// along the line joining the midpoints of its quad's two opposite edges, and lifts
// outward off the face. The lift is NOT a fixed fraction of the edge: it scales with
// cot(dihedral/2) of the join edge the vertex sits over, so a sharp join folds up much
// more than a nearly-flat one — see config.operations.gyroLiftFactor.
const FACE_SLIDE = config.operations.gyroFaceSlide;

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

/** One peripheral (q) vertex of a gyred face: its new index, the boundary edge it
 *  sits over (two original vertex ids), and the pivot it swings around. */
interface QVert {
  index: number;
  start: Vector3; // the edge midpoint (t=0)
  target: Vector3; // where it slides to at the full gyro (t=1), along the opposite-edge line
}

/**
 * Gyro as a twist extension of a JOIN. Given the join `poly` (all quad faces), each
 * original vertex — together with the inner halves of its edges — rotates about its
 * radial axis; a new vertex appears at every edge midpoint and each quad splits into
 * two, producing the gyro (the dual of snub). The topology (tiling + weld across
 * every join edge) is exactly the classic gyro, so it is independent of the
 * intermediate rotation, which the post-release relaxer regularizes.
 *
 * `apexPos` (the join apex the base drag ended on, passed by the controller) selects
 * the local neighbourhood the arc is drawn in.
 */
export function buildGyro(
  poly: Polyhedron,
  _draggedFid: number,
  apexPos: Vector3,
  cameraPos: Vector3 | null = null,
  _inView: InViewTest | null = null,
): MorphPlan {
  const dcel = poly.dcel;
  const V = dcel.vertices.length;
  const old = poly.colors;
  const color = twoColorVertices(dcel);

  function buildVariant(startColor: 0 | 1): {
    previewFaces: number[][];
    vertexCount: number;
    vertexColor: number[];
    faceColor: number[];
    faceStart: number[];
    edgeColor: Map<string, number>;
    qverts: QVert[];
  } {
    const previewFaces: number[][] = [];
    const faceColor: number[] = [];
    const faceStart: number[] = [];
    const vertexColor: number[] = [];
    for (let i = 0; i < V; i++) vertexColor[i] = old.vertex[i];
    const ownerFace = new Map<number, number>();
    const centerEdges = new Map<string, number>();
    const qverts: QVert[] = [];
    let idx = V;

    for (const f of dcel.faces) {
      const bh = faceHalfEdges(f);
      const m = bh.length; // = 4 for a join
      const n = m / 2;

      let s = 0;
      for (let i = 0; i < m; i++) if (color.get(bh[i].origin.id) === startColor) { s = i; break; }
      const P: number[] = [];
      for (let i = 0; i < m; i++) P.push(bh[(s + i) % m].origin.id);

      const cf = faceMax(f, old);
      const hasCenter = n >= 3;
      const center = hasCenter ? idx++ : -1;
      if (hasCenter) {
        vertexColor[center] = old.face[f.id];
        ownerFace.set(center, f.id);
      }
      // Outward normal of this quad — the lift direction, shared by both its q's so
      // the raise has NO in-plane component (a per-vertex radial axis would tilt the
      // two q's toward opposite corners, which reads as an unwanted twist).
      const faceNormal = faceNormalHE(f);
      if (faceNormal.dot(faceCentroidHE(f)) < 0) faceNormal.negate();
      const qIdx: number[] = [];
      const spokeColor = cf + 3;
      for (let j = 0; j < n; j++) {
        const q = idx++;
        qIdx.push(q);
        // q_j sits at the midpoint of boundary edge (P[2j-1], P[2j]). Projected onto
        // the quad it slides straight along the line joining that midpoint to the
        // midpoint of the OPPOSITE edge (P[2j+1], P[2j+2]), and lifts outward along the
        // face normal. The chirality lives entirely in the topology (which opposite-
        // edge pair each variant's 2-colouring picks), so this motion is a clean
        // straight slide with no in-plane rotation; the relaxer then settles the
        // pentagons into the true gyro.
        const a = dcel.vertices[P[(2 * j - 1 + m) % m]].position;
        const pivot = dcel.vertices[P[2 * j]].position;
        const oppA = dcel.vertices[P[(2 * j + 1) % m]].position;
        const oppB = dcel.vertices[P[(2 * j + 2) % m]].position;
        const mid = a.clone().add(pivot).multiplyScalar(0.5);
        const oppMid = oppA.clone().add(oppB).multiplyScalar(0.5);
        const v0 = mid.clone().sub(pivot);
        // Lift height: cot(dihedral/2)·|v0| of the join edge (a,pivot) this q sits over,
        // scaled by gyroLiftFactor. The dihedral comes from the two join faces meeting
        // along that edge — the sharper the valley, the more the q rises to fold the
        // quads into a flat pentagon. (cot = cos/sin; near-flat edges → tiny lift.)
        const boundary = bh[(s + ((2 * j - 1 + m) % m)) % m];
        const cotHalf = cotHalfDihedral(boundary, faceNormal);
        const target = mid.clone()
          .addScaledVector(oppMid.clone().sub(mid), FACE_SLIDE)
          .addScaledVector(faceNormal, config.operations.gyroLiftFactor * cotHalf * v0.length());
        qverts.push({ index: q, start: mid.clone(), target });
        vertexColor[q] = cf + 2;
        ownerFace.set(q, f.id);
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
        faceColor.push(old.edge.get(edgeKey(P[2 * j], P[2 * j + 1])) ?? 0);
        faceStart.push(old.face[f.id]);
        previewFaces.push([qIdx[(j + 1) % n], P[2 * j + 1], P[(2 * j + 2) % m]]);
        faceColor.push(old.edge.get(edgeKey(P[2 * j + 1], P[(2 * j + 2) % m])) ?? 0);
        faceStart.push(old.face[f.id]);
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
        const fid = ownerFace.get(a) ?? ownerFace.get(b);
        if (fid !== undefined) edgeColor.set(key, faceMaxPlus1(dcel.faces[fid], old));
      }
    }

    return { previewFaces, vertexCount: idx, vertexColor, faceColor, faceStart, edgeColor, qverts };
  }

  const variants = ([0, 1] as const).map((startColor) => buildVariant(startColor));

  // Welded max: dissolve every original edge (shared by two faces of the join).
  const dissolve = new Set<string>();
  const dissolveList: Array<[number, number]> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    dissolve.add(edgeKey(he.origin.id, he.next.origin.id));
    dissolveList.push([he.origin.id, he.next.origin.id]);
  }

  function weldedFaces(faces: number[][], faceColorsIn: number[]): { faces: number[][]; faceColors: number[] } {
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
    const outColors: number[] = [];
    for (const [key, list] of occ) {
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
      const [sa, sb] = key.split("_").map(Number);
      outColors.push(old.edge.get(edgeKey(sa, sb)) ?? 0);
    }
    for (let fi = 0; fi < faces.length; fi++) {
      if (!consumed.has(fi)) {
        out.push(faces[fi].slice());
        outColors.push(faceColorsIn[fi]);
      }
    }
    return { faces: out, faceColors: outColors };
  }

  // ---- Handle: a single ROTATION arc in the tangent plane of the join apex the drag
  // ended on. The apex vertex itself stays put, but its edges to the new midpoint
  // vertices (the q's — the only real edges of the gyro) rotate about it as the gyro
  // forms, and THAT rotation is the gyro's twist. The handle is a circular arc swept
  // about the apex through the same angle (see `arcSpan`), so riding it out to its limit
  // carries those edges to the finished gyro. The arc sits on the side of the apex
  // facing AWAY from the camera (rather than on a particular spoke, whose post-join
  // angle is often shallow and reads as a foreshortened sliver that the cursor jumps
  // across), so it always presents its full width. It extends ±arcSpan about its
  // midpoint; dragging across the middle chooses the chirality, so either gyro is
  // reachable, and the midpoint (zero twist) is the join rest point the cursor snaps
  // back onto.
  let apexVid = 0;
  let bestD = Infinity;
  for (const v of dcel.vertices) {
    const d = v.position.distanceTo(apexPos);
    if (d < bestD) { bestD = d; apexVid = v.id; }
  }
  const apex = dcel.vertices[apexVid].position.clone();
  const apexNormal = apex.clone().normalize(); // outward (solid centred at the origin)
  // Component of `v` in the apex tangent plane (the plane the arc lives in).
  const tangent = (v: Vector3) => v.clone().addScaledVector(apexNormal, -v.dot(apexNormal));
  // Signed angle (about `axis`) rotating `from` onto `to`.
  const signedAngle = (from: Vector3, to: Vector3, axis: Vector3) =>
    Math.atan2(axis.dot(new Vector3().crossVectors(from, to)), from.dot(to));

  // The apex's spokes in its tangent plane — used only to size the arc (its radius is a
  // fraction of the mean spoke length) and as a fallback reference direction.
  const spokes = outgoingHalfEdges(dcel.vertices[apexVid])
    .map((h) => tangent(h.next.origin.position.clone().sub(apex)))
    .filter((r) => r.lengthSq() > 1e-10);
  const n = Math.max(1, spokes.length); // = sides of the original face
  const arcRadius =
    (spokes.reduce((s, r) => s + r.length(), 0) / n) * config.operations.gyroArcRadiusFraction;

  // The arc's midpoint direction: straight away from the camera in the tangent plane
  // (apex − cameraPos, projected), so the arc never foreshortens. Falls back to a spoke
  // when the camera looks down the apex normal or isn't supplied (e.g. in tests).
  let refDir = cameraPos ? tangent(apex.clone().sub(cameraPos)) : new Vector3();
  if (refDir.lengthSq() < 1e-10) refDir = (spokes[0] ?? new Vector3(1, 0, 0)).clone();
  const radius = refDir.normalize().multiplyScalar(arcRadius); // midpoint offset from apex

  // Each direction reaches this far: 360/(divisor·n) degrees (short of 360/(2n), a 2nd
  // join). The two directions are the two chiralities.
  const arcSpan = (2 * Math.PI) / (config.operations.twistArcDivisor * n);
  // A small dead-zone at the midpoint: within it the cursor snaps to the plain join
  // (zero twist), so the handle "rests" at the join the way snub rests at the rectify.
  const REST_T = 0.06;

  // Live twist state. `sign` is which way along the arc (chirality); `curT` is the
  // fraction of arcSpan reached.
  let curT = 0;
  let sign = 1;
  const variantIndex = () => (sign >= 0 ? 0 : 1);

  // Each new vertex slides in a straight line from its edge midpoint to its target,
  // so the split faces open the way the gyro tiling expects.
  function positions(t: number): Vector3[] {
    const va = variants[variantIndex()];
    const out: Vector3[] = new Array(va.vertexCount);
    for (let i = 0; i < V; i++) out[i] = dcel.vertices[i].position.clone();
    for (const q of va.qverts) out[q.index] = q.start.clone().lerp(q.target, t);
    return out;
  }

  function previewFaceColors(t: number): Color[] {
    const va = variants[variantIndex()];
    return lerpFaceColors(va.faceStart, va.faceColor, t);
  }

  // Where the arc's swept tip sits at signed twist `sg·t` (t=0 at the midpoint).
  function ridePoint(sg: number, t: number): Vector3 {
    return radius.clone().applyAxisAngle(apexNormal, sg * arcSpan * t).add(apex);
  }

  // Intersect the cursor ray with the apex tangent plane. The twist is the hit's angle
  // relative to the arc midpoint (clamped to ±arcSpan; its sign is the chirality) —
  // but SCALED by how far OUT the cursor is (its radial distance vs the arc radius), so
  // the effective snap interpolates from the arc's midpoint (the join rest point, when
  // the cursor is at the apex centre) out to the true angular position as the cursor
  // reaches the arc. This keeps the marker from leaping to an arc end while the cursor
  // is still climbing from the join up to the arc. A small dead-zone snaps it to the
  // plain join (zero twist) near the midpoint.
  function snap(ray: Ray): { t: number; point: Vector3 } {
    const denom = ray.direction.dot(apexNormal);
    if (Math.abs(denom) >= 1e-6) {
      const s = apex.clone().sub(ray.origin).dot(apexNormal) / denom;
      const hit = tangent(ray.origin.clone().addScaledVector(ray.direction, s));
      const d = hit.length();
      if (d > 1e-9) {
        const ang = signedAngle(radius, hit, apexNormal);
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
      axis: apexNormal.clone(),
      halfSweepRad: arcSpan,
    };
  }

  function commit(t: number, _weld: boolean): { mesh: Mesh; colors: ColorSet } {
    const va = variants[variantIndex()];
    const { faces, faceColors } = weldedFaces(va.previewFaces, va.faceColor);
    const edge = new Map(va.edgeColor);
    for (const [a, b] of dissolveList) edge.delete(edgeKey(a, b));
    return { mesh: { vertices: positions(t), faces }, colors: { vertex: va.vertexColor.slice(), face: faceColors, edge } };
  }

  return {
    kind: "gyro",
    get previewFaces() { return variants[variantIndex()].previewFaces; },
    get previewEdgeColors() { return variants[variantIndex()].edgeColor; },
    get vanishingEdges() { return dissolveList; },
    positions,
    previewFaceColors,
    snap,
    commit,
    arc,
    chirality: () => (variantIndex() === 0 ? "R" : "L"),
  };
}
