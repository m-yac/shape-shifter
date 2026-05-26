import { Vector3 } from "three";
import { type Mesh } from "../geometry/HalfEdge";
import { meshRadius } from "../geometry/polyhedron";
import { config } from "../config";
import { planarizeStep } from "./planarize";
import {
  regularizeFacesStep,
  canonicalStep,
  spherizeStep,
  minAdjacentFaceAngle,
  normalizeStep,
} from "./regularize";
import { type SolverTopology } from "./topology";

export type SolverPhase = "planarize" | "regularize" | "done" | "invalid";
export type Strategy = "faces" | "canonical" | "spherize";

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * Relaxation solver, run incrementally across frames so the shape visibly
 * settles. Stage 1 flattens faces (failure => INVALID). Stage 2 regularizes,
 * but escalates its objective if the solid nears collapse (adjacent faces going
 * coplanar): regular faces → equal vertex angles → spherize. Faces are kept flat
 * throughout. Mutates `vertices` in place; call `advance()` until it returns false.
 */
export class RelaxSolver {
  readonly mesh: Mesh;
  phase: SolverPhase = "planarize";
  strategy: Strategy = "faces";

  private iter = 0;
  private readonly startTime = performance.now();
  private damping = config.solver.regularity.dampingStart;
  private readonly radius: number;
  private readonly batch = 10;

  /**
   * @param forced  when set, locks the regularization to this single strategy
   *                instead of the automatic anti-collapse escalation — used by the
   *                manual relax keys to isolate the coplanarity (canonical) step.
   */
  constructor(
    vertices: Vector3[],
    private readonly topo: SolverTopology,
    private readonly forced: Strategy | null = null,
  ) {
    this.mesh = { vertices, faces: topo.orientedFaces };
    this.radius = meshRadius(this.mesh) || 1;
    if (forced) this.strategy = forced;
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
            : this.strategy === "canonical"
              ? "canonicalStep() — dual/midsphere (anti-collapse)"
              : "spherizeStep() — last-resort inflate";
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
    const prev = this.strategy;
    this.chooseStrategy(Rg);
    // A fresh objective needs authority to reshape, so reset the damping ramp.
    if (this.strategy !== prev) this.damping = Rg.dampingStart;

    const step = Rg.stepFactor * this.damping;
    let move: number;
    if (this.strategy === "faces") {
      move = regularizeFacesStep(this.mesh, step, this.radius);
    } else if (this.strategy === "canonical") {
      move = canonicalStep(this.mesh, this.topo.edges, step, this.radius);
    } else {
      move = spherizeStep(this.mesh, step, this.radius);
    }

    // Keep faces flat, then recenter and ease the scale toward avg-radius = target.
    if (Rg.keepPlanar) {
      for (let s = 0; s < Rg.planarSubsteps; s++)
        planarizeStep(this.mesh, planarStep, this.radius);
    }
    const avg = normalizeStep(this.mesh, Rg.targetAverageRadius, Rg.rescaleRate);

    this.damping *= Rg.dampingRate;
    this.iter++;
    // Finish only once the shape has settled AND the rescale has reached target.
    const sizeSettled = Math.abs(avg - Rg.targetAverageRadius) < 0.005;
    if ((move < Rg.convergeTolerance && sizeSettled) || this.iter >= Rg.iterations) {
      this.phase = "done";
    }
  }

  /**
   * Escalate the strategy based on how close to coplanar we are.
   *
   *   faces ──(ang < safe)──▶ canonical ──(ang < danger)──▶ spherize
   *                                ▲                            │
   *                                └────────(ang > danger·m)────┘
   *
   * Note `canonical` is STICKY: it never falls back to `faces`. If a shape shows
   * any flattening tendency under face-regularization (true for Catalan-like
   * solids, whose triangular faces can stay regular while their apex swings flat),
   * then faces is the wrong objective and we keep the canonical/dual objective.
   * Shapes that never flatten (Platonic, Archimedean) simply stay in `faces`.
   */
  private chooseStrategy(Rg: typeof config.solver.regularity): void {
    if (this.forced) {
      this.strategy = this.forced; // locked by the manual relax keys
      return;
    }
    const ang = minAdjacentFaceAngle(this.mesh, this.topo.edgeFaces);
    const safe = deg(Rg.coplanar.safeAngleDeg);
    const danger = deg(Rg.coplanar.dangerAngleDeg);
    const margin = Rg.coplanar.recoverMargin;

    if (this.strategy === "faces") {
      if (ang < safe) this.strategy = "canonical";
    } else if (this.strategy === "canonical") {
      if (ang < danger) this.strategy = "spherize";
    } else {
      if (ang > danger * margin) this.strategy = "canonical";
    }
  }
}
