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
  drag. Produced the `p ≈ 0.79·dihedral − 0.85` fit used in `gyro.ts`.
- **`gyro_lift_magnitude.investigate.ts`** — the companion study of the lift
  *magnitude* (the FACE_LIFT constant): how high a q vertex sits above its home
  join face, vs. the join's dihedral / angle deficit.
