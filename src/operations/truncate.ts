import { Vector3, Ray } from "three";
import {
  type Mesh,
  type HalfEdge,
  outgoingHalfEdges,
  faceVertices,
} from "../geometry/HalfEdge";
import { type Polyhedron, faceNormalHE, faceCentroidHE } from "../geometry/polyhedron";
import { type MorphPlan } from "./types";
import { weldVertexPairs } from "./weld";
import { closestLineParam, distancePointToRay } from "../util/lines";

/** A point is "in view" if any of the given (outward) normals faces the camera. */
export type InViewTest = (point: Vector3, normals: Vector3[]) => boolean;

/** Outward unit normals of the two faces sharing half-edge `h` (its midpoint's
 *  facing depends on these). Centroid-orient like SceneView since face winding
 *  isn't guaranteed outward. */
function edgeFaceNormals(h: HalfEdge): Vector3[] {
  const faces = h.twin ? [h.face, h.twin.face] : [h.face];
  return faces.map((f) => {
    const n = faceNormalHE(f);
    if (n.dot(faceCentroidHE(f)) < 0) n.negate();
    return n;
  });
}

/**
 * Truncate ↔ Rectify, driven by dragging a vertex inward along a connected edge.
 *
 * Model: BY DEFAULT every vertex is truncated at once; the dragged vertex is
 * merely the handle controlling the global cut depth. Multi-select restricts
 * which vertices participate, but the depth→geometry mapping (the Rectify bound)
 * is the same either way.
 *
 * Each half-edge `h` whose origin is truncated yields one cut vertex N(h) sitting
 * a fraction `t*0.5` of the way from origin(h) to its neighbor. At t=1 the two cut
 * vertices on every fully-truncated edge meet at the midpoint → Rectify.
 *
 * @param poly       current polyhedron
 * @param draggedVid the vertex grabbed (the drag handle)
 * @param selected   optional subset of vertices to truncate (multi-select);
 *                    when null/empty, ALL vertices are truncated
 */
export function buildTruncate(
  poly: Polyhedron,
  draggedVid: number,
  selected: Set<number> | null,
  inView: InViewTest | null = null,
): MorphPlan {
  const dcel = poly.dcel;

  const truncated = new Set<number>(
    selected && selected.size > 0
      ? selected
      : dcel.vertices.map((v) => v.id),
  );
  truncated.add(draggedVid); // the handle is always truncated

  // ---- Index the new vertices ------------------------------------------------
  // First: one cut vertex per half-edge whose origin is truncated.
  // Then:  every original vertex that is NOT truncated, kept as-is.
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

  // Cache origin/dest positions for each cut half-edge so positions(t) is cheap.
  const cutEnds: Array<{ index: number; origin: Vector3; dest: Vector3 }> = [];
  for (const he of dcel.halfedges) {
    const i = cutIndex.get(he.id);
    if (i === undefined) continue;
    cutEnds.push({
      index: i,
      origin: he.origin.position,
      dest: he.next.origin.position,
    });
  }
  const keepEnds: Array<{ index: number; pos: Vector3 }> = [];
  for (const v of dcel.vertices) {
    const i = keepIndex.get(v.id);
    if (i !== undefined) keepEnds.push({ index: i, pos: v.position });
  }

  function positions(t: number): Vector3[] {
    const cf = t * 0.5; // cut fraction along the edge (0 → vertex, 0.5 → midpoint)
    const out: Vector3[] = new Array(vertexCount);
    for (const c of cutEnds) {
      out[c.index] = c.origin
        .clone()
        .lerp(c.dest, cf);
    }
    for (const k of keepEnds) out[k.index] = k.pos.clone();
    return out;
  }

  // ---- Build the (un-welded) truncated faces --------------------------------
  const previewFaces: number[][] = [];

  // (a) one polygon per original face
  for (const f of dcel.faces) {
    const loop: number[] = [];
    let h = f.halfedge;
    const start = h;
    do {
      const v = h.origin;
      if (truncated.has(v.id)) {
        // incoming cut (near v on the previous edge) then outgoing cut
        loop.push(cutIndex.get(h.prev.twin!.id)!);
        loop.push(cutIndex.get(h.id)!);
      } else {
        loop.push(keepIndex.get(v.id)!);
      }
      h = h.next;
    } while (h !== start);
    previewFaces.push(loop);
  }

  // (b) one new polygon per truncated vertex (the freshly exposed n-gon face)
  for (const v of dcel.vertices) {
    if (!truncated.has(v.id)) continue;
    const loop = outgoingHalfEdges(v).map((h) => cutIndex.get(h.id)!);
    previewFaces.push(loop);
  }

  // ---- Weld pairs that coincide at Rectify ----------------------------------
  // Only edges with BOTH endpoints truncated collapse (their two cut vertices
  // meet at the midpoint).
  const weldPairs: Array<[number, number]> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue; // once per undirected edge
    const a = cutIndex.get(he.id);
    const b = cutIndex.get(he.twin.id);
    if (a !== undefined && b !== undefined) weldPairs.push([a, b]);
  }

  // ---- Snapping: pick the closest incident edge and project the ray onto it --
  function snap(ray: Ray): {
    t: number;
    point: Vector3;
    highlight?: { a: Vector3; b: Vector3 };
  } {
    const e = closestIncidentEdge(poly, draggedVid, ray, inView);
    const t = Math.max(0, Math.min(1, e.frac / 0.5));
    // Orange range line: from the current cut vertex to the rectify (midpoint) max.
    return { t, point: e.point, highlight: { a: e.point.clone(), b: e.mid.clone() } };
  }

  function commit(t: number, weld: boolean): Mesh {
    const mesh: Mesh = {
      vertices: positions(t),
      faces: previewFaces.map((f) => f.slice()),
    };
    return weld ? weldVertexPairs(mesh, weldPairs) : mesh;
  }

  return { kind: "truncate", previewFaces, positions, snap, commit };
}

/**
 * The incident edge of `vid` closest to the pick ray, with: the edge endpoints
 * (`from` = the vertex, `to` = its neighbor), the rectify max point (`mid`), the
 * snapped point along the edge, and the cut fraction (0..0.5). Used by the drag
 * snapping and by hover feedback (which edge would be dragged).
 *
 * When `inView` is given, only edges whose MIDPOINT is in view (per its two
 * adjacent faces' outward normals) are considered, so you can't drag along an
 * edge on the back/side of the solid. If that leaves no candidate, falls through
 * to the degenerate result below (no edge offered → the drag does nothing).
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
      best = {
        from: from.clone(),
        to: from.clone().add(edge),
        mid,
        point,
        frac,
        dist,
      };
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
