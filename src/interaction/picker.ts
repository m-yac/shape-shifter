import { Vector2, Vector3, Ray, Raycaster, type Camera, type Object3D } from "three";
import { type Marker } from "../render/sceneView";
import { config } from "../config";

/**
 * Turns mouse position into either a picked marker (vertex / face-center) or a
 * world-space pick ray. Hover detection works in screen space (a pixel radius), so it
 * stays forgiving however small the markers look on screen.
 */
export class Picker {
  private raycaster = new Raycaster();

  /**
   * Does any of `normals` point toward the camera by more than `pickNormalMarginDeg`
   * past perpendicular? Normals must be unit-length and oriented outward. With a unit
   * view direction, n·view == cos(angle), so lying within the margin of 90° means
   * |cos| <= sin(margin); facing therefore requires n·view > sin(margin). Culls
   * occluded markers, and decides which edges a vertex can be dragged along (their far
   * endpoint must itself face the camera).
   */
  static facesCamera(position: Vector3, normals: Vector3[], camera: Camera): boolean {
    const view = camera.position.clone().sub(position).normalize();
    const minDot = Math.sin(
      (config.interaction.pickNormalMarginDeg * Math.PI) / 180,
    );
    return normals.some((n) => n.dot(view) > minDot);
  }

  private ndc(clientX: number, clientY: number, canvas: HTMLCanvasElement): Vector2 {
    const r = canvas.getBoundingClientRect();
    return new Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
  }

  ray(clientX: number, clientY: number, canvas: HTMLCanvasElement, camera: Camera): Ray {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY, canvas), camera);
    return this.raycaster.ray.clone();
  }

  /** Does the pick ray hit the given object (e.g. the polyhedron surface)? */
  intersects(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    camera: Camera,
    object: Object3D,
  ): boolean {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY, canvas), camera);
    return this.raycaster.intersectObject(object, false).length > 0;
  }

  /** Nearest front-facing marker within `hoverPixelRadius` (grabbable range). */
  pick(
    markers: Marker[],
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    camera: Camera,
  ): Marker | null {
    return (
      this.pickClosest(
        markers,
        clientX,
        clientY,
        canvas,
        camera,
        config.interaction.hoverPixelRadius,
      )?.marker ?? null
    );
  }

  /** Nearest front-facing marker within `maxRadius` px, plus its pixel distance. */
  pickClosest(
    markers: Marker[],
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    camera: Camera,
    maxRadius: number,
  ): { marker: Marker; pixelDist: number } | null {
    const r = canvas.getBoundingClientRect();
    const mx = clientX - r.left;
    const my = clientY - r.top;
    const camPos = camera.position;

    let best: Marker | null = null;
    let bestDist = maxRadius;
    let bestDepth = Infinity;

    for (const m of markers) {
      // Cull markers whose faces are all edge-on or back-facing (occluded on a
      // convex, centered solid). Normals are pre-oriented outward in SceneView.
      if (!Picker.facesCamera(m.position, m.normals, camera)) continue;

      const p = m.position.clone().project(camera);
      if (p.z > 1) continue; // behind far plane / camera
      const sx = (p.x * 0.5 + 0.5) * r.width;
      const sy = (-p.y * 0.5 + 0.5) * r.height;
      const dist = Math.hypot(sx - mx, sy - my);
      if (dist > bestDist) continue;

      const depth = camPos.distanceTo(m.position);
      // Prefer closer-to-cursor; break ties by nearer-to-camera.
      if (dist < bestDist - 0.5 || depth < bestDepth) {
        best = m;
        bestDist = Math.max(dist, 1);
        bestDepth = depth;
      }
    }
    return best ? { marker: best, pixelDist: bestDist } : null;
  }

  /** World point along a ray (for debugging). */
  static pointOnRay(ray: Ray, t: number): Vector3 {
    return ray.origin.clone().add(ray.direction.clone().multiplyScalar(t));
  }
}
