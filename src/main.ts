import {
  Scene,
  WebGLRenderer,
  Color,
  HemisphereLight,
  DirectionalLight,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  HalfFloatType,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { config } from "./config";
import { getSeed } from "./geometry/seeds";
import { Polyhedron } from "./geometry/polyhedron";
import { CameraRig } from "./interaction/camera";
import { SceneView } from "./render/sceneView";
import { DragController } from "./interaction/dragController";
import { Readout } from "./ui/readout";
import { Screen } from "./ui/screen";
import { IntroCutscene } from "./interaction/introCutscene";

const app = document.getElementById("app")!;
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Title-case a seed key ("tetrahedron" → "Tetrahedron") for the history root. */
const seedLabel = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

// --- screen (the vintage monitor + character grid) --------------------------
const screen = new Screen(
  document.getElementById("bezel")!,
  document.getElementById("grid")!,
);
screen.layout();

// --- renderer ---------------------------------------------------------------
// When pixelateRender is on, the buffer is rendered at one texel per font pixel
// (pixel ratio 1/pixelSize) and the canvas is nearest-neighbor upscaled, so the
// 3D shares the text's chunky pixel grid. Otherwise it renders crisp at full
// device resolution.
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(
  config.theme.pixelateRender
    ? 1 / config.theme.pixelSize
    : Math.min(window.devicePixelRatio, 2),
);
if (config.theme.pixelateRender) renderer.domElement.style.imageRendering = "pixelated";
app.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(config.render.backgroundColor);

// --- lighting (enough to read the flat-shaded faces) ------------------------
const hemi = new HemisphereLight(0xffffff, 0x404050, 1.0);
scene.add(hemi);
const key = new DirectionalLight(0xffffff, 1.1);
key.position.set(3, 5, 4);
scene.add(key);
const fill = new DirectionalLight(0xffffff, 0.5);
fill.position.set(-4, -2, -3);
scene.add(fill);

// --- camera + view + controller ---------------------------------------------
const rig = new CameraRig(renderer.domElement);
const view = new SceneView(scene);
const readout = new Readout(screen);

// --- post-processing: phosphor bloom over the 3D view -----------------------
// UnrealBloom gives the polyhedra the same soft halo the text gets from its
// layered text-shadow; both are scaled by config.theme.bloom.intensity so they
// glow by the same amount (see Screen.textGlow).
// A multisampled HDR target keeps the polyhedra edges antialiased (the default
// composer target has no MSAA) and gives the bloom highlights headroom.
const composerTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerTarget);
composer.setPixelRatio(renderer.getPixelRatio());
composer.addPass(new RenderPass(scene, rig.camera));
// UnrealBloom's strength runs hotter than the CSS text glow at the same number,
// so the shared intensity is scaled down here to keep the 3D bloom visually in
// step with the text (tune this if you change the look of one but not the other).
const bloomPass = new UnrealBloomPass(
  new Vector2(1, 1), // sized on first layout
  config.theme.bloom.intensity * config.theme.bloom.scale_3d,
  config.theme.bloom.radius,
  config.theme.bloom.threshold,
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Fit the renderer, composer, and camera to the grid, now and on every layout.
screen.onLayout((s) => {
  renderer.setSize(s.width, s.height);
  composer.setSize(s.width, s.height);
  rig.setAspect(s.width / s.height);
});
// The status readout (a box-framed popup) self-places into the bottom-left
// corner on every layout; see ui/readout.ts.

let currentSeed: string = config.seeds.initial;
const initialPoly = new Polyhedron(getSeed(currentSeed));
rig.frame(new Vector3());

let controller: DragController | null = null;
let intro: IntroCutscene | null = new IntroCutscene(
  initialPoly,
  view,
  rig.camera,
  rig.controls,
  () => {
    intro = null;
    rig.frame(new Vector3());
    controller = new DragController(
      initialPoly,
      seedLabel(currentSeed),
      view,
      rig.camera,
      rig.controls,
      renderer.domElement,
      readout,
      screen,
    );
  });

// --- undo / redo + seed loading via keyboard --------------------------------
window.addEventListener("keydown", (e) => {
  if (!controller) return;
  // Undo: Cmd/Ctrl+Z. Redo: Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y. (Camera is kept;
  // shapes are normalized to ~unit so no reframe is needed.)
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) controller.redo();
    else controller.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    controller.redo();
    return;
  }

  // Manual relaxation (debugging the post-release solve). Plain keys (no modifier).
  if (config.debug.manualRelax && !mod) {
    const k = e.key.toLowerCase();
    const d = config.debug;
    if (k === d.relaxKey) return void controller.relax(null);
    if (k === d.forceFacesKey) return void controller.relax("faces");
    if (k === d.forceCanonicalKey) return void controller.relax("canonical");
    if (k === d.forceSpherizeKey) return void controller.relax("spherize");
  }

  const enabled = config.seeds.enabled;
  if (config.seeds.numberKeyToLoadSeed && /^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    if (idx < enabled.length) {
      currentSeed = enabled[idx];
      controller.load(new Polyhedron(getSeed(currentSeed)), seedLabel(currentSeed));
      rig.frame(new Vector3());
    }
  } else if (e.key.toLowerCase() === config.seeds.resetKey) {
    controller.load(new Polyhedron(getSeed(currentSeed)), seedLabel(currentSeed));
    rig.frame(new Vector3());
  }
});

// --- render loop ------------------------------------------------------------
function animate(): void {
  requestAnimationFrame(animate);
  if (intro) intro.update();
  if (controller) controller.update();
  rig.update();
  composer.render();
}
animate();
