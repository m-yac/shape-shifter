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
- **`faces_planarity.investigate.ts`** — why the `"faces"` strategy used to report
  `planarity.warnText` on a fresh commit. The regularity step pulls vertices off
  their face planes while the planarize substeps pull them back; they reach an
  equilibrium whose residual out-of-plane error is **linear in the step size**, so
  iterating longer never helps — only a smaller step does. The auto path used to
  pin the step at full strength (`stepFactor * dampingStart` = 2) whenever the
  faces were non-planar, which pinned the residual at its largest and, since
  `done` requires planar, meant such shapes never finished relaxing at all.
  Holding an OPTIONS button ran at half that (`holdDamping`), which is why a click
  "fixed" the warning without visibly moving the shape. Also compares the auto
  (`sustain = false`) and held (`sustain = true`) drive paths per shape.
- **`ico_snub_color_rules.investigate.ts`** — can the `config.colors.operations.snub`
  rules be chosen so an icosahedral-symmetry solid built out of the tetrahedron gets the
  swatches it *would* get if the icosahedron were an atomic seed with one-hot element IDs?
  (Symptom: subdividing the icosidodecahedron leaves 12 triangles `red` instead of a tint.)
  Works entirely in the collapsed 3-vector provenance space, since that is all the swatch
  lookup ever sees. **Key result:** a named color comes out wrong exactly when a scheme
  group's key is *stolen* by another group. The old rules had 4 such keys and they accounted
  for all 56 wrong colors; the worst was `snub.newVertex` = `0.75·oldVertex + 0.25·oldEdge`
  landing on `[.125,.125,.75]`, which is *identical* to "0.75 of an icosahedron edge + 0.25
  of an icosahedron face" — the exact combination `subdivide.newFace` computes, hence the
  red triangles. The root cause was `snub.newFace = {oldEdge: 1}`, which made the
  octahedron's edge color an icosahedron FACE color. **The fix (shipped):** read each snub
  rule off what the new element BORDERS — `newFace = (2·oldEdge + oldVertex)/3` (two old
  edges and one new edge), `snubEdge = (oldFace + newFace)/2` (the two faces it borders) —
  which moves the face color off that point and frees `newVertex` to stay at its old 3:1
  tint. That leaves 0 stolen keys and 0 wrong colors at every depth. It needs ONE new
  synthesized swatch family, `avg(<a>,<b>,<c>)` (the equal 1/3 mix of all three groups),
  because the new gap triangle is exactly that mix and would otherwise fall back to white.
  The sweeps kept here also record the paths NOT taken: with the old `newFace` the choice
  was a forced trade-off (3261 steal-free rule sets exist, but every one costs the face
  color of two of the four snub/gyro library solids), and freeing `newVertex` to a full
  three-token rule does not dodge it — **zero** weightings satisfy both.
- **`provenance_collapse.investigate.ts`** — can a color SCHEME be a linear collapse of the
  14-vector rather than an enumerated lookup table? I.e. is there an `L_ico : R^14 → R^3`
  sending every icosahedron face → `[1,0,0]`, vertex → `[0,1,0]`, edge → `[0,0,1]`, the way
  `collapse` does for the tetrahedron — so `avg`/`tint` become plain interpolation between
  three swatches? **No — and provably not, for the octahedron either, under ANY choice of rule
  coefficients.** The octahedron's 8 faces ARE the tetrahedron's 4 face one-hots plus its 4
  vertex one-hots, and its 6 vertices ARE the 6 edge one-hots, so the constraints already pin
  `L` on the whole basis (`L(tetFace) = L(tetVert) = FACE`, `L(tetEdge) = VERT`). Every ID is a
  *convex* combination of that basis, so every image lies on the FACE–VERT segment and the EDGE
  corner is unreachable. The witness: all 12 octahedron edges are the exact midpoint of two
  octahedron *faces* in ID space. The octa/ico edge orbit is intrinsically a MIXTURE of the
  other two, which is why an exact-match table is needed to recover it. **The fix, measured in
  section 4:** don't *derive* the icosahedral triple — *seed* it. Give the icosahedron the same
  privilege the tetrahedron has (faces `[1,0,0]`, verts `[0,1,0]`, edges `[0,0,1]`; the
  dodecahedron the same with face/vert swapped) and propagate with the same rules. No new
  machinery — a `GeomColor` is a `number[]` and every rule is convex, so `combine` propagates a
  3-vector as happily as a 14-vector. Across 42 chains / 15084 elements: **0 land outside the
  triangle, coords sum to 1 exactly, and both routes to every shared solid agree.** The 25
  barycentric points that occur reproduce today's table wherever it has an answer (`[1,0,0]` =
  yellow, `[0.5,0.5,0]` = `avg(red,yellow)`, `[0.75,0.25,0]` = `tint(yellow)`, …), give real
  colors to the 4464 / 15084 elements that fall back to `white` today, and collapse the one
  point today splits across two swatches — the key-stealing bug — into a single color.
- **`truncate_planarity.investigate.ts`** — non-planarity of the faces created
  by truncating / rectifying a non-canonical solid (e.g. the triakis
  tetrahedron), and a per-edge cut-speed adjustment that flattens them.
