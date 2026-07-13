import { Vector3, Ray, Color } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { type ColorSet, type GeomColor } from "../geometry/colors";

/** The kind of interactive operation a gesture maps to. */
export type OperationKind =
  | "truncate"
  | "kis"
  | "snub"
  | "gyro"
  | "chamfer"
  | "subdivide";

/**
 * The rotation-arc handle a gyro plan exposes. After a face drag welds into the join the
 * cursor sits on a face-centre apex; that apex doesn't move during the gyro, so it can't
 * be dragged directly. Instead the handle is a circular arc in the apex's tangent plane
 * that sweeps one of the join edges (spokes) about the apex: rotating the spoke drives the
 * gyro. `ref` is the spoke at zero twist, the arc's midpoint; the arc extends
 * ±`halfSweepRad` about `axis` through `center` (the apex), so both chiralities are shown
 * and the cursor drags across the middle to pick a direction. Snub uses straight drag-line
 * handles and has no arc.
 */
export interface TwistArc {
  center: Vector3;
  /** The ride position at zero twist: the arc's midpoint, the swept spoke's tip. */
  ref: Vector3;
  /** The ride position at the current twist, where the handle marker sits. */
  ride: Vector3;
  axis: Vector3;
  /** The arc extends ±this about `axis` from `ref` (the two chiralities). */
  halfSweepRad: number;
}

/**
 * A live, in-progress operation. Built when a drag starts; the topology is fixed
 * for the duration of the drag and only the parameter `t` (in [0, 1]) changes.
 *
 * Base ops (truncate / kis): t = 0 is a no-op end, t = 1 is the welded Rectify /
 * Join. Twist ops (snub / gyro): t is the normalized position along the twist arc
 * (0 = the plain rectify/join, 1 = the full snub/gyro at the arc's end), and the
 * chosen chirality is reported by `chirality()`.
 */
export interface MorphPlan {
  kind: OperationKind;

  /** Topology shown during the drag, before any welding. */
  previewFaces: number[][];

  /** Vertex positions for a given parameter t. */
  positions(t: number): Vector3[];

  /**
   * Per-preview-face RGB color for the live drag, interpolated by t between each face's
   * t=0 appearance and its rule color at the drag limit. One entry per `previewFaces`
   * face.
   *
   * `weld` is the live weld state (the drag has reached the Rectify/Join max). Some
   * operations recolor faces at the weld: kis's two triangles merge into a
   * differently-colored Join quad, subdivide's corner fan merges into the vertex figure.
   * At the weld those merged preview faces must already show the welded color, otherwise
   * releasing snaps from the drag look to the committed colors. Ops that don't recolor at
   * the weld ignore the flag.
   */
  previewFaceColors(t: number, weld?: boolean): Color[];

  /**
   * Colors for the preview topology's edges, keyed by undirected preview-vertex-index pair
   * (`edgeKey`). Drives the colored wireframe during a drag; the dark-palette edge colors
   * don't interpolate.
   */
  previewEdgeColors: Map<string, GeomColor>;

  /**
   * Edges (as preview vertex-index pairs) that collapse at the weld. When the drag is at
   * the welded max these are hidden, so the about-to-merge faces read as a single face
   * before the geometry is welded.
   */
  vanishingEdges: Array<[number, number]>;

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
   * Final mesh and element colors for parameter t. When `weld` is true (t reached the max
   * end) the topology collapses to the Rectify/Join form; otherwise it is the intermediate
   * (truncated / kissed) topology at that t. The returned colors are the plain rule
   * colors; the ico/dodeca override is applied by the caller.
   */
  commit(t: number, weld: boolean): { mesh: Mesh; colors: ColorSet };

  /**
   * For chiral operations (snub / gyro), the handedness of the currently-selected mirror
   * form, so a committed shape's name can distinguish the two enantiomorphs, which are
   * otherwise the same combinatorial signature. Reflects the live `snap` choice; absent on
   * achiral operations (truncate / kis).
   */
  chirality?(): "R" | "L";

  /**
   * For twist ops (snub / gyro), the arc handle geometry at the current parameter, so the
   * view can draw it. Reflects the live `snap` choice (parameter and chirality). Absent on
   * base ops (truncate / kis).
   */
  arc?(): TwistArc;
}
