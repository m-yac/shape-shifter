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
import { seedColors } from "./geometry/colors";
import { CameraRig } from "./interaction/camera";
import { SceneView } from "./render/sceneView";
import { DragController } from "./interaction/dragController";
import { Readout } from "./ui/readout";
import { Screen } from "./ui/screen";
import { ShapesPanel } from "./ui/shapesPanel";
import { GlitchOverlay } from "./ui/glitch";
import { IntroCutscene } from "./interaction/introCutscene";
import { LetterIntro } from "./interaction/letterIntro";
import { BezelControls } from "./ui/bezelControls";
import { HelpDialog } from "./ui/helpDialog";
import { hasSavedProgress } from "./history/historyStore";
import { led } from "./ui/led";
import { fileBase, saveWysiwygPng, saveLightPng, download } from "./render/exportImage";
import { polyhedronToStl } from "./render/exportMesh";

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

// --- glitch overlay ---------------------------------------------------------
// One corruption overlay on top of the grid, shared by the boot sequence (which
// choreographs it) and the new-shape discovery flash. Ticked every frame.
const glitch = new GlitchOverlay(screen, document.getElementById("grid")!);

// --- renderer ---------------------------------------------------------------
// With pixelateRender on, the buffer is rendered at one texel per font pixel
// (pixel ratio 1/pixelSize) and the canvas nearest-neighbor upscaled, so the 3D
// shares the text's chunky pixel grid. Otherwise it renders crisp at full device
// resolution. preserveDrawingBuffer lets the PNG save read the canvas whenever the
// click lands relative to the render loop.
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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
// The top-left SHAPES panel appears once the intro finishes; the SELECTION
// readout box tucks in just below it.
let shapesPanel: ShapesPanel | null = null;
const readout = new Readout(screen, () => shapesPanel?.reservedRows() ?? 0);

// --- post-processing: glass bloom over the 3D view --------------------------
// UnrealBloom gives the polyhedra the same soft halo the text gets from its layered
// text-shadow; both are scaled by config.theme.bloom.intensity so they glow by the
// same amount (see Screen.textGlow). The multisampled HDR target keeps the polyhedra
// edges antialiased (the default composer target has no MSAA) and gives the bloom
// highlights headroom.
const composerTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerTarget);
composer.setPixelRatio(renderer.getPixelRatio());
composer.addPass(new RenderPass(scene, rig.camera));
// UnrealBloom's strength runs hotter than the CSS text glow at the same number, so
// the shared intensity is scaled down here to keep the 3D bloom in step with the
// text. Tune it if you change the look of one but not the other.
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

/** A fresh seed polyhedron with its initial element colors. */
function seedPoly(name: string): Polyhedron {
  const mesh = getSeed(name);
  return new Polyhedron(mesh, seedColors(mesh));
}

let currentSeed: string = config.seeds.initial;
const initialPoly = seedPoly(currentSeed);
rig.frame(new Vector3());

let controller: DragController | null = null;
let intro: IntroCutscene | null = null;

// --- bottom-bezel controls (LED + Help/Info + PNG/STL save) -----------------
// The save buttons act on the current shape and no-op until the controller exists,
// i.e. until the intro hands off. The filename is the shape name, lower-cased with
// spaces turned into underscores.
const helpDialog = new HelpDialog(screen);
const bezelControls = new BezelControls(screen.bezel, {
  onHelp: () => helpDialog.toggle(controller?.isLibraryOpen() ? "library" : "main"),
  onSavePng: () => {
    if (!controller) return;
    const base = fileBase(controller.currentName());
    saveWysiwygPng(renderer, base);
    saveLightPng(renderer, scene, rig.camera, view, controller.currentPoly(), base);
  },
  onSaveStl: () => {
    if (!controller) return;
    const base = fileBase(controller.currentName());
    download(polyhedronToStl(controller.currentPoly()), `${base}.stl`);
  },
});
// Clicks on the Help button toggle the dialog; clicks anywhere else dismiss it.
helpDialog.setToggleButton(bezelControls.helpButton);

// Flick the activity LED while the user drags (orbiting the shape or a handle):
// any pointer move with a button down counts as working.
let pointerDown = false;
window.addEventListener("pointerdown", () => (pointerDown = true));
window.addEventListener("pointerup", () => (pointerDown = false));
window.addEventListener("pointermove", () => {
  if (pointerDown) led.pulse();
});

// The program (the faux-BIOS boot + the shape fading in) doesn't start on load: the
// letter rises first, and the program boots only once the reader puts it away.
// `startProgram` is the handoff, and is safe to call more than once.
function startProgram(): void {
  if (intro) return;
  intro = new IntroCutscene(
    initialPoly,
    view,
    rig.camera,
    rig.controls,
    screen,
    glitch,
    () => {
      intro = null;
      rig.frame(new Vector3());
      // The bottom-left readout appears now, via the controller. The top-left SHAPES
      // panel and the HISTORY panel stay hidden until the first edit.
      shapesPanel = new ShapesPanel(screen);
      controller = new DragController(
        initialPoly,
        seedLabel(currentSeed),
        view,
        rig.camera,
        rig.controls,
        renderer.domElement,
        readout,
        screen,
        glitch,
        shapesPanel,
        () => {
          // First edit: reveal the panels that wait for it.
          shapesPanel?.show();
          readout.enableSelection();
        },
      );
      readout.fadeIn(); // the bottom-left popup fades in as the intro hands off
    });
}

// The worn typewritten letter rises in on load and starts the program when the
// reader puts it away (clicks the center, or off to the side). With the letter
// disabled, the program boots immediately.
if (config.letter.enabled) {
  new LetterIntro(screen, config.letterText, startProgram);
} else {
  startProgram();
  // A returning visitor with saved progress skips the boot intro and lands
  // straight in the app (their made shapes are already restored).
  if (hasSavedProgress()) jumpToApp();
}

/** Skip the boot intro and reveal every panel immediately. */
function jumpToApp() {
  if (!intro) return;
  intro.skip(); // runs the whenFinished above synchronously, creating the panels
  shapesPanel?.show();
  controller?.revealHistory();
  readout.enableSelection();
}

function skipIntro(e: Event) {
  if (!intro) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  jumpToApp();
}

// Any key or click skips the intro and jumps straight to the app, revealing every
// panel without waiting for a first edit. Registered before the main keyboard handler
// and stops the event there, so the skipping keystroke isn't also read as an app
// shortcut.
window.addEventListener("keyup", (e) => {
  if (e.key.length == 1 || e.key == "Escape")
    skipIntro(e);
});
window.addEventListener("pointerup", (e) => {
  skipIntro(e);
});

// --- undo / redo + seed loading via keyboard --------------------------------
window.addEventListener("keydown", (e) => {
  if (!controller) return;
  // Undo: Cmd/Ctrl+Z. Redo: Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y. The camera is kept —
  // shapes are normalized to ~unit, so no reframe is needed.
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
    if (k === d.relaxKey) return void controller.relax();
    if (k === d.facesKey) return void controller.selectStrategy("faces");
    if (k === d.edgesKey) return void controller.selectStrategy("edges");
    if (k === d.jumbledKey) return void controller.selectStrategy("jumbled");
  }

  if (e.key.toLowerCase() === config.seeds.resetKey) {
    // Same as clicking the first HISTORY entry: jump back to the seed root, keeping
    // the timeline intact rather than wiping it with a fresh load.
    controller.jumpTo(0);
    rig.frame(new Vector3());
  }
});

// --- render loop ------------------------------------------------------------
function animate(): void {
  requestAnimationFrame(animate);
  if (intro) intro.update();
  if (controller) controller.update();
  glitch.tick(performance.now());
  rig.update();
  composer.render();
  led.tick(); // apply the activity LED's blink for this frame (after any pulses)
}
animate();
