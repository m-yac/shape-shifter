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

export type SolverPhase = "planarize" | "regularize" | "done" | "invalid";

/**
 * The regularization objective, chosen by the user (the OPTIONS panel buttons):
 *   - "faces"    make every face a regular polygon       (regularizeFacesStep)
 *   - "edges"    canonical / midsphere form              (canonicalStep)   [default]
 *   - "vertices" make every vertex figure regular        (regularizeVerticesStep)
 */
export type Strategy = "vertices" | "edges" | "faces";

/**
 * Relaxation solver, run incrementally across frames so the shape visibly
 * settles. Stage 1 flattens faces (failure => INVALID). Stage 2 regularizes using
 * the single chosen `strategy`, keeping faces flat throughout. Mutates `vertices`
 * in place; call `advance()` until it returns false.
 */
export class RelaxSolver {
  readonly mesh: Mesh;
  phase: SolverPhase = "planarize";
  readonly strategy: Strategy;
  /** While true (an OPTIONS button is held), the regularizer keeps stepping at a
   *  fixed strength instead of damping itself to a stop, and ignores the iteration
   *  cap — so it genuinely keeps going until the shape settles or you release. */
  sustain = false;

  private iter = 0;
  private readonly startTime = performance.now();
  private damping = config.solver.regularity.dampingStart;
  private readonly radius: number;
  private readonly batch = 10;

  constructor(
    vertices: Vector3[],
    private readonly topo: SolverTopology,
    strategy: Strategy = config.solver.defaultStrategy,
  ) {
    this.mesh = { vertices, faces: topo.orientedFaces };
    // Pin the on-screen size right away (recenter + scale to the target average
    // radius). Together with the per-frame snap in regularizeOnce this keeps the
    // solid the SAME apparent size throughout — so neither a fresh commit nor a
    // strategy switch makes it visibly jump in scale and then slowly drift back.
    const Rg = config.solver.regularity;
    normalizeStep(this.mesh, Rg.targetAverageRadius, 1);
    this.radius = meshRadius(this.mesh) || 1;
    this.strategy = strategy;
  }

  get done(): boolean {
    return this.phase === "done" || this.phase === "invalid";
  }
  get invalid(): boolean {
    return this.phase === "invalid";
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
            : this.strategy === "vertices"
              ? "regularizeVerticesStep() — regular vertex figures"
              : "canonicalStep() — midsphere / canonical";
        return `${fn} + normalizeStep() · iter ${this.iter}`;
      }
      case "invalid":
        return "INVALID — planarizeStep() did not converge";
      default:
        return "done";
    }
  }

  advance(): boolean {
    const P = config.solver.planarity;
    const Rg = config.solver.regularity;

    for (let b = 0; b < this.batch && !this.done; b++) {
      if (this.phase === "planarize") {
        const err = planarizeStep(this.mesh, P.stepFactor, this.radius);
        this.iter++;
        if (err < P.tolerance) {
          this.phase = "regularize";
          this.iter = 0;
          this.damping = Rg.dampingStart;
        } else if (
          this.iter >= P.maxIterations ||
          performance.now() - this.startTime > P.timeBudgetMs
        ) {
          this.phase = config.solver.invalidOnTimeout ? "invalid" : "regularize";
          this.iter = 0;
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
    // While held, step at a fixed (contractive) strength so it keeps relaxing
    // instead of damping itself toward zero motion; otherwise use the decaying ramp.
    const damp = this.sustain ? Rg.holdDamping : this.damping;
    const step = Rg.stepFactor * damp;
    let move: number;
    if (this.strategy === "faces") {
      move = regularizeFacesStep(this.mesh, step, this.radius);
    } else if (this.strategy === "vertices") {
      move = regularizeVerticesStep(this.mesh, this.topo.neighbors, step, this.radius);
    } else {
      move = canonicalStep(this.mesh, this.topo.edges, step, this.radius);
    }

    // Keep faces flat, then recenter and ease the scale toward avg-radius = target.
    if (Rg.keepPlanar) {
      for (let s = 0; s < Rg.planarSubsteps; s++)
        planarizeStep(this.mesh, planarStep, this.radius);
    }
    const avg = normalizeStep(this.mesh, Rg.targetAverageRadius, Rg.rescaleRate);

    if (!this.sustain) this.damping *= Rg.dampingRate;
    this.iter++;
    // Finish once the shape has settled (and the rescale reached target). While
    // held we never quit on the iteration cap — only on genuine settling, judged
    // by a slightly looser epsilon so a converged shape stops even as you hold.
    const sizeSettled = Math.abs(avg - Rg.targetAverageRadius) < 0.005;
    const tol = this.sustain ? Rg.holdConvergeTolerance : Rg.convergeTolerance;
    const cappedOut = !this.sustain && this.iter >= Rg.iterations;
    if ((move < tol && sizeSettled) || cappedOut) {
      this.phase = "done";
    }
  }
}
