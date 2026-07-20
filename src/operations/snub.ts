import { Vector3, Matrix3, Ray, Color } from "three";
import {
  type Mesh,
  type DCEL,
  type HalfEdge,
  outgoingHalfEdges,
} from "../geometry/HalfEdge";
import {
  type Polyhedron,
  faceCentroidHE,
  faceNormalHE,
  newellNormal,
} from "../geometry/polyhedron";
import { type ColorSet, type GeomColor, edgeKey, paletteRGB } from "../geometry/colors";
import { combine, dualRule, recolorPropellor, stagedFaceColors } from "./colorUtil";
import { type MorphPlan } from "./types";
import { type InViewTest } from "./truncate";
import { closestLineParam, distancePointToRay } from "../util/lines";
import { config } from "../config";

const BLACK: GeomColor = [0, 0, 0];

// A nominal per-split-vertex slide magnitude. Only the slide directions (and their
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

/** Centroid + outward unit normal of a ring of points (the live plane of a face whose
 *  vertices are moving with the twist). */
function ringPlane(ring: Vector3[]): { c: Vector3; n: Vector3 } {
  const c = new Vector3();
  for (const p of ring) c.add(p);
  c.multiplyScalar(1 / ring.length);
  const n = newellNormal(ring);
  if (n.dot(c) < 0) n.negate(); // outward (solid centred at the origin)
  return { c, n };
}

/**
 * Where the vertex a rectification's figure face was cut from used to sit.
 *
 * A rectification's faces are bipartite: each figure face (from an original vertex) is
 * surrounded entirely by shrunken original faces, whose planes are the original faces'
 * planes untouched. The original vertex is where those planes met, so it is recovered
 * exactly by intersecting them — and, since the recovery reads the planes off the
 * rectification itself, it comes back in whatever frame the rectification is in (the
 * subdivide weld inflates its rectification; the recovered point inflates with it).
 *
 * Three planes meet in a point, so a degree-3 figure is exact and a higher-degree one is
 * overdetermined; as truncate and kis do for their own weld solves, take the least-squares
 * meeting point via the normal equations (Σnnᵀ)·x = Σn(n·c), with a small Tikhonov pull
 * toward the figure's centroid so a nearly-flat vertex (near-parallel planes, meeting
 * point at infinity) stays bounded rather than blowing up.
 */
function figureApexHome(poly: Polyhedron, fid: number): Vector3 {
  const f = poly.dcel.faces[fid];
  const seed = faceCentroidHE(f);
  const LAMBDA = 1e-3; // vs the unit-normal data terms
  let m00 = LAMBDA, m01 = 0, m02 = 0, m11 = LAMBDA, m12 = 0, m22 = LAMBDA;
  const rhs = seed.clone().multiplyScalar(LAMBDA);
  let h = f.halfedge;
  const start = h;
  do {
    const g = h.twin?.face;
    if (g) {
      const n = faceNormalHE(g);
      const d = n.dot(faceCentroidHE(g));
      m00 += n.x * n.x; m01 += n.x * n.y; m02 += n.x * n.z;
      m11 += n.y * n.y; m12 += n.y * n.z; m22 += n.z * n.z;
      rhs.addScaledVector(n, d);
    }
    h = h.next;
  } while (h !== start);
  const inv = new Matrix3().set(m00, m01, m02, m01, m11, m12, m02, m12, m22).invert();
  return rhs.applyMatrix3(inv);
}

/**
 * One triangle of a figure's kis fan, and the snub gap triangle it welds into at the
 * propellor: `u`→`w` is the figure edge the two straddle (which dissolves in the weld),
 * `z` the gap triangle's far corner, so the merged quad is `[apex, u, z, w]`.
 */
interface FanTri {
  fid: number;
  apex: number;
  u: number;
  w: number;
  gap: number; // index of the gap triangle in the snub's face list
  z: number;
}

/**
 * The volute overlay of a snub variant: the snub with every vertex-figure face kissed
 * back into the vertex it was cut from. Only built when `buildSnub` is given a
 * `figureStart` (see `buildVolute`); the snub's own vertices, faces and handles are
 * untouched.
 */
interface VoluteData {
  vertexCount: number;
  /** One kis apex per figure face: its vertex index, the propellor apex it is headed for,
   *  and how high that lands above the figure's (moving) plane. */
  apexes: Array<{ fid: number; index: number; home: Vector3; height: number }>;
  faces: number[][];
  faceColor: GeomColor[];
  faceStart: GeomColor[];
  /** Per preview face, the color it takes at the propellor weld: a fan triangle and its gap
   *  triangle merge into a blade quad, so both show that quad's recolored color there. */
  faceWeld: GeomColor[];
  vertexColor: GeomColor[];
  edgeColor: Map<string, GeomColor>;
  /** The fan triangles, in preview order, and where each welds. */
  fans: FanTri[];
  /** The propellor: the same vertices, with each fan/gap pair merged into one quad. */
  weldFaces: number[][];
  weldFaceColor: GeomColor[];
  weldEdgeColor: Map<string, GeomColor>;
  /** How many of `weldFaces` (the leading block) are X's own kept faces, so the propellor
   *  recolor can tell them from the blade quads that follow. */
  weldKeptFaceCount: number;
  /** The propellor's recolored colors (aligned to `weldFaces`), computed once at build so
   *  the drag preview's t=1 end and the committed weld share one source. */
  weldColors: ColorSet;
}

/**
 * Snub as a twist extension of a rectification.
 *
 * Model (the Conway snub): each face of the rectification maps to a rotated and shrunk
 * face of the snub. Every degree-4 vertex splits into a pair of vertices, each shared by
 * two of the four surrounding faces; the pairing (which faces stay joined across which
 * shared edge) is the chirality. Each split vertex slides along its pair's shared kept
 * edge: the shrink cancels the rotation, so the path is a straight line and the two split
 * vertices separate along the two opposite kept edges. The two faces that separate at a
 * vertex leave a gap filled by a triangle.
 *
 * So: R-face → rotated face, R-vertex → 2 vertices + an edge, R-edge → one gap triangle
 * at the end where its two faces split. `draggedVid` is the rectify vertex the base drag
 * ended on; `originVertex` is the original (pre-rectify) vertex position the drag
 * started from; the direction back toward it is the un-rectify line, which the two
 * chiral drag handles straddle at ±45° (see below).
 *
 * With `figureStart` the plan is a **volute** instead: the same snub, but the
 * rectification's vertex-figure faces (those with id ≥ `figureStart`, since a rectify
 * keeps the original faces first and appends one figure per original vertex) are kissed
 * back into the vertices they were cut from, rising as the twist runs. Kising a
 * rectify's figures *is* the subdivision — the vertex figure becomes a corner fan again —
 * which is why the volute extends a subdivide drag exactly as the snub extends a truncate
 * drag. Unlike the plain snub, that twist ends in a weld: at t=1 each fan triangle has
 * risen flush with the gap triangle beside it, and merging the two gives the propellor —
 * the same shape a whirl's twist welds into, from the other side.
 */
export function buildSnub(
  poly: Polyhedron,
  draggedVid: number,
  originVertex: Vector3,
  _inView: InViewTest | null = null,
  figureStart: number | null = null,
  cameraPos: Vector3 | null = null,
): MorphPlan {
  const dcel = poly.dcel;
  const old = poly.colors;
  const C = config.colors.operations;
  const faceCol = twoColorFaces(dcel);
  /** Volute only: a rectify face that is an original vertex's figure, so the twist kisses
   *  it back into that vertex. */
  const isFigure = (fid: number) => figureStart !== null && fid >= figureStart;

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
    const keptEdgeCol = new Map<number, GeomColor>(); // snub vertex index → its kept edge's colour
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
          // The pair's shared kept edge, which the split vertex slides along: H[aIdx] for
          // chir 0, the previous edge for chir 1.
          const keptIdx = chir === 0 ? aIdx : (aIdx - 1 + m) % m;
          const kept = H[keptIdx];
          const slide = kept.next.origin.position.clone().sub(v.position).multiplyScalar(SEP);
          snubVerts.push({ index: idx, source: v.position.clone(), slide });
          srcVid.set(idx, v.id);
          keptEdgeCol.set(idx, old.edge.get(edgeKey(v.id, kept.next.origin.id)) ?? BLACK);
          indexOf.set(key, idx);
        }
        heVert.set(h.id, idx);
      }
    }

    // Snub colors come from the config.colors.operations.snub rules. Snub twists the
    // rectification, so those rules are phrased in rectify space and their tokens resolve
    // straight off the rectification's own stored colors (`old`): oldFace = old.face,
    // oldVertex = old.vertex, oldEdge = old.edge.

    const edgeColor = new Map<string, GeomColor>();
    // Faces: each rectification face → the loop of its corners' split vertices.
    const faces: number[][] = [];
    const faceColor: GeomColor[] = [];
    for (const f of dcel.faces) {
      const loop: number[] = [];
      let h = f.halfedge;
      const start = h;
      do { loop.push(heVert.get(h.id)!); h = h.next; } while (h !== start);
      faces.push(loop);
      // the rotated rectify face keeps its color.
      faceColor.push(old.face[f.id]);
      // Each boundary edge of this face takes snub.snubEdge, with this face as its
      // oldFace. It also borders exactly one gap triangle (built below); its oldVertex is
      // the rectify vertex that triangle opens at (the same one that triangle's newFace
      // uses), i.e. the endpoint where this face and its neighbour across the edge split
      // into distinct vertices.
      h = f.halfedge;
      do {
        const splitVid =
          heVert.get(h.id)! !== heVert.get(h.twin!.next.id)! ? h.origin.id : h.next.origin.id;
        const key = edgeKey(heVert.get(h.id)!, heVert.get(h.next.id)!);
        edgeColor.set(key, combine(C.snub.snubEdge, {
          oldFace: old.face[f.id],
          oldVertex: old.vertex[splitVid],
          // The rectify edge this boundary edge is a shrunk copy of (unused by the
          // current rule, but the natural source should it want oldEdge).
          oldEdge: old.edge.get(edgeKey(h.origin.id, h.next.origin.id)) ?? BLACK,
        }));
        h = h.next;
      } while (h !== start);
    }

    // Triangles: one per rectification edge, at the end where its two faces split.
    // Each takes snub.newFace, from the rectify vertex it opens at and the rectify edge
    // the gap opens across.
    for (const h of dcel.halfedges) {
      const ht = h.twin!;
      if (h.id >= ht.id) continue;
      const fAtV = heVert.get(h.id)!;
      const gAtV = heVert.get(ht.next.id)!;
      const fAtN = heVert.get(h.next.id)!;
      const gAtN = heVert.get(ht.id)!;
      // The triangle opens at the rectify vertex where the two faces split; its
      // first corner sits at that vertex, so srcVid gives the source rectify vertex.
      const tri = fAtV !== gAtV
        ? [fAtV, gAtV, fAtN] // split at v (meet at n)
        : [fAtN, gAtN, fAtV]; // split at n
      faces.push(tri);
      faceColor.push(combine(C.snub.newFace, {
        oldVertex: old.vertex[srcVid.get(tri[0])!],
        oldEdge: old.edge.get(edgeKey(h.origin.id, h.next.origin.id)) ?? BLACK,
      }));
    }

    const vertexColor: GeomColor[] = new Array(snubVerts.length);
    // snub.newVertex: the split vertex takes the color of the rectify edge it slides
    // along (`keptEdgeCol`).
    for (const sv of snubVerts) {
      vertexColor[sv.index] = combine(C.snub.newVertex, {
        oldEdge: keptEdgeCol.get(sv.index)!,
        oldVertex: old.vertex[srcVid.get(sv.index)!],
      });
    }
    // Remaining edges are the center split edges: a rectify vertex splits into two and
    // the new edge between them (both ends share a source rectify vertex) takes
    // snub.newEdge. (A non-center edge that somehow escaped the rotated-face pass falls
    // back to its rectify edge.)
    for (const loop of faces) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const key = edgeKey(a, b);
        if (edgeColor.has(key)) continue;
        const va = srcVid.get(a)!;
        const vb = srcVid.get(b)!;
        edgeColor.set(key, va === vb
          ? combine(C.snub.newEdge, { oldVertex: old.vertex[va] })
          : old.edge.get(edgeKey(va, vb)) ?? BLACK);
      }
    }

    return { snubVerts, heVert, faces, faceColor, vertexColor, edgeColor };
  }

  type Variant = ReturnType<typeof buildVariant>;
  const variants = [buildVariant(0), buildVariant(1)];

  /** Split-vertex positions at `t`, before any volute rescale. */
  function splitPositions(va: Variant, t: number): Vector3[] {
    const out: Vector3[] = new Array(va.snubVerts.length);
    for (const sv of va.snubVerts) out[sv.index] = sv.source.clone().addScaledVector(sv.slide, t);
    return out;
  }

  // ---- Handle geometry. The dragged vertex is the rectify vertex `P`; the base drag
  // reached it by collapsing the original edge toward `originVertex`, so the direction
  // P→originVertex is the un-rectify line. The two chiral drag handles are that line
  // rotated ±45° in P's tangent plane (90° apart, bisected by the un-rectify line), each
  // parallel to the new edge its snub chirality opens.
  //
  // The split vertices travel exactly these handles: drop the inward (radial) part of
  // each raw kept-edge slide, which would otherwise shrink the solid visibly, then
  // rotate every slide by the same tangential twist `alpha` that carries the dragged
  // vertex's slide onto its 45° handle. The drag marker then sits exactly on the dragged
  // vertex all the way out to the full snub.
  const draggedV = dcel.vertices[draggedVid];
  const P = draggedV.position.clone();
  // Mean rectification-edge length at P — the scale the full snub is sized against.
  const edgeLen =
    outAt.get(draggedVid)!.reduce((s, h) => s + h.next.origin.position.distanceTo(P), 0) /
    outAt.get(draggedVid)!.length;
  const targetSep = config.operations.snubEdgeFraction * edgeLen;
  const normal = P.clone().normalize(); // outward (solid is centred at the origin)
  const tangentTo = (v: Vector3, n: Vector3) => v.clone().addScaledVector(n, -v.dot(n));

  // Was the drag a slide across the surface into P, or a climb straight out of it? A
  // truncate drag runs along an edge, which is very nearly tangent at P, so nearly all of
  // it survives the projection into the tangent plane. A subdivide drag climbs the edge
  // normal, which at P is radial, so almost none of it does and what little is left is
  // noise pointing anywhere — hence a relative test, which noise of the wrong direction
  // can't clear, rather than an absolute epsilon.
  const back = originVertex.clone().sub(P); // the way back down the drag
  const RADIAL = 0.1; // tangential share below this ⇒ a climb
  const isClimb = tangentTo(back, normal).length() < RADIAL * back.length();

  // How the drag looked on screen coming into P: the direction it appeared to travel, with
  // the view component dropped. Null when there is nothing to read (no camera, as in
  // tests, or a drag straight down the view axis).
  let dragOnScreen: Vector3 | null = null;
  if (cameraPos) {
    const view = P.clone().sub(cameraPos).normalize();
    const drag = P.clone().sub(originVertex);
    drag.addScaledVector(view, -drag.dot(view));
    if (drag.lengthSq() > 1e-10) dragOnScreen = drag.normalize();
  }

  // The corner of P the handles hang off, and the line the two of them straddle.
  //
  // Every corner of P is bounded by two of its rectification edges, and the two
  // chiralities slide that corner's split vertex along one each — so whatever the corner,
  // its two slides straddle it and their sum bisects it. Taking the bisector from the
  // slides themselves is the one safe choice, not merely a fallback: the ±45° handles are
  // placed by which *side* of the bisector each variant's slide falls on, so a bisector
  // that does not actually lie between the two slides drops both handles on the same side
  // (one line where there should be two) or flips them, twisting the snub the wrong way
  // and coming out concave. The drag steers which corner, which is what it can safely
  // steer.
  const cornerBisector = (h: HalfEdge): Vector3 =>
    variants.reduce((acc, va) => {
      const s = tangentTo(va.snubVerts[va.heVert.get(h.id)!].slide, normal);
      return s.lengthSq() > 1e-12 ? acc.add(s.normalize()) : acc;
    }, new Vector3());

  // Which corner the drag came in over. A truncate drag walked an edge in from
  // `originVertex`, a real point on the solid, so it came over the corner whose bisector
  // points most nearly back at it — the vertex figure of the vertex it collapsed, whose
  // two edges that edge bisects. A climb came from *behind* P, radially, so it points back
  // at no corner at all; but it still travelled a direction on screen, so match the corner
  // bisectors against that instead, flattened to screen the same way.
  const viewDir = cameraPos ? P.clone().sub(cameraPos).normalize() : null;
  const flatten = (v: Vector3) =>
    isClimb && viewDir ? v.clone().addScaledVector(viewDir, -v.dot(viewDir)) : v.clone();
  const comeFrom = isClimb
    ? dragOnScreen?.clone().negate() ?? null
    : tangentTo(back, normal).normalize();

  let anchorHe = outAt.get(draggedVid)![0];
  let bisector = cornerBisector(anchorHe);
  if (comeFrom && comeFrom.lengthSq() > 1e-10) {
    let bestScore = -Infinity;
    for (const h of outAt.get(draggedVid)!) {
      const b = cornerBisector(h);
      const flat = flatten(b);
      if (flat.lengthSq() < 1e-12) continue;
      const score = flat.normalize().dot(comeFrom);
      if (score > bestScore) { bestScore = score; anchorHe = h; bisector = b; }
    }
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
    // Rescale every slide so the two vertices P splits into (`anchorIdx` and the other
    // split vertex sharing P) end up `targetSep` apart at the full snub, sizing both the
    // handle and the committed geometry to the true snub edge.
    const otherIdx = outAt.get(draggedVid)!
      .map((h) => va.heVert.get(h.id)!)
      .find((i) => i !== anchorIdx)!;
    const sep = anchor.slide.distanceTo(va.snubVerts[otherIdx].slide);
    const k = sep > 1e-9 ? targetSep / sep : 1;
    for (const sv of va.snubVerts) sv.slide.multiplyScalar(k);
    return { origin: P.clone(), slide: anchor.slide.clone() };
  });

  // ---- Volute: kis each vertex figure back into the vertex it was cut from. ----------
  //
  // Everything the snub does is left exactly as it is; the only new geometry is one apex
  // per figure. Each apex heads for the height at which its fan welds — `propellorApex`,
  // out in the direction the original vertex stood — starting flush on its figure's plane
  // (so the un-twisted rectify still reads as one flat face) and tracking that plane as the
  // twist rotates and shrinks it beneath, so the pyramid never inverts.
  //
  // The solid is left at whatever scale the rectification came in at. Rewinding that here
  // would be a uniform scale, so it buys nothing — the commit is regularized, which
  // recenters and rescales anyway — while costing the drag a visible collapse and, worse,
  // moving the split vertices off the straight handles they are supposed to ride (see
  // `snap`). So the volute scales nothing: every vertex tracks its snub slide exactly, and
  // the apexes rise out of the figures on top of that. What keeps the rise in proportion is
  // the subdivide that hands the rectification over: it splits its motion between the edge
  // vertices going out and the original vertices coming in (see subdivide.ts `scaleAt`),
  // rather than inflating the whole solid to hold the latter still.
  function apexAt(va: Variant, a: VoluteData["apexes"][number], t: number, verts: Vector3[]): Vector3 {
    const { c, n } = ringPlane(va.faces[a.fid].map((i) => verts[i]));
    return a.home.clone()
      .addScaledVector(n, -a.home.clone().sub(c).dot(n)) // flush on the live plane
      .addScaledVector(n, t * a.height);
  }

  /**
   * Where a figure's apex ends up at the propellor: the point at which every one of its
   * fan triangles has gone coplanar with the snub gap triangle across its base, so the two
   * merge into one flat quad.
   *
   * A fan triangle `[u, w, apex]` and the gap triangle `[w, u, z]` beside it are coplanar
   * exactly when the apex lies on the gap triangle's plane, and that is a condition on the
   * apex alone — the gap triangles are the snub's own, and hold still while the apex rises.
   * So the k planes around a degree-k figure pin the apex down: a degree-3 figure exactly,
   * a higher one over-determined, which (as everywhere else here) is settled by least
   * squares — the normal equations (Σnnᵀ + λI)·a = Σn(n·c) + λ·seed, seeded at the point
   * the original vertex stood at (`figureApexHome`), whose Tikhonov pull keeps a figure
   * with near-parallel gap planes from throwing its apex off to infinity.
   */
  function propellorApex(
    fid: number,
    fans: FanTri[],
    at1: Vector3[],
  ): Vector3 {
    const seed = figureApexHome(poly, fid);
    const LAMBDA = 1e-3; // vs the unit-normal data terms
    let m00 = LAMBDA, m01 = 0, m02 = 0, m11 = LAMBDA, m12 = 0, m22 = LAMBDA;
    const rhs = seed.clone().multiplyScalar(LAMBDA);
    for (const fan of fans) {
      const { c, n } = ringPlane([at1[fan.u], at1[fan.z], at1[fan.w]]);
      const d = n.dot(c);
      m00 += n.x * n.x; m01 += n.x * n.y; m02 += n.x * n.z;
      m11 += n.y * n.y; m12 += n.y * n.z; m22 += n.z * n.z;
      rhs.addScaledVector(n, d);
    }
    const inv = new Matrix3().set(m00, m01, m02, m01, m11, m12, m02, m12, m22).invert();
    return rhs.applyMatrix3(inv);
  }

  function buildVoluteData(va: Variant): VoluteData {
    const F = dcel.faces.length;
    const at1 = splitPositions(va, 1);

    // The snub face across each edge, so a figure's fan triangles can find the gap
    // triangles they weld into. The rectification's dual graph is bipartite — every edge
    // runs between an original face and a figure — so each of a figure's edges borders a
    // gap triangle, and each gap triangle borders exactly one figure: the fans and the
    // gaps pair up one to one, which is what makes the weld a clean quad per pair.
    const across = new Map<string, number[]>();
    va.faces.forEach((loop, fi) => {
      for (let i = 0; i < loop.length; i++) {
        const k = edgeKey(loop[i], loop[(i + 1) % loop.length]);
        (across.get(k) ?? across.set(k, []).get(k)!).push(fi);
      }
    });

    let idx = va.snubVerts.length;
    const apexes: VoluteData["apexes"] = [];
    const fansOf = new Map<number, FanTri[]>();
    for (const f of dcel.faces) {
      if (!isFigure(f.id)) continue;
      const loop = va.faces[f.id];
      const index = idx++;
      const fans: FanTri[] = [];
      for (let i = 0; i < loop.length; i++) {
        const u = loop[i];
        const w = loop[(i + 1) % loop.length];
        const gap = (across.get(edgeKey(u, w)) ?? []).find((x) => x !== f.id);
        if (gap === undefined) throw new Error(`volute: figure edge ${u}-${w} borders no gap triangle`);
        const z = va.faces[gap].find((v) => v !== u && v !== w)!;
        fans.push({ fid: f.id, apex: index, u, w, gap, z });
      }
      fansOf.set(f.id, fans);

      const home = propellorApex(f.id, fans, at1);
      const p1 = ringPlane(loop.map((i) => at1[i]));
      // How far above the figure's final plane that lands: the apex rises to exactly this
      // as the twist runs, so the fan reaches its weld just as the snub reaches its end. A
      // figure whose gap planes never meet outward (a flat or inverted corner) has no such
      // height, so fall back to a shallow pyramid and let the relaxer take it from there.
      let height = home.clone().sub(p1.c).dot(p1.n);
      if (!(height > 1e-6)) {
        const perim = loop.reduce(
          (s, v, i) => s + at1[v].distanceTo(at1[loop[(i + 1) % loop.length]]), 0);
        height = 0.15 * (perim / loop.length);
      }
      apexes.push({ fid: f.id, index, home, height });
    }

    // Faces: a figure becomes its fan of kis triangles; every other snub face is kept.
    // Colors are read against the snub's own faces/edges/vertices: an apex takes the figure
    // face it rises from, a fan triangle takes that face and its base edge, and a fan edge
    // takes that face and the split vertex it hangs off.
    const faces: number[][] = [];
    const faceColor: GeomColor[] = [];
    const faceStart: GeomColor[] = [];
    const faceWeld: GeomColor[] = [];
    const fans: FanTri[] = [];
    // Preview-face bookkeeping, so the weld's recolored blade colors can be written back onto
    // the right preview faces once the propellor is built: origFi → its preview index (kept
    // faces), and, parallel to `fans`, the preview index of each fan triangle.
    const previewOfFace = new Map<number, number>();
    const fanPreview: number[] = [];
    const edgeColor = new Map(va.edgeColor);
    const vertexColor = va.vertexColor.slice();
    for (let fi = 0; fi < va.faces.length; fi++) {
      if (fi >= F || !isFigure(fi)) {
        previewOfFace.set(fi, faces.length);
        faces.push(va.faces[fi].slice());
        faceColor.push(va.faceColor[fi]);
        faceStart.push(va.faceColor[fi]);
        faceWeld.push(va.faceColor[fi]);
        continue;
      }
      const a = apexes.find((x) => x.fid === fi)!;
      const figColor = va.faceColor[fi];
      vertexColor[a.index] = combine(dualRule(C.truncate.newFace), { oldFace: figColor });
      for (const fan of fansOf.get(fi)!) {
        fanPreview.push(faces.length);
        faces.push([fan.u, fan.w, a.index]);
        fans.push(fan);
        faceColor.push(combine(dualRule(C.truncate.newVertex), {
          oldFace: figColor,
          oldEdge: va.edgeColor.get(edgeKey(fan.u, fan.w)) ?? BLACK,
        }));
        // The fan lies flat inside the figure at t=0, so it starts as that one face and
        // tints into its own colors as the apex rises.
        faceStart.push(figColor);
        // …and at the weld it merges into the gap triangle beside it, forming a blade quad;
        // this is overwritten below with that quad's recolored propellor color.
        faceWeld.push(va.faceColor[fan.gap]);
        edgeColor.set(edgeKey(fan.u, a.index), combine(dualRule(C.truncate.newEdge), {
          oldFace: figColor,
          oldVertex: va.vertexColor[fan.u],
        }));
      }
    }

    // The propellor: each fan/gap pair merges across the figure edge they straddle, into
    // the quad `[apex, u, z, w]` — the fan's two spokes, then the gap's two far sides. The
    // rotated original faces come through untouched, and nothing is recolored: the merged
    // quad is the gap triangle grown a corner, so it keeps the gap's color, and only the
    // dissolved figure edges leave the edge map.
    const merged = new Set(fans.map((fan) => fan.gap));
    const weldFaces: number[][] = [];
    const weldFaceColor: GeomColor[] = [];
    for (let fi = 0; fi < va.faces.length; fi++) {
      if (fi < F && isFigure(fi)) continue; // replaced by its fan's quads
      if (merged.has(fi)) continue; // welded into a quad below
      weldFaces.push(va.faces[fi].slice());
      weldFaceColor.push(va.faceColor[fi]);
    }
    // Everything pushed so far is one of X's own faces (the rotated originals); the fan/gap
    // quads that follow are the propellor's new blades.
    const weldKeptFaceCount = weldFaces.length;
    for (const fan of fans) {
      weldFaces.push([fan.apex, fan.u, fan.z, fan.w]);
      weldFaceColor.push(va.faceColor[fan.gap]);
    }
    const weldEdgeColor = new Map(edgeColor);
    for (const fan of fans) weldEdgeColor.delete(edgeKey(fan.u, fan.w));

    // Recolor the propellor once — the same pass commit runs — so the live preview's t=1 end
    // and the committed weld share one source. The blade quads follow the kept faces in
    // `weldFaces` (one per fan, in `fans` order), so each fan's recolored color goes back
    // onto both preview faces that merge into it: the fan triangle and its gap triangle.
    const keptFaceIds = new Set<number>();
    for (let fi = 0; fi < weldKeptFaceCount; fi++) keptFaceIds.add(fi);
    const keptVertIds = new Set(apexes.map((a) => a.index));
    const weldColors = recolorPropellor(
      weldFaces.map((f) => f.slice()),
      { vertex: vertexColor.slice(), face: weldFaceColor.slice(), edge: new Map(weldEdgeColor) },
      keptFaceIds,
      keptVertIds,
    );
    for (let j = 0; j < fans.length; j++) {
      const blade = weldColors.face[weldKeptFaceCount + j];
      faceWeld[fanPreview[j]] = blade;
      const gp = previewOfFace.get(fans[j].gap);
      if (gp !== undefined) faceWeld[gp] = blade;
    }

    return {
      vertexCount: idx, apexes, faces, faceColor, faceStart, faceWeld, vertexColor,
      edgeColor, fans, weldFaces, weldFaceColor, weldEdgeColor, weldKeptFaceCount, weldColors,
    };
  }

  const volutes = figureStart === null ? null : variants.map(buildVoluteData);

  // Live twist state.
  let curT = 0;
  let sign = 1; // +1 → variant 0, −1 → variant 1
  const variantIndex = () => (sign >= 0 ? 0 : 1);

  function positions(t: number): Vector3[] {
    const va = variants[variantIndex()];
    const vol = volutes?.[variantIndex()];
    const out = splitPositions(va, t);
    if (vol) for (const a of vol.apexes) out[a.index] = apexAt(va, a, t, out);
    return out;
  }

  function previewFaceColors(t: number, weld?: boolean): Color[] {
    const vol = volutes?.[variantIndex()];
    // A snub's faces are the rectification's, rotated: nothing recolors, at any t.
    if (!vol) return variants[variantIndex()].faceColor.map((c) => paletteRGB(c));
    // A volute runs between two welds, so it reads like a base drag: the rectification at
    // t=0, the volute's own colors at t=0.5 (the shape an intermediate release commits),
    // and the propellor at t=1, where each fan triangle merges into the gap triangle beside
    // it and takes its color. The seam between that pair is hidden at the weld, so the two
    // read as the one quad they are about to become and releasing doesn't snap.
    return stagedFaceColors(vol.faceStart, vol.faceColor, vol.faceWeld, t, weld);
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
    // Highlight the active handle line so the controller renders it like every other drag
    // line. As with the truncation line, it spans only the un-dragged remainder: from the
    // dragged vertex (best.point) to the end.
    const ln = lines[best.i];
    return {
      t: curT,
      point: best.point,
      highlight: { a: best.point.clone(), b: ln.origin.clone().add(ln.slide) },
    };
  }

  function commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet } {
    const vol = volutes?.[variantIndex()];
    if (vol && weld) {
      // The twist's own weld: the fans have risen to where they lie flat against their gap
      // triangles, so merge each pair into its quad — the propellor. Its colors were recolored
      // from X at build (see recolorPropellor / weldColors), so both twists produce the
      // identical propellor and the drag preview's t=1 end already matches this commit.
      return {
        mesh: { vertices: positions(1), faces: vol.weldFaces.map((f) => f.slice()) },
        colors: {
          vertex: vol.weldColors.vertex.map((c) => c.slice()),
          face: vol.weldColors.face.map((c) => c.slice()),
          edge: new Map(vol.weldColors.edge),
        },
      };
    }
    const va = vol ?? variants[variantIndex()];
    return {
      mesh: { vertices: positions(t), faces: va.faces.map((f) => f.slice()) },
      colors: { vertex: va.vertexColor.slice(), face: va.faceColor.slice(), edge: new Map(va.edgeColor) },
    };
  }

  return {
    kind: figureStart === null ? "snub" : "volute",
    get previewFaces() {
      return volutes?.[variantIndex()].faces ?? variants[variantIndex()].faces;
    },
    get previewEdgeColors() {
      return volutes?.[variantIndex()].edgeColor ?? variants[variantIndex()].edgeColor;
    },
    // At the propellor each figure edge is the seam a fan triangle and its gap triangle
    // merge across, so it dissolves. A plain snub welds nothing.
    get vanishingEdges(): Array<[number, number]> {
      const vol = volutes?.[variantIndex()];
      return vol ? vol.fans.map((f) => [f.u, f.w] as [number, number]) : [];
    },
    positions,
    previewFaceColors,
    snap,
    commit,
    chirality: () => (variantIndex() === 0 ? "R" : "L"),
  };
}

/**
 * Volute as a twist extension of a subdivision, the way snub extends a truncation.
 *
 * A subdivide welds into the rectification by sinking each original vertex onto the plane
 * of its ring, so the volute is the snub of that rectification with those vertex figures
 * kissed straight back into the vertices they came from: the snub's rotated figures
 * become corner fans again and the original vertices reappear as their apexes (cube → 6
 * squares + 48 triangles). Everything else — the twist, its two chiralities, the straight
 * chiral handles at the rectify vertex the subdivide drag ended on — is the snub's,
 * unchanged; only the apex vertices are new, and they hold still while it happens.
 *
 * @param poly        the rectification (as the subdivide's weld produced it): the original
 *                    faces' polygons first, then one figure per original vertex, which is
 *                    what `figureStart` splits.
 * @param figureStart the index of the first figure face = the original solid's face count
 * @param dragFrom    where the subdivide drag started (the edge vertex's rest point on its
 *                    edge), which is what a snub reads its handle bisector back down. It
 *                    is radial from the rectify vertex, so the bisector only survives on
 *                    screen — see the degenerate-bisector path in `buildSnub`.
 */
export function buildVolute(
  poly: Polyhedron,
  draggedVid: number,
  figureStart: number,
  dragFrom: Vector3 | null = null,
  cameraPos: Vector3 | null = null,
  inView: InViewTest | null = null,
): MorphPlan {
  // A snub reads the drag it extends off the original vertex its truncate collapsed. A
  // subdivide drag has no such vertex — it climbed a radial off an edge — but the point it
  // climbed *from* plays the same part, so hand that over in its place. With no drag
  // origin at all (tests), the rectify vertex itself takes the fully degenerate path,
  // which straddles the two chiralities' own slide directions instead.
  const from = dragFrom ?? poly.vertices[draggedVid].clone();
  return buildSnub(poly, draggedVid, from, inView, figureStart, cameraPos);
}
