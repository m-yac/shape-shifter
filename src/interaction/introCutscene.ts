import { ArcballControls } from "three/examples/jsm/Addons.js";
import { Polyhedron } from "../geometry/polyhedron";
import { SceneView } from "../render/sceneView";
import { Fog, PerspectiveCamera } from "three";
import { config } from "../config";

export class IntroCutscene {
  private fog: Fog;
  private distance: number;
  private startTime: number = 0;
  private consoleEl: HTMLElement;

  constructor(
    private readonly poly: Polyhedron,
    private readonly view: SceneView,
    private readonly camera: PerspectiveCamera,
    private readonly controls: ArcballControls,
    private whenFinished: () => void
  ) {
    this.consoleEl = document.getElementById("console")!;

    this.fog = new Fog(config.render.backgroundColor, 0, config.intro.cameraDistance - 1);
    this.distance = config.intro.cameraDistance;

    this.controls.enabled = false;
    this.camera.position.set(0, 0, this.distance);
    this.view.scene.fog = this.fog;
    this.view.setPolyhedron(this.poly, false);
  }

  private finish(): void {
    this.view.scene.fog = null;
    this.controls.enabled = true;
    this.whenFinished();
  }

  updateFadeIn(t: number): void {
    this.camera.position.set(0, 0, this.distance);
    const t2 = t * t;
    const t4 = t2 * t2;
    const t8 = t4 * t4;
    this.distance = config.intro.cameraDistance + (config.camera.startDistance - config.intro.cameraDistance) * (1.2 * t - 0.2 * t8);
    this.fog.near = (config.camera.startDistance + 1) * t8;
  }

  update(): void {
    const now = performance.now();
    if (this.startTime == 0) {
      this.startTime = now;
    }
    let t = (now - this.startTime) / 1000;

    const tBoot = t / config.intro.bootDuration;
    if (tBoot < 1) {
      this.consoleEl.style = `background-color: rgba(${config.theme.monitorBright}, ${1 - tBoot});`
      // update boot
    }
    if (tBoot >= 1 && this.consoleEl.style[0] != "background-color: unset;") {
      this.consoleEl.style = "background-color: unset;";
    }
    t -= config.intro.bootDuration;

    const tFadeIn = t / config.intro.shapeFadeInDuration;
    if (tFadeIn < 1) {
      return this.updateFadeIn(tFadeIn);
    }
    t -= config.intro.shapeFadeInDuration

    this.finish();
  }
}