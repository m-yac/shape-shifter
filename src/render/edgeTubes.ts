import {
  Group,
  Mesh as ThreeMesh,
  CylinderGeometry,
  MeshBasicMaterial,
  Color,
  Vector3,
  type Camera,
} from "three";

/** A colored edge to draw as a tube: its two endpoints (in the parent group's
 *  frame), its color, and an optional radius multiplier (primary-swatch edges are
 *  drawn thicker; defaults to 1). */
export interface EdgeTubeSpec {
  a: Vector3;
  b: Vector3;
  color: Color;
  radiusScale?: number;
}

const TUBE_UP = new Vector3(0, 1, 0);
const ORIGIN = new Vector3(0, 0, 0);
const _dir = new Vector3();
const _mid = new Vector3();
const _world = new Vector3();

/**
 * Draws a set of edges as thin tubes rather than line segments, so a colored edge
 * reads clearly instead of as a one-pixel line. Each tube is a shared unit cylinder
 * (radius 1, height 1 along +Y) scaled per frame so its on-screen thickness stays
 * constant with camera distance, like the drag range line and the pickable markers.
 *
 * A pool of meshes is grown / shrunk to fit across `setEdges` calls, so live
 * previews and solve frames don't churn Three objects. `object` is the Group to add
 * to a parent: the polyhedron group, or a library node's shape group.
 */
export class EdgeTubes {
  readonly object = new Group();
  private readonly geo: CylinderGeometry;
  private tubes: { mesh: ThreeMesh; a: Vector3; b: Vector3; radiusScale: number }[] = [];
  private opacity = 1;
  // Last camera parameters passed to `updateScales`, so `setEdges` can lay the meshes
  // out immediately in the same frame the endpoints change, rather than leaving them a
  // frame behind the surface (edges appear to detach while a shape relaxes otherwise).
  private lastScale: { camera: Camera; refDistance: number; baseRadius: number; worldOffset: Vector3 } | null = null;

  constructor(radialSegments: number) {
    this.geo = new CylinderGeometry(1, 1, 1, Math.max(3, radialSegments));
  }

  /** Whether the whole set is drawn (hidden edges / ghosted nodes turn it off). */
  setVisible(v: boolean): void {
    this.object.visible = v;
  }

  /** Fade every tube to `o` (the library dims non-hovered solids). Applies to
   *  later-created meshes too. */
  setOpacity(o: number): void {
    this.opacity = o;
    for (const t of this.tubes) this.applyOpacity(t.mesh.material as MeshBasicMaterial);
  }

  private applyOpacity(m: MeshBasicMaterial): void {
    m.opacity = this.opacity;
    m.transparent = this.opacity < 1;
    m.needsUpdate = true;
  }

  /** Replace the set of edges. Reuses meshes when the count is unchanged. */
  setEdges(edges: ReadonlyArray<EdgeTubeSpec>): void {
    while (this.tubes.length < edges.length) {
      const mesh = new ThreeMesh(this.geo, new MeshBasicMaterial({ color: 0xffffff }));
      this.object.add(mesh);
      this.tubes.push({ mesh, a: new Vector3(), b: new Vector3(), radiusScale: 1 });
    }
    while (this.tubes.length > edges.length) {
      const t = this.tubes.pop()!;
      this.object.remove(t.mesh);
      (t.mesh.material as MeshBasicMaterial).dispose();
    }
    for (let i = 0; i < edges.length; i++) {
      const t = this.tubes[i];
      t.a.copy(edges[i].a);
      t.b.copy(edges[i].b);
      t.radiusScale = edges[i].radiusScale ?? 1;
      const m = t.mesh.material as MeshBasicMaterial;
      m.color.copy(edges[i].color);
      this.applyOpacity(m);
    }
    // Position/scale the (possibly reused or newly created) meshes now, using the most
    // recent camera parameters, so they track this frame's endpoints instead of lagging
    // a frame behind. Skipped only before the first `updateScales`.
    if (this.lastScale) this.layout();
  }

  /**
   * Orient + scale every tube to span its edge at a radius that keeps its apparent
   * on-screen width constant: `baseRadius` is the world radius at `refDistance`,
   * scaled by (distance / refDistance). Endpoints are stored in the parent group's
   * local frame, so `worldOffset` (that parent's position) is added to measure the
   * camera distance in world space; pass the origin for a parent at the origin.
   */
  updateScales(
    camera: Camera,
    refDistance: number,
    baseRadius: number,
    worldOffset: Vector3 = ORIGIN,
  ): void {
    this.lastScale = { camera, refDistance, baseRadius, worldOffset };
    this.layout();
  }

  /** Orient + scale every tube from the stored endpoints and the last camera params. */
  private layout(): void {
    const { camera, refDistance, baseRadius, worldOffset } = this.lastScale!;
    for (const t of this.tubes) {
      _dir.copy(t.b).sub(t.a);
      const len = _dir.length();
      if (len < 1e-6) {
        t.mesh.visible = false;
        continue;
      }
      t.mesh.visible = true;
      _mid.copy(t.a).add(t.b).multiplyScalar(0.5);
      const d = camera.position.distanceTo(_world.copy(_mid).add(worldOffset));
      const radius = baseRadius * t.radiusScale * Math.max(d / refDistance, 0.05);
      t.mesh.position.copy(_mid);
      t.mesh.quaternion.setFromUnitVectors(TUBE_UP, _dir.normalize());
      t.mesh.scale.set(radius, len, radius);
    }
  }
}
