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
}

/**
 * Parse one arrow token group into its arrows. Grammar: a run of (direction
 * letter + per-axis span) pairs, optionally wrapped in ">". Every line is solid
 * and carries one arrowhead pointing in its forward direction; the ">" says
 * WHERE that head sits — ">u2" at the START, "u2" (bare) in the MIDDLE, "u2>" at
 * the END. Each letter carries its OWN span — so "d3r2" steps (+2 x, −3 y),
 * allowing non-45° lines — and a missing number means 1 (">u" = up one, head at
 * the start). One config string may bundle several arrows, e.g. "f4r4, b2r2".
 */
export function parseArrow(tokenGroup: string): ParsedArrow[] {
  const out: ParsedArrow[] = [];
  for (const tok of tokenGroup.split(/[\s,]+/).filter(Boolean)) {
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
    if (matched) out.push({ step, head });
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
        edges.push({ from, to, head: a.head });
        outgoing[from].push(ei);
      }
    }
  });

  return { nodes, edges, outgoing };
}

/**
 * Which node indices are visible, given the discovered ones. A node only counts
 * as a "neighbour" if an arrow points TO it (it's a possible descendant), so we
 * only ever follow edges in their arrow direction. The rule:
 *   • discovered solids;
 *   • their direct descendants (one arrow hop, any style);
 *   • any node reached from such a descendant by a MIDDLE-headed edge — but only
 *     when that descendant was itself reached by a start- or middle-headed edge
 *     (an end-headed edge is a leaf and does not expand further).
 * (So with only the Tetrahedron made, you see it, its truncation + kis, and — one
 * middle-headed hop further — its rectification and join.)
 */
export function computeVisible(graph: DiagramGraph, discovered: Set<number>): Set<number> {
  const visible = new Set<number>(discovered);
  const expandableDescendants = new Set<number>();

  for (const d of discovered) {
    for (const ei of graph.outgoing[d]) {
      const e = graph.edges[ei];
      visible.add(e.to);
      if (e.head !== "end") expandableDescendants.add(e.to);
    }
  }
  for (const n1 of expandableDescendants) {
    for (const ei of graph.outgoing[n1]) {
      const e = graph.edges[ei];
      if (e.head === "middle") visible.add(e.to);
    }
  }
  return visible;
}

/**
 * Indices of the edges to actually DRAW, given the discovered + visible sets. An
 * edge is drawn when both endpoints are visible AND it leaves an "expandable"
 * node — a discovered shape or a direct descendant of one. So a second-hop ghost
 * (a neighbour of a neighbour) shows the arrows leading TO it, but not the arrows
 * leading FROM it (which would point off toward shapes you're nowhere near yet).
 */
export function drawableEdges(
  graph: DiagramGraph,
  discovered: Set<number>,
  visible: Set<number>,
): number[] {
  const expandable = new Set<number>(discovered);
  for (const d of discovered) {
    for (const ei of graph.outgoing[d]) expandable.add(graph.edges[ei].to);
  }
  const out: number[] = [];
  graph.edges.forEach((e, i) => {
    if (visible.has(e.from) && visible.has(e.to) && expandable.has(e.from)) out.push(i);
  });
  return out;
}
