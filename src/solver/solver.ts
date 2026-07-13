import { Vector3 } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { meshRadius } from "../geometry/polyhedron";
import { config } from "../config";
import { planarizeStep } from "./planarize";
import {
  regularizeFacesStep,
  regularizeVerticesStep,
  canonicalStep,
  normalizeStep,
} from "./regularize";
import { type SolverTopology } from "./topology";

export type SolverPhase = "planarize" | "regularize" | "done";

/**
 * The form the relaxation drives the solid toward, chosen in the OPTIONS panel's
 * Form buttons:
 *   - "faces"   every face a regular polygon    (regularizeFacesStep)
 *   - "edges"   canonical / midsphere form      (canonicalStep)   [default]
 *   - "jumbled" vertex-figure regularizer       (regularizeVerticesStep)
 *
 * "jumbled" does not converge on regular vertex figures — it wanders and its faces
 * never flatten. The wandering is the point, hence the name rather than a
 * regularization objective.
 */
export type Strategy = "jumbled" | "edges" | "faces";

/**
 * Relaxation solver, run incrementally across frames so the shape visibly settles.
 * Stage 1 flattens faces; stage 2 regularizes under the chosen `strategy`, keeping
 * faces flat throughout. Mutates `vertices` in place; call `advance()` until it
 * returns false.
 */
export class RelaxSolver {
  readonly mesh: Mesh;
  phase: SolverPhase = "planarize";
  readonly strategy: Strategy;
  /** While true (an OPTIONS button is held), the regularizer steps at a fixed
   *  strength instead of damping to a stop, and ignores the iteration cap. */
  sustain = false;

  private iter = 0;
  private readonly startTime = performance.now();
  private damping = config.solver.regularity.dampingStart;
  private readonly radius: number;
  private readonly batch = 10;
  /** Latest face-planarity error, relative to `radius`. */
  private planarErr = Infinity;

  constructor(
    vertices: Vector3[],
    private readonly topo: SolverTopology,
    strategy: Strategy = config.solver.defaultStrategy,
  ) {
    this.mesh = { vertices, faces: topo.orientedFaces };
    // Pin the on-screen size up front (recenter + scale to the target average
    // radius). With the per-frame rescale in regularizeOnce this holds the apparent
    // size constant, so a commit or a strategy switch doesn't visibly jump in scale.
    const Rg = config.solver.regularity;
    normalizeStep(this.mesh, Rg.targetAverageRadius, 1);
    this.radius = meshRadius(this.mesh) || 1;
    this.strategy = strategy;
  }

  get done(): boolean {
    return this.phase === "done";
  }
  /** Whether every face is currently flat (within the planarity tolerance). */
  get planar(): boolean {
    return this.planarErr < config.solver.planarity.tolerance;
  }

  /** Debug status naming the function currently being run (shown in the readout). */
  get statusLabel(): string {
    switch (this.phase) {
      case "planarize":
        return `planarizeStep() — flattening faces · iter ${this.iter}`;
      case "regularize": {
        const fn =
          this.strategy === "faces"
            ? "regularizeFacesStep() — regular faces"
            : this.strategy === "jumbled"
              ? "regularizeVerticesStep() — jumbled"
              : "canonicalStep() — midsphere / canonical";
        return `${fn} + normalizeStep() · iter ${this.iter}`;
      }
      default:
        return "done";
    }
  }

  advance(): boolean {
    const P = config.solver.planarity;
    const Rg = config.solver.regularity;

    for (let b = 0; b < this.batch && !this.done; b++) {
      if (this.phase === "planarize") {
        this.planarErr = planarizeStep(this.mesh, P.stepFactor, this.radius);
        this.iter++;
        if (
          this.planarErr < P.tolerance ||
          this.iter >= P.maxIterations ||
          performance.now() - this.startTime > P.timeBudgetMs
        ) {
          // Hand off to the regularize phase either way: if the faces didn't
          // flatten in time, its planarize substeps keep working on them at full
          // strength while its own damping ramp decays.
          this.phase = "regularize";
          this.iter = 0;
          this.damping = Rg.dampingStart;
        }
      } else if (this.phase === "regularize") {
        this.regularizeOnce(Rg, P.stepFactor);
      }
    }
    return !this.done;
  }

  private regularizeOnce(
    Rg: typeof config.solver.regularity,
    planarStep: number,
  ): void {
    // Step strength: while a button is held, the fixed contractive strength;
    // otherwise the decaying ramp that lets the shape come to rest.
    //
    // The ramp has to keep decaying even while the faces are still not planar. The
    // regularity step pulls vertices off their face planes and the planarize
    // substeps below pull them back, so the two settle at an equilibrium whose
    // residual out-of-plane error is proportional to `step`. A step held at full
    // strength pins that residual at its largest, and for shapes whose residual
    // lands near `planarity.tolerance` the faces would then never flatten. Decaying
    // the ramp shrinks the residual until it crosses the tolerance.
    const damp = this.sustain ? Rg.holdDamping : this.damping;
    const step = Rg.stepFactor * damp;
    let move: number;
    if (this.strategy === "faces") {
      move = regularizeFacesStep(this.mesh, step, this.radius);
    } else if (this.strategy === "jumbled") {
      move = regularizeVerticesStep(this.mesh, this.topo.neighbors, step, this.radius);
    } else {
      move = canonicalStep(this.mesh, this.topo.edges, step, this.radius);
    }

    // Keep faces flat (tracking the residual planarity error), then recenter and
    // ease the scale toward avg-radius = target.
    if (Rg.keepPlanar) {
      for (let s = 0; s < Rg.planarSubsteps; s++)
        this.planarErr = planarizeStep(this.mesh, planarStep, this.radius);
    }
    const avg = normalizeStep(this.mesh, Rg.targetAverageRadius, Rg.rescaleRate);

    if (!this.sustain) this.damping *= Rg.dampingRate;
    this.iter++;
    // Finish once the shape has settled and the rescale has reached target. While
    // held, only settling ends it, never the iteration cap.
    const sizeSettled = Math.abs(avg - Rg.targetAverageRadius) < 0.005;
    const tol = this.sustain ? Rg.holdConvergeTolerance : Rg.convergeTolerance;
    const settled = move < tol && sizeSettled;
    const cappedOut = !this.sustain && this.iter >= Rg.iterations;
    if (this.planar) {
      if (settled || cappedOut) this.phase = "done";
    } else if (!this.sustain && settled) {
      // Faces aren't flat, but the ramp has decayed the shape to a standstill, so
      // no further iteration will flatten them (jumbled never does). Stop rather
      // than spin; the SHAPE panel keeps showing `planarity.warnText`. Sustain is
      // exempt, so a held button can go on jumbling.
      this.phase = "done";
    }
  }
}
