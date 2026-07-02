import { Vector3, Ray, Color } from "three";
import {
  type Mesh,
  type HalfEdge,
  outgoingHalfEdges,
  faceVertices,
} from "../geometry/HalfEdge";
import { type Polyhedron, faceNormalHE, faceCentroidHE } from "../geometry/polyhedron";
import { type ColorSet, edgeKey, paletteRGB } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { weldVertexPairs } from "./weld";
import { vertexMaxPlus1 } from "./colorUtil";
import { closestLineParam, distancePointToRay } from "../util/lines";

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

/** The reusable truncation topology + colors for a given set of truncated vertices,
 *  independent of the cut depth (which `positions` applies per vertex). */
interface TruncationData {
  vertexCount: number;
  previewFaces: number[][];
  weldPairs: Array<[number, number]>;
  vertexColor: number[];
  faceColor: number[];
  edgeColor: Map<string, number>;
  /** Cut vertices: index + the edge they slide along + their origin vertex id. */
  cutEnds: Array<{ index: number; origin: Vector3; dest: Vector3; originVid: number }>;
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
    cutEnds.push({ index: i, origin: he.origin.position, dest: he.next.origin.position, originVid: he.origin.id });
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

  // Colors: cut vertex ← original edge; kept vertex keeps its color; exposed n-gon
  // ← the truncated vertex color; original faces keep theirs; n-gon perimeter edges
  // ← c+1; surviving edge remnants keep their original color.
  const vertexColor: number[] = new Array(vertexCount);
  for (const he of dcel.halfedges) {
    const i = cutIndex.get(he.id);
    if (i !== undefined) vertexColor[i] = old.edge.get(edgeKey(he.origin.id, he.next.origin.id)) ?? 0;
  }
  for (const v of dcel.vertices) {
    const i = keepIndex.get(v.id);
    if (i !== undefined) vertexColor[i] = old.vertex[v.id];
  }

  const faceColor: number[] = [];
  for (const f of dcel.faces) faceColor.push(old.face[f.id]);
  for (const v of dcel.vertices) if (truncated.has(v.id)) faceColor.push(old.vertex[v.id]);

  const edgeColor = new Map<string, number>();
  for (const v of dcel.vertices) {
    if (!truncated.has(v.id)) continue;
    const mp = vertexMaxPlus1(v, old);
    const ring = outgoingHalfEdges(v).map((h) => cutIndex.get(h.id)!);
    for (let k = 0; k < ring.length; k++) {
      edgeColor.set(edgeKey(ring[k], ring[(k + 1) % ring.length]), mp);
    }
  }
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    const u = he.origin.id;
    const w = he.next.origin.id;
    const endU = truncated.has(u) ? cutIndex.get(he.id)! : keepIndex.get(u)!;
    const endW = truncated.has(w) ? cutIndex.get(he.twin.id)! : keepIndex.get(w)!;
    edgeColor.set(edgeKey(endU, endW), old.edge.get(edgeKey(u, w)) ?? 0);
  }

  return { vertexCount, previewFaces, weldPairs, vertexColor, faceColor, edgeColor, cutEnds, keepEnds };
}

/** Positions for a truncation, given a per-origin-vertex cut fraction (0..0.5). */
function truncationPositions(data: TruncationData, cutFrac: (vid: number) => number): Vector3[] {
  const out: Vector3[] = new Array(data.vertexCount);
  for (const c of data.cutEnds) out[c.index] = c.origin.clone().lerp(c.dest, cutFrac(c.originVid));
  for (const k of data.keepEnds) out[k.index] = k.pos.clone();
  return out;
}

/**
 * Truncate → Rectify, driven by dragging a vertex inward along a connected edge.
 *
 * Staging: the preview always shows the FULL truncation (every vertex). The
 * SELECTED arity group cuts from t=0 (`cutFrac = 0.5·t`); every OTHER vertex stays
 * at zero depth (visually sharp) until t=0.5, then cuts too (`0.5·clamp(2t−1)`),
 * so the drag reads as an n-truncate, transitions to a full truncation at t=0.5,
 * and reaches a full Rectify at t=1 (every cut fraction hits 0.5 and welds). A
 * release with t<0.5 commits the clean n-truncation of just the selected set.
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

  const selCut = (t: number) => 0.5 * t;
  const nonCut = (t: number) => 0.5 * Math.max(0, Math.min(1, 2 * t - 1));
  const fracFor = (t: number) => (vid: number) => (selectedSet.has(vid) ? selCut(t) : nonCut(t));

  function positions(t: number): Vector3[] {
    return truncationPositions(full, fracFor(t));
  }

  function previewFaceColors(_t: number): Color[] {
    return full.faceColor.map((c) => paletteRGB(c));
  }

  function snap(ray: Ray): { t: number; point: Vector3; highlight?: { a: Vector3; b: Vector3 } } {
    const e = closestIncidentEdge(poly, draggedVid, ray, inView);
    const t = Math.max(0, Math.min(1, e.frac / 0.5));
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
        mesh: { vertices: truncationPositions(sub, () => selCut(t)), faces: sub.previewFaces.map((f) => f.slice()) },
        colors: { vertex: sub.vertexColor.slice(), face: sub.faceColor.slice(), edge: new Map(sub.edgeColor) },
      };
    }
    // Full truncation (uniform, or partial past the t=0.5 transition).
    return {
      mesh: { vertices: positions(t), faces: full.previewFaces.map((f) => f.slice()) },
      colors: { vertex: full.vertexColor.slice(), face: full.faceColor.slice(), edge: new Map(full.edgeColor) },
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
 * (`from`/`to`), the rectify max (`mid`), the snapped point, and the cut fraction
 * (0..0.5). When `inView` is given, only edges whose midpoint is in view count.
 */
export function closestIncidentEdge(
  poly: Polyhedron,
  vid: number,
  ray: Ray,
  inView: InViewTest | null = null,
): { from: Vector3; to: Vector3; mid: Vector3; point: Vector3; frac: number } {
  const v = poly.dcel.vertices[vid];
  let best:
    | { from: Vector3; to: Vector3; mid: Vector3; point: Vector3; frac: number; dist: number }
    | null = null;
  for (const h of outgoingHalfEdges(v)) {
    const from = h.origin.position;
    const edge = h.next.origin.position.clone().sub(from);
    const mid = from.clone().add(edge.clone().multiplyScalar(0.5));
    if (inView && !inView(mid, edgeFaceNormals(h))) continue;
    let frac = closestLineParam(from, edge, ray.origin, ray.direction);
    frac = Math.max(0, Math.min(0.5, frac));
    const point = from.clone().add(edge.clone().multiplyScalar(frac));
    const dist = distancePointToRay(point, ray);
    if (!best || dist < best.dist) {
      best = { from: from.clone(), to: from.clone().add(edge), mid, point, frac, dist };
    }
  }
  if (!best) {
    const p = v.position.clone();
    return { from: p, to: p.clone(), mid: p.clone(), point: p.clone(), frac: 0 };
  }
  return best;
}

/** Convenience: vertices of a face as positions (used in tests / debugging). */
export function facePositions(poly: Polyhedron, faceId: number): Vector3[] {
  return faceVertices(poly.dcel.faces[faceId]).map((v) => v.position);
}
