import { Vector3, Ray, Color } from "three";
import {
  type Mesh,
  type HalfEdge,
  outgoingHalfEdges,
  faceVertices,
} from "../geometry/HalfEdge";
import { type Polyhedron, faceNormalHE, faceCentroidHE } from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey, paletteRGB } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { weldVertexPairs } from "./weld";
import { combine } from "./colorUtil";
import { config } from "../config";
import { closestLineParam, distancePointToRay } from "../util/lines";

const BLACK: GeomColor = [0, 0, 0];

/** A point is "in view" if any of the given (outward) normals faces the camera. */
export type InViewTest = (point: Vector3, normals: Vector3[]) => boolean;

/** Outward unit normals of the two faces sharing half-edge `h`. */
function edgeFaceNormals(h: HalfEdge): Vector3[] {
  const faces = h.twin ? [h.face, h.twin.face] : [h.face];
  return faces.map((f) => {
    const n = faceNormalHE(f);
    if (n.dot(faceCentroidHE(f)) < 0) n.negate();
    return n;
  });
}

/**
 * Per-half-edge collapse fraction for an "equal radial depth" truncation.
 *
 * Each undirected edge collapses at a single point `v + s·(w−v)`; during a
 * Truncate→Rectify drag the two cut ends ride at `s·t` (from v) and `(1−s)·t`
 * (from w) and weld at t=1. A uniform s=½ leaves the exposed vertex n-gons badly
 * non-planar on solids with non-coplanar vertex stars (e.g. Catalan solids like
 * the triakis tetrahedron). Choosing s per edge so a vertex's cut points share a
 * radial depth (|v| + s·(w−v)·v̂ constant across its edges) flattens them — for
 * the triakis tetra this is exact.
 *
 * The collapse point on edge v→w has radial depth |v| + s·(w−v)·v̂; equalizing to
 * a per-vertex target |v|+δ_v gives s = δ_v / ((w−v)·v̂). We solve the δ (one per
 * vertex) by least squares so the two endpoints of every edge agree on the single
 * collapse point, then read the reconciled s. Returns a directed fraction for
 * every half-edge id, measured from that half-edge's own origin; a half-edge and
 * its twin sum to 1, so their cut ends meet exactly at t=1.
 */
export function computeCollapseFractions(poly: Polyhedron): Map<number, number> {
  const dcel = poly.dcel;
  // radial depth drop of `to` relative to `from`, along from's outward radial.
  const depthDrop = (from: Vector3, to: Vector3) =>
    to.clone().sub(from).dot(from.clone().normalize());

  // from v: s = δ_v/a_v; from w: s = 1 − δ_w/a_w (a = (other−this)·thiŝ). Skip
  // edges tangent to the sphere (a≈0: no radial depth to equalize) in the solve.
  type Inc = { a: number; other: number; ao: number };
  const incident = new Map<number, Inc[]>();
  for (const v of dcel.vertices) incident.set(v.id, []);
  const edges: Array<{ he: number; twin: number; va: number; wb: number; a_v: number; a_w: number }> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    const v = he.origin.position, w = he.next.origin.position;
    const a_v = depthDrop(v, w), a_w = depthDrop(w, v);
    edges.push({ he: he.id, twin: he.twin.id, va: he.origin.id, wb: he.next.origin.id, a_v, a_w });
    if (Math.abs(a_v) > 1e-9 && Math.abs(a_w) > 1e-9) {
      incident.get(he.origin.id)!.push({ a: a_v, other: he.next.origin.id, ao: a_w });
      incident.get(he.next.origin.id)!.push({ a: a_w, other: he.origin.id, ao: a_v });
    }
  }

  // Coordinate descent on δ, seeded so s≈0.5.
  const delta = new Map<number, number>();
  for (const v of dcel.vertices) {
    const inc = incident.get(v.id)!;
    const meanA = inc.length ? inc.reduce((sum, i) => sum + i.a, 0) / inc.length : 0;
    delta.set(v.id, 0.5 * meanA);
  }
  for (let round = 0; round < 400; round++) {
    for (const v of dcel.vertices) {
      // solve δ_v minimizing Σ_edges(δ_v/a − sTarget)², sTarget = 1 − δ_other/a_other
      let num = 0, den = 0;
      for (const i of incident.get(v.id)!) {
        num += (1 - delta.get(i.other)! / i.ao) / i.a;
        den += 1 / (i.a * i.a);
      }
      if (den > 1e-12) delta.set(v.id, num / den);
    }
  }

  // Reconcile the two endpoints' opinion into one s per edge; twin gets 1−s.
  const out = new Map<number, number>();
  for (const e of edges) {
    let s: number;
    if (Math.abs(e.a_v) < 1e-9 || Math.abs(e.a_w) < 1e-9) {
      s = 0.5;
    } else {
      const sFromV = delta.get(e.va)! / e.a_v;
      const sFromW = 1 - delta.get(e.wb)! / e.a_w;
      s = 0.5 * (sFromV + sFromW);
    }
    s = Math.max(0.02, Math.min(0.98, s));
    out.set(e.he, s);
    out.set(e.twin, 1 - s);
  }
  return out;
}

/** The reusable truncation topology + colors for a given set of truncated vertices,
 *  independent of the cut depth (which `positions` applies per edge). */
interface TruncationData {
  vertexCount: number;
  previewFaces: number[][];
  weldPairs: Array<[number, number]>;
  /** Rectify vertex colors (oldEdge) — used when the two cut ends weld. */
  vertexColor: GeomColor[];
  /** Truncated-form vertex colors (truncate.newVertex = oldVertex + oldEdge/10). */
  truncVertexColor: GeomColor[];
  faceColor: GeomColor[];
  edgeColor: Map<string, GeomColor>;
  /** Cut vertices: index + the half-edge they slide along + origin vertex id. */
  cutEnds: Array<{ index: number; heId: number; origin: Vector3; dest: Vector3; originVid: number }>;
  /** Untruncated (kept) vertices, carried through unchanged. */
  keepEnds: Array<{ index: number; pos: Vector3 }>;
}

/** Build the truncation of `poly` cutting exactly the vertices in `truncated`. */
function buildTruncationData(poly: Polyhedron, truncated: Set<number>): TruncationData {
  const dcel = poly.dcel;
  const old = poly.colors;

  // One cut vertex per half-edge whose origin is truncated; kept vertices follow.
  const cutIndex = new Map<number, number>(); // halfedge id -> new vertex index
  const keepIndex = new Map<number, number>(); // old vertex id -> new vertex index
  let idx = 0;
  for (const he of dcel.halfedges) {
    if (truncated.has(he.origin.id)) cutIndex.set(he.id, idx++);
  }
  for (const v of dcel.vertices) {
    if (!truncated.has(v.id)) keepIndex.set(v.id, idx++);
  }
  const vertexCount = idx;

  const cutEnds: TruncationData["cutEnds"] = [];
  for (const he of dcel.halfedges) {
    const i = cutIndex.get(he.id);
    if (i === undefined) continue;
    cutEnds.push({ index: i, heId: he.id, origin: he.origin.position, dest: he.next.origin.position, originVid: he.origin.id });
  }
  const keepEnds: TruncationData["keepEnds"] = [];
  for (const v of dcel.vertices) {
    const i = keepIndex.get(v.id);
    if (i !== undefined) keepEnds.push({ index: i, pos: v.position });
  }

  // (a) one polygon per original face; (b) one exposed n-gon per truncated vertex.
  const previewFaces: number[][] = [];
  for (const f of dcel.faces) {
    const loop: number[] = [];
    let h = f.halfedge;
    const start = h;
    do {
      const v = h.origin;
      if (truncated.has(v.id)) {
        loop.push(cutIndex.get(h.prev.twin!.id)!); // incoming cut
        loop.push(cutIndex.get(h.id)!); // outgoing cut
      } else {
        loop.push(keepIndex.get(v.id)!);
      }
      h = h.next;
    } while (h !== start);
    previewFaces.push(loop);
  }
  for (const v of dcel.vertices) {
    if (!truncated.has(v.id)) continue;
    previewFaces.push(outgoingHalfEdges(v).map((h) => cutIndex.get(h.id)!));
  }

  // Edges with BOTH ends truncated collapse at the midpoint (→ Rectify).
  const weldPairs: Array<[number, number]> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    const a = cutIndex.get(he.id);
    const b = cutIndex.get(he.twin.id);
    if (a !== undefined && b !== undefined) weldPairs.push([a, b]);
  }

  // Colors (config.colors.operations.truncate / rectify):
  //   cut vertex, TRUNCATED form ← truncate.newVertex = old vertex + its old edge/10.
  //   cut vertex, WELDED (Rectify) form ← its original edge color (rectify.newVertex):
  //     the two ends of an edge carry the SAME oldEdge but DIFFERENT oldVertex, so the
  //     truncate color can't survive welding (weldVertexPairs needs the pair to agree);
  //     the rectify color does. We keep both colorings and pick per commit path.
  //   kept vertex keeps its color.
  //   exposed n-gon ← truncate.newFace = old vertex color.
  //   original faces keep theirs.
  //   n-gon perimeter edge ← truncate.newEdge = old vertex + nth bordering-face/10.
  //   surviving edge remnant ← its original edge color.
  const C = config.colors.operations;
  const vertexColor: GeomColor[] = new Array(vertexCount);
  const truncVertexColor: GeomColor[] = new Array(vertexCount);
  for (const he of dcel.halfedges) {
    const i = cutIndex.get(he.id);
    if (i === undefined) continue;
    const oldEdge = old.edge.get(edgeKey(he.origin.id, he.next.origin.id)) ?? BLACK;
    vertexColor[i] = combine(C.rectify.newVertex, { oldEdge }, "rectify.newVertex");
    truncVertexColor[i] = combine(C.truncate.newVertex, { oldVertex: old.vertex[he.origin.id], oldEdge }, "truncate.newVertex");
  }
  for (const v of dcel.vertices) {
    const i = keepIndex.get(v.id);
    if (i !== undefined) vertexColor[i] = truncVertexColor[i] = old.vertex[v.id];
  }

  const faceColor: GeomColor[] = [];
  for (const f of dcel.faces) faceColor.push(old.face[f.id]);
  for (const v of dcel.vertices) {
    if (!truncated.has(v.id)) continue;
    faceColor.push(combine(C.truncate.newFace, { oldVertex: old.vertex[v.id] }));
  }

  const edgeColor = new Map<string, GeomColor>();
  for (const v of dcel.vertices) {
    if (!truncated.has(v.id)) continue;
    const H = outgoingHalfEdges(v);
    const ring = H.map((h) => cutIndex.get(h.id)!);
    for (let k = 0; k < ring.length; k++) {
      // The n-gon edge (ring[k],ring[k+1]) borders original face H[k+1].face.
      const borderFace = old.face[H[(k + 1) % H.length].face.id];
      edgeColor.set(
        edgeKey(ring[k], ring[(k + 1) % ring.length]),
        combine(C.truncate.newEdge, { oldVertex: old.vertex[v.id], oldFace: borderFace }),
      );
    }
  }
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    const u = he.origin.id;
    const w = he.next.origin.id;
    const endU = truncated.has(u) ? cutIndex.get(he.id)! : keepIndex.get(u)!;
    const endW = truncated.has(w) ? cutIndex.get(he.twin.id)! : keepIndex.get(w)!;
    edgeColor.set(edgeKey(endU, endW), old.edge.get(edgeKey(u, w)) ?? BLACK);
  }

  return { vertexCount, previewFaces, weldPairs, vertexColor, truncVertexColor, faceColor, edgeColor, cutEnds, keepEnds };
}

/** Positions for a truncation, given a per-cut-end fraction along its half-edge. */
function truncationPositions(
  data: TruncationData,
  cutFrac: (c: TruncationData["cutEnds"][number]) => number,
): Vector3[] {
  const out: Vector3[] = new Array(data.vertexCount);
  for (const c of data.cutEnds) out[c.index] = c.origin.clone().lerp(c.dest, cutFrac(c));
  for (const k of data.keepEnds) out[k.index] = k.pos.clone();
  return out;
}

/**
 * Truncate → Rectify, driven by dragging a vertex inward along a connected edge.
 *
 * Each edge collapses at a per-edge point `s` (see `computeCollapseFractions`)
 * rather than its midpoint, keeping the exposed vertex n-gons planar. `s` is a
 * directed fraction per half-edge (a half-edge and its twin sum to 1).
 *
 * Staging: the preview always shows the FULL truncation (every vertex). The
 * SELECTED arity group cuts from t=0 (`cutFrac = s·t`); every OTHER vertex stays
 * at zero depth (visually sharp) until t=0.5, then cuts too (`s·clamp(2t−1)`),
 * so the drag reads as an n-truncate, transitions to a full truncation at t=0.5,
 * and reaches a full Rectify at t=1 (every edge's two ends meet at its `s` and
 * weld). A release with t<0.5 commits the clean n-truncation of just the set.
 *
 * @param poly       current polyhedron
 * @param draggedVid the vertex grabbed (the drag handle, always in the selection)
 * @param selected   the arity group / multi-select subset (null → whole solid)
 */
export function buildTruncate(
  poly: Polyhedron,
  draggedVid: number,
  selected: Set<number> | null,
  inView: InViewTest | null = null,
): MorphPlan {
  const dcel = poly.dcel;
  const allIds = dcel.vertices.map((v) => v.id);
  const selectedSet = new Set<number>(selected && selected.size > 0 ? selected : allIds);
  selectedSet.add(draggedVid);
  const isPartial = selectedSet.size < allIds.length;

  // The preview / weld topology is the full truncation of every vertex.
  const full = buildTruncationData(poly, new Set(allIds));

  // Per-half-edge collapse fraction (equal radial depth → planar vertex n-gons).
  const collapse = computeCollapseFractions(poly);
  type CutEnd = TruncationData["cutEnds"][number];
  const sOf = (c: CutEnd) => collapse.get(c.heId) ?? 0.5;
  const selCut = (c: CutEnd, t: number) => sOf(c) * t;
  const nonCut = (c: CutEnd, t: number) => sOf(c) * Math.max(0, Math.min(1, 2 * t - 1));
  const fracFor = (t: number) => (c: CutEnd) => (selectedSet.has(c.originVid) ? selCut(c, t) : nonCut(c, t));

  function positions(t: number): Vector3[] {
    return truncationPositions(full, fracFor(t));
  }

  function previewFaceColors(_t: number): Color[] {
    return full.faceColor.map((c) => paletteRGB(c));
  }

  function snap(ray: Ray): { t: number; point: Vector3; highlight?: { a: Vector3; b: Vector3 } } {
    const e = closestIncidentEdge(poly, draggedVid, ray, inView, collapse);
    const t = e.max > 1e-9 ? Math.max(0, Math.min(1, e.frac / e.max)) : 0;
    return { t, point: e.point, highlight: { a: e.point.clone(), b: e.mid.clone() } };
  }

  function commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet } {
    if (weld) {
      const mesh: Mesh = { vertices: positions(t), faces: full.previewFaces.map((f) => f.slice()) };
      const colors: ColorSet = { vertex: full.vertexColor.slice(), face: full.faceColor.slice(), edge: new Map(full.edgeColor) };
      return weldVertexPairs(mesh, full.weldPairs, colors);
    }
    // t < 0.5 on a partial selection → the clean n-truncation of just that set.
    if (isPartial && t < 0.5) {
      const sub = buildTruncationData(poly, selectedSet);
      return {
        mesh: { vertices: truncationPositions(sub, (c) => selCut(c, t)), faces: sub.previewFaces.map((f) => f.slice()) },
        colors: { vertex: sub.truncVertexColor.slice(), face: sub.faceColor.slice(), edge: new Map(sub.edgeColor) },
      };
    }
    // Full truncation (uniform, or partial past the t=0.5 transition).
    return {
      mesh: { vertices: positions(t), faces: full.previewFaces.map((f) => f.slice()) },
      colors: { vertex: full.truncVertexColor.slice(), face: full.faceColor.slice(), edge: new Map(full.edgeColor) },
    };
  }

  return {
    kind: "truncate",
    previewFaces: full.previewFaces,
    positions,
    previewFaceColors,
    previewEdgeColors: full.edgeColor,
    vanishingEdges: full.weldPairs,
    snap,
    commit,
  };
}

/**
 * The incident edge of `vid` closest to the pick ray, with the edge endpoints
 * (`from`/`to`), the rectify max (`mid`, at the edge's collapse point `s·edge`),
 * the snapped point, the cut fraction (0..`max`), and that edge's collapse `max`.
 * When `inView` is given, only edges whose collapse point is in view count.
 * `collapse` (per-half-edge fractions) is computed if not supplied.
 */
export function closestIncidentEdge(
  poly: Polyhedron,
  vid: number,
  ray: Ray,
  inView: InViewTest | null = null,
  collapse?: Map<number, number>,
): { from: Vector3; to: Vector3; mid: Vector3; point: Vector3; frac: number; max: number } {
  const v = poly.dcel.vertices[vid];
  const coll = collapse ?? computeCollapseFractions(poly);
  let best:
    | { from: Vector3; to: Vector3; mid: Vector3; point: Vector3; frac: number; max: number; dist: number }
    | null = null;
  for (const h of outgoingHalfEdges(v)) {
    const from = h.origin.position;
    const edge = h.next.origin.position.clone().sub(from);
    const sMax = coll.get(h.id) ?? 0.5;
    const mid = from.clone().add(edge.clone().multiplyScalar(sMax));
    if (inView && !inView(mid, edgeFaceNormals(h))) continue;
    let frac = closestLineParam(from, edge, ray.origin, ray.direction);
    frac = Math.max(0, Math.min(sMax, frac));
    const point = from.clone().add(edge.clone().multiplyScalar(frac));
    const dist = distancePointToRay(point, ray);
    if (!best || dist < best.dist) {
      best = { from: from.clone(), to: from.clone().add(edge), mid, point, frac, max: sMax, dist };
    }
  }
  if (!best) {
    const p = v.position.clone();
    return { from: p, to: p.clone(), mid: p.clone(), point: p.clone(), frac: 0, max: 0 };
  }
  return best;
}

/** Convenience: vertices of a face as positions (used in tests / debugging). */
export function facePositions(poly: Polyhedron, faceId: number): Vector3[] {
  return faceVertices(poly.dcel.faces[faceId]).map((v) => v.position);
}
