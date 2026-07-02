import { Vector3, Ray, Color } from "three";
import { type Mesh, type HEFace } from "../geometry/HalfEdge";
import { type Polyhedron } from "../geometry/polyhedron";
import { faceCentroidHE, faceNormalHE } from "../geometry/polyhedron";
import { type ColorSet, edgeKey } from "../geometry/colors";
import { type MorphPlan } from "./types";
import { faceMaxPlus1, lerpFaceColors } from "./colorUtil";
import { closestLineParam } from "../util/lines";

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
  vertexColor: number[];
  faceColor: number[]; // per preview triangle: the "at Join" color (base-edge)
  faceStart: number[]; // per preview triangle: the flat face color
  edgeColor: Map<string, number>;
  joinDissolve: Array<[number, number]>;
}

function buildKisData(poly: Polyhedron, kissed: Set<number>): KisData {
  const dcel = poly.dcel;
  const old = poly.colors;
  const V = dcel.vertices.length;

  const kfaces = new Map<number, KFace>();
  let apexIdx = V;
  for (const f of dcel.faces) {
    if (!kissed.has(f.id)) continue;
    const centroid = faceCentroidHE(f);
    const normal = faceNormalHE(f);
    let hJoin = 0;
    let he = f.halfedge;
    const start = he;
    do {
      const g = he.twin!.face;
      if (kissed.has(g.id)) {
        const solved = joinHeight(
          he.origin.position,
          he.next.origin.position,
          centroid,
          normal,
          faceCentroidHE(g),
          faceNormalHE(g),
        );
        if (solved && solved > 1e-6) hJoin = Math.max(hJoin, solved);
      }
      he = he.next;
    } while (he !== start);
    if (hJoin <= 1e-6) hJoin = 0.5 * centroid.distanceTo(f.halfedge.origin.position);
    kfaces.set(f.id, { id: f.id, centroid, normal, hJoin, apex: apexIdx++ });
  }
  const vertexCount = apexIdx;

  const previewFaces: number[][] = [];
  const triOwner: number[] = [];
  const faceColor: number[] = [];
  const faceStart: number[] = [];
  for (const f of dcel.faces) {
    const loop = faceLoop(f);
    const kf = kfaces.get(f.id);
    if (!kf) {
      previewFaces.push(loop);
      triOwner.push(f.id);
      faceColor.push(old.face[f.id]);
      faceStart.push(old.face[f.id]);
      continue;
    }
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      previewFaces.push([a, b, kf.apex]);
      triOwner.push(f.id);
      faceColor.push(old.edge.get(edgeKey(a, b)) ?? 0);
      faceStart.push(old.face[f.id]);
    }
  }

  const vertexColor: number[] = new Array(vertexCount);
  for (let i = 0; i < V; i++) vertexColor[i] = old.vertex[i];
  for (const kf of kfaces.values()) vertexColor[kf.apex] = old.face[kf.id];

  const edgeColor = new Map<string, number>();
  for (const [k, c] of old.edge) edgeColor.set(k, c);
  for (const f of dcel.faces) {
    const kf = kfaces.get(f.id);
    if (!kf) continue;
    const mp = faceMaxPlus1(f, old);
    for (const u of faceLoop(f)) edgeColor.set(edgeKey(u, kf.apex), mp);
  }

  const joinDissolve: Array<[number, number]> = [];
  for (const he of dcel.halfedges) {
    if (!he.twin || he.id >= he.twin.id) continue;
    if (kfaces.has(he.face.id) && kfaces.has(he.twin.face.id)) {
      joinDissolve.push([he.origin.id, he.next.origin.id]);
    }
  }

  return { V, vertexCount, kfaces, previewFaces, triOwner, vertexColor, faceColor, faceStart, edgeColor, joinDissolve };
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
function joinTopology(poly: Polyhedron, data: KisData): { faces: number[][]; faceColors: number[]; edge: Map<string, number> } {
  const dcel = poly.dcel;
  const old = poly.colors;
  const faces: number[][] = [];
  const faceColors: number[] = [];
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
      const baseColor = old.edge.get(edgeKey(a, b)) ?? 0;
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

  const full = buildKisData(poly, new Set(allIds));

  const selFrac = (t: number) => t;
  const nonFrac = (t: number) => Math.max(0, Math.min(1, 2 * t - 1));
  const fracFor = (t: number) => (fid: number) => (selectedSet.has(fid) ? selFrac(t) : nonFrac(t));

  function positions(t: number): Vector3[] {
    return kisPositions(poly, full, fracFor(t));
  }

  function previewFaceColors(t: number): Color[] {
    // Each triangle interpolates from its flat face color to its Join base-edge
    // color by its OWNING face's height fraction (so unselected faces don't tint
    // until they start rising at t=0.5).
    const frac = fracFor(t);
    const eff = full.triOwner.map((fid) => frac(fid));
    const out: Color[] = new Array(full.previewFaces.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = lerpFaceColors([full.faceStart[i]], [full.faceColor[i]], eff[i])[0];
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
      const sub = buildKisData(poly, selectedSet);
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
