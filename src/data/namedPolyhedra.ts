import { type Mesh } from "../geometry/HalfEdge";
import { Polyhedron } from "../geometry/polyhedron";
import { seedColors, type ColorSet, type SchemeName } from "../geometry/colors";
import { getSeed } from "../geometry/seeds";
import { buildTruncate } from "../operations/truncate";
import { buildSnub } from "../operations/snub";
import { buildKis } from "../operations/kis";
import { buildGyro } from "../operations/gyro";
import { buildChamfer } from "../operations/chamfer";
import { buildSubdivide } from "../operations/subdivide";

/**
 * The named-polyhedron database — the SINGLE source of truth for both
 * identification (`identify/identify.ts`) and the LIBRARY browse diagram
 * (`ui/libraryBrowser.ts` via `libraryShapeFor`).
 *
 * Identification is purely combinatorial (vertex/face configurations + V,E,F), so
 * an entry only needs correct CONNECTIVITY. The LIBRARY, however, also renders each
 * solid in its *default colors*, and those depend on the construction PATH — so we
 * build every solid the way the GAME makes it: rooted at the tetrahedron (the only
 * starting seed), following the same operation tree the player would (e.g. the
 * game's cube is `join(tetrahedron)`, whose faces inherit the tetrahedron's edge
 * color — not a bare cube seed whose faces are color 0). Each entry also carries the
 * symmetry color SCHEME it displays in, mirroring the live app's auto-switch.
 *
 * ── To add your own ──────────────────────────────────────────────────────────
 *   Build it from an existing solid with the recipe helpers below (truncate /
 *   rectify / kis / join / snub / gyro, or the arity-selected truncateVerticesOfDegree
 *   / kisFacesOfSides), then add an `E(name, type, scheme, poly)` entry.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/** The family a named solid belongs to (shown in the discovery popup). */
export type SolidType =
  | "Platonic solid"
  | "Archimedean solid"
  | "Catalan solid"
  | "Chamfered solid"
  | "Subdivided solid"
  | "Johnson solid"
  | "Dihedral solid";

/** One recorded construction step from the tetrahedron: the verb applied and the
 *  resulting (post-operation) solid. The chain excludes the tetrahedron root. */
export interface BuildStep {
  label: string;
  poly: Polyhedron;
}

export interface NamedPolyhedron {
  name: string;
  type: SolidType;
  /** A colored embedding built by the recipe. `poly.mesh` is its connectivity
   *  (all identification needs); `poly.colors` carries the geometric colors so
   *  the LIBRARY browse diagram can render each solid in its default colors. */
  poly: Polyhedron;
  /** The symmetry-appropriate color scheme (the one the live app auto-switches to
   *  for this solid's family), so the browse diagram colors each solid the way the
   *  live app does when you make it. */
  scheme: SchemeName;
  /** The construction chain from the tetrahedron (excluding the root), so the
   *  LIBRARY can reopen the solid in the main view with a tetrahedron-rooted
   *  history even when the user never personally made it. */
  steps: BuildStep[];
}

// --- recipe helpers ---------------------------------------------------------
// Colors propagate through a chain of operations exactly as they do during live
// editing (a fresh seed starts with `seedColors`, and every operation layers on its
// c+n rule). Each helper takes and returns a *colored* Polyhedron.
const wrap = (r: { mesh: Mesh; colors: ColorSet }): Polyhedron =>
  new Polyhedron(r.mesh, r.colors);

/** Uniform truncation (intermediate topology). */
const truncate = (p: Polyhedron): Polyhedron =>
  wrap(buildTruncate(p, 0, null).commit(0.5, false));
/** Rectify / ambo (the welded "max" of the truncate drag). */
const rectify = (p: Polyhedron): Polyhedron =>
  wrap(buildTruncate(p, 0, null).commit(1, true));
/** Kis (intermediate topology). */
const kis = (p: Polyhedron): Polyhedron =>
  wrap(buildKis(p, 0, null).commit(0.5, false));
/** Join (the welded "max" of the kis drag). */
const join = (p: Polyhedron): Polyhedron =>
  wrap(buildKis(p, 0, null).commit(1, true));
/** Snub of `p` — a SINGLE game operation: the vertex drag rectifies `p` and keeps
 *  going into the twist, so the rectification is an internal stage, not a step of
 *  its own. (Any vertex / anchor works, since the committed topology is the
 *  whole-solid snub.) */
const snub = (p: Polyhedron): Polyhedron => {
  const r = rectify(p);
  return wrap(buildSnub(r, 0, r.vertices[0].clone()).commit(1, true));
};
/** Gyro of `p` — likewise a single operation: the face drag joins `p` and twists on. */
const gyro = (p: Polyhedron): Polyhedron => {
  const j = join(p);
  return wrap(buildGyro(j, 0, j.vertices[0].clone()).commit(1, true));
};

// --- chamfer / subdivide ----------------------------------------------------
// These are built with the actual interactive operations (the same `buildChamfer`
// / `buildSubdivide` the game runs on a dragged edge), rather than reconstructed
// from truncate/kis on a selected arity. That arity trick can't express the
// tetrahedron — its join (the cube) is vertex-uniform and its rectify (the
// octahedron) is face-uniform, so there's no sub-arity to target — whereas the
// real operation chamfers/subdivides EVERY edge and so handles it directly. Any
// edge works as the drag handle (the op is global); we just take the first.

/** Chamfer (intermediate topology) every edge of `p`. */
const chamfer = (p: Polyhedron): Polyhedron => {
  const he = p.dcel.halfedges[0];
  const edge: [number, number] = [he.origin.id, he.next.origin.id];
  return wrap(buildChamfer(p, edge, he.face.id).commit(0.5, false));
};

/** Subdivide (intermediate topology) every edge of `p`. */
const subdivide = (p: Polyhedron): Polyhedron => {
  const he = p.dcel.halfedges[0];
  const edge: [number, number] = [he.origin.id, he.next.origin.id];
  return wrap(buildSubdivide(p, edge).commit(0.5, false));
};

// --- step-recording builds --------------------------------------------------
// A Build is a solid together with the chain of operations that produced it from
// the tetrahedron. The low-level recipe helpers above stay pure (poly → poly);
// these wrappers apply one and append the labeled step, so every named solid
// carries a tetrahedron-rooted history.
// The tetrahedron — the only starting seed, and the root of every construction.
const tetMesh = getSeed("tetrahedron");
const tet = new Polyhedron(tetMesh, seedColors(tetMesh));

interface Build {
  poly: Polyhedron;
  steps: BuildStep[];
}
const root: Build = { poly: tet, steps: [] };
const step = (b: Build, fn: (p: Polyhedron) => Polyhedron, label: string): Build => {
  const poly = fn(b.poly);
  return { poly, steps: [...b.steps, { label, poly }] };
};
const Truncate = (b: Build): Build => step(b, truncate, "Truncate");
const Rectify = (b: Build): Build => step(b, rectify, "Rectify");
const Kis = (b: Build): Build => step(b, kis, "Kis");
const Join = (b: Build): Build => step(b, join, "Join");
const Snub = (b: Build): Build => step(b, snub, "Snub");
const Gyro = (b: Build): Build => step(b, gyro, "Gyro");
const Chamfer = (b: Build): Build => step(b, chamfer, "Chamfer");
const Subdivide = (b: Build): Build => step(b, subdivide, "Subdivide");

/** Finalize a build into a named-database entry. */
const E = (
  name: string,
  type: SolidType,
  scheme: SchemeName,
  b: Build,
): NamedPolyhedron => ({ name, type, poly: b.poly, scheme, steps: b.steps });

const P: SolidType = "Platonic solid";
const A: SolidType = "Archimedean solid";
const C: SolidType = "Catalan solid";
const Ch: SolidType = "Chamfered solid";
const Sub: SolidType = "Subdivided solid";

const TE: SchemeName = "tetrahedral";
const OC: SchemeName = "octahedral";
const IC: SchemeName = "icosahedral";

// --- the construction tree, rooted at the tetrahedron -----------------------
// (Identical to what the game produces from the only starting seed; the Build
// wrappers record each step so a tetrahedron-rooted history can be replayed.)
const octB = Rectify(root); //     rectify(tetra) = octahedron
const cubeB = Join(root); //       join(tetra)    = cube
// Snub / gyro are SINGLE operations that pass through the rectify / join on their
// way, so they hang off the same parent as those — not off their result. (Snubbing
// the tetrahedron makes the icosahedron in one drag; the octahedron is never a step.)
const icoB = Snub(root); //        snub(tetra)    = icosahedron
const dodB = Gyro(root); //        gyro(tetra)    = dodecahedron

const cuboctB = Rectify(octB); //  rectify(octa)  = cuboctahedron
const rhDodB = Join(octB); //      join(octa)     = rhombic dodecahedron
const icosidodB = Rectify(icoB); // rectify(icosa) = icosidodecahedron
const rhTriB = Join(icoB); //      join(icosa)    = rhombic triacontahedron

export const NAMED: NamedPolyhedron[] = [
  // Platonic solids
  E("Tetrahedron", P, TE, root),
  E("Octahedron", P, OC, octB),
  E("Cube", P, OC, cubeB),
  E("Icosahedron", P, IC, icoB),
  E("Dodecahedron", P, IC, dodB),

  // Archimedean solids — truncations
  E("Truncated tetrahedron", A, TE, Truncate(root)),
  E("Truncated octahedron", A, OC, Truncate(octB)),
  E("Truncated cube", A, OC, Truncate(cubeB)),
  E("Truncated icosahedron", A, IC, Truncate(icoB)),
  E("Truncated dodecahedron", A, IC, Truncate(dodB)),
  // Archimedean solids — rectifications & beyond
  E("Cuboctahedron", A, OC, cuboctB),
  E("Icosidodecahedron", A, IC, icosidodB),
  E("Truncated Cuboctahedron", A, OC, Truncate(cuboctB)),
  E("Truncated Icosidodecahedron", A, IC, Truncate(icosidodB)),
  E("Rhombicuboctahedron", A, OC, Rectify(cuboctB)),
  E("Rhombicosidodecahedron", A, IC, Rectify(icosidodB)),
  E("Snub cuboctahedron", A, OC, Snub(octB)),
  E("Snub Icosidodecahedron", A, IC, Snub(icoB)),

  // Catalan solids — kis
  E("Triakis tetrahedron", C, TE, Kis(root)),
  E("Triakis octahedron", C, OC, Kis(octB)),
  E("Tetrakis hexahedron", C, OC, Kis(cubeB)),
  E("Triakis icosahedron", C, IC, Kis(icoB)),
  E("Pentakis dodecahedron", C, IC, Kis(dodB)),
  // Catalan solids — joins & beyond
  E("Rhombic dodecahedron", C, OC, rhDodB),
  E("Rhombic triacontahedron", C, IC, rhTriB),
  E("Disdyakis dodecahedron", C, OC, Kis(rhDodB)),
  E("Disdyakis triacontahedron", C, IC, Kis(rhTriB)),
  E("Deltoidal icositetrahedron", C, OC, Join(cuboctB)),
  E("Deltoidal hexecontahedron", C, IC, Join(icosidodB)),
  E("Pentagonal icositetrahedron", C, OC, Gyro(octB)),
  E("Pentagonal hexecontahedron", C, IC, Gyro(icoB)),

  // Chamfered solids — every edge chamfered (the live operation).
  E("Chamfered tetrahedron", Ch, TE, Chamfer(root)),
  E("Chamfered cube", Ch, OC, Chamfer(cubeB)),
  E("Chamfered octahedron", Ch, OC, Chamfer(octB)),
  E("Chamfered dodecahedron", Ch, IC, Chamfer(dodB)),
  E("Chamfered icosahedron", Ch, IC, Chamfer(icoB)),

  // Subdivided solids — every edge subdivided (the live operation).
  E("Subdivided tetrahedron", Sub, TE, Subdivide(root)),
  E("Subdivided cube", Sub, OC, Subdivide(cubeB)),
  E("Subdivided octahedron", Sub, OC, Subdivide(octB)),
  E("Subdivided dodecahedron", Sub, IC, Subdivide(dodB)),
  E("Subdivided icosahedron", Sub, IC, Subdivide(icoB)),
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

/** One entry of a synthesized tetrahedron-rooted history (used when no user-made
 *  timeline exists for a shape — e.g. opening it via the reveal-all cheat). */
export interface HistoryStepData {
  label: string;
  poly: Polyhedron;
  isSeed: boolean;
}

/** The full tetrahedron-rooted construction chain for a named solid (the
 *  tetrahedron seed followed by each recorded operation's result), or null. */
export function historyStepsFor(name: string): HistoryStepData[] | null {
  const e = BY_NAME.get(name.trim().toLowerCase());
  if (!e) return null;
  const out: HistoryStepData[] = [{ label: "Tetrahedron", poly: tet, isSeed: true }];
  for (const s of e.steps) out.push({ label: s.label, poly: s.poly, isSeed: false });
  return out;
}
