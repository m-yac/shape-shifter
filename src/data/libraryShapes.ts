import { Polyhedron } from "../geometry/polyhedron";
import { getSeed } from "../geometry/seeds";
import { seedColors, type ColorSet, type SchemeName } from "../geometry/colors";
import { type Mesh } from "../geometry/HalfEdge";
import { buildTruncate } from "../operations/truncate";
import { buildKis } from "../operations/kis";
import { buildSnub } from "../operations/snub";
import { buildGyro } from "../operations/gyro";

/**
 * Construction of every LIBRARY-diagram solid the way the GAME makes it — rooted
 * at the tetrahedron (the only starting seed) and following the diagram's
 * operation tree. This is DELIBERATELY separate from the identification database
 * (`data/namedPolyhedra.ts`), which builds the same solids from convenient
 * Platonic seeds: identification only cares about connectivity, but the browse
 * diagram must reproduce each solid's *default colors*, and the geometric colors
 * depend on the construction path (e.g. the game's cube is `join(tetrahedron)`,
 * whose faces inherit the tetrahedron's edge color — not a bare cube seed whose
 * faces are color 0). Re-rooting here keeps those colors faithful.
 *
 * Each solid also carries the symmetry color SCHEME it displays in, mirroring
 * the live app's auto-switch (tetrahedral / octahedral / icosahedral).
 *
 *   Tetra family:   T, truncate(T), rectify(T)=octa, kis(T), join(T)=cube,
 *                   snub(octa)=icosa, gyro(cube)=dodeca
 *   then each higher family applies the six operations to its own center pair.
 */

const wrap = (r: { mesh: Mesh; colors: ColorSet }): Polyhedron =>
  new Polyhedron(r.mesh, r.colors);

const truncate = (p: Polyhedron): Polyhedron =>
  wrap(buildTruncate(p, 0, null).commit(0.5, false));
const rectify = (p: Polyhedron): Polyhedron =>
  wrap(buildTruncate(p, 0, null).commit(1, true));
const kis = (p: Polyhedron): Polyhedron =>
  wrap(buildKis(p, 0, null).commit(0.5, false));
const join = (p: Polyhedron): Polyhedron =>
  wrap(buildKis(p, 0, null).commit(1, true));
const snub = (p: Polyhedron): Polyhedron =>
  wrap(buildSnub(p, 0, null).commit(1, true));
const gyro = (p: Polyhedron): Polyhedron =>
  wrap(buildGyro(p, 0, null).commit(1, true));

export interface LibraryShape {
  poly: Polyhedron;
  scheme: SchemeName;
}

const TE: SchemeName = "tetrahedral";
const OC: SchemeName = "octahedral";
const IC: SchemeName = "icosahedral";

let CACHE: Map<string, LibraryShape> | null = null;

function buildAll(): Map<string, LibraryShape> {
  const map = new Map<string, LibraryShape>();
  const add = (name: string, poly: Polyhedron, scheme: SchemeName): void => {
    map.set(name.trim().toLowerCase(), { poly, scheme });
  };

  const tetMesh = getSeed("tetrahedron");
  const tet = new Polyhedron(tetMesh, seedColors(tetMesh));

  // Tetrahedron family.
  const truncTet = truncate(tet);
  const oct = rectify(tet); //            rectify(tetra) = octahedron
  const triTet = kis(tet);
  const cube = join(tet); //              join(tetra)    = cube
  const ico = snub(oct); //               snub(octa)     = icosahedron
  const dod = gyro(cube); //              gyro(cube)     = dodecahedron

  add("Tetrahedron", tet, TE);
  add("Truncated Tetrahedron", truncTet, TE);
  add("Triakis Tetrahedron", triTet, TE);
  add("Octahedron", oct, OC);
  add("Cube", cube, OC);
  add("Icosahedron", ico, IC);
  add("Dodecahedron", dod, IC);

  // Octahedron / Cube family (operations on the octahedron + cube).
  const truncOct = truncate(oct);
  const triOct = kis(oct);
  const truncCube = truncate(cube);
  const tetraHex = kis(cube);
  const cuboct = rectify(oct); //         rectify(octa)  = cuboctahedron
  const rhDod = join(oct); //             join(octa)     = rhombic dodecahedron
  const snubCuboct = snub(cuboct);
  const pentIco = gyro(rhDod);

  add("Truncated Octahedron", truncOct, OC);
  add("Triakis Octahedron", triOct, OC);
  add("Truncated Cube", truncCube, OC);
  add("Tetrakis Hexahedron", tetraHex, OC);
  add("Cuboctahedron", cuboct, OC);
  add("Rhombic Dodecahedron", rhDod, OC);
  add("Snub Cuboctahedron", snubCuboct, OC);
  add("Pentagonal Icositetrahedron", pentIco, OC);

  // Icosahedron / Dodecahedron family.
  const truncIco = truncate(ico);
  const triIco = kis(ico);
  const truncDod = truncate(dod);
  const pentDod = kis(dod);
  const icosidod = rectify(ico); //       rectify(icosa) = icosidodecahedron
  const rhTri = join(ico); //             join(icosa)    = rhombic triacontahedron
  const snubIcosidod = snub(icosidod);
  const pentHex = gyro(rhTri);

  add("Truncated Icosahedron", truncIco, IC);
  add("Triakis Icosahedron", triIco, IC);
  add("Truncated Dodecahedron", truncDod, IC);
  add("Pentakis Dodecahedron", pentDod, IC);
  add("Icosidodecahedron", icosidod, IC);
  add("Rhombic Triacontahedron", rhTri, IC);
  add("Snub Icosidodecahedron", snubIcosidod, IC);
  add("Pentagonal Hexecontahedron", pentHex, IC);

  // Cuboctahedron / Rhombic Dodecahedron family.
  add("Truncated Cuboctahedron", truncate(cuboct), OC);
  add("Rhombicuboctahedron", rectify(cuboct), OC);
  add("Deltoidal Icositetrahedron", join(cuboct), OC);
  add("Disdyakis Dodecahedron", kis(rhDod), OC);

  // Icosidodecahedron / Rhombic Triacontahedron family.
  add("Truncated Icosidodecahedron", truncate(icosidod), IC);
  add("Rhombicosidodecahedron", rectify(icosidod), IC);
  add("Deltoidal Hexecontahedron", join(icosidod), IC);
  add("Disdyakis Triacontahedron", kis(rhTri), IC);

  return map;
}

/** The colored Polyhedron + color scheme for a diagram solid (case-insensitive),
 *  built (and cached) the way the game makes it. Null if the name is unknown. */
export function libraryShapeFor(name: string): LibraryShape | null {
  if (!CACHE) CACHE = buildAll();
  return CACHE.get(name.trim().toLowerCase()) ?? null;
}
