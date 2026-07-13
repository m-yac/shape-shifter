import { Vector3, Ray, Color } from "three";
import { type Mesh, type HEFace, faceVertices } from "../geometry/HalfEdge";
import { type Polyhedron, faceCentroidHE, faceNormalHE } from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { type InViewTest } from "./truncate";
import { weldVertexPairs } from "./weld";
import { combine, dualRule, lerpFaceColors } from "./colorUtil";
import { computeJoinHeights } from "./kis";
import { config } from "../config";
import { closestLineParam } from "../util/lines";

const BLACK: GeomColor = [0, 0, 0];

/** Vertices of a face as an ordered id loop. */
function faceLoopIds(f: HEFace): number[] {
  return faceVertices(f).map((v) => v.id);
}

/**
 * The point every face shrinks toward, one per face.
 *
 * Each original edge (p,q) becomes a hexagon `[p, A_p, A_q, q, B_q, B_p]`, where
 * `A_p = lerp(p, target_A, t)`. The hexagon must contain p, q and the two inset corners of
 * face A, all four of which lie in A's plane when the target is A's centroid, so a
 * centroid-targeted hexagon can only be planar by accident: the target must leave the face
 * plane.
 *
 * Writing the planarity condition out, the hexagon is planar exactly when
 * `det[q−p, target_A−p, target_B−p] = 0`, i.e. when p, q and the two targets are coplanar,
 * a condition on the targets alone, independent of t. That is the same condition kis solves
 * when it places a pyramid apex per face such that the Join quads `[p, apex_A, q, apex_B]`
 * are planar. So the chamfer targets are the join apexes, and reusing them makes every
 * hexagon planar at every t with the original vertices held fixed. It also makes
 * chamfer→Join geometrically identical to joining directly, which the color rules assume.
 *
 * For a non-canonical solid `computeJoinHeights` is a least-squares fit, so the hexagons
 * inherit its (small) residual rather than being exactly planar.
 */
function insetTargets(poly: Polyhedron): Map<number, Vector3> {
  const heights = computeJoinHeights(poly);
  const targets = new Map<number, Vector3>();
  for (const f of poly.dcel.faces)
    targets.set(f.id, faceCentroidHE(f).addScaledVector(faceNormalHE(f), heights.get(f.id)!));
  return targets;
}

/**
 * Chamfer ↔ Join, driven by dragging an edge midpoint sideways along a bordering face.
 * Like truncate/kis the gesture is global: dragging one edge chamfers every edge, and the
 * handle only sets the global inset. Each original face shrinks toward its join apex (see
 * `insetTargets`), each original edge is replaced by a hexagon spanning the gap, and every
 * original vertex is kept, fixed in place.
 *
 *   t = 0 → coincident with the original (zero inset, hexagons collapsed).
 *   0 < t < 1 → the chamfered solid (n-gons + hexagons).
 *   t = 1 → Join: every face has shrunk to its apex; welding the collapsed
 *           perimeters deletes the original faces and merges each hexagon into a
 *           rhombus (e.g. chamfer-join of the cube → rhombic dodecahedron).
 *
 * @param poly        current polyhedron
 * @param edge        the dragged undirected edge (vertex-id pair)
 * @param trackFaceId which bordering face's inset seam tracks the cursor
 */
export function buildChamfer(
  poly: Polyhedron,
  edge: [number, number],
  trackFaceId: number,
  _inView: InViewTest | null = null,
): MorphPlan {
  const dcel = poly.dcel;
  const old = poly.colors;
  const V = dcel.vertices.length;

  // ---- Index the new inset vertices: one per (face, vertex) corner. -----------
  const cornerIndex = new Map<string, number>(); // `${faceId}_${vId}` -> new index
  const cornerOf = (fid: number, vid: number) => cornerIndex.get(`${fid}_${vid}`)!;
  // Per inset vertex, cache its original vertex position and its face's inset target so
  // positions(t) is a cheap lerp.
  // Chamfer is the dual of subdivide, so its rules are the dualized (vertex↔face) subdivide
  // rules (see colorUtil.dualRule). An inset corner (a new vertex) ←
  // dual(subdivide.newFace), from this vertex and face. At the Join weld a face's insets
  // collapse to its centre, which recolors to the join apex; see commit.
  const C = config.colors.operations;
  const targets = insetTargets(poly);
  const insets: Array<{ index: number; v: Vector3; c: Vector3; color: GeomColor }> = [];
  let idx = V;
  for (const f of dcel.faces) {
    const target = targets.get(f.id)!;
    const loop = faceVertices(f);
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i];
      cornerIndex.set(`${f.id}_${v.id}`, idx);
      insets.push({
        index: idx,
        v: v.position,
        c: target,
        color: combine(dualRule(C.subdivide.newFace), {
          oldVertex: old.vertex[v.id],
          oldFace: old.face[f.id],
        }),
      });
      idx++;
    }
  }
  const vertexCount = idx;

  // The original vertices are fixed: `insetTargets` already guarantees planar
  // hexagons around them.
  function positions(t: number): Vector3[] {
    const out: Vector3[] = new Array(vertexCount);
    for (let i = 0; i < V; i++) out[i] = dcel.vertices[i].position.clone();
    for (const n of insets) out[n.index] = n.v.clone().lerp(n.c, t);
    return out;
  }

  // ---- Build the (un-welded) chamfered faces ---------------------------------
  const previewFaces: number[][] = [];
  const faceColor: GeomColor[] = [];
  const faceStart: GeomColor[] = [];

  // (a) one shrunk polygon per original face (same arity, inset toward its target).
  //     A homothety about the target, so the shrunk face stays planar.
  for (const f of dcel.faces) {
    previewFaces.push(faceLoopIds(f).map((vid) => cornerOf(f.id, vid)));
    faceColor.push(old.face[f.id]); // shrunk face keeps its original color
    faceStart.push(old.face[f.id]);
  }
  // (b) one hexagon per undirected edge, spanning the gap the edge opened up.
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue; // once per undirected edge
    const A = he.face;
    const B = he.twin.face;
    const p = he.origin.id;
    const q = he.next.origin.id;
    previewFaces.push([
      p, cornerOf(A.id, p), cornerOf(A.id, q),
      q, cornerOf(B.id, q), cornerOf(B.id, p),
    ]);
    // The new hexagon replaces the original edge → dual(subdivide.newVertex), from the
    // original edge. Constant through the drag; the welded rhombus keeps it at the Join
    // limit.
    const ec = combine(dualRule(C.subdivide.newVertex), { oldEdge: old.edge.get(edgeKey(p, q)) ?? BLACK });
    faceColor.push(ec);
    faceStart.push(ec);
  }

  // ---- Colors for vertices + edges -------------------------------------------
  const vertexColor: GeomColor[] = new Array(vertexCount);
  for (let i = 0; i < V; i++) vertexColor[i] = old.vertex[i];
  for (const n of insets) vertexColor[n.index] = n.color;

  const edgeColor = new Map<string, GeomColor>();
  for (const f of dcel.faces) {
    const vids = faceLoopIds(f);
    const loop = vids.map((vid) => cornerOf(f.id, vid));
    for (let i = 0; i < loop.length; i++) {
      // Shrunk-face perimeter edges collapse when the face shrinks to its apex at the
      // Join: the dual of subdivide's fan edges, which vanish at the Rectify. So ←
      // dual(subdivEdgeEdge), from the original edge it insets from and this face.
      edgeColor.set(edgeKey(loop[i], loop[(i + 1) % loop.length]),
        combine(dualRule(C.subdivide.subdivEdgeEdge), {
          oldEdge: old.edge.get(edgeKey(vids[i], vids[(i + 1) % vids.length])) ?? BLACK,
          oldFace: old.face[f.id],
        }));
    }
  }
  // Connector edges (original vertex → its inset corners) survive the Join: each becomes a
  // spoke to the collapsed face centre, like a kis spoke — the dual of subdivide's
  // central-polygon edges, which survive as the Rectify edges. So ← dual(subdivFaceEdge),
  // from the face the connector lies in and its original vertex. This makes a chamfer→Join
  // color-identical to joining directly.
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    const p = he.origin.id;
    const q = he.next.origin.id;
    const spoke = (fid: number, vid: number): GeomColor =>
      combine(dualRule(C.subdivide.subdivFaceEdge), { oldFace: old.face[fid], oldVertex: old.vertex[vid] });
    edgeColor.set(edgeKey(p, cornerOf(he.face.id, p)), spoke(he.face.id, p));
    edgeColor.set(edgeKey(q, cornerOf(he.face.id, q)), spoke(he.face.id, q));
    edgeColor.set(edgeKey(p, cornerOf(he.twin.face.id, p)), spoke(he.twin.face.id, p));
    edgeColor.set(edgeKey(q, cornerOf(he.twin.face.id, q)), spoke(he.twin.face.id, q));
  }

  // ---- Weld: each face collapses to its apex at the Join end. ----------------
  const weldPairs: Array<[number, number]> = [];
  const vanishing: Array<[number, number]> = [];
  for (const f of dcel.faces) {
    const loop = faceLoopIds(f).map((vid) => cornerOf(f.id, vid));
    for (let i = 1; i < loop.length; i++) weldPairs.push([loop[0], loop[i]]);
    for (let i = 0; i < loop.length; i++) vanishing.push([loop[i], loop[(i + 1) % loop.length]]);
  }

  function previewFaceColors(t: number): Color[] {
    return lerpFaceColors(faceStart, faceColor, t);
  }

  // ---- Snap: project the cursor onto the seam line from the edge midpoint to the
  //  tracked face's inset target. s = how far the inset seam has swept across the face.
  const a = dcel.vertices[edge[0]].position;
  const b = dcel.vertices[edge[1]].position;
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const trackC = targets.get(trackFaceId)!;
  function snap(ray: Ray): { t: number; point: Vector3; highlight?: { a: Vector3; b: Vector3 } } {
    const dir = trackC.clone().sub(mid);
    let s = closestLineParam(mid, dir, ray.origin, ray.direction);
    s = Math.max(0, Math.min(1, s));
    const point = mid.clone().add(dir.clone().multiplyScalar(s));
    return { t: s, point, highlight: { a: point.clone(), b: trackC.clone() } };
  }

  function commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet } {
    const mesh: Mesh = { vertices: positions(t), faces: previewFaces.map((f) => f.slice()) };
    const vertex = vertexColor.slice();
    if (weld) {
      // At the Join each face's insets collapse to its apex, becoming the join apex vertex,
      // which (like a kis apex, its dual) takes the old face color rather than the inset's
      // old-vertex tint. Recolor them so a chamfer→Join matches joining directly.
      for (const f of dcel.faces)
        for (const v of faceVertices(f)) vertex[cornerOf(f.id, v.id)] = old.face[f.id];
    }
    const colors: ColorSet = {
      vertex,
      face: faceColor.slice(),
      edge: new Map(edgeColor),
    };
    return weld ? weldVertexPairs(mesh, weldPairs, colors) : { mesh, colors };
  }

  return {
    kind: "chamfer",
    previewFaces,
    positions,
    previewFaceColors,
    previewEdgeColors: edgeColor,
    vanishingEdges: vanishing,
    snap,
    commit,
  };
}
