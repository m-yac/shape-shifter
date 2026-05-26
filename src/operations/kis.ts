import { Vector3, Ray } from "three";
import { type Mesh, type HEFace } from "../geometry/HalfEdge";
import { type Polyhedron } from "../geometry/polyhedron";
import { faceCentroidHE, faceNormalHE } from "../geometry/polyhedron";
import { type MorphPlan } from "./types";
import { closestLineParam } from "../util/lines";

/** Smallest strictly-positive root of A h² + B h + C, or null. */
function smallestPositiveRoot(A: number, B: number, C: number): number | null {
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) < 1e-12) return null;
    const h = -C / B;
    return h > 1e-9 ? h : null;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const candidates = [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].filter(
    (h) => h > 1e-9,
  );
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * The apex height at which the two pyramid triangles straddling edge (P1,P2)
 * become coplanar (so they merge into one quad — i.e. Join). Both apexes are
 * C_f = c_f + h*n_f and C_g = c_g + h*n_g; we require P1,P2,C_f,C_g coplanar.
 */
function joinHeight(
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
    uf.dot(new Vector3().crossVectors(w, ng)) +
    nf.dot(new Vector3().crossVectors(w, ug));
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

/**
 * Kis ↔ Join, driven by dragging a face center outward along its normal.
 *
 * Model: BY DEFAULT every face is kissed (a pyramid raised on each); the dragged
 * face is the handle setting the global height fraction. At t=1 every apex reaches
 * its join height and adjacent triangles merge into quads → Join.
 */
export function buildKis(
  poly: Polyhedron,
  draggedFid: number,
  selected: Set<number> | null,
): MorphPlan {
  const dcel = poly.dcel;
  const V = dcel.vertices.length;

  const kissed = new Set<number>(
    selected && selected.size > 0 ? selected : dcel.faces.map((f) => f.id),
  );
  kissed.add(draggedFid);

  // Per kissed face: centroid, outward normal, join height, apex vertex index.
  interface KFace {
    id: number;
    centroid: Vector3;
    normal: Vector3;
    hJoin: number;
    apex: number;
  }
  const kfaces = new Map<number, KFace>();
  let apexIdx = V;
  for (const f of dcel.faces) {
    if (!kissed.has(f.id)) continue;
    const centroid = faceCentroidHE(f);
    const normal = faceNormalHE(f);
    // Join height = apex rise at which a pyramid triangle becomes coplanar with its
    // neighbour's (so they merge into a quad). Only edges shared with ANOTHER kissed
    // face actually merge, so take the LARGEST such height — that way every mergeable
    // edge has reached (or passed) coplanarity, i.e. the faces visibly join. (Using
    // one representative edge under-rises on irregular solids / partial selections.)
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
    // Fallback (e.g. an isolated kissed face with no kissed neighbours, so nothing
    // merges): half the centroid->vertex distance, so the handle still has a max.
    if (hJoin <= 1e-6) hJoin = 0.5 * centroid.distanceTo(f.halfedge.origin.position);
    kfaces.set(f.id, { id: f.id, centroid, normal, hJoin, apex: apexIdx++ });
  }
  const apexCount = apexIdx - V;

  function positions(t: number): Vector3[] {
    const out: Vector3[] = new Array(V + apexCount);
    for (let i = 0; i < V; i++) out[i] = dcel.vertices[i].position.clone();
    for (const kf of kfaces.values()) {
      out[kf.apex] = kf.centroid
        .clone()
        .add(kf.normal.clone().multiplyScalar(t * kf.hJoin));
    }
    return out;
  }

  // Preview topology: pyramids (triangles) on kissed faces, others unchanged.
  const previewFaces: number[][] = [];
  for (const f of dcel.faces) {
    const loop = faceLoop(f);
    const kf = kfaces.get(f.id);
    if (!kf) {
      previewFaces.push(loop);
      continue;
    }
    for (let i = 0; i < loop.length; i++) {
      previewFaces.push([loop[i], loop[(i + 1) % loop.length], kf.apex]);
    }
  }

  // Join topology: merge adjacent kissed-face triangles across each shared edge
  // into one quad; triangles bordering a non-kissed face stay as triangles.
  function joinFaces(): number[][] {
    const faces: number[][] = [];
    const emitted = new Set<number>();
    for (const f of dcel.faces) {
      const kf = kfaces.get(f.id);
      if (!kf) {
        faces.push(faceLoop(f));
        continue;
      }
      let h = f.halfedge;
      const start = h;
      do {
        const a = h.origin.id;
        const b = h.next.origin.id;
        const g = h.twin!.face;
        const kg = kfaces.get(g.id);
        if (kg) {
          const key = Math.min(h.id, h.twin!.id);
          if (!emitted.has(key)) {
            emitted.add(key);
            faces.push([a, kf.apex, b, kg.apex]); // the merged rhombus/kite
          }
        } else {
          faces.push([a, b, kf.apex]); // border triangle (partial selection)
        }
        h = h.next;
      } while (h !== start);
    }
    return faces;
  }

  // Snap the ray to the dragged face's outward normal line.
  const dragged = kfaces.get(draggedFid)!;
  function snap(ray: Ray): {
    t: number;
    point: Vector3;
    highlight?: { a: Vector3; b: Vector3 };
  } {
    let s = closestLineParam(
      dragged.centroid,
      dragged.normal,
      ray.origin,
      ray.direction,
    );
    s = Math.max(0, Math.min(dragged.hJoin, s));
    const point = dragged.centroid
      .clone()
      .add(dragged.normal.clone().multiplyScalar(s));
    const t = Math.max(0, Math.min(1, s / dragged.hJoin));
    // Orange range line: from the current apex to the join (max) point.
    return {
      t,
      point,
      highlight: {
        a: point.clone(),
        b: dragged.centroid
          .clone()
          .add(dragged.normal.clone().multiplyScalar(dragged.hJoin)),
      },
    };
  }

  function commit(t: number, weld: boolean): Mesh {
    return {
      vertices: positions(t),
      faces: weld ? joinFaces() : previewFaces.map((f) => f.slice()),
    };
  }

  return { kind: "kis", previewFaces, positions, snap, commit };
}
