import { it } from "vitest";
import { Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron, meshRadius } from "../src/geometry/polyhedron";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildChamfer } from "../src/operations/chamfer";
import { buildSubdivide } from "../src/operations/subdivide";
import { buildGyro } from "../src/operations/gyro";
import { extractTopology } from "../src/solver/topology";
import { planarizeStep } from "../src/solver/planarize";
import { regularizeFacesStep, normalizeStep } from "../src/solver/regularize";
import { RelaxSolver, type Strategy } from "../src/solver/solver";
import { config } from "../src/config";

const P = config.solver.planarity;
const Rg = config.solver.regularity;

const poly = (p: { mesh: Mesh; colors: ColorSet }) => new Polyhedron(p.mesh, p.colors);
const seed = (n: string) => new Polyhedron(getSeed(n));
type Mesh = Polyhedron["mesh"];
type ColorSet = Polyhedron["colors"];

const cases: Array<[string, () => Polyhedron]> = [
  ["cube→kis(.5)", () => poly(buildKis(seed("cube"), 0, null).commit(0.5, false))],
  ["cube→chamfer(.5)", () => poly(buildChamfer(seed("cube"), [0, 1], 0).commit(0.5, false))],
  ["cube→subdivide(.5)", () => poly(buildSubdivide(seed("cube"), [0, 1]).commit(0.5, false))],
  ["cube→gyro(1)", () => poly(buildGyro(seed("cube"), 0, new Vector3(1, 1, 1)).commit(1, false))],
  ["cube→trunc(.5)→kis(.5)", () => {
    const t = poly(buildTruncate(seed("cube"), 0, null).commit(0.5, false));
    return poly(buildKis(t, 0, null).commit(0.5, false));
  }],
  ["icosa→chamfer(.5)", () => poly(buildChamfer(seed("icosahedron"), [0, 1], 0).commit(0.5, false))],
  ["dodeca→chamfer(.6)", () => poly(buildChamfer(seed("dodecahedron"), [0, 1], 0).commit(0.6, false))],
];

/**
 * Part 1. The equilibrium law behind the "faces won't planarize" warning.
 *
 * In the regularize phase, `regularizeFacesStep` pulls vertices off their face
 * planes and the `planarSubsteps` calls to `planarizeStep` pull them back. They
 * settle at an equilibrium, and its residual out-of-plane error is LINEAR in the
 * regularity step size. So the step size alone decides whether a given shape ever
 * reads as planar (`planarity.tolerance`) — no amount of extra iteration helps.
 */
it("planarity residual is proportional to the regularize step", () => {
  console.log(`planarity tolerance = ${P.tolerance}`);
  console.log(`(the app uses step = regularity.stepFactor * damping = ${Rg.stepFactor} * damp)\n`);
  for (const [name, mk] of cases) {
    const base = mk();
    const topo = extractTopology(base);
    const row: string[] = [];
    for (const step of [0.25, 0.5, 1.0, 2.0]) {
      const mesh = { vertices: base.raw.vertices.map((v) => v.clone()), faces: topo.orientedFaces };
      normalizeStep(mesh, Rg.targetAverageRadius, 1);
      const radius = meshRadius(mesh) || 1;
      let err = Infinity;
      for (let i = 0; i < 3000; i++) {
        regularizeFacesStep(mesh, step, radius);
        for (let s = 0; s < Rg.planarSubsteps; s++) err = planarizeStep(mesh, P.stepFactor, radius);
        normalizeStep(mesh, Rg.targetAverageRadius, Rg.rescaleRate);
      }
      row.push(`step ${step.toFixed(2)}: ${err.toExponential(2)}${err < P.tolerance ? " " : "*"}`);
    }
    console.log(`  ${name.padEnd(24)} ${row.join("   ")}`);
  }
  console.log("\n  (* = above tolerance, i.e. reads as non-planar)");
});

/**
 * Part 2. The two ways the app drives the solver: a fresh commit relaxes on its
 * own (`sustain = false`, decaying damping ramp), whereas a HELD OPTIONS button
 * pins the step at `holdDamping` and never lets the solver stop. Both must reach
 * planar for the shapes above; the held run is expected to report done=false,
 * since by design it only stops when the button is released.
 */
function run(p: Polyhedron, strategy: Strategy, sustain: boolean, frames = 2000) {
  const topo = extractTopology(p);
  const s = new RelaxSolver(p.mesh.vertices.map((v: Vector3) => v.clone()), topo, strategy);
  let f = 0;
  for (; f < frames && !s.done; f++) {
    s.sustain = sustain;
    s.advance();
  }
  return { done: s.done, planar: s.planar, frames: f };
}

it("faces strategy: auto commit (sustain=false) vs held button (sustain=true)", () => {
  for (const [name, mk] of cases) {
    const p = mk();
    const fmt = (r: ReturnType<typeof run>) =>
      `planar=${String(r.planar).padEnd(5)} done=${String(r.done).padEnd(5)} frames=${r.frames}`;
    console.log(`\n${name}`);
    console.log(`  faces auto : ${fmt(run(p, "faces", false))}`);
    console.log(`  faces held : ${fmt(run(p, "faces", true))}`);
    console.log(`  edges auto : ${fmt(run(p, "edges", false))}`);
  }
});
