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
 * The form the relaxation drives the solid toward, chosen by the user (the OPTIONS
 * panel's "Form" buttons):
 *   - "faces"  make every face a regular polygon       (regularizeFacesStep)
 *   - "edges"  canonical / midsphere form              (canonicalStep)   [default]
 *   - "jumbled" (regularizeVerticesStep)
 *
 * "jumbled" runs the vertex-figure regularizer, which does NOT actually converge on
 * regular vertex figures — it wanders, and its faces never flatten. That is kept
 * deliberately: the wandering is the point, so it is presented as "Jumbled" rather
 * than as a regularization objective. See dragController's hold-to-latch handling,
 * which lets a long press leave it jumbling after the button is released.
 */
export type Strategy = "jumbled" | "edges" | "faces";

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
  /** Latest face-planarity error (relative). Tracked so the relaxation can keep
   *  the canonical step running at full strength until faces actually flatten. */
  private planarErr = Infinity;

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
          // Hand off to the canonical/regularize step either way: if it didn't
          // flatten in time, that step keeps trying (it never marks the shape
          // invalid) — its planarize substeps run at full strength while its own
          // damping ramp decays, so the faces do eventually flatten.
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
    // Step strength: while a button is held use the fixed contractive strength;
    // otherwise use the decaying ramp that lets the shape come to rest.
    //
    // The ramp must keep decaying even while the faces are NOT yet planar. The
    // regularity step pulls vertices off their face planes and the planarize
    // substeps below pull them back, so the two settle at an equilibrium whose
    // residual out-of-plane error is PROPORTIONAL to `step`. Holding the step at
    // full strength therefore pins that residual at its largest — for shapes whose
    // residual coefficient lands near `planarity.tolerance` the faces can never
    // flatten, the shape never reaches `done`, and the SHAPE panel shows
    // `planarity.warnText` forever. Letting the ramp decay shrinks the residual
    // until it crosses the tolerance.
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
    // Finish once the shape has settled (and the rescale reached target). While
    // held we never quit on the iteration cap, only on genuine settling.
    const sizeSettled = Math.abs(avg - Rg.targetAverageRadius) < 0.005;
    const tol = this.sustain ? Rg.holdConvergeTolerance : Rg.convergeTolerance;
    const settled = move < tol && sizeSettled;
    const cappedOut = !this.sustain && this.iter >= Rg.iterations;
    if (this.planar) {
      if (settled || cappedOut) this.phase = "done";
    } else if (!this.sustain && settled) {
      // The faces still aren't flat, but the decaying ramp has run the shape to a
      // standstill, so no further iteration can flatten them ("jumbled" never does).
      // Stop rather than spinning forever — the SHAPE panel keeps showing
      // `planarity.warnText`, and a held button (sustain) is exempt so it can go on
      // jumbling for as long as the user wants.
      this.phase = "done";
    }
  }
}
