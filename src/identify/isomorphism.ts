/**
 * Labeled graph isomorphism by backtracking, pruned by vertex labels (the canonical
 * vertex configuration). Free of Three.js, so it can run inside a Web Worker. This
 * verifies a name match: if a configuration- and connectivity-preserving bijection
 * exists, the polyhedron really is that one.
 */
export interface GraphData {
  n: number;
  /** adjacency[i] = list of neighbor vertex indices */
  adjacency: number[][];
  /** labels[i] = canonical vertex configuration of vertex i */
  labels: string[];
}

export function areIsomorphic(a: GraphData, b: GraphData): boolean {
  if (a.n !== b.n) return false;

  const adjA = a.adjacency.map((nbrs) => new Set(nbrs));
  const adjB = b.adjacency.map((nbrs) => new Set(nbrs));

  // Quick reject: identical label multisets and per-vertex degree distribution.
  const tally = (labels: string[], adj: Set<number>[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i < labels.length; i++) {
      const key = `${labels[i]}#${adj[i].size}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  };
  const ta = tally(a.labels, adjA);
  const tb = tally(b.labels, adjB);
  if (ta.size !== tb.size) return false;
  for (const [k, v] of ta) if (tb.get(k) !== v) return false;

  // Order A's vertices in BFS order, so each new one is adjacent to an
  // already-placed vertex and the adjacency constraints prune early.
  const order: number[] = [];
  const seen = new Array<boolean>(a.n).fill(false);
  for (let s = 0; s < a.n; s++) {
    if (seen[s]) continue;
    seen[s] = true;
    const q = [s];
    while (q.length) {
      const u = q.shift()!;
      order.push(u);
      for (const w of adjA[u])
        if (!seen[w]) {
          seen[w] = true;
          q.push(w);
        }
    }
  }

  const mapAtoB = new Array<number>(a.n).fill(-1);
  const usedB = new Array<boolean>(b.n).fill(false);

  const consistent = (u: number, t: number): boolean => {
    if (a.labels[u] !== b.labels[t]) return false;
    if (adjA[u].size !== adjB[t].size) return false;
    // every already-mapped A-vertex must preserve adjacency with u
    for (let i = 0; i < a.n; i++) {
      const ti = mapAtoB[i];
      if (ti === -1) continue;
      if (adjA[u].has(i) !== adjB[t].has(ti)) return false;
    }
    return true;
  };

  const place = (k: number): boolean => {
    if (k === order.length) return true;
    const u = order[k];
    for (let t = 0; t < b.n; t++) {
      if (usedB[t] || !consistent(u, t)) continue;
      mapAtoB[u] = t;
      usedB[t] = true;
      if (place(k + 1)) return true;
      mapAtoB[u] = -1;
      usedB[t] = false;
    }
    return false;
  };

  return place(0);
}
