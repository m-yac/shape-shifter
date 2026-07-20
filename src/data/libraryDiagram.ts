import { config } from "../config";

/**
 * The LIBRARY browse diagram as a plain graph, free of Three.js and the DOM, so the
 * layout coordinates, the arrow notation and the discovery-driven visibility rule can
 * be tested in isolation. `ui/libraryBrowser.ts` consumes this to place and reveal the
 * 3D solids.
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
 * Parse one arrow token group into its arrows. Grammar: an optional leading ":" for
 * dashed, then a run of (direction letter, span) pairs, optionally wrapped in ">".
 * Every line carries one arrowhead pointing forward along it; the ">" places that
 * head: ">u2" at the start, bare "u2" in the middle, "u2>" at the end. A leading ":"
 * (before the ">") makes the line dashed, e.g. ":>fl", a chamfer/subdivide branch that
 * reveals its target but does not chain onward (see `walk`). Each letter carries its
 * own span, so "d3r2" steps (+2 x, -3 y), allowing non-45° lines; a missing number
 * means 1 (">u" is up one, head at the start). One config string may bundle several
 * arrows, e.g. "f4r4, b2r2".
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
  /** node index -> indices of the edges leaving it. Edges are directed (from -> to),
   *  so a node's descendants are `edges[..].to`. */
  outgoing: number[][];
}

type RawEntry = readonly [number, number, number, string, readonly string[]];

const coordKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Build the diagram graph from `config.library.diagram`: place each named solid at
 *  its coordinate and resolve every arrow to a directed edge, pointing from the node
 *  it is declared on to the node at its target coordinate. */
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

// The three head styles ordered along a compound arrow: a truncate/kis (start) welds
// into a rectify/join (middle) which twists into a snub/gyro (end). Once a hop of one
// style has been followed, only a later style can continue the chain.
const HEAD_RANK: Record<ArrowHead, number> = { start: 0, middle: 1, end: 2 };

interface Walk {
  /** Node indices to show: discovered, plus everything the walk reveals. */
  visible: Set<number>;
  /** Indices of the edges the walk traversed, the ones to draw. */
  edges: Set<number>;
}

/**
 * The reveal walk shared by `computeVisible` and `drawableEdges`. Starting from each
 * discovered solid, follow the compound-arrow chain, revealing every shape along the
 * way. Edges are only ever followed in their arrow direction. The rules:
 *   - discovered solids are always visible;
 *   - a chain may only begin at a start (>…) arrow, never partway along a compound
 *     arrow. So the Subdivided Cube, revealed by a dashed branch and carrying only a
 *     middle arrow onward (to its rectification, the Deltoidal Icositetrahedron),
 *     reveals nothing: the ">…" hop that middle arrow continues (Cuboctahedron ->
 *     Subdivided Octahedron) was never traversed.
 *   - from a node the chain has reached, an arrow whose head style is strictly later
 *     than the one arrived by reveals its target and continues the chain. A start (>…)
 *     leads into a middle (…) into an end (…>).
 *   - there are two parallel tracks that never cross: the solid arrows (truncate,
 *     rectify, snub) and the dashed arrows (:>…, chamfer/subdivide → whirl/volute →
 *     propeller). A solid arrow never continues a dashed chain, nor a dashed arrow a
 *     solid one — the arrow that opens a chain (from a root's start head) fixes its
 *     track. With only the Tetrahedron made you therefore see, on the solid track, its
 *     truncation and kis, their rectification and join (Octahedron, Cube), and one hop
 *     further the snub and gyro (Icosahedron, Dodecahedron); and on the dashed track its
 *     chamfer and subdivide, their whirl and volute, and one hop further the propeller.
 */
function walk(graph: DiagramGraph, discovered: Set<number>): Walk {
  const visible = new Set<number>(discovered);
  const edges = new Set<number>();
  // BFS over (node, phase, dashed) states; `phase` is the rank of the head arrived by,
  // or -1 for a discovered root, which may only open a chain at a start head. `dashed`
  // records which track the chain is on, so it can only ever continue along its own.
  const seen = new Set<string>();
  const queue: { node: number; phase: number; dashed: boolean }[] = [];
  for (const d of discovered) {
    queue.push({ node: d, phase: -1, dashed: false });
    seen.add(`${d}:-1`);
  }
  while (queue.length) {
    const { node, phase, dashed } = queue.shift()!;
    for (const ei of graph.outgoing[node]) {
      const e = graph.edges[ei];
      const rank = HEAD_RANK[e.head];
      if (phase === -1) {
        // A root opens a chain only at a start head (>…); the arrow's own dashedness
        // then picks the track — solid or dashed — the chain runs on.
        if (rank !== HEAD_RANK.start) continue;
      } else {
        // Inside a chain, stay on its track and advance to a strictly later stage.
        if (e.dashed !== dashed || rank <= phase) continue;
      }
      visible.add(e.to);
      edges.add(ei);
      const key = `${e.to}:${rank}:${e.dashed ? "d" : "s"}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ node: e.to, phase: rank, dashed: e.dashed });
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
 * Indices of the edges to draw, given the discovered set: exactly the edges the reveal
 * walk traversed, the arrows leading into each revealed shape. A shape at the tip of
 * the chain thus shows the arrows that reach it, but not the ones leading from it
 * toward shapes still out of reach. `_visible` is taken for API symmetry with
 * `computeVisible`; the walk recomputes the same reachability.
 */
export function drawableEdges(
  graph: DiagramGraph,
  discovered: Set<number>,
  _visible: Set<number>,
): number[] {
  return [...walk(graph, discovered).edges];
}
