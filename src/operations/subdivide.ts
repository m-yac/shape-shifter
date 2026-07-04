import { Vector3, Ray, Color } from "three";
import {
  type Mesh,
  type HEFace,
  outgoingHalfEdges,
} from "../geometry/HalfEdge";
import {
  type Polyhedron,
  faceCentroidHE,
  faceNormalHE,
} from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { type InViewTest } from "./truncate";
import { combine, stagedFaceColors } from "./colorUtil";
import { config } from "../config";
import { closestLineParam } from "../util/lines";

const BLACK: GeomColor = [0, 0, 0];

/** Outward unit normal of a face (centroid-oriented, like SceneView). */
function outwardNormal(f: HEFace): Vector3 {
  const n = faceNormalHE(f);
  if (n.dot(faceCentroidHE(f)) < 0) n.negate();
  return n;
}

/**
 * Subdivide, driven by dragging an edge midpoint outward along the edge normal
 * (the mean of its two bordering face normals). Like truncate/kis the gesture is
 * global: dragging ONE edge subdivides EVERY edge. A new vertex is placed in the
 * middle of each edge (raised along the normal), every original vertex is kept (as
 * the apex of its vertex figure), each original face becomes the polygon of its
 * edge midpoints, and each original vertex grows a fan of triangles to its
 * surrounding midpoints.
 *
 *   t = 0 → coplanar with the original (midpoints flat, looks unchanged).
 *   0 < t < 1 → the subdivided solid (e.g. cube → 6 quads + 24 triangles).
 *   t = 1 → the raised faces become coplanar with each original face again and
 *           weld back into it (the original solid).
 *
 * @param poly current polyhedron
 * @param edge the dragged undirected edge (vertex-id pair), for the snap axis
 */
export function buildSubdivide(
  poly: Polyhedron,
  edge: [number, number],
  _inView: InViewTest | null = null,
): MorphPlan {
  const dcel = poly.dcel;
  const old = poly.colors;

  // ---- Index a vertex at every edge midpoint, plus an apex at every vertex. ----
  const edgeIndex = new Map<string, number>(); // edgeKey -> midpoint vertex index
  const midData: Array<{ index: number; mid: Vector3; normal: Vector3; key: string }> = [];
  let idx = 0;
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue; // once per undirected edge
    const p = he.origin.position;
    const q = he.next.origin.position;
    const key = edgeKey(he.origin.id, he.next.origin.id);
    const normal = outwardNormal(he.face).add(outwardNormal(he.twin.face)).normalize();
    edgeIndex.set(key, idx);
    midData.push({ index: idx, mid: p.clone().add(q).multiplyScalar(0.5), normal, key });
    idx++;
  }
  const E = idx;
  const apexOf = (vid: number) => E + vid;
  const vertexCount = E + dcel.vertices.length;

  // The limit (hMax) is the lift at which every vertex's corner fan becomes
  // coplanar: there its triangles merge into the vertex-figure polygon and the
  // apex welds away, so the solid becomes its RECTIFICATION. For a vertex v with
  // axis a (its mean face normal), an incident edge midpoint m raised by s along
  // its normal n lies level with the apex when (v − m)·a = s (n·a), so the lift
  // that flattens the fan is s = (v − m)·a / (n·a). This differs per vertex on an
  // irregular solid; the mean is exact for the vertex/edge-transitive Platonic
  // solids and a good heuristic otherwise (the post-release solver refines it).
  const midByKey = new Map<string, { mid: Vector3; normal: Vector3 }>();
  for (const m of midData) midByKey.set(m.key, m);
  let hSum = 0;
  let hCount = 0;
  for (const v of dcel.vertices) {
    const ring = outgoingHalfEdges(v);
    const axis = new Vector3();
    for (const h of ring) axis.add(outwardNormal(h.face));
    if (axis.lengthSq() < 1e-18) continue;
    axis.normalize();
    let s = 0;
    let n = 0;
    for (const h of ring) {
      const md = midByKey.get(edgeKey(h.origin.id, h.next.origin.id));
      if (!md) continue;
      const denom = md.normal.dot(axis);
      if (Math.abs(denom) < 1e-6) continue;
      s += v.position.clone().sub(md.mid).dot(axis) / denom;
      n++;
    }
    if (n > 0) {
      hSum += s / n;
      hCount++;
    }
  }
  // Fall back to a fraction of the average edge length if the heuristic degenerates.
  let avgLen = 0;
  for (const m of midData) {
    const [a, b] = m.key.split("_").map(Number);
    avgLen += dcel.vertices[a].position.distanceTo(dcel.vertices[b].position);
  }
  avgLen /= Math.max(1, midData.length);
  const hMax = hCount > 0 && hSum > 0 ? hSum / hCount : 0.5 * avgLen;

  function positions(t: number): Vector3[] {
    const out: Vector3[] = new Array(vertexCount);
    for (const m of midData) out[m.index] = m.mid.clone().addScaledVector(m.normal, t * hMax);
    for (const v of dcel.vertices) out[apexOf(v.id)] = v.position.clone();
    return out;
  }

  // ---- Faces: per-face midpoint polygon + per-vertex triangle fan. ------------
  // Colors (config.colors.operations.subdivide): midpoint vertex ← newVertex; central
  // polygon keeps the old face; corner triangle ← newFace. The drag stages each preview
  // face across THREE colors (see colorUtil.stagedFaceColors): the ORIGINAL solid at
  // t=0, the subdivision at t=0.5, then the welded Rectify at t=1.
  const C = config.colors.operations;
  const midColor = (vid: number, wid: number): GeomColor =>
    old.edge.get(edgeKey(vid, wid)) ?? BLACK;
  const previewFaces: number[][] = [];
  const faceOrig: GeomColor[] = []; // t=0: the original solid's face color (looks unchanged)
  const faceMid: GeomColor[] = []; // t=0.5: the subdivision color (also the un-welded commit)
  const faceEnd: GeomColor[] = []; // t=1: the welded (Rectify) color it merges into

  const midOf = (vid: number, wid: number) => edgeIndex.get(edgeKey(vid, wid))!;

  // (a) one polygon per original face, through its edge midpoints — keeps its face
  // color throughout (original = subdivided = rectified central polygon).
  for (const f of dcel.faces) {
    const loop: number[] = [];
    let h = f.halfedge;
    const start = h;
    do {
      loop.push(midOf(h.origin.id, h.next.origin.id));
      h = h.next;
    } while (h !== start);
    previewFaces.push(loop);
    faceOrig.push(old.face[f.id]);
    faceMid.push(old.face[f.id]);
    faceEnd.push(old.face[f.id]);
  }
  // (b) one triangle per (vertex, consecutive incident-edge pair): the corner fan.
  const cornerTriangles: number[][] = [];
  for (const v of dcel.vertices) {
    const ring = outgoingHalfEdges(v);
    for (let i = 0; i < ring.length; i++) {
      const mi = midOf(v.id, ring[i].next.origin.id);
      const mj = midOf(v.id, ring[(i + 1) % ring.length].next.origin.id);
      const tri = [mi, apexOf(v.id), mj];
      previewFaces.push(tri);
      cornerTriangles.push(tri);
      // This triangle lies flat inside the face bordered by ring[i] and ring[i+1]
      // (they share ring[i+1].face, since ring advances via twin.next).
      const incFace = old.face[ring[(i + 1) % ring.length].face.id];
      // Original: that face's color (so the un-dragged solid looks unchanged).
      faceOrig.push(incFace);
      // Subdivided: newFace, from this incident face and the corner's vertex.
      faceMid.push(combine(C.subdivide.newFace, {
        oldFace: incFace,
        oldVertex: old.vertex[v.id],
      }));
      // Rectify weld: the corner fan of v merges into its vertex figure = old vertex.
      faceEnd.push(old.vertex[v.id]);
    }
  }

  // ---- Vertex + edge colors --------------------------------------------------
  const vertexColor: GeomColor[] = new Array(vertexCount);
  for (const m of midData) {
    const [a, b] = m.key.split("_").map(Number);
    vertexColor[m.index] = combine(C.subdivide.newVertex, { oldEdge: midColor(a, b) });
  }
  for (const v of dcel.vertices) vertexColor[apexOf(v.id)] = old.vertex[v.id];

  const edgeColor = new Map<string, GeomColor>();
  // (a) central-polygon edges ← subdivFaceEdge (the shared vertex the midpoints flank,
  //     and the face they lie in).
  for (const f of dcel.faces) {
    let h = f.halfedge;
    const start = h;
    do {
      const m1 = midOf(h.origin.id, h.next.origin.id);
      const m2 = midOf(h.next.origin.id, h.next.next.origin.id);
      edgeColor.set(edgeKey(m1, m2), combine(C.subdivide.subdivFaceEdge, {
        oldVertex: old.vertex[h.next.origin.id], // the vertex the two midpoints flank
        oldFace: old.face[f.id],
      }));
      h = h.next;
    } while (h !== start);
  }
  // (b) fan edges (midpoint → apex, along an original edge) ← subdivEdgeEdge (from that
  //     original edge and its vertex).
  for (const v of dcel.vertices) {
    const ring = outgoingHalfEdges(v);
    for (let i = 0; i < ring.length; i++) {
      const wi = ring[i].next.origin.id;
      const wj = ring[(i + 1) % ring.length].next.origin.id;
      const mi = midOf(v.id, wi);
      const mj = midOf(v.id, wj);
      const apex = apexOf(v.id);
      edgeColor.set(edgeKey(mi, apex), combine(C.subdivide.subdivEdgeEdge, {
        oldEdge: midColor(v.id, wi),
        oldVertex: old.vertex[v.id],
      }));
      edgeColor.set(edgeKey(apex, mj), combine(C.subdivide.subdivEdgeEdge, {
        oldEdge: midColor(v.id, wj),
        oldVertex: old.vertex[v.id],
      }));
    }
  }

  function previewFaceColors(t: number, weld?: boolean): Color[] {
    // original solid → subdivision (t=0.5) → Rectify weld (t=1); the weld's merged
    // vertex figures are shown exactly at the weld so releasing is seamless.
    return stagedFaceColors(faceOrig, faceMid, faceEnd, t, weld);
  }

  // ---- Snap: project the cursor onto the edge-normal line from its midpoint. ---
  const eMid = dcel.vertices[edge[0]].position
    .clone()
    .add(dcel.vertices[edge[1]].position)
    .multiplyScalar(0.5);
  const eNormal =
    midData.find((m) => m.key === edgeKey(edge[0], edge[1]))?.normal.clone() ??
    new Vector3(0, 1, 0);
  function snap(ray: Ray): { t: number; point: Vector3; highlight?: { a: Vector3; b: Vector3 } } {
    let s = closestLineParam(eMid, eNormal, ray.origin, ray.direction);
    s = Math.max(0, Math.min(hMax, s));
    const point = eMid.clone().addScaledVector(eNormal, s);
    const t = hMax > 1e-9 ? s / hMax : 0;
    return {
      t,
      point,
      highlight: { a: point.clone(), b: eMid.clone().addScaledVector(eNormal, hMax) },
    };
  }

  function commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet } {
    if (weld) {
      // At the limit every vertex's corner fan is coplanar: its triangles merge
      // into the vertex-figure polygon and the apex welds away, leaving only the
      // edge-midpoint vertices — i.e. the RECTIFICATION of the solid.
      const verts: Vector3[] = new Array(E);
      const midCol: GeomColor[] = new Array(E);
      for (const m of midData) {
        verts[m.index] = m.mid.clone().addScaledVector(m.normal, hMax);
        const [a, b] = m.key.split("_").map(Number);
        // Rectify vertex ← its source edge (subdivide.newVertex).
        midCol[m.index] = combine(C.subdivide.newVertex, { oldEdge: midColor(a, b) });
      }
      const faces: number[][] = [];
      const rFaceColor: GeomColor[] = [];
      // (a) the central polygon of each original face (through its edge midpoints).
      for (const f of dcel.faces) {
        const loop: number[] = [];
        let h = f.halfedge;
        const start = h;
        do {
          loop.push(midOf(h.origin.id, h.next.origin.id));
          h = h.next;
        } while (h !== start);
        faces.push(loop);
        rFaceColor.push(old.face[f.id]);
      }
      // (b) the vertex figure of each original vertex (its surrounding midpoints).
      // At the limit this is the rectify face-from-vertex, which reuses truncate.newFace
      // — the same rule truncate.ts applies to this exposed n-gon.
      for (const v of dcel.vertices) {
        faces.push(outgoingHalfEdges(v).map((h) => midOf(v.id, h.next.origin.id)));
        rFaceColor.push(combine(C.truncate.newFace, { oldVertex: old.vertex[v.id] }, "truncate.newFace"));
      }
      const rEdgeColor = new Map<string, GeomColor>();
      for (const loop of faces) {
        for (let i = 0; i < loop.length; i++) {
          // Rectify edge: the color of one endpoint midpoint (its source old edge).
          rEdgeColor.set(edgeKey(loop[i], loop[(i + 1) % loop.length]), midCol[loop[i]] ?? BLACK);
        }
      }
      return {
        mesh: { vertices: verts, faces },
        colors: { vertex: midCol, face: rFaceColor, edge: rEdgeColor },
      };
    }
    return {
      mesh: { vertices: positions(t), faces: previewFaces.map((f) => f.slice()) },
      colors: {
        vertex: vertexColor.slice(),
        face: faceMid.slice(), // the un-welded subdivision color
        edge: new Map(edgeColor),
      },
    };
  }

  return {
    kind: "subdivide",
    previewFaces,
    positions,
    previewFaceColors,
    previewEdgeColors: edgeColor,
    vanishingEdges: [],
    snap,
    commit,
  };
}
