import { Vector3, Ray } from "three";
import { type Mesh } from "../geometry/HalfEdge";

/** The kind of interactive operation a gesture maps to. */
export type OperationKind = "truncate" | "kis" | "snub" | "gyro";

/**
 * A live, in-progress operation. Built when a drag starts; the topology is fixed
 * for the duration of the drag and only the parameter `t` (in [0, 1]) changes.
 *   t = 0  → geometrically identical to the original (no-op end)
 *   t = 1  → the "max" form: Rectify / Join (welded)
 */
export interface MorphPlan {
  kind: OperationKind;

  /** Topology shown DURING the drag (before any welding). */
  previewFaces: number[][];

  /** Vertex positions for a given parameter t. */
  positions(t: number): Vector3[];

  /**
   * Snap the camera pick ray to this operation's snap geometry and report the
   * resulting parameter, the exact snapped world point (where the dragged new
   * vertex should sit), and the segment to highlight (the edge / normal line
   * currently being dragged along).
   */
  snap(ray: Ray): {
    t: number;
    point: Vector3;
    highlight?: { a: Vector3; b: Vector3 };
  };

  /**
   * Final mesh for parameter t. When `weld` is true (t reached the max end) the
   * topology collapses to the Rectify/Join form; otherwise it is the intermediate
   * (truncated / kissed) topology at that t.
   */
  commit(t: number, weld: boolean): Mesh;
}
