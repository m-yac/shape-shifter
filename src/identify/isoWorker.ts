/// <reference lib="webworker" />
import { areIsomorphic, type GraphData } from "./isomorphism";

/**
 * Background isomorphism check. The main thread sends the current polyhedron's
 * labeled graph plus the candidate named polyhedron's graph, and gets back whether
 * they are isomorphic, which is what earns the name its ✓. Off the main thread so a
 * large brute-force never blocks dragging.
 */
interface Request {
  id: number;
  candidate: GraphData;
  target: GraphData;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, candidate, target } = e.data;
  const result = areIsomorphic(candidate, target);
  (self as DedicatedWorkerGlobalScope).postMessage({ id, result });
};
