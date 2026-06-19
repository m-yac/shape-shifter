import { Polyhedron } from "../geometry/polyhedron";
import { edgePairs } from "../geometry/HalfEdge";
import {
  type Signature,
  computeSignature,
  signaturesEqual,
  vertexConfig,
} from "./configurations";
import { type GraphData } from "./isomorphism";
import { NAMED } from "../data/namedPolyhedra";

/** Plain labeled graph of a polyhedron (vertices + adjacency + configs). */
export function buildGraphData(poly: Polyhedron): GraphData {
  const dcel = poly.dcel;
  const n = dcel.vertices.length;
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edgePairs(dcel)) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  const labels = dcel.vertices.map((v) => vertexConfig(dcel, v.id));
  return { n, adjacency, labels };
}

interface DBEntry {
  name: string;
  signature: Signature;
  graph: GraphData;
}

// Precompute signatures + graphs for the named database once.
const DB: DBEntry[] = NAMED.map((np) => {
  const poly = np.poly;
  return {
    name: np.name,
    signature: computeSignature(poly.dcel),
    graph: buildGraphData(poly),
  };
});

export interface Identification {
  signature: Signature;
  /** First named polyhedron whose signature matches, or null. */
  name: string | null;
}

export function identify(poly: Polyhedron): Identification {
  const signature = computeSignature(poly.dcel);
  const match = DB.find((e) => signaturesEqual(e.signature, signature));
  return { signature, name: match ? match.name : null };
}

/** The target graph for the named polyhedron (for isomorphism verification). */
export function namedGraphFor(name: string): GraphData | null {
  const e = DB.find((x) => x.name === name);
  return e ? e.graph : null;
}
