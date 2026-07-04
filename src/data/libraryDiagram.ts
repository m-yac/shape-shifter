import { config } from "../config";

/**
 * The LIBRARY browse diagram as a pure graph — no THREE.js, no DOM — so the
 * layout (coordinates), the arrow notation, and the discovery-driven visibility
 * rule can be unit-tested in isolation. `ui/libraryBrowser.ts` consumes this to
 * place + reveal the 3D solids.
 */

// Direction letters → unit grid step (y up, x right, z toward the viewer).
const DIRV: Record<string, [number, number, number]> = {
  u: [0, 1, 0],
  d: [0, -1, 0],
  r: [1, 0, 0],
  l: [-1, 0, 0],
  f: [0, 0, 1],
  b: [0, 0, -1],
};

/** Where the (always-forward-pointing) arrowhead sits along the line. */
export type ArrowHead = "start" | "middle" | "end";

export interface ParsedArrow {
  step: [number, number, number];
  head: ArrowHead;
  dashed: boolean;
}

/**
 * Parse one arrow token group into its arrows. Grammar: an optional leading ":"
 * (dashed) then a run of (direction letter + per-axis span) pairs, optionally
 * wrapped in ">". Every line carries one arrowhead pointing in its forward
 * direction; the ">" says WHERE that head sits — ">u2" at the START, "u2" (bare)
 * in the MIDDLE, "u2>" at the END. A leading ":" (before the ">") makes the line
 * DASHED, e.g. ":>fl" — a chamfer/subdivide branch that reveals its target but
 * does not chain onward into a middle arrow (see `computeVisible`). Each letter
 * carries its OWN span — so "d3r2" steps (+2 x, −3 y), allowing non-45° lines —
 * and a missing number means 1 (">u" = up one, head at the start). One config
 * string may bundle several arrows, e.g. "f4r4, b2r2".
 */
export function parseArrow(tokenGroup: string): ParsedArrow[] {
  const out: ParsedArrow[] = [];
  for (const raw of tokenGroup.split(/[\s,]+/).filter(Boolean)) {
    const dashed = raw.startsWith(":");
    const tok = dashed ? raw.slice(1) : raw;
    const head: ArrowHead = tok.startsWith(">") ? "start" : tok.endsWith(">") ? "end" : "middle";
    const step: [number, number, number] = [0, 0, 0];
    let matched = false;
    for (const m of tok.matchAll(/([udlrfb])(\d*)/gi)) {
      const v = DIRV[m[1].toLowerCase()];
      if (!v) continue;
      const span = m[2] ? parseInt(m[2], 10) : 1;
      step[0] += v[0] * span;
      step[1] += v[1] * span;
      step[2] += v[2] * span;
      matched = true;
    }
    if (matched) out.push({ step, head, dashed });
  }
  return out;
}

export interface DiagramNodeInfo {
  coord: [number, number, number];
  name: string;
}

export interface DiagramEdgeInfo {
  from: number;
  to: number;
  head: ArrowHead;
  dashed: boolean;
}

export interface DiagramGraph {
  nodes: DiagramNodeInfo[];
  edges: DiagramEdgeInfo[];
  /** node index → indices of the edges leaving it (arrows it is the SOURCE of).
   *  Edges are directed (from → to), so a node's descendants are `edges[..].to`. */
  outgoing: number[][];
}

type RawEntry = readonly [number, number, number, string, readonly string[]];

const coordKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Build the diagram graph from `config.library.diagram`: place each named solid
 *  at its coordinate and resolve every arrow to a DIRECTED edge (the arrow points
 *  from the node it is declared on to the node at its target coordinate). */
export function buildDiagramGraph(): DiagramGraph {
  const diagram = config.library.diagram as unknown as RawEntry[];
  const nodes: DiagramNodeInfo[] = [];
  const edges: DiagramEdgeInfo[] = [];
  const outgoing: number[][] = [];
  const byCoord = new Map<string, number>();

  diagram.forEach(([x, y, z, name]) => {
    byCoord.set(coordKey(x, y, z), nodes.length);
    nodes.push({ coord: [x, y, z], name });
    outgoing.push([]);
  });

  diagram.forEach(([x, y, z, , arrows], from) => {
    for (const tokenGroup of arrows) {
      for (const a of parseArrow(tokenGroup)) {
        const to = byCoord.get(coordKey(x + a.step[0], y + a.step[1], z + a.step[2]));
        if (to === undefined) continue; // dangling arrow (no solid at the target)
        const ei = edges.length;
        edges.push({ from, to, head: a.head, dashed: a.dashed });
        outgoing[from].push(ei);
      }
    }
  });

  return { nodes, edges, outgoing };
}

// The three head styles ordered along a compound arrow: a truncate/kis (start)
// welds into a rectify/join (middle) which twists into a snub/gyro (end). Once
// you've followed a hop of one style, only a LATER style can continue the chain.
const HEAD_RANK: Record<ArrowHead, number> = { start: 0, middle: 1, end: 2 };

interface Walk {
  /** Node indices to show (discovered + everything the walk reveals). */
  visible: Set<number>;
  /** Indices of the edges the walk actually traversed (the ones to DRAW). */
  edges: Set<number>;
}

/**
 * The reveal walk shared by `computeVisible` and `drawableEdges`. Starting from
 * each discovered solid we follow the compound-arrow chain, revealing every
 * shape along the way. A node only counts as a "neighbour" if an arrow points TO
 * it, so we only ever follow edges in their arrow direction. The rule:
 *   • discovered solids;
 *   • from any node, following a SOLID arrow whose head style comes strictly
 *     LATER than the one we arrived by (a discovered root may follow any style)
 *     reveals its target and continues the chain from there. So a start (>…)
 *     leads into a middle (…) which leads into an end (…>): truncate → rectify →
 *     snub. (With only the Tetrahedron made you thus see its truncation + kis,
 *     their rectification + join — the Octahedron + Cube — and one further hop,
 *     the snub + gyro — the Icosahedron + Dodecahedron.)
 *   • DASHED arrows (:>…, the chamfer/subdivide branches) are followed only from
 *     a discovered solid and are leaves: they reveal their target but never chain
 *     onward into a middle arrow.
 */
function walk(graph: DiagramGraph, discovered: Set<number>): Walk {
  const visible = new Set<number>(discovered);
  const edges = new Set<number>();
  // BFS over (node, phase) states; `phase` is the rank of the head we arrived
  // by, or -1 for a discovered root (which may begin the chain at any style).
  const seen = new Set<string>();
  const queue: { node: number; phase: number }[] = [];
  for (const d of discovered) {
    queue.push({ node: d, phase: -1 });
    seen.add(`${d}:-1`);
  }
  while (queue.length) {
    const { node, phase } = queue.shift()!;
    for (const ei of graph.outgoing[node]) {
      const e = graph.edges[ei];
      if (e.dashed) {
        // A chamfer/subdivide leaf: only from a discovered root, never chained.
        if (phase === -1) {
          visible.add(e.to);
          edges.add(ei);
        }
        continue;
      }
      const rank = HEAD_RANK[e.head];
      if (rank <= phase) continue; // must be a strictly later stage of the chain
      visible.add(e.to);
      edges.add(ei);
      const key = `${e.to}:${rank}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ node: e.to, phase: rank });
      }
    }
  }
  return { visible, edges };
}

/** Which node indices are visible, given the discovered ones (see `walk`). */
export function computeVisible(graph: DiagramGraph, discovered: Set<number>): Set<number> {
  return walk(graph, discovered).visible;
}

/**
 * Indices of the edges to actually DRAW, given the discovered set. These are
 * exactly the edges the reveal walk traversed — the arrows leading INTO each
 * revealed shape — so a shape at the tip of the chain shows the arrows that
 * reach it but not the ones leading FROM it toward shapes you can't get to yet.
 * (`visible` is accepted for API symmetry with `computeVisible`; the walk
 * recomputes the same reachability.)
 */
export function drawableEdges(
  graph: DiagramGraph,
  discovered: Set<number>,
  _visible: Set<number>,
): number[] {
  return [...walk(graph, discovered).edges];
}
