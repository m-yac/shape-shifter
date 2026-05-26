import {
  Scene,
  WebGLRenderer,
  Color,
  HemisphereLight,
  DirectionalLight,
  Vector3,
} from "three";
import { config } from "./config";
import { getSeed } from "./geometry/seeds";
import { Polyhedron } from "./geometry/polyhedron";
import { CameraRig } from "./interaction/camera";
import { SceneView } from "./render/sceneView";
import { DragController } from "./interaction/dragController";
import { Readout } from "./ui/readout";

const app = document.getElementById("app")!;
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Title-case a seed key ("tetrahedron" → "Tetrahedron") for the history root. */
const seedLabel = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

// --- renderer ---------------------------------------------------------------
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
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
const readout = new Readout();

let currentSeed: string = config.seeds.initial;
const initialPoly = new Polyhedron(getSeed(currentSeed));
rig.frame(new Vector3());

const controller = new DragController(
  initialPoly,
  seedLabel(currentSeed),
  view,
  rig.camera,
  rig.controls,
  renderer.domElement,
  readout,
);

// --- undo / redo + seed loading via keyboard --------------------------------
window.addEventListener("keydown", (e) => {
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

// --- resize -----------------------------------------------------------------
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  rig.resize();
});

// --- render loop ------------------------------------------------------------
function animate(): void {
  requestAnimationFrame(animate);
  controller.update();
  rig.update();
  renderer.render(scene, rig.camera);
}
animate();
