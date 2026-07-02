# Empirical investigations

Scratch experiments that measure geometric properties of the operations and fit
the constants baked into `src/operations/*`. They are **not** part of the test
suite — each one sweeps parameters and `console.log`s a table rather than
asserting, so a human reads the output and derives (or checks) a formula.

Run them all:

```sh
npm run investigate
```

Run one by name filter (vitest `-t` / path filter both work):

```sh
npm run investigate -- gyro_lift_exponent
```

Each file is named `*.investigate.ts` so the normal `npm test` never picks it
up; they run only under `vitest.investigations.config.ts`.

## Current investigations

- **`gyro_lift_exponent.investigate.ts`** — how far the q-vertex lift must lead
  the in-plane slide (`lift = t^p`) to keep the split gyro faces planar during a
  drag. Produced the `p ≈ 0.79·dihedral − 0.85` fit used in `gyro.ts`. Sweeps both
  **relaxed** joins (canonical, uniform faces — where that fit was made) and **raw**
  un-relaxed joins (the drag-time geometry straight out of `buildKis`, the only path
  that exercises kis's per-face `computeJoinHeights`). Beyond the single global
  exponent it does a **per-q schedule** sweep (coordinate descent on a per-q exponent,
  seeded at the current heuristic) and an **endpoint (t=1) target** sweep (frees each
  q's slide/lift magnitude to flatten the final pentagon). Finding: on *non-canonical*
  raw joins (e.g. `join(cuboctahedron)`) the exponent has **no leverage** — the t=1
  gyro pentagon is itself ~0.05 non-planar, so no schedule flattens it, and freeing the
  lift magnitude alone barely helps (0.055→0.049); only freeing the per-q slide *and*
  lift together recovers planarity (→~0.006). So matching kis's planar-join change wants
  a per-q **gyro target solve** (slide + lift), the analog of `computeJoinHeights`, not a
  new `liftExponent`.
- **`gyro_lift_magnitude.investigate.ts`** — the companion study of the lift
  *magnitude* (the FACE_LIFT constant): how high a q vertex sits above its home
  join face, vs. the join's dihedral / angle deficit.
- **`truncate_planarity.investigate.ts`** — non-planarity of the faces created
  by truncating / rectifying a non-canonical solid (e.g. the triakis
  tetrahedron), and a per-edge cut-speed adjustment that flattens them.
