import { Vector3, Ray, Color } from "three";
import { type Mesh, type HEFace, faceVertices } from "../geometry/HalfEdge";
import { type Polyhedron, faceCentroidHE } from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { type InViewTest } from "./truncate";
import { weldVertexPairs } from "./weld";
import { combine, dualRule, lerpFaceColors } from "./colorUtil";
import { config } from "../config";
import { closestLineParam } from "../util/lines";

const BLACK: GeomColor = [0, 0, 0];

/** Vertices of a face as an ordered id loop. */
function faceLoopIds(f: HEFace): number[] {
  return faceVertices(f).map((v) => v.id);
}

/** Invert a symmetric 3x3 matrix given as 9 row-major numbers, or null if it is
 *  (near-)singular. Used to least-squares-fit a chamfer vertex onto the planes of
 *  its incident hexagons. */
function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  return [
    A * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    C * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

/**
 * Chamfer ↔ Join, driven by dragging an edge midpoint sideways along a bordering
 * face. Like truncate/kis the gesture is global: dragging ONE edge chamfers EVERY
 * edge (the handle just sets the global inset). Each original face shrinks toward
 * its centroid, each original edge is replaced by a hexagon spanning the gap, and
 * every original vertex is kept.
 *
 *   t = 0 → coincident with the original (zero inset, hexagons collapsed).
 *   0 < t < 1 → the chamfered solid (n-gons + hexagons).
 *   t = 1 → Join: every face has shrunk to its centroid; welding the collapsed
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

  // ---- Index the inset ("new") vertices: one per (face, vertex) corner. -------
  const cornerIndex = new Map<string, number>(); // `${faceId}_${vId}` -> new index
  const cornerOf = (fid: number, vid: number) => cornerIndex.get(`${fid}_${vid}`)!;
  // Per inset vertex, cache its original vertex position and its face centroid so
  // positions(t) is a cheap lerp.
  // Chamfer is the exact DUAL of subdivide, so its rules are the dualized (vertex↔
  // face) subdivide rules (see colorUtil.dualRule). An inset corner (a new vertex) ←
  // dual(subdivide.newFace) = old vertex + this face/10. (At the Join weld a face's
  // insets collapse to its centre, which recolors to the join apex = old face — see
  // commit.)
  const C = config.colors.operations;
  const insets: Array<{ index: number; v: Vector3; c: Vector3; color: GeomColor }> = [];
  let idx = V;
  for (const f of dcel.faces) {
    const centroid = faceCentroidHE(f);
    const loop = faceVertices(f);
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i];
      cornerIndex.set(`${f.id}_${v.id}`, idx);
      insets.push({
        index: idx,
        v: v.position,
        c: centroid,
        color: combine(dualRule(C.subdivide.newFace), {
          oldVertex: old.vertex[v.id],
          oldFace: old.face[f.id],
        }),
      });
      idx++;
    }
  }
  const vertexCount = idx;

  // ---- Move the original vertices so the new hexagons stay planar. -------------
  // Each undirected edge's hexagon is `[p, A_p, A_q, q, B_q, B_p]`. Its four inset
  // corners always form a parallelogram (so they're coplanar) whose plane has
  // normal N = (q−p)×(c_B−c_A) through the parallelogram center C(t) = lerp(m, k, t)
  // (m = edge midpoint, k = mean of the two face centroids). The hexagon is planar
  // exactly when p and q also lie in that plane. Each original vertex sits on one
  // such plane per incident edge; we least-squares fit it to all of them (exact for
  // symmetric solids, and continuous from the identity since every vertex already
  // lies on all its planes at t = 0). The shrunk faces stay planar regardless, so
  // moving the originals doesn't disturb them.
  interface PlaneRef { N: Vector3; m: Vector3; k: Vector3; }
  const vPlanes: PlaneRef[][] = Array.from({ length: V }, () => []);
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue; // once per undirected edge
    const p = he.origin.position;
    const q = he.next.origin.position;
    const cA = faceCentroidHE(he.face);
    const cB = faceCentroidHE(he.twin.face);
    const N = q.clone().sub(p).cross(cB.clone().sub(cA));
    if (N.lengthSq() < 1e-18) continue;
    N.normalize();
    const m = p.clone().add(q).multiplyScalar(0.5);
    const k = cA.clone().add(cB).multiplyScalar(0.5);
    const ref: PlaneRef = { N, m, k };
    vPlanes[he.origin.id].push(ref);
    vPlanes[he.next.origin.id].push(ref);
  }
  // Per vertex: the inverse normal-matrix (Σ N Nᵀ), or null when under-determined
  // (then the vertex doesn't move). Constant across t, so precompute once.
  const vInv: (number[] | null)[] = new Array(V);
  for (let v = 0; v < V; v++) {
    const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const { N } of vPlanes[v]) {
      M[0] += N.x * N.x; M[1] += N.x * N.y; M[2] += N.x * N.z;
      M[3] += N.y * N.x; M[4] += N.y * N.y; M[5] += N.y * N.z;
      M[6] += N.z * N.x; M[7] += N.z * N.y; M[8] += N.z * N.z;
    }
    vInv[v] = invert3(M);
  }

  /** The planarizing position of original vertex `v` at parameter `t`. */
  function movedVertex(v: number, t: number): Vector3 {
    const inv = vInv[v];
    if (!inv) return dcel.vertices[v].position.clone();
    let bx = 0, by = 0, bz = 0;
    for (const { N, m, k } of vPlanes[v]) {
      // plane point C(t) = lerp(m, k, t); residual basis Σ N (N·C)
      const cx = m.x + (k.x - m.x) * t;
      const cy = m.y + (k.y - m.y) * t;
      const cz = m.z + (k.z - m.z) * t;
      const d = N.x * cx + N.y * cy + N.z * cz;
      bx += N.x * d; by += N.y * d; bz += N.z * d;
    }
    return new Vector3(
      inv[0] * bx + inv[1] * by + inv[2] * bz,
      inv[3] * bx + inv[4] * by + inv[5] * bz,
      inv[6] * bx + inv[7] * by + inv[8] * bz,
    );
  }

  function positions(t: number): Vector3[] {
    const out: Vector3[] = new Array(vertexCount);
    for (let i = 0; i < V; i++) out[i] = movedVertex(i, t);
    for (const n of insets) out[n.index] = n.v.clone().lerp(n.c, t);
    return out;
  }

  // ---- Build the (un-welded) chamfered faces ---------------------------------
  const previewFaces: number[][] = [];
  const faceColor: GeomColor[] = [];
  const faceStart: GeomColor[] = [];

  // (a) one shrunk polygon per original face (same arity, inset toward centroid).
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
    // The new hexagon replaces the original edge → dual(subdivide.newVertex) = old
    // edge color (constant through the drag; the welded rhombus keeps it at the Join
    // limit).
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
      // Shrunk-face perimeter edges collapse when the face shrinks to its centroid at
      // the Join — the dual of subdivide's fan edges (which vanish at the Rectify) —
      // so ← dual(subdivEdgeEdge) = the original edge it insets from + this face/10.
      edgeColor.set(edgeKey(loop[i], loop[(i + 1) % loop.length]),
        combine(dualRule(C.subdivide.subdivEdgeEdge), {
          oldEdge: old.edge.get(edgeKey(vids[i], vids[(i + 1) % vids.length])) ?? BLACK,
          oldFace: old.face[f.id],
        }));
    }
  }
  // Connector edges (original vertex → its inset corners) SURVIVE the Join — each
  // becomes a spoke to the collapsed face centre, exactly like a kis spoke (the dual
  // of subdivide's central-polygon edges, which survive as the Rectify edges) — so ←
  // dual(subdivFaceEdge) = the face the connector lies in + its original vertex/10.
  // (This makes a chamfer→Join color-identical to joining directly.)
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

  // ---- Weld: each face collapses to its centroid at the Join end. -------------
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
  //  tracked face's centroid. s = how far the inset seam has swept across the face. -
  const a = dcel.vertices[edge[0]].position;
  const b = dcel.vertices[edge[1]].position;
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const trackC = faceCentroidHE(dcel.faces[trackFaceId]);
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
      // At the Join each face's insets collapse to its centroid, becoming the join
      // apex vertex — which (like a kis apex, the dual) is the old FACE color, NOT the
      // inset's old-vertex tint. Recolor them so a chamfer→Join matches joining
      // directly (e.g. cube → rhombic dodecahedron identically).
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
