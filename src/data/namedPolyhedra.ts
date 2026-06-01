import { type Mesh } from "../geometry/HalfEdge";
import { Polyhedron } from "../geometry/polyhedron";
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
  mesh: Mesh;
}

// --- recipe helpers ---------------------------------------------------------
const seed = (name: string): Mesh => getSeed(name);

/** Uniform truncation (intermediate topology) of a seed. */
const truncate = (mesh: Mesh): Mesh =>
  buildTruncate(new Polyhedron(mesh), 0, null).commit(0.5, false);

/** Rectify / ambo of a seed (the welded "max" of the truncate drag). */
const rectify = (mesh: Mesh): Mesh =>
  buildTruncate(new Polyhedron(mesh), 0, null).commit(1, true);

/** Snub of a seed */
const snub = (mesh: Mesh): Mesh =>
  buildSnub(new Polyhedron(mesh), 0, null).commit(1, true);

/** Kis (intermediate topology) of a seed. */
const kis = (mesh: Mesh): Mesh =>
  buildKis(new Polyhedron(mesh), 0, null).commit(0.5, false);

/** Join of a seed (the welded "max" of the kis drag). */
const join = (mesh: Mesh): Mesh =>
  buildKis(new Polyhedron(mesh), 0, null).commit(1, true);

/** Join of a seed (the welded "max" of the kis drag). */
const gyro = (mesh: Mesh): Mesh =>
  buildGyro(new Polyhedron(mesh), 0, null).commit(1, true);

const P: SolidType = "Platonic solid";
const A: SolidType = "Archimedean solid";
const C: SolidType = "Catalan solid";

export const NAMED: NamedPolyhedron[] = [
  // Platonic solids
  { name: "Tetrahedron", type: P, mesh: seed("tetrahedron") },
  { name: "Cube", type: P, mesh: seed("cube") },
  { name: "Octahedron", type: P, mesh: seed("octahedron") },
  { name: "Dodecahedron", type: P, mesh: seed("dodecahedron") },
  { name: "Icosahedron", type: P, mesh: seed("icosahedron") },

  // Archimedean solids

  // 1. Truncated
  { name: "Truncated tetrahedron", type: A, mesh: truncate(getSeed("tetrahedron")) },
  { name: "Truncated cube", type: A, mesh: truncate(getSeed("cube")) },
  { name: "Truncated octahedron", type: A, mesh: truncate(getSeed("octahedron")) },
  { name: "Truncated dodecahedron", type: A, mesh: truncate(getSeed("dodecahedron")) },
  { name: "Truncated icosahedron", type: A, mesh: truncate(getSeed("icosahedron")) },

  // 2. Rectified
  { name: "Cuboctahedron", type: A, mesh: rectify(getSeed("cube")) },
  { name: "Icosidodecahedron", type: A, mesh: rectify(getSeed("icosahedron")) },

  // 3. Truncated-Rectified
  { name: "Truncated Cuboctahedron", type: A, mesh: truncate(rectify(getSeed("cube"))) },
  { name: "Truncated Icosidodecahedron", type: A, mesh: truncate(rectify(getSeed("icosahedron"))) },

  // 4. Double-Rectified
  { name: "Rhombicuboctahedron", type: A, mesh: rectify(rectify(getSeed("cube"))) },
  { name: "Rhombiccosidodecahedron", type: A, mesh: rectify(rectify(getSeed("icosahedron"))) },

  // 5. Snub-Rectified
  { name: "Snub cuboctahedron", type: A, mesh: snub(rectify(getSeed("cube"))) },
  { name: "Snub Icosidodecahedron", type: A, mesh: snub(rectify(getSeed("icosahedron"))) },

  // Catalan solids

  // 1. Kissed
  { name: "Triakis tetrahedron", type: C, mesh: kis(getSeed("tetrahedron")) },
  { name: "Tetrakis hexahedron", type: C, mesh: kis(getSeed("cube")) },
  { name: "Triakis octahedron", type: C, mesh: kis(getSeed("octahedron")) },
  { name: "Pentakis dodecahedron", type: C, mesh: kis(getSeed("dodecahedron")) },
  { name: "Triakis icosahedron", type: C, mesh: kis(getSeed("icosahedron")) },

  // 2. Joined
  { name: "Rhombic dodecahedron", type: C, mesh: join(getSeed("cube")) },
  { name: "Rhombic triacontahedron", type: C, mesh: join(getSeed("dodecahedron")) },

  // 3. Kissed-Joined
  { name: "Disdyakis dodecahedron", type: C, mesh: kis(join(getSeed("cube"))) },
  { name: "Disdyakis triacontahedron", type: C, mesh: kis(join(getSeed("dodecahedron"))) },

  // 4. Double-Joined
  { name: "Deltoidal icositetrahedron", type: C, mesh: join(join(getSeed("cube"))) },
  { name: "Deltoidal hexecontahedron", type: C, mesh: join(join(getSeed("dodecahedron"))) },

  // 5. Gyro-Joined
  { name: "Pentagonal icositetrahedron", type: C, mesh: gyro(join(getSeed("cube"))) },
  { name: "Pentagonal hexecontahedron", type: C, mesh: gyro(join(getSeed("dodecahedron"))) },
];

/** The family ("Platonic solid", …) of a named solid, or null if unknown. */
export function solidTypeFor(name: string): SolidType | null {
  return NAMED.find((n) => n.name === name)?.type ?? null;
}
