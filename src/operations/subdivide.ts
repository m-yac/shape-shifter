import { Vector3, Ray, Color } from "three";
import { type Mesh, outgoingHalfEdges } from "../geometry/HalfEdge";
import { type Polyhedron, newellNormal } from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { type InViewTest, computeCollapseFractions } from "./truncate";
import { combine, stagedFaceColors } from "./colorUtil";
import { config } from "../config";
import { closestLineParam } from "../util/lines";

const BLACK: GeomColor = [0, 0, 0];

/** Best-fit plane of a ring of points, as a point + unit normal. */
function ringPlane(ring: Vector3[]): { c: Vector3; n: Vector3 } {
  const c = new Vector3();
  for (const p of ring) c.add(p);
  c.multiplyScalar(1 / ring.length);
  return { c, n: newellNormal(ring) };
}

/**
 * Subdivide, driven by dragging an edge's new vertex outward. Like truncate and kis the
 * gesture is global: dragging one edge subdivides every edge. A new vertex is placed on
 * each edge (at truncate's collapse point, see the note in the body), every original
 * vertex is kept (as the apex of its vertex figure), each original face becomes the
 * polygon of its edge vertices, and each original vertex grows a fan of triangles to its
 * surrounding edge vertices.
 *
 *   t = 0 → coplanar with the original (midpoints flat, looks unchanged).
 *   0 < t < 1 → the subdivided solid (e.g. cube → 6 quads + 24 triangles).
 *   t = 1 → the raised faces become coplanar with each original face again and
 *           weld back into it (the original solid).
 *
 * @param poly current polyhedron
 * @param edge the dragged undirected edge (vertex-id pair), for the snap axis
 * @param collapse per-half-edge truncation collapse fractions (see
 *   `computeCollapseFractions`); solved here if omitted. The solve is costly, so callers
 *   that rebuild the plan mid-drag should pass their memoized map.
 */
export function buildSubdivide(
  poly: Polyhedron,
  edge: [number, number],
  _inView: InViewTest | null = null,
  collapse: Map<number, number> = computeCollapseFractions(poly),
): MorphPlan {
  const dcel = poly.dcel;
  const old = poly.colors;

  // ---- Index a vertex on every edge, plus an apex at every vertex. ------------
  //
  // Subdivide is the dual of chamfer, and its geometry follows the same rule: reuse the
  // weld limit's solver rather than a heuristic. Chamfer shrinks each face toward kis's
  // join apex; dually, subdivide's new vertex on edge (p,q) sits at truncate's collapse
  // point `p + s·(q−p)`, where a Rectify's two cut ends meet (`computeCollapseFractions`
  // solves the s that keeps every vertex n-gon planar). Two properties follow, both of
  // which a raised edge midpoint lacks:
  //
  //   * the new vertices of a face lie on that face's edges, hence in its plane, so the
  //     central polygon is exactly planar and convex (the edge points of a convex polygon
  //     always are); a lifted midpoint polygon is neither;
  //   * the ring around a vertex is planar, so the corner fan flattens cleanly and the
  //     weld is truncate's Rectify exactly, not an approximation of it.
  //
  // The drag then plays out on the other end: the apex sinks from v to the plane of its
  // ring (where the fan flattens and it welds away), and the solid is rescaled each frame
  // so that sinking is seen as the two halves of one gesture — the edge vertices sweeping
  // outward under the cursor while the original vertices draw inward at the same rate (see
  // `scaleAt`).
  const edgeIndex = new Map<string, number>(); // edgeKey -> edge vertex index
  const midData: Array<{ index: number; rest: Vector3; key: string }> = [];
  let idx = 0;
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue; // once per undirected edge
    const key = edgeKey(he.origin.id, he.next.origin.id);
    const s = collapse.get(he.id) ?? 0.5;
    edgeIndex.set(key, idx);
    midData.push({
      index: idx,
      rest: he.origin.position.clone().lerp(he.next.origin.position, s),
      key,
    });
    idx++;
  }
  const E = idx;
  const apexOf = (vid: number) => E + vid;
  const vertexCount = E + dcel.vertices.length;

  const restOf = new Map<string, Vector3>();
  for (const m of midData) restOf.set(m.key, m.rest);
  const ringOf = (v: (typeof dcel.vertices)[number]) =>
    outgoingHalfEdges(v).map((h) => restOf.get(edgeKey(h.origin.id, h.next.origin.id))!);

  // Where each apex lands at t=1: the foot of v on the plane of its ring, i.e. the
  // lift at which its corner fan goes flat.
  const foot = new Map<number, Vector3>();
  for (const v of dcel.vertices) {
    const ring = ringOf(v);
    if (ring.length < 3) {
      foot.set(v.id, v.position.clone());
      continue;
    }
    const { c, n } = ringPlane(ring);
    foot.set(v.id, v.position.clone().addScaledVector(n, -v.position.clone().sub(c).dot(n)));
  }

  const meanRadius = (pts: Vector3[]) =>
    pts.reduce((s, p) => s + p.length(), 0) / Math.max(1, pts.length);
  const R0 = meanRadius(dcel.vertices.map((v) => v.position)); // apexes at rest
  const R1 = meanRadius(dcel.vertices.map((v) => foot.get(v.id)!)); // apexes at the weld
  const RM = meanRadius(midData.map((m) => m.rest)); // the edge vertices, which never move

  /** Apex positions at `t`, before the rescale. */
  const sunkApexes = (t: number): Vector3[] =>
    dcel.vertices.map((v) => v.position.clone().lerp(foot.get(v.id)!, t));

  // ---- The rescale: the two halves of the gesture, split evenly. -------------
  //
  // Unscaled, only the apexes move (each sinking toward its ring's plane); the edge
  // vertices sit still on the edges. The solid is scale-invariant, so the rescale is free
  // to say where that relative motion is *seen*, and it puts half in each: the apexes
  // travel inward exactly as far as the edge vertices travel outward, so the solid opens
  // up around a fixed size instead of inflating. (Holding the apexes still instead — the
  // whole motion loaded onto the edge vertices — blows the welded rectification up by
  // R0/R1, half again on a cube and 3× on a tetrahedron, and a volute then bloomed its
  // corners out of that already-inflated frame.)
  //
  // With A(t) the apexes' mean radius before the rescale, equal travel at scale k reads
  //     R0 − k·A(t) = k·RM − RM   ⟹   k(t) = (R0 + RM) / (A(t) + RM).
  //
  // A(t) interpolates the mean radius rather than averaging the interpolated radii: both
  // agree at t=0 and t=1 (and everywhere on a symmetric solid, where each vertex sinks
  // along its own radial), but only this form inverts in closed form. A mean of norms does
  // not, and inverting it numerically would leave `snap` unable to return exactly t=1, the
  // only value the drag controller welds on.
  const apexRadius = (t: number) => R0 + t * (R1 - R0);
  const scaleAt = (t: number) =>
    apexRadius(t) + RM > 1e-9 ? (R0 + RM) / (apexRadius(t) + RM) : 1;
  const kMax = scaleAt(1);

  /** Exact inverse of `scaleAt`. */
  function tForScale(k: number): number {
    if (Math.abs(R1 - R0) < 1e-12 || k <= 1) return 0;
    const a = (R0 + RM) / k - RM; // the apex radius this scale corresponds to
    return Math.max(0, Math.min(1, (a - R0) / (R1 - R0)));
  }

  function positions(t: number): Vector3[] {
    const k = scaleAt(t);
    const out: Vector3[] = new Array(vertexCount);
    for (const m of midData) out[m.index] = m.rest.clone().multiplyScalar(k);
    const apex = sunkApexes(t);
    dcel.vertices.forEach((v, i) => {
      out[apexOf(v.id)] = apex[i].multiplyScalar(k);
    });
    return out;
  }

  // ---- Faces: per-face midpoint polygon + per-vertex triangle fan. ------------
  // Colors (config.colors.operations.subdivide): midpoint vertex ← newVertex; central
  // polygon keeps the old face; corner triangle ← newFace. The drag stages each preview
  // face across three colors (see colorUtil.stagedFaceColors): the original solid at t=0,
  // the subdivision at t=0.5, then the welded Rectify at t=1.
  const C = config.colors.operations;
  const midColor = (vid: number, wid: number): GeomColor =>
    old.edge.get(edgeKey(vid, wid)) ?? BLACK;
  const previewFaces: number[][] = [];
  const faceOrig: GeomColor[] = []; // t=0: the original solid's face color (looks unchanged)
  const faceMid: GeomColor[] = []; // t=0.5: the subdivision color (also the un-welded commit)
  const faceEnd: GeomColor[] = []; // t=1: the welded (Rectify) color it merges into

  const midOf = (vid: number, wid: number) => edgeIndex.get(edgeKey(vid, wid))!;

  // (a) one polygon per original face, through its edge midpoints. It keeps its color
  // throughout (original = subdivided = rectified central polygon).
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
  // (b) one triangle per (vertex, consecutive incident-edge pair): the corner fan. At the
  // Rectify weld the fan goes flat and merges into v's vertex figure, so its spokes (edge
  // vertex → apex) dissolve, dual to the original edges kis dissolves when its pyramid
  // triangles merge into a Join quad. Hiding them at t=1 makes the fan read as the single
  // vertex-figure polygon before the geometry welds.
  const fanDissolve: Array<[number, number]> = [];
  const cornerTriangles: number[][] = [];
  for (const v of dcel.vertices) {
    const ring = outgoingHalfEdges(v);
    for (const h of ring) fanDissolve.push([midOf(v.id, h.next.origin.id), apexOf(v.id)]);
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
    // original solid → subdivision (t=0.5) → Rectify weld (t=1); the weld's merged vertex
    // figures are shown exactly at the weld so releasing is seamless.
    return stagedFaceColors(faceOrig, faceMid, faceEnd, t, weld);
  }

  // ---- Snap: the dragged edge's vertex sweeps outward along its radial, from its rest
  //  point to where the Rectify weld leaves it. The cursor's travel `s` fixes the scale,
  //  which `tForScale` inverts exactly, so dragging to the far end yields t=1 on the nose
  //  and the drag controller welds.
  const eRest =
    midData.find((m) => m.key === edgeKey(edge[0], edge[1]))?.rest.clone() ??
    dcel.vertices[edge[0]].position.clone();
  const eDir = eRest.clone().normalize();
  const eLen = eRest.length();
  const sMax = eLen * (kMax - 1); // outward travel over the whole drag

  function snap(ray: Ray): { t: number; point: Vector3; highlight?: { a: Vector3; b: Vector3 } } {
    let s = closestLineParam(eRest, eDir, ray.origin, ray.direction);
    s = Math.max(0, Math.min(sMax, s));
    const t = sMax > 1e-9 ? (s >= sMax ? 1 : tForScale(1 + s / eLen)) : 0;
    return {
      t,
      point: eRest.clone().addScaledVector(eDir, s),
      highlight: { a: eRest.clone().addScaledVector(eDir, s), b: eRest.clone().multiplyScalar(kMax) },
    };
  }

  function commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet } {
    if (weld) {
      // At the limit every vertex's corner fan is coplanar: its triangles merge into the
      // vertex-figure polygon and the apex welds away, leaving only the edge-midpoint
      // vertices, i.e. the rectification of the solid.
      const verts: Vector3[] = new Array(E);
      const midCol: GeomColor[] = new Array(E);
      for (const m of midData) {
        verts[m.index] = m.rest.clone().multiplyScalar(kMax);
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
      // (b) the vertex figure of each original vertex (its surrounding midpoints). At the
      // limit this is the rectify face-from-vertex, reusing truncate.newFace, the same
      // rule truncate.ts applies to this exposed n-gon.
      for (const v of dcel.vertices) {
        faces.push(outgoingHalfEdges(v).map((h) => midOf(v.id, h.next.origin.id)));
        rFaceColor.push(combine(C.truncate.newFace, { oldVertex: old.vertex[v.id] }, "truncate.newFace"));
      }
      // Rectify edges ← rectify.newEdge (oldFace + oldVertex)/2, as truncate's Rectify
      // path colors them: the welded subdivide is the rectification, so its edges match.
      // Each rectify edge is a central-polygon edge of one original face `f` flanking one
      // original vertex (the corner its two midpoints straddle); that (face, vertex) pair
      // is its source. Copying an endpoint vertex's own color instead would make every
      // edge collide with that vertex (see tests/colorIds).
      const rEdgeColor = new Map<string, GeomColor>();
      for (const f of dcel.faces) {
        let h = f.halfedge;
        const start = h;
        do {
          const m1 = midOf(h.origin.id, h.next.origin.id);
          const m2 = midOf(h.next.origin.id, h.next.next.origin.id);
          rEdgeColor.set(edgeKey(m1, m2), combine(C.rectify.newEdge, {
            oldVertex: old.vertex[h.next.origin.id], // the corner the two midpoints flank
            oldFace: old.face[f.id],
          }, "rectify.newEdge"));
          h = h.next;
        } while (h !== start);
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
    vanishingEdges: fanDissolve,
    snap,
    commit,
  };
}
