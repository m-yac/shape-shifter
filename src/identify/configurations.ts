import {
  type DCEL,
  faceOrder,
  vertexDegree,
  facesAroundVertex,
  faceVertices,
} from "../geometry/HalfEdge";

/**
 * Canonical form of a cyclic sequence: the lexicographically smallest string
 * over all rotations AND the reversal (so orientation/handedness doesn't matter).
 * e.g. [4,3,4,3] and [3,4,3,4] both canonicalize to "3.4.3.4".
 */
export function canonicalSequence(seq: number[]): string {
  if (seq.length === 0) return "";
  const rotations = (arr: number[]): number[][] =>
    arr.map((_, i) => arr.slice(i).concat(arr.slice(0, i)));
  const cmp = (a: number[], b: number[]): number => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  const candidates = [...rotations(seq), ...rotations(seq.slice().reverse())];
  candidates.sort(cmp);
  return candidates[0].join(".");
}

/** Vertex configuration = the cyclic list of face orders around a vertex. */
export function vertexConfig(dcel: DCEL, vId: number): string {
  const orders = facesAroundVertex(dcel.vertices[vId]).map(faceOrder);
  return canonicalSequence(orders);
}

/** Face configuration = the cyclic list of vertex degrees around a face. */
export function faceConfig(dcel: DCEL, fId: number): string {
  const degrees = faceVertices(dcel.faces[fId]).map(vertexDegree);
  return canonicalSequence(degrees);
}

export interface Signature {
  V: number;
  E: number;
  F: number;
  /** canonical vertex configuration -> how many vertices have it */
  vertexConfigs: Record<string, number>;
  /** canonical face configuration -> how many faces have it */
  faceConfigs: Record<string, number>;
}

export function computeSignature(dcel: DCEL): Signature {
  const vertexConfigs: Record<string, number> = {};
  const faceConfigs: Record<string, number> = {};
  for (const v of dcel.vertices) {
    const key = vertexConfig(dcel, v.id);
    vertexConfigs[key] = (vertexConfigs[key] ?? 0) + 1;
  }
  for (const f of dcel.faces) {
    const key = faceConfig(dcel, f.id);
    faceConfigs[key] = (faceConfigs[key] ?? 0) + 1;
  }
  return {
    V: dcel.vertices.length,
    E: dcel.halfedges.length / 2,
    F: dcel.faces.length,
    vertexConfigs,
    faceConfigs,
  };
}

function mapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export function signaturesEqual(a: Signature, b: Signature): boolean {
  return (
    a.V === b.V &&
    a.E === b.E &&
    a.F === b.F &&
    mapsEqual(a.vertexConfigs, b.vertexConfigs) &&
    mapsEqual(a.faceConfigs, b.faceConfigs)
  );
}

/**
 * Formats a number as a unicode superscript
 */
function superscript(num: number): string {
  let result = "";
  num = Math.floor(num);
  while (num > 0) {
    result = "⁰¹²³⁴⁵⁶⁷⁸⁹"[num % 10] + result;
    num = Math.floor(num / 10);
  }
  return result;
}

/**
 * Pretty configuration string using exponents for runs: the internal canonical
 * key "4.4.4.4.4" becomes "4^5", "3.3.3.3.5" becomes "3^4.5", and alternating
 * configs like "3.4.3.4" are left as-is.
 */
export function formatConfig(canonical: string): string {
  const vals = canonical.split(".");
  const out: string[] = [];
  let i = 0;
  while (i < vals.length) {
    let j = i;
    while (j < vals.length && vals[j] === vals[i]) j++;
    const run = j - i;
    out.push(run > 1 ? `${vals[i]}${superscript(run)}` : vals[i]);
    i = j;
  }
  return out.join(".");
}

/** Human-readable one-liner, handy for the console / readout. */
export function describeSignature(sig: Signature): string {
  const fmt = (m: Record<string, number>) =>
    Object.entries(m)
      .sort()
      .map(([k, n]) => `${n}×(${formatConfig(k)})`)
      .join(", ");
  return (
    `${sig.F} Faces: ${fmt(sig.faceConfigs)}\n` +
    `${sig.V} Vertices: ${fmt(sig.vertexConfigs)}`
  );
}
