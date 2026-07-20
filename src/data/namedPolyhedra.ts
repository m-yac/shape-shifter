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
import { type OperationKind } from "../operations/types";
import { operationLabel, type OpDescriptor } from "../operations/naming";
import { config } from "../config";

/**
 * The named-polyhedron database, used by both identification (`identify/identify.ts`)
 * and the LIBRARY browse diagram (`ui/libraryBrowser.ts` via `libraryShapeFor`).
 *
 * Identification is purely combinatorial (vertex/face configurations plus V, E, F),
 * so an entry only needs correct connectivity. The LIBRARY also renders each solid in
 * its default colors, and those depend on the construction path, so every solid is
 * built the way the game makes it: rooted at the tetrahedron, the only starting seed,
 * following the same operation tree a player would. The game's cube is
 * `join(tetrahedron)`, whose faces inherit the tetrahedron's edge color, not a bare
 * cube seed whose faces are color 0. Each entry also carries the symmetry color
 * scheme it displays in, mirroring the live app's auto-switch.
 *
 * To add one: build it from an existing solid with the recipe helpers below (truncate,
 * rectify, kis, join, snub, gyro) and add an `E(name, type, scheme, build)` entry.
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

/** One recorded construction step from the tetrahedron: the operation applied and the
 *  resulting (post-operation) solid. The chain excludes the tetrahedron root. The op is the
 *  same `OpDescriptor` a live edit produces (kind, weld end, whole-solid selection, and —
 *  for snub / gyro — the handedness the recipe built), so a history synthesized from it
 *  reads identically to one the player made: its row label is `operationLabel(op)` ("R-Snub",
 *  not a bare "Snub"), and its derived name flows through the same `composeName`. */
export interface BuildStep {
  op: OpDescriptor;
  poly: Polyhedron;
}

export interface NamedPolyhedron {
  name: string;
  /** True when `name` was auto-generated as "<modifier> <parent name>" (e.g. "Truncated
   *  Cube") rather than a special one-off name (Cube, Rhombic dodecahedron). Such a name
   *  behaves transparently in derived names: truncating a truncated cube stacks to
   *  "2x Truncated Cube" instead of nesting "Truncated Truncated Cube". */
  auto: boolean;
  /** True for the two snub / gyro results that are *not* chiral: the icosahedron (snub of
   *  the tetrahedron) and the dodecahedron (gyro of the tetrahedron). A chiral drag produces
   *  a handed name by default ("R-Snub Cube"), so these achiral exceptions are marked to
   *  suppress it — an icosahedron is never "R-Icosahedron". Every other snub / gyro result
   *  (snub cube/dodecahedron, pentagonal icositetrahedron/hexecontahedron) is genuinely
   *  chiral and takes the handedness. */
  achiral: boolean;
  type: SolidType;
  /** A colored embedding built by the recipe. `poly.mesh` is its connectivity, all
   *  identification needs; `poly.colors` carries the geometric colors the LIBRARY
   *  diagram renders with. */
  poly: Polyhedron;
  /** The color scheme the live app auto-switches to for this solid's family, so the
   *  browse diagram colors it the way the live app does. */
  scheme: SchemeName;
  /** The construction chain from the tetrahedron (excluding the root), so the LIBRARY
   *  can reopen the solid with a tetrahedron-rooted history even when the user never
   *  made it themselves. */
  steps: BuildStep[];
}

// --- recipe helpers ---------------------------------------------------------
// Colors propagate through a chain of operations exactly as they do during live
// editing: a fresh seed starts with `seedColors` and every operation layers on its
// combination rule. Each helper takes and returns a colored Polyhedron.
const wrap = (r: { mesh: Mesh; colors: ColorSet }): Polyhedron =>
  new Polyhedron(r.mesh, r.colors);

/** Uniform truncation (intermediate topology). */
const truncate = (p: Polyhedron): Polyhedron =>
  wrap(buildTruncate(p, 0, null).commit(0.5, false));
/** Rectify / ambo: the welded max of the truncate drag. */
const rectify = (p: Polyhedron): Polyhedron =>
  wrap(buildTruncate(p, 0, null).commit(1, true));
/** Kis (intermediate topology). */
const kis = (p: Polyhedron): Polyhedron =>
  wrap(buildKis(p, 0, null).commit(0.5, false));
/** Join: the welded max of the kis drag. */
const join = (p: Polyhedron): Polyhedron =>
  wrap(buildKis(p, 0, null).commit(1, true));
// Snub / gyro are single game operations that rectify / join `p` and keep going into the
// twist; they are recorded as one chiral step by the `Snub` / `Gyro` build wrappers below,
// which capture the handedness the plan reports.

// --- chamfer / subdivide ----------------------------------------------------
// These use the interactive operations (the `buildChamfer` / `buildSubdivide` the
// game runs on a dragged edge) rather than a reconstruction from truncate/kis on a
// selected arity. That arity trick can't express the tetrahedron: its join (the cube)
// is vertex-uniform and its rectify (the octahedron) is face-uniform, so there is no
// sub-arity to target. The real operation acts on every edge, so it handles the
// tetrahedron directly. Any edge serves as the drag handle, since the operation is
// global; the first one is taken.

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
// A Build is a solid together with the chain of operations that produced it from the
// tetrahedron. The recipe helpers above stay pure (poly -> poly); these wrappers apply
// one and append the labeled step, so every named solid carries a tetrahedron-rooted
// history. The tetrahedron is the only starting seed, and the root of every build.
const tetMesh = getSeed("tetrahedron");
const tet = new Polyhedron(tetMesh, seedColors(tetMesh));

interface Build {
  poly: Polyhedron;
  steps: BuildStep[];
}
const root: Build = { poly: tet, steps: [] };

/** A whole-solid op descriptor for a recipe step — the recipes always act on the entire
 *  solid, never a sub-selection. `chirality` is set only for snub / gyro. */
const wholeOp = (kind: OperationKind, weld: boolean, chirality?: "R" | "L"): OpDescriptor =>
  ({ kind, weld, sel: { kind: "whole" }, chirality });

/** Apply one operation and record it as a step carrying its full op descriptor. */
const step = (
  b: Build,
  fn: (p: Polyhedron) => { poly: Polyhedron; op: OpDescriptor },
): Build => {
  const { poly, op } = fn(b.poly);
  return { poly, steps: [...b.steps, { op, poly }] };
};
const Truncate = (b: Build): Build => step(b, (p) => ({ poly: truncate(p), op: wholeOp("truncate", false) }));
const Rectify = (b: Build): Build => step(b, (p) => ({ poly: rectify(p), op: wholeOp("truncate", true) }));
const Kis = (b: Build): Build => step(b, (p) => ({ poly: kis(p), op: wholeOp("kis", false) }));
const Join = (b: Build): Build => step(b, (p) => ({ poly: join(p), op: wholeOp("kis", true) }));
const Chamfer = (b: Build): Build => step(b, (p) => ({ poly: chamfer(p), op: wholeOp("chamfer", false) }));
const Subdivide = (b: Build): Build => step(b, (p) => ({ poly: subdivide(p), op: wholeOp("subdivide", false) }));
// Snub / gyro: rectify / join, then twist to the weld. The committed plan reports which
// enantiomorph it built — the recipe never snaps, so it is the default "R" — and that
// handedness rides along on the step's op, exactly as a live drag's would.
const Snub = (b: Build): Build =>
  step(b, (p) => {
    const r = rectify(p);
    const plan = buildSnub(r, 0, r.vertices[0].clone());
    return { poly: wrap(plan.commit(1, true)), op: wholeOp("snub", true, plan.chirality!()) };
  });
const Gyro = (b: Build): Build =>
  step(b, (p) => {
    const j = join(p);
    const plan = buildGyro(j, 0, j.vertices[0].clone());
    return { poly: wrap(plan.commit(1, true)), op: wholeOp("gyro", true, plan.chirality!()) };
  });

/** Maps a specially-named solid's polyhedron to its name, so an auto-named solid one
 *  operation away (Truncate/Chamfer/Subdivide of it) can compose "<modifier> <name>". */
const specialByPoly = new Map<Polyhedron, string>();

/** Finalize a build into a named-database entry. Pass `null` for `name` to leave the
 *  solid auto-named: its name is composed after the array is built (see below) as the
 *  operation's modifier prepended to its specially-named parent (e.g. "Truncated Cube"),
 *  so the same shape reached by further operations stacks its modifier rather than
 *  nesting a redundant name. */
const E = (
  name: string | null,
  type: SolidType,
  scheme: SchemeName,
  b: Build,
  achiral = false,
): NamedPolyhedron => {
  if (name != null) specialByPoly.set(b.poly, name);
  return { name: name ?? "", auto: name == null, achiral, type, poly: b.poly, scheme, steps: b.steps };
};

const P: SolidType = "Platonic solid";
const A: SolidType = "Archimedean solid";
const C: SolidType = "Catalan solid";
const Ch: SolidType = "Chamfered solid";
const Sub: SolidType = "Subdivided solid";

const TE: SchemeName = "tetrahedral";
const OC: SchemeName = "octahedral";
const IC: SchemeName = "icosahedral";

// --- the construction tree, rooted at the tetrahedron -----------------------
const octB = Rectify(root); //     rectify(tetra) = octahedron
const cubeB = Join(root); //       join(tetra)    = cube
// Snub and gyro are single operations that pass through the rectify / join on their
// way, so they hang off the same parent as those, not off their result: snubbing the
// tetrahedron makes the icosahedron in one drag, with the octahedron never a step.
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
  E("Icosahedron", P, IC, icoB, /* achiral */ true),
  E("Dodecahedron", P, IC, dodB, /* achiral */ true),

  // Archimedean solids — truncations (auto-named "Truncated <parent>")
  E(null, A, TE, Truncate(root)),
  E(null, A, OC, Truncate(octB)),
  E(null, A, OC, Truncate(cubeB)),
  E(null, A, IC, Truncate(icoB)),
  E(null, A, IC, Truncate(dodB)),
  // Archimedean solids — rectifications & beyond
  E("Cuboctahedron", A, OC, cuboctB),
  E("Icosidodecahedron", A, IC, icosidodB),
  E(null, A, OC, Truncate(cuboctB)),
  E(null, A, IC, Truncate(icosidodB)),
  E("Rhombicuboctahedron", A, OC, Rectify(cuboctB)),
  E("Rhombicosidodecahedron", A, IC, Rectify(icosidodB)),
  // Snub cube / snub dodecahedron: auto-named after their dual seed (the cube / dodecahedron)
  // so the composed name reads "Snub Cube" / "Snub Dodecahedron" and the chiral prefix stacks
  // onto that ("R-Snub Cube", "Truncated R-Snub Cube"). Snubbing the octahedron / icosahedron
  // gives the same topology but a different color path.
  E(null, A, OC, Snub(cubeB)),
  E(null, A, IC, Snub(dodB)),

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

  // Chamfered solids — every edge chamfered (auto-named "Chamfered <parent>").
  E(null, Ch, TE, Chamfer(root)),
  E(null, Ch, OC, Chamfer(cubeB)),
  E(null, Ch, OC, Chamfer(octB)),
  E(null, Ch, IC, Chamfer(dodB)),
  E(null, Ch, IC, Chamfer(icoB)),

  // Subdivided solids — every edge subdivided (auto-named "Subdivided <parent>").
  E(null, Sub, TE, Subdivide(root)),
  E(null, Sub, OC, Subdivide(cubeB)),
  E(null, Sub, OC, Subdivide(octB)),
  E(null, Sub, IC, Subdivide(dodB)),
  E(null, Sub, IC, Subdivide(icoB)),
];

// --- fill in the auto-generated names ---------------------------------------
// Each auto-named solid is one operation from a specially-named parent, so its name is
// that operation's name-modifier ("Truncated"/"Chamfered"/"Subdivided") prepended to the
// parent's name. The parent is the solid before this entry's last step (or the
// tetrahedron root for a one-step build), looked up in `specialByPoly` — populated for
// every explicitly named entry above, so array order doesn't matter here.
for (const np of NAMED) {
  if (!np.auto) continue;
  const steps = np.steps;
  const last = steps[steps.length - 1];
  const parentPoly = steps.length >= 2 ? steps[steps.length - 2].poly : tet;
  const parentName = specialByPoly.get(parentPoly);
  // The chirality-free name modifier ("Truncated"/"Snub"/…). The derived DB name is the
  // canonical, handedness-free one ("Snub Cube"); the L-/R- prefix is layered on at display
  // time by operations/naming.ts, so it must not be baked into the stored name here.
  const [, modifier] = config.ui.operationLabels[last.op.kind][last.op.weld ? "welded" : "unwelded"];
  if (parentName) np.name = `${modifier} ${parentName}`;
}

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

/** Whether `name` is an auto-generated name ("Truncated Cube"), as opposed to a special
 *  one-off name (Cube, Rhombic dodecahedron). Derived names treat an auto-named ancestor
 *  transparently, stacking its modifier ("2x Truncated Cube") instead of nesting it. */
export function isAutoName(name: string): boolean {
  return BY_NAME.get(name.trim().toLowerCase())?.auto ?? false;
}

/** Whether `name` is one of the two achiral snub / gyro results (icosahedron,
 *  dodecahedron). A chiral drag names its result with the handedness by default, so these
 *  two are the exceptions that suppress it — an icosahedron is never "R-Icosahedron". */
export function isAchiralName(name: string): boolean {
  return BY_NAME.get(name.trim().toLowerCase())?.achiral ?? false;
}

/** One entry of a synthesized tetrahedron-rooted history (used when no user-made timeline
 *  exists for a shape — e.g. opening it via the reveal-all cheat). Mirrors a live history
 *  entry: the row `label` is `operationLabel(op)` and `op` is the operation itself (null for
 *  the tetrahedron seed), so reopening a library solid is indistinguishable from making it. */
export interface HistoryStepData {
  label: string;
  op: OpDescriptor | null;
  poly: Polyhedron;
  isSeed: boolean;
}

/** The full tetrahedron-rooted construction chain for a named solid (the
 *  tetrahedron seed followed by each recorded operation's result), or null. */
export function historyStepsFor(name: string): HistoryStepData[] | null {
  const e = BY_NAME.get(name.trim().toLowerCase());
  if (!e) return null;
  const out: HistoryStepData[] = [{ label: "Tetrahedron", op: null, poly: tet, isSeed: true }];
  for (const s of e.steps) out.push({ label: operationLabel(s.op), op: s.op, poly: s.poly, isSeed: false });
  return out;
}
