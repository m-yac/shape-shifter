import { ArcballControls } from "three/examples/jsm/Addons.js";
import { Polyhedron } from "../geometry/polyhedron";
import { SceneView } from "../render/sceneView";
import { Fog, PerspectiveCamera } from "three";
import { config } from "../config";
import { BootSequence } from "./bootSequence";
import { Screen, fadeOut } from "../ui/screen";
import { GlitchOverlay } from "../ui/glitch";
import { led } from "../ui/led";
import { CAMERA_XY, CAMERA_Z } from "./camera";

/** Parse a "#rrggbb" hex color into an [r, g, b] triple of 0..255 ints. */
function hexRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export class IntroCutscene {
  private fog: Fog;
  private distance: number;
  private startTime: number = 0;
  private consoleEl: HTMLElement;

  // The faux-BIOS boot screen that plays in the console overlay on launch.
  private boot: BootSequence;
  private bootDone = false;
  private warmupDone = false;
  private consoleFadingOut = false;
  // performance.now() when the shape fade-in began (the boot signals this partway
  // through its closing message); 0 until then.
  private fadeStart = 0;

  // Monitor warm-up flash colors (power-on color -> backlight).
  private readonly brightRgb: [number, number, number];
  private readonly backlightRgb: [number, number, number];

  constructor(
    private readonly poly: Polyhedron,
    private readonly view: SceneView,
    private readonly camera: PerspectiveCamera,
    private readonly controls: ArcballControls,
    screen: Screen,
    private readonly glitch: GlitchOverlay,
    private whenFinished: () => void
  ) {
    this.consoleEl = document.getElementById("console")!;
    this.boot = new BootSequence(this.consoleEl, screen, glitch, () => {
      if (this.fadeStart === 0) this.fadeStart = performance.now();
    });

    this.brightRgb = config.theme.monitorBright
      .split(",")
      .map((s) => parseInt(s.trim(), 10)) as [number, number, number];
    this.backlightRgb = hexRgb(config.theme.backlight);

    this.fog = new Fog(config.render.backgroundColor, 0, config.intro.cameraDistance - 1);
    this.distance = config.intro.cameraDistance;

    this.controls.enabled = false;
    const d = this.distance;
    this.camera.position.set(d*CAMERA_XY, d*CAMERA_XY, d*CAMERA_Z);
    this.view.scene.fog = this.fog;
    this.view.setPolyhedron(this.poly, false);

    // The monitor is powering on: light the activity LED with the screen flash.
    led.powerOn();
  }

  private finished = false;

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.view.scene.fog = null;
    this.controls.enabled = true;
    this.glitch.clear(); // leave the app with a clean screen (also covers a skip)
    this.whenFinished();
  }

  /** Abort the intro (e.g. the user pressed a key): drop the boot screen and jump
   *  straight to the shape, fully visible, with the app UI shown. */
  skip(): void {
    if (this.finished) return;
    this.consoleEl.style.display = "none";
    this.finish();
  }

  updateFadeIn(t: number): void {
    const d = this.distance;
    this.camera.position.set(d*CAMERA_XY, d*CAMERA_XY, d*CAMERA_Z);
    const t2 = t * t;
    const t4 = t2 * t2;
    const t8 = t4 * t4;
    this.distance = config.intro.cameraDistance + (config.camera.startDistance - config.intro.cameraDistance) * (1.2 * t - 0.2 * t8);
    this.fog.near = (config.camera.startDistance + 1) * t8;
  }

  /** Blend the console background from the warm monitor color to the backlight over the
   *  first `warmupDuration` seconds: the monitor powering on before any text. Runs only
   *  until warm-up completes, then leaves the background to the boot sequence, which
   *  goes transparent for the closing message. */
  private updateWarmup(t: number): void {
    if (this.warmupDone) return;
    const k = Math.min(1, t / config.intro.warmupDuration);
    if (k >= 1) {
      this.consoleEl.style.backgroundColor = config.theme.backlight; // revert to the CSS backlight color
      this.warmupDone = true;
      return;
    }
    const mix = (i: number) => Math.round(this.brightRgb[i] + (this.backlightRgb[i] - this.brightRgb[i]) * k);
    this.consoleEl.style.backgroundColor = `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
  }

  update(): void {
    const now = performance.now();
    if (this.startTime == 0) {
      this.startTime = now;
    }
    const t = (now - this.startTime) / 1000;

    // Phase 1: the boot sequence runs on its own clock over a solid console, after a
    // brief power-on flash. The console doesn't fade out here; the boot makes its own
    // background transparent for the closing message, which stays on screen over the
    // fading-in shape.
    if (!this.bootDone) {
      this.updateWarmup(t);
      this.bootDone = this.boot.update();
    }

    // Phase 2: the shape fades in behind the closing message, triggered by the boot
    // partway through typing it. Once the shape has fully faded in, control passes on.
    if (this.fadeStart === 0) return; // not yet at the fade-in beat
    const elapsed = (now - this.fadeStart) / 1000;
    const total = config.intro.shapeFadeInDuration;

    // Start fading the closing message out early, so it is gone a touch before the
    // shape's fade-in completes rather than lingering past it.
    const fadeOutSeconds = 0.6;
    const finishGap = 0.4; // leave the message gone this long before the shape lands
    if (!this.consoleFadingOut && total - elapsed <= fadeOutSeconds + finishGap) {
      this.consoleFadingOut = true;
      fadeOut(this.consoleEl, fadeOutSeconds);
    }

    if (elapsed < total) {
      return this.updateFadeIn(elapsed / total);
    }
    this.finish();
  }
}