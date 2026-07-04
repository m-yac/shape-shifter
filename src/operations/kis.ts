import { Vector3, Ray, Color } from "three";
import { type Mesh, type HEFace } from "../geometry/HalfEdge";
import { type Polyhedron } from "../geometry/polyhedron";
import { faceCentroidHE, faceNormalHE } from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey, paletteRGB } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { combine, dualRule } from "./colorUtil";
import { config } from "../config";
import { closestLineParam } from "../util/lines";

const BLACK: GeomColor = [0, 0, 0];

/** Smallest strictly-positive root of A h² + B h + C, or null. */
export function smallestPositiveRoot(A: number, B: number, C: number): number | null {
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) < 1e-12) return null;
    const h = -C / B;
    return h > 1e-9 ? h : null;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const candidates = [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].filter((h) => h > 1e-9);
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * The apex height at which the two pyramid triangles straddling edge (P1,P2)
 * become coplanar (so they merge into one quad — i.e. Join).
 */
export function joinHeight(
  P1: Vector3,
  P2: Vector3,
  cf: Vector3,
  nf: Vector3,
  cg: Vector3,
  ng: Vector3,
): number | null {
  const w = P2.clone().sub(P1);
  const uf = cf.clone().sub(P1);
  const ug = cg.clone().sub(P1);
  const A = nf.dot(new Vector3().crossVectors(w, ng));
  const B =
    uf.dot(new Vector3().crossVectors(w, ng)) + nf.dot(new Vector3().crossVectors(w, ug));
  const C = uf.dot(new Vector3().crossVectors(w, ug));
  return smallestPositiveRoot(A, B, C);
}

function faceLoop(f: HEFace): number[] {
  const loop: number[] = [];
  let h = f.halfedge;
  const start = h;
  do {
    loop.push(h.origin.id);
    h = h.next;
  } while (h !== start);
  return loop;
}

/**
 * Per-face apex height for a planar-faced Join (the dual of truncate's
 * `computeCollapseFractions`).
 *
 * Kis raises a pyramid of height h_f (along the face normal) on every face; at
 * Join two pyramid triangles straddling a shared edge merge into one quad. That
 * quad `[P1, apex_f, P2, apex_g]` is planar iff P1, P2, apex_f, apex_g are
 * coplanar, i.e. the scalar triple product
 *   R(h_f,h_g) = (apex_f−P1)·((P2−P1)×(apex_g−P1)) = A·h_f·h_g + β·h_f + α·h_g + C
 * vanishes (apex_f = c_f + h_f·n_f). A single per-face height that hits R=0 on
 * *every* incident edge does not exist for a non-canonical solid (each face has
 * one apex but several edges), so — exactly as truncate solves one radial-depth
 * δ per vertex by least squares over the edges — we solve one height h_f per face
 * by least squares over the join quads. For the triakis tetra this is exact.
 *
 * The residual is bilinear in (h_f,h_g), so a per-face update is linear once the
 * neighbours are fixed: with p = A·h_g+β and q = α·h_g+C over f's edges,
 *   h_f = −Σ p·q / Σ p²   (coordinate descent, seeded at the symmetric height).
 */
export function computeJoinHeights(poly: Polyhedron): Map<number, number> {
  const dcel = poly.dcel;
  const cen = new Map<number, Vector3>();
  const nrm = new Map<number, Vector3>();
  for (const f of dcel.faces) {
    cen.set(f.id, faceCentroidHE(f));
    nrm.set(f.id, faceNormalHE(f));
  }

  // Symmetric (h_f = h_g) seed: current behaviour — max join height over edges,
  // fallback to half the centroid→vertex distance for a face with no neighbours.
  const seed = new Map<number, number>();
  for (const f of dcel.faces) {
    let h = 0;
    let he = f.halfedge;
    const start = he;
    do {
      const g = he.twin!.face;
      const solved = joinHeight(
        he.origin.position, he.next.origin.position,
        cen.get(f.id)!, nrm.get(f.id)!, cen.get(g.id)!, nrm.get(g.id)!,
      );
      if (solved && solved > 1e-6) h = Math.max(h, solved);
      he = he.next;
    } while (he !== start);
    if (h <= 1e-6) h = 0.5 * cen.get(f.id)!.distanceTo(f.halfedge.origin.position);
    seed.set(f.id, h);
  }

  // Per-face bilinear coefficients of the join-quad residual, variable = h_f.
  type Inc = { A: number; b: number; a: number; C: number; other: number };
  const incident = new Map<number, Inc[]>();
  for (const f of dcel.faces) incident.set(f.id, []);
  for (const he of dcel.halfedges) {
    const f = he.face, g = he.twin!.face;
    const P1 = he.origin.position, w = he.next.origin.position.clone().sub(P1);
    const nf = nrm.get(f.id)!, ng = nrm.get(g.id)!;
    const uf = cen.get(f.id)!.clone().sub(P1), ug = cen.get(g.id)!.clone().sub(P1);
    const wxng = new Vector3().crossVectors(w, ng);
    const wxug = new Vector3().crossVectors(w, ug);
    incident.get(f.id)!.push({
      A: nf.dot(wxng),   // h_f·h_g
      b: nf.dot(wxug),   // h_f
      a: uf.dot(wxng),   // h_g
      C: uf.dot(wxug),   // const
      other: g.id,
    });
  }

  const h = new Map(seed);
  const bound = 4 * Math.max(...seed.values());
  for (let round = 0; round < 400; round++) {
    for (const f of dcel.faces) {
      let num = 0, den = 0;
      for (const e of incident.get(f.id)!) {
        const hg = h.get(e.other)!;
        const p = e.A * hg + e.b, q = e.a * hg + e.C;
        num += p * q;
        den += p * p;
      }
      if (den > 1e-12) h.set(f.id, Math.max(1e-4, Math.min(bound, -num / den)));
    }
  }
  return h;
}

interface KFace {
  id: number;
  centroid: Vector3;
  normal: Vector3;
  hJoin: number;
  apex: number;
}

/** The reusable kis topology + colors for a given set of kissed faces. */
interface KisData {
  V: number;
  vertexCount: number;
  kfaces: Map<number, KFace>;
  previewFaces: number[][];
  /** Owner original-face id per preview triangle (for staged color / height). */
  triOwner: number[];
  vertexColor: GeomColor[];
  faceColor: GeomColor[]; // per preview triangle: the (unwelded) kis triangle color
  faceStart: GeomColor[]; // per preview triangle: the flat face color (t=0 look)
  faceJoin: GeomColor[]; // per preview triangle: the welded Join-quad color it merges into
  edgeColor: Map<string, GeomColor>;
  joinDissolve: Array<[number, number]>;
}

function buildKisData(poly: Polyhedron, kissed: Set<number>, heights: Map<number, number>): KisData {
  const dcel = poly.dcel;
  const old = poly.colors;
  const V = dcel.vertices.length;

  const kfaces = new Map<number, KFace>();
  let apexIdx = V;
  for (const f of dcel.faces) {
    if (!kissed.has(f.id)) continue;
    const centroid = faceCentroidHE(f);
    const normal = faceNormalHE(f);
    // Solved per-face height that keeps the Join quads planar (see
    // computeJoinHeights); fall back to half the centroid→vertex distance.
    const hJoin = heights.get(f.id) ?? 0.5 * centroid.distanceTo(f.halfedge.origin.position);
    kfaces.set(f.id, { id: f.id, centroid, normal, hJoin, apex: apexIdx++ });
  }
  const vertexCount = apexIdx;

  // Colors: kis is the exact DUAL of truncate, so its rules are the dualized
  // (vertex↔face) truncate rules (see colorUtil.dualRule). apex vertex ←
  // dual(truncate.newFace); new triangle ← dual(truncate.newVertex) (its flat start
  // color is the old face); spoke edges ← dual(truncate.newEdge). (The Join quad
  // recolors to dual(rectify.newVertex) in joinTopology.)
  const C = config.colors.operations;
  const previewFaces: number[][] = [];
  const triOwner: number[] = [];
  const faceColor: GeomColor[] = [];
  const faceStart: GeomColor[] = [];
  const faceJoin: GeomColor[] = [];
  for (const f of dcel.faces) {
    const loop = faceLoop(f);
    const kf = kfaces.get(f.id);
    if (!kf) {
      previewFaces.push(loop);
      triOwner.push(f.id);
      faceColor.push(old.face[f.id]);
      faceStart.push(old.face[f.id]);
      faceJoin.push(old.face[f.id]); // never joined → keeps its color at the weld
      continue;
    }
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      previewFaces.push([a, b, kf.apex]);
      triOwner.push(f.id);
      faceColor.push(combine(dualRule(C.truncate.newVertex), {
        oldFace: old.face[f.id],
        oldEdge: old.edge.get(edgeKey(a, b)) ?? BLACK,
      }));
      faceStart.push(old.face[f.id]);
      // At the Join this triangle merges (across base edge a-b) into a quad recolored
      // to dual(rectify.newVertex), from the base edge; preview that at the weld so
      // releasing into the Join doesn't snap.
      faceJoin.push(combine(dualRule(C.rectify.newVertex), {
        oldEdge: old.edge.get(edgeKey(a, b)) ?? BLACK,
      }));
    }
  }

  const vertexColor: GeomColor[] = new Array(vertexCount);
  for (let i = 0; i < V; i++) vertexColor[i] = old.vertex[i];
  for (const kf of kfaces.values()) {
    vertexColor[kf.apex] = combine(dualRule(C.truncate.newFace), { oldFace: old.face[kf.id] });
  }

  const edgeColor = new Map<string, GeomColor>();
  for (const [k, c] of old.edge) edgeColor.set(k, c);
  for (const f of dcel.faces) {
    const kf = kfaces.get(f.id);
    if (!kf) continue;
    for (const u of faceLoop(f)) {
      edgeColor.set(edgeKey(u, kf.apex), combine(dualRule(C.truncate.newEdge), {
        oldFace: old.face[f.id],
        oldVertex: old.vertex[u],
      }));
    }
  }

  const joinDissolve: Array<[number, number]> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    if (kfaces.has(he.face.id) && kfaces.has(he.twin.face.id)) {
      joinDissolve.push([he.origin.id, he.next.origin.id]);
    }
  }

  return { V, vertexCount, kfaces, previewFaces, triOwner, vertexColor, faceColor, faceStart, faceJoin, edgeColor, joinDissolve };
}

/** Apex positions for a kis, given a per-face height fraction (0..1 of hJoin). */
function kisPositions(poly: Polyhedron, data: KisData, frac: (fid: number) => number): Vector3[] {
  const out: Vector3[] = new Array(data.vertexCount);
  for (let i = 0; i < data.V; i++) out[i] = poly.dcel.vertices[i].position.clone();
  for (const kf of data.kfaces.values()) {
    out[kf.apex] = kf.centroid.clone().add(kf.normal.clone().multiplyScalar(frac(kf.id) * kf.hJoin));
  }
  return out;
}

/** Merge adjacent kissed-face triangles across each shared edge into a quad (Join);
 *  triangles bordering a non-kissed face stay triangles. */
function joinTopology(poly: Polyhedron, data: KisData): { faces: number[][]; faceColors: GeomColor[]; edge: Map<string, GeomColor> } {
  const dcel = poly.dcel;
  const old = poly.colors;
  const C = config.colors.operations;
  const faces: number[][] = [];
  const faceColors: GeomColor[] = [];
  const emitted = new Set<number>();
  for (const f of dcel.faces) {
    const kf = data.kfaces.get(f.id);
    if (!kf) {
      faces.push(faceLoop(f));
      faceColors.push(old.face[f.id]);
      continue;
    }
    let h = f.halfedge;
    const start = h;
    do {
      const a = h.origin.id;
      const b = h.next.origin.id;
      // Join face = dual(rectify.newVertex), from the nth base edge (both the merged
      // quad and an un-merged boundary tri).
      const baseColor = combine(dualRule(C.rectify.newVertex), { oldEdge: old.edge.get(edgeKey(a, b)) ?? BLACK });
      const g = h.twin!.face;
      const kg = data.kfaces.get(g.id);
      if (kg) {
        const key = Math.min(h.id, h.twin!.id);
        if (!emitted.has(key)) {
          emitted.add(key);
          faces.push([a, kf.apex, b, kg.apex]);
          faceColors.push(baseColor);
        }
      } else {
        faces.push([a, b, kf.apex]);
        faceColors.push(baseColor);
      }
      h = h.next;
    } while (h !== start);
  }
  const edge = new Map(data.edgeColor);
  for (const [a, b] of data.joinDissolve) edge.delete(edgeKey(a, b));
  return { faces, faceColors, edge };
}

/**
 * Kis → Join, driven by dragging a face center outward along its normal.
 *
 * Each face rises to a per-face apex height (see `computeJoinHeights`) chosen so
 * the merged Join quads stay planar, rather than a single symmetric join height.
 *
 * Staging (dual of truncate): the preview always raises a pyramid on EVERY face.
 * The SELECTED arity group rises from t=0 (`frac = t`); every OTHER face stays flat
 * (`frac = clamp(2t−1)`) until t=0.5, then rises too, so the drag reads as an n-kis,
 * becomes a full kis at t=0.5, and a full Join at t=1. A release with t<0.5 commits
 * the clean n-kis of just the selected set.
 */
export function buildKis(
  poly: Polyhedron,
  draggedFid: number,
  selected: Set<number> | null,
): MorphPlan {
  const dcel = poly.dcel;
  const allIds = dcel.faces.map((f) => f.id);
  const selectedSet = new Set<number>(selected && selected.size > 0 ? selected : allIds);
  selectedSet.add(draggedFid);
  const isPartial = selectedSet.size < allIds.length;

  // Per-face apex heights that keep the Join quads planar (dual of truncate's
  // per-edge collapse fractions). Computed once on the full solid.
  const heights = computeJoinHeights(poly);
  const full = buildKisData(poly, new Set(allIds), heights);

  const selFrac = (t: number) => t;
  const nonFrac = (t: number) => Math.max(0, Math.min(1, 2 * t - 1));
  const fracFor = (t: number) => (fid: number) => (selectedSet.has(fid) ? selFrac(t) : nonFrac(t));

  function positions(t: number): Vector3[] {
    return kisPositions(poly, full, fracFor(t));
  }

  function previewFaceColors(t: number, weld?: boolean): Color[] {
    // At the Join weld each pair of triangles merges into one recolored quad — show
    // that quad color now so releasing into the Join is seamless (the merge seams are
    // hidden by the caller, so both halves reading the same color look like one quad).
    if (weld) return full.faceJoin.map((c) => paletteRGB(c));
    // Otherwise each triangle stages across its three colors by its OWNING face's
    // height fraction (so on a partial n-kis the unselected faces don't tint until
    // they start rising at t=0.5): flat face color → kis color (half height) → Join
    // quad color (full height).
    const frac = fracFor(t);
    const out: Color[] = new Array(full.previewFaces.length);
    for (let i = 0; i < out.length; i++) {
      const e = frac(full.triOwner[i]);
      out[i] =
        e <= 0.5
          ? paletteRGB(full.faceStart[i]).lerp(paletteRGB(full.faceColor[i]), e * 2)
          : paletteRGB(full.faceColor[i]).lerp(paletteRGB(full.faceJoin[i]), (e - 0.5) * 2);
    }
    return out;
  }

  const dragged = full.kfaces.get(draggedFid)!;
  function snap(ray: Ray): { t: number; point: Vector3; highlight?: { a: Vector3; b: Vector3 } } {
    let s = closestLineParam(dragged.centroid, dragged.normal, ray.origin, ray.direction);
    s = Math.max(0, Math.min(dragged.hJoin, s));
    const point = dragged.centroid.clone().add(dragged.normal.clone().multiplyScalar(s));
    const t = Math.max(0, Math.min(1, s / dragged.hJoin));
    return {
      t,
      point,
      highlight: {
        a: point.clone(),
        b: dragged.centroid.clone().add(dragged.normal.clone().multiplyScalar(dragged.hJoin)),
      },
    };
  }

  function commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet } {
    if (weld) {
      const { faces, faceColors, edge } = joinTopology(poly, full);
      return { mesh: { vertices: positions(t), faces }, colors: { vertex: full.vertexColor.slice(), face: faceColors, edge } };
    }
    if (isPartial && t < 0.5) {
      const sub = buildKisData(poly, selectedSet, heights);
      return {
        mesh: { vertices: kisPositions(poly, sub, () => selFrac(t)), faces: sub.previewFaces.map((f) => f.slice()) },
        colors: { vertex: sub.vertexColor.slice(), face: sub.faceColor.slice(), edge: new Map(sub.edgeColor) },
      };
    }
    return {
      mesh: { vertices: positions(t), faces: full.previewFaces.map((f) => f.slice()) },
      colors: { vertex: full.vertexColor.slice(), face: full.faceColor.slice(), edge: new Map(full.edgeColor) },
    };
  }

  return {
    kind: "kis",
    previewFaces: full.previewFaces,
    positions,
    previewFaceColors,
    previewEdgeColors: full.edgeColor,
    vanishingEdges: full.joinDissolve,
    snap,
    commit,
  };
}
