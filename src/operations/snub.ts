import { Vector3, Ray, Color } from "three";
import {
  type Mesh,
  type DCEL,
  type HalfEdge,
  outgoingHalfEdges,
} from "../geometry/HalfEdge";
import { type Polyhedron, faceCentroidHE } from "../geometry/polyhedron";
import { type ColorSet, edgeKey, paletteRGB } from "../geometry/colors";
import { vertexMax, vertexMaxPlus1 } from "./colorUtil";
import { type MorphPlan } from "./types";
import { type InViewTest } from "./truncate";
import { closestLineParam, distancePointToRay } from "../util/lines";
import { config } from "../config";

// A nominal per-split-vertex slide magnitude. Only the slide DIRECTIONS (and their
// relative sizes) matter: the handle step below rescales every slide uniformly so the
// dragged vertex's split reaches `snubEdgeFraction` of an edge, so this cancels out.
const SEP = 0.42;

/** Proper 2-coloring of the faces of a rectification (adjacent faces differ). A
 *  rectification's dual graph is bipartite, so this never conflicts. */
function twoColorFaces(dcel: DCEL): Map<number, 0 | 1> {
  const color = new Map<number, 0 | 1>();
  color.set(dcel.faces[0].id, 0);
  const queue = [dcel.faces[0]];
  while (queue.length) {
    const f = queue.shift()!;
    const c = color.get(f.id)!;
    let h = f.halfedge;
    const start = h;
    do {
      if (h.twin) {
        const g = h.twin.face;
        if (!color.has(g.id)) {
          color.set(g.id, (c ^ 1) as 0 | 1);
          queue.push(g);
        }
      }
      h = h.next;
    } while (h !== start);
  }
  return color;
}

/**
 * Snub as a twist extension of a RECTIFICATION.
 *
 * Model (the Conway snub): each face of the rectification maps to a rotated + shrunk
 * face of the snub. Every degree-4 vertex SPLITS INTO A PAIR of vertices, each shared
 * by two of the four surrounding faces; the pairing (which two faces stay joined
 * across which shared edge) is the chirality. Each split vertex slides along its
 * pair's shared "kept" edge — the shrink cancels the rotation, so the path is a
 * straight line and the two split vertices separate along the two opposite kept edges.
 * The two faces that separate at a vertex leave a gap filled by a triangle.
 *
 * So: `R-face → rotated face`, `R-vertex → 2 vertices + a new edge`, `R-edge → one
 * gap triangle` at the end where its two faces split. `draggedVid` is the rectify
 * vertex the base drag ended on; `originVertex` is the ORIGINAL (pre-rectify) vertex
 * position the drag started from — the direction back toward it is the "un-rectify"
 * line, which the two chiral drag handles straddle at ±45° (see below).
 */
export function buildSnub(
  poly: Polyhedron,
  draggedVid: number,
  originVertex: Vector3,
  _inView: InViewTest | null = null,
): MorphPlan {
  const dcel = poly.dcel;
  const old = poly.colors;
  const faceCol = twoColorFaces(dcel);

  const outAt = new Map<number, HalfEdge[]>();
  for (const v of dcel.vertices) outAt.set(v.id, outgoingHalfEdges(v));

  interface SnubVert { index: number; source: Vector3; slide: Vector3 }

  /** Build one chiral variant (pairing sense `chir`). */
  function buildVariant(chir: 0 | 1) {
    // Each corner (half-edge) is assigned to a split vertex keyed by (vertex, the
    // A-coloured face anchoring its pair). Both faces of a pair map to the same key.
    const keyOf = (vid: number, aface: number) => vid * 1_000_000 + aface;
    const indexOf = new Map<number, number>();
    const heVert = new Map<number, number>(); // half-edge id → snub vertex index
    const srcVid = new Map<number, number>(); // snub vertex index → source rectification vertex id
    const snubVerts: SnubVert[] = [];

    for (const v of dcel.vertices) {
      const H = outAt.get(v.id)!;
      const m = H.length;
      for (let k = 0; k < m; k++) {
        const h = H[k];
        // The A-face anchoring this corner's pair (itself if A, else the neighbour A).
        const aIdx = faceCol.get(h.face.id) === 0 ? k : (chir === 0 ? (k - 1 + m) % m : (k + 1) % m);
        const aface = H[aIdx].face.id;
        const key = keyOf(v.id, aface);
        let idx = indexOf.get(key);
        if (idx === undefined) {
          idx = snubVerts.length;
          indexOf.set(key, idx);
          // The pair's shared "kept" edge: H[aIdx] for chir 0, the previous edge for
          // chir 1. The split vertex slides along it.
          const keptIdx = chir === 0 ? aIdx : (aIdx - 1 + m) % m;
          const kept = H[keptIdx];
          const slide = kept.next.origin.position.clone().sub(v.position).multiplyScalar(SEP);
          snubVerts.push({ index: idx, source: v.position.clone(), slide });
          srcVid.set(idx, v.id);
          indexOf.set(key, idx);
        }
        heVert.set(h.id, idx);
      }
    }

    // Faces: each rectification face → the loop of its corners' split vertices.
    const faces: number[][] = [];
    const faceColor: number[] = [];
    for (const f of dcel.faces) {
      const loop: number[] = [];
      let h = f.halfedge;
      const start = h;
      do { loop.push(heVert.get(h.id)!); h = h.next; } while (h !== start);
      faces.push(loop);
      faceColor.push(old.face[f.id]);
    }

    // Triangles: one per rectification edge, at the end where its two faces split.
    for (const h of dcel.halfedges) {
      const ht = h.twin!;
      if (h.id >= ht.id) continue;
      const fAtV = heVert.get(h.id)!;
      const gAtV = heVert.get(ht.next.id)!;
      const fAtN = heVert.get(h.next.id)!;
      const gAtN = heVert.get(ht.id)!;
      // The gap triangle is a brand-NEW face; it opens at whichever end the two faces
      // split, so it takes a fresh colour keyed off that split vertex (c+2).
      const splitV = fAtV !== gAtV ? h.origin : h.next.origin;
      if (fAtV !== gAtV) faces.push([fAtV, gAtV, fAtN]); // split at v (meet at n)
      else faces.push([fAtN, gAtN, fAtV]); // split at n
      faceColor.push(vertexMax(splitV, old) + 2);
    }

    // Colours: split vertex ← its source vertex; preserved-face edges ← the original
    // rectification edge; the new split edge joining the two vertices a rectification
    // vertex splits into ← that vertex's colour; any other genuinely-new edge ← c+1.
    const vertexColor: number[] = new Array(snubVerts.length);
    for (const v of dcel.vertices) {
      for (const h of outAt.get(v.id)!) vertexColor[heVert.get(h.id)!] = old.vertex[v.id];
    }
    const edgeColor = new Map<string, number>();
    for (const f of dcel.faces) {
      let h = f.halfedge;
      const start = h;
      do {
        const c = old.edge.get(edgeKey(h.origin.id, h.next.origin.id));
        if (c !== undefined) edgeColor.set(edgeKey(heVert.get(h.id)!, heVert.get(h.next.id)!), c);
        h = h.next;
      } while (h !== start);
    }
    for (const loop of faces) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const key = edgeKey(a, b);
        if (edgeColor.has(key)) continue;
        // A split edge's two ends share a source rectification vertex → that vertex's
        // colour; anything else left over is a genuinely new edge (c+1).
        const va = srcVid.get(a);
        const vb = srcVid.get(b);
        edgeColor.set(
          key,
          va !== undefined && va === vb
            ? old.vertex[va]
            : vertexMaxPlus1(dcel.vertices[(va ?? vb)!], old),
        );
      }
    }

    return { snubVerts, heVert, faces, faceColor, vertexColor, edgeColor };
  }

  const variants = [buildVariant(0), buildVariant(1)];

  // ---- Handle geometry. The dragged vertex is the rectify vertex `P`; the base drag
  // reached it by collapsing the original edge back toward `originVertex`, so the
  // direction P→originVertex is the "un-rectify" line. The two chiral drag handles
  // are that line rotated ±45° in P's tangent plane — 90° apart, bisected by the
  // un-rectify line — each parallel to the new edge its snub chirality opens.
  //
  // The split vertices travel exactly these tangent handles: we drop the inward
  // (radial) part of each raw kept-edge slide — that inward pull is what made the
  // whole solid visibly shrink — and rotate every slide by the same tangential twist
  // `alpha` that carries the DRAGGED vertex's slide onto its 45° handle. So the drag
  // marker sits precisely on the dragged vertex all the way out to the full snub.
  const draggedV = dcel.vertices[draggedVid];
  let anchorFace = draggedV.halfedge.face;
  let bestD = Infinity;
  for (const h of outAt.get(draggedVid)!) {
    const d = faceCentroidHE(h.face).distanceTo(originVertex);
    if (d < bestD) { bestD = d; anchorFace = h.face; }
  }
  const anchorHe = outAt.get(draggedVid)!.find((h) => h.face.id === anchorFace.id)!;

  const P = draggedV.position.clone();
  // Mean rectification-edge length at P — the scale the full snub is sized against.
  const edgeLen =
    outAt.get(draggedVid)!.reduce((s, h) => s + h.next.origin.position.distanceTo(P), 0) /
    outAt.get(draggedVid)!.length;
  const targetSep = config.operations.snubEdgeFraction * edgeLen;
  const normal = P.clone().normalize(); // outward (solid is centred at the origin)
  const tangentTo = (v: Vector3, n: Vector3) => v.clone().addScaledVector(n, -v.dot(n));
  // Bisector = the un-rectify direction (P→originVertex) in P's tangent plane. If that
  // is degenerate (originVertex ≈ P, e.g. in tests) fall back to the bisector of the
  // two chiralities' true split-slide directions, which straddle it.
  let bisector = tangentTo(originVertex.clone().sub(P), normal);
  if (bisector.lengthSq() < 1e-10) {
    bisector = variants.reduce((acc, va) => {
      const s = tangentTo(va.snubVerts[va.heVert.get(anchorHe.id)!].slide, normal);
      return acc.add(s.normalize());
    }, new Vector3());
  }
  bisector.normalize();

  // Signed angle (about `axis`) rotating unit `from` onto unit `to`.
  const signedAngle = (from: Vector3, to: Vector3, axis: Vector3) =>
    Math.atan2(axis.dot(new Vector3().crossVectors(from, to)), from.dot(to));

  // Per variant: retarget every split vertex's slide onto the tangent plane, twisted
  // by the anchor's alpha, and expose the anchor's resulting slide as the drag line.
  const lines = variants.map((va) => {
    const anchorIdx = va.heVert.get(anchorHe.id)!;
    const anchor = va.snubVerts[anchorIdx];
    const anchorTan = tangentTo(anchor.slide, normal);
    const side = Math.sign(normal.dot(new Vector3().crossVectors(bisector, anchorTan))) || 1;
    const handleDir = bisector.clone().applyAxisAngle(normal, (side * Math.PI) / 4);
    const alpha = signedAngle(anchorTan.clone().normalize(), handleDir, normal);
    for (const sv of va.snubVerts) {
      const n = sv.source.clone().normalize();
      sv.slide = tangentTo(sv.slide, n).applyAxisAngle(n, alpha);
    }
    // Rescale every slide uniformly so the two vertices P splits into (`anchorIdx` and
    // the other split vertex sharing P) end up `targetSep` apart at the full snub —
    // sizing both the handle and the committed geometry to the true snub edge.
    const otherIdx = outAt.get(draggedVid)!
      .map((h) => va.heVert.get(h.id)!)
      .find((i) => i !== anchorIdx)!;
    const sep = anchor.slide.distanceTo(va.snubVerts[otherIdx].slide);
    const k = sep > 1e-9 ? targetSep / sep : 1;
    for (const sv of va.snubVerts) sv.slide.multiplyScalar(k);
    return { origin: P.clone(), slide: anchor.slide.clone() };
  });

  // Live twist state.
  let curT = 0;
  let sign = 1; // +1 → variant 0, −1 → variant 1
  const variantIndex = () => (sign >= 0 ? 0 : 1);

  function positions(t: number): Vector3[] {
    const va = variants[variantIndex()];
    const out: Vector3[] = new Array(va.snubVerts.length);
    for (const sv of va.snubVerts) out[sv.index] = sv.source.clone().addScaledVector(sv.slide, t);
    return out;
  }

  function previewFaceColors(_t: number): Color[] {
    return variants[variantIndex()].faceColor.map((c) => paletteRGB(c));
  }

  function snap(ray: Ray): { t: number; point: Vector3; highlight?: { a: Vector3; b: Vector3 } } {
    // Project the ray onto each chirality's line; take the nearest.
    let best = { i: 0, t: 0, point: lines[0].origin.clone(), dist: Infinity };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const s = Math.max(0, Math.min(1, closestLineParam(ln.origin, ln.slide, ray.origin, ray.direction)));
      const point = ln.origin.clone().addScaledVector(ln.slide, s);
      const dist = distancePointToRay(point, ray);
      if (dist < best.dist) best = { i, t: s, point, dist };
    }
    sign = best.i === 0 ? 1 : -1;
    curT = best.t;
    // Highlight the active handle line so the controller renders it exactly like
    // every other drag line (the same white tube). Like the truncation line, it spans
    // only the UN-dragged remainder — from the dragged vertex (best.point) to the end.
    const ln = lines[best.i];
    return {
      t: curT,
      point: best.point,
      highlight: { a: best.point.clone(), b: ln.origin.clone().add(ln.slide) },
    };
  }

  function commit(t: number, _weld: boolean): { mesh: Mesh; colors: ColorSet } {
    const va = variants[variantIndex()];
    return {
      mesh: { vertices: positions(t), faces: va.faces.map((f) => f.slice()) },
      colors: { vertex: va.vertexColor.slice(), face: va.faceColor.slice(), edge: new Map(va.edgeColor) },
    };
  }

  return {
    kind: "snub",
    get previewFaces() { return variants[variantIndex()].faces; },
    get previewEdgeColors() { return variants[variantIndex()].edgeColor; },
    vanishingEdges: [],
    positions,
    previewFaceColors,
    snap,
    commit,
    chirality: () => (variantIndex() === 0 ? "R" : "L"),
  };
}
