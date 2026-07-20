import {
  type DCEL,
  faceOrder,
  vertexDegree,
  facesAroundVertex,
  faceVertices,
} from "../geometry/HalfEdge";

/**
 * Canonical form of a cyclic sequence: the lexicographically smallest string over all
 * rotations and the reversal, so orientation and handedness don't matter. [4,3,4,3]
 * and [3,4,3,4] both canonicalize to "3.4.3.4".
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

/** Format a number as unicode superscript digits. */
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
 * Display form of a canonical key, using superscripts for runs: "4.4.4.4.4" becomes
 * "4^5", "3.3.3.3.5" becomes "3^4.5", and alternating configs like "3.4.3.4" are
 * left as they are.
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

/** Names for small polygon side counts; beyond the table they read "13-gon" etc. */
// const POLYGON_NAMES = [
//   "triangle", "quadrilateral", "pentagon", "hexagon", "heptagon", "octagon",
//   "nonagon", "decagon", "hendecagon", "dodecagon",
// ];
const SHORT_POLYGON_NAMES = [
  "tri", "quad", "pent", "hex", "hept", "oct", "non", "dec", "hendec", "dodec"
];
const SHORT_POLYGON_PLURAL_NAMES = [
  "tris", "quads", "pents", "hexes", "hepts", "octs", "nons", "decs", "hendecs", "dodecs"
];
function polygonName(a: number, n: number): string {
  if (n == 1)
    return SHORT_POLYGON_NAMES[a - 3] ?? `${a}-gon`;
  return SHORT_POLYGON_PLURAL_NAMES[a - 3] ?? `${a}-gons`;
}

/**
 * Count the elements of a signature map by arity — a face's side count or a
 * vertex's degree, both being the length of the canonical configuration key —
 * as [arity, count] pairs sorted by arity.
 */
function byArity(m: Record<string, number>): [arity: number, count: number][] {
  const counts = new Map<number, number>();
  for (const [k, n] of Object.entries(m)) {
    const a = k.split(".").length;
    counts.set(a, (counts.get(a) ?? 0) + n);
  }
  return [...counts].sort((x, y) => x[0] - y[0]);
}

/**
 * One "N things" clause with a per-arity breakdown: a single arity folds into the
 * head ("15 pentagonal faces"), several are parenthesized ("12 faces (8 pentagons,
 * 4 triangles)").
 */
function summarizeGroups(
  groups: [arity: number, count: number][],
  total: number,
  noun: string,
  nounPlural: string,
  item: (arity: number, count: number) => string,
): string {
  const things = total === 1 ? noun : nounPlural;
  if (groups.length == 1)
    return `${total} ${things} (all ${item(groups[0][0], total)})`;
  groups.sort(([_1, n1], [_2, n2]) => n2 - n1);
  const gs = groups.slice(0, groups.length == 3 ? 3 : 2)
                   .map(([a, n]) => `${n} ${item(a, n)}`)
                   .join(", ");
  if (groups.length <= 3)
    return `${total} ${things} (${gs})`;
  else
    return `${total} ${things} (${gs}, ...)`;
}

/**
 * Short form of a signature: element counts with a breakdown by face side count
 * and vertex degree, but without the configuration strings. Broken across lines so
 * no line exceeds `maxChars`, only ever between the face/vertex/edge clauses.
 */
export function summarizeSignature(sig: Signature, maxChars: number): [string, number] {
  const faces = summarizeGroups(
    byArity(sig.faceConfigs),
    sig.F,
    "face",
    "faces",
    polygonName
  );
  const vertices = summarizeGroups(
    byArity(sig.vertexConfigs),
    sig.V,
    "vertex",
    "vertices",
    (a) => `deg-${a}`,
  );
  const edges = `${sig.E} ${sig.E === 1 ? "edge" : "edges"}`;
  return packLines([faces, vertices, edges], maxChars);
}

/**
 * Join `parts` with ", " onto as few lines as possible without exceeding
 * `maxChars`, breaking only between parts (so an over-long part simply overflows).
 * The separating comma stays on the line its part ends.
 * Also returns the max width of a line.
 */
export function packLines(parts: string[], maxChars: number): [string, number] {
  const lines: string[] = [];
  let max_width = 0;
  for (const part of parts) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 2 + part.length <= maxChars) {
      lines[last] += `, ${part}`;
      max_width = Math.max(max_width, lines[last].length);
    } else {
      if (last >= 0) {
        lines[last] += ",";
        max_width = Math.max(max_width, lines[last].length);
      }
      lines.push(part);
      max_width = Math.max(max_width, lines[last+1].length);
    }
  }
  return [lines.join("\n"), max_width];
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
