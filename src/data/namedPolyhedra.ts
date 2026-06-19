import { type Mesh } from "../geometry/HalfEdge";
import { Polyhedron } from "../geometry/polyhedron";
import { seedColors, type ColorSet, type SchemeName } from "../geometry/colors";
import { getSeed } from "../geometry/seeds";
import { buildTruncate } from "../operations/truncate";
import { buildSnub } from "../operations/snub";
import { buildKis } from "../operations/kis";
import { buildGyro } from "../operations/gyro";

/**
 * The named-polyhedron database used for identification.
 *
 * Identification is purely combinatorial (vertex/face configurations + V,E,F),
 * so an entry only needs correct CONNECTIVITY — the positions can be any valid
 * embedding. To keep this list error-free we generate most entries by applying
 * our own operations to the Platonic seeds (e.g. "cuboctahedron = rectify(cube)").
 *
 * ── To add your own ──────────────────────────────────────────────────────────
 *   • From a recipe:  { name: "...", mesh: rectify("octahedron") }
 *   • From raw data:  { name: "...", mesh: { vertices:[...], faces:[[...]] } }
 *     (winding is fixed automatically; positions only need to form a valid solid)
 * ─────────────────────────────────────────────────────────────────────────────
 */
/** The family a named solid belongs to (shown in the discovery popup). */
export type SolidType =
  | "Platonic solid"
  | "Archimedean solid"
  | "Catalan solid"
  | "Johnson solid"
  | "Dihedral solid";

export interface NamedPolyhedron {
  name: string;
  type: SolidType;
  /** A colored embedding built by the recipe. `poly.mesh` is its connectivity
   *  (all identification needs); `poly.colors` carries the geometric colors so
   *  the LIBRARY browse diagram can render each solid in its default colors. */
  poly: Polyhedron;
  /** The symmetry-appropriate color scheme (inherited from the seed the recipe
   *  starts from), so the browse diagram colors each solid the way the live app
   *  does when you make it. */
  scheme: SchemeName;
}

// --- recipe helpers ---------------------------------------------------------
// A recipe carries a *colored* Polyhedron plus the symmetry scheme it inherits
// from its seed; colors propagate through a chain of operations exactly as they
// do during live editing (a fresh seed starts with `seedColors`, and every
// operation layers on its c+n rule), and the scheme rides along unchanged.
interface Recipe {
  poly: Polyhedron;
  scheme: SchemeName;
}

/** The scheme a Platonic seed (and everything derived from it) displays in. */
const schemeForSeed = (name: string): SchemeName =>
  name === "tetrahedron"
    ? "tetrahedral"
    : name === "cube" || name === "octahedron"
      ? "octahedral"
      : "icosahedral";

const seed = (name: string): Recipe => {
  const m = getSeed(name);
  return { poly: new Polyhedron(m, seedColors(m)), scheme: schemeForSeed(name) };
};

const step = (r: Recipe, out: { mesh: Mesh; colors: ColorSet }): Recipe => ({
  poly: new Polyhedron(out.mesh, out.colors),
  scheme: r.scheme,
});

/** Uniform truncation (intermediate topology) of a seed. */
const truncate = (r: Recipe): Recipe =>
  step(r, buildTruncate(r.poly, 0, null).commit(0.5, false));

/** Rectify / ambo of a seed (the welded "max" of the truncate drag). */
const rectify = (r: Recipe): Recipe =>
  step(r, buildTruncate(r.poly, 0, null).commit(1, true));

/** Snub of a seed */
const snub = (r: Recipe): Recipe =>
  step(r, buildSnub(r.poly, 0, null).commit(1, true));

/** Kis (intermediate topology) of a seed. */
const kis = (r: Recipe): Recipe =>
  step(r, buildKis(r.poly, 0, null).commit(0.5, false));

/** Join of a seed (the welded "max" of the kis drag). */
const join = (r: Recipe): Recipe =>
  step(r, buildKis(r.poly, 0, null).commit(1, true));

/** Gyro of a seed (the welded "max" of the gyro drag). */
const gyro = (r: Recipe): Recipe =>
  step(r, buildGyro(r.poly, 0, null).commit(1, true));

/** Finalize a recipe into a named-database entry. */
const E = (name: string, type: SolidType, r: Recipe): NamedPolyhedron => ({
  name,
  type,
  poly: r.poly,
  scheme: r.scheme,
});

const P: SolidType = "Platonic solid";
const A: SolidType = "Archimedean solid";
const C: SolidType = "Catalan solid";

export const NAMED: NamedPolyhedron[] = [
  // Platonic solids
  E("Tetrahedron", P, seed("tetrahedron")),
  E("Cube", P, seed("cube")),
  E("Octahedron", P, seed("octahedron")),
  E("Dodecahedron", P, seed("dodecahedron")),
  E("Icosahedron", P, seed("icosahedron")),

  // Archimedean solids

  // 1. Truncated
  E("Truncated tetrahedron", A, truncate(seed("tetrahedron"))),
  E("Truncated cube", A, truncate(seed("cube"))),
  E("Truncated octahedron", A, truncate(seed("octahedron"))),
  E("Truncated dodecahedron", A, truncate(seed("dodecahedron"))),
  E("Truncated icosahedron", A, truncate(seed("icosahedron"))),

  // 2. Rectified
  E("Cuboctahedron", A, rectify(seed("cube"))),
  E("Icosidodecahedron", A, rectify(seed("icosahedron"))),

  // 3. Truncated-Rectified
  E("Truncated Cuboctahedron", A, truncate(rectify(seed("cube")))),
  E("Truncated Icosidodecahedron", A, truncate(rectify(seed("icosahedron")))),

  // 4. Double-Rectified
  E("Rhombicuboctahedron", A, rectify(rectify(seed("cube")))),
  E("Rhombicosidodecahedron", A, rectify(rectify(seed("icosahedron")))),

  // 5. Snub-Rectified
  E("Snub cuboctahedron", A, snub(rectify(seed("cube")))),
  E("Snub Icosidodecahedron", A, snub(rectify(seed("icosahedron")))),

  // Catalan solids

  // 1. Kissed
  E("Triakis tetrahedron", C, kis(seed("tetrahedron"))),
  E("Tetrakis hexahedron", C, kis(seed("cube"))),
  E("Triakis octahedron", C, kis(seed("octahedron"))),
  E("Pentakis dodecahedron", C, kis(seed("dodecahedron"))),
  E("Triakis icosahedron", C, kis(seed("icosahedron"))),

  // 2. Joined
  E("Rhombic dodecahedron", C, join(seed("cube"))),
  E("Rhombic triacontahedron", C, join(seed("dodecahedron"))),

  // 3. Kissed-Joined
  E("Disdyakis dodecahedron", C, kis(join(seed("cube")))),
  E("Disdyakis triacontahedron", C, kis(join(seed("dodecahedron")))),

  // 4. Double-Joined
  E("Deltoidal icositetrahedron", C, join(join(seed("cube")))),
  E("Deltoidal hexecontahedron", C, join(join(seed("dodecahedron")))),

  // 5. Gyro-Joined
  E("Pentagonal icositetrahedron", C, gyro(join(seed("cube")))),
  E("Pentagonal hexecontahedron", C, gyro(join(seed("dodecahedron")))),
];

/** The family ("Platonic solid", …) of a named solid, or null if unknown. */
export function solidTypeFor(name: string): SolidType | null {
  return NAMED.find((n) => n.name === name)?.type ?? null;
}

// Case-insensitive lookup from a display name to its database entry. The
// LIBRARY diagram (config) lists names in Title Case ("Truncated Tetrahedron")
// while the database mixes case ("Truncated tetrahedron"), so normalize both.
const BY_NAME = new Map<string, NamedPolyhedron>();
for (const e of NAMED) BY_NAME.set(e.name.toLowerCase(), e);

/** The database entry (colored Polyhedron + scheme) for a named solid
 *  (case-insensitive), or null. */
export function namedPolyhedronFor(name: string): NamedPolyhedron | null {
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}
