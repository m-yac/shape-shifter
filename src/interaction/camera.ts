import { PerspectiveCamera, Vector3 } from "three";
import { ArcballControls } from "three/examples/jsm/controls/ArcballControls.js";
import { config } from "../config";

export const CAMERA_XY = Math.cos(0.4 * Math.PI);
export const CAMERA_Z  = Math.sin(0.4 * Math.PI);

/**
 * Perspective camera and orbit controls. Both mouse buttons orbit the shape; the wheel
 * zooms. When the left button grabs a vertex / face handle, the drag controller
 * disables these controls for the duration, so dragging empty space rotates while
 * dragging a handle performs the operation.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly controls: ArcballControls;

  constructor(domElement: HTMLElement) {
    // Aspect is a placeholder; the screen's first layout sets it via setAspect.
    this.camera = new PerspectiveCamera(config.camera.fov, 1, 0.01, 1000);
    const d = config.camera.startDistance;
    this.camera.position.set(d*CAMERA_XY, d*CAMERA_XY, d*CAMERA_Z);

    this.controls = new ArcballControls(this.camera, domElement);
    this.controls.rotateSpeed = config.camera.rotateSpeed;
    this.controls.scaleFactor = config.camera.scaleFactor;
    this.controls.enablePan = false;
    this.controls.unsetMouseAction(1);
    this.controls.unsetMouseAction(2);
    this.controls.unsetMouseAction('WHEEL', 'SHIFT');
    this.controls.minDistance = config.camera.minDistance;
    this.controls.maxDistance = config.camera.maxDistance;
    this.controls.enableAnimations = true;
    this.controls.dampingFactor = config.camera.dampingFactor;
  }

  /** Position the camera a sensible distance for a unit-ish solid. */
  frame(_center: Vector3): void {
    if (!config.camera.autoFrame) return;
    const d = config.camera.startDistance;
    this.camera.position.set(d*CAMERA_XY, d*CAMERA_XY, d*CAMERA_Z);
    // this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Match the camera to the screen's aspect ratio (called on each layout). */
  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(): void {
    this.controls.update();
  }
}
