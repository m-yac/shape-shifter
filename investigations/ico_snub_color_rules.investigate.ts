import { describe, it } from "vitest";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import {
  type ColorSet,
  type GeomColor,
  meshEdgeKeys,
  paletteSwatch,
  setColorScheme,
  uniformColors,
} from "../src/geometry/colors";
import { type Mesh } from "../src/geometry/HalfEdge";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildSnub } from "../src/operations/snub";
import { buildGyro } from "../src/operations/gyro";
import { buildSubdivide } from "../src/operations/subdivide";
import { buildChamfer } from "../src/operations/chamfer";
import { config } from "../src/config";

/**
 * Can the `snub` color rules be chosen so that an icosahedral-symmetry solid built out
 * of the tetrahedron (tetra → rectify → octahedron → snub → icosahedron) gets EXACTLY
 * the swatches it would get if the icosahedron were an atomic seed whose faces all had
 * ID [1,0,0], vertices [0,1,0] and edges [0,0,1]?
 *
 * The whole swatch lookup only ever sees the COLLAPSED 3-vector (face, vert, edge)
 * provenance triple (geometry/colors.ts `collapse`), and every operation rule is a
 * linear combination, so this investigation works directly in that 3-space: the
 * tetrahedron starts as face=[1,0,0] / vert=[0,1,0] / edge=[0,0,1] and every derived
 * color is exactly the collapse of the real 14-D ID.
 *
 * ACTUAL   = colors from the real operations (config.colors.operations, with `snub`
 *            swapped to the candidate) resolved through the icosahedral scheme whose
 *            group triples are DERIVED from those same rules (as geometry/colors.ts does).
 * IDEAL    = the same operation chain run on the same mesh with the one-hot icosahedron
 *            colors, resolved through a scheme whose groups are just those one-hots.
 * A candidate passes when every element of every reachable shape agrees.
 */

// ---------------------------------------------------------------------------
// The scheme machinery, re-implemented over collapsed triples (mirrors colors.ts).
// ---------------------------------------------------------------------------

type Triple = readonly number[];
type Rule = Readonly<Record<string, number>>;
type Group = { swatch: string; triples: Triple[] };

const key = (c: Triple) => c.map((x) => Math.round(x * 1000)).join(",");

const wsum = (terms: Array<[Triple, number]>): Triple => {
  const out = [0, 0, 0];
  for (const [v, k] of terms) for (let i = 0; i < 3; i++) out[i] += (v[i] ?? 0) * k;
  return out;
};

const dedupe = (ts: Triple[]): Triple[] => {
  const seen = new Set<string>();
  const out: Triple[] = [];
  for (const t of ts) if (!seen.has(key(t))) { seen.add(key(t)); out.push(t); }
  return out;
};

/** Weighted combinations over the cross product of each token's source triples. */
function derive(rule: Rule, src: Record<string, Triple[]>): Triple[] {
  let combos: Triple[] = [[0, 0, 0]];
  for (const [tok, coeff] of Object.entries(rule)) {
    const next: Triple[] = [];
    for (const acc of combos) for (const t of src[tok]) next.push(wsum([[acc, 1], [t, coeff]]));
    combos = next;
  }
  return combos;
}

/**
 * The synthesized swatch families. `tint` is geometry/colors.ts's existing one (0.75 base
 * + 0.25 of another group, or of an equal pair of the two others). `extras` lets us ask
 * what a WIDER palette would buy:
 *   tint2  — the same shape at 2/3 : 1/3 instead of 3/4 : 1/4.
 *   avg3   — an equal 1/3 : 1/3 : 1/3 mix of all three groups.
 * Both are added at the LOWEST precedence, so they can only claim keys nothing else wants.
 */
type Extras = { tint2?: boolean; tint4?: boolean; avg3?: boolean };

/** The augmented (swatch, triples, tier) list — the single source both the lookup and the
 *  stolen-key check are built from. Lower tier = higher precedence. */
function augment(groups: Record<string, Group>, extras: Extras = {}): Array<Group & { tier: number }> {
  const keys = Object.keys(groups);
  const aug: Array<Group & { tier: number }> = keys.map((k) => ({ ...groups[k], tier: 0 }));
  const pair = (a: string, b: string) => `avg(${[a, b].sort().join(",")})`;

  /** base·t + (1-t) of one other group, or split evenly over the two others. */
  const tintLike = (i: number, t: number, label: string, tier: number) => {
    const base = groups[keys[i]];
    const others = keys.filter((_, k) => k !== i).map((k) => groups[k]);
    const out: Triple[] = [];
    for (const bt of base.triples) {
      for (const o of others) for (const ot of o.triples) out.push(wsum([[bt, t], [ot, 1 - t]]));
      for (let x = 0; x < others.length; x++)
        for (let y = x + 1; y < others.length; y++)
          for (const o1 of others[x].triples)
            for (const o2 of others[y].triples)
              out.push(wsum([[bt, t], [o1, (1 - t) / 2], [o2, (1 - t) / 2]]));
    }
    aug.push({ swatch: `${label}(${base.swatch})`, triples: out, tier });
  };

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = groups[keys[i]], b = groups[keys[j]];
      const t1: Triple[] = [];
      for (const x of a.triples) for (const y of b.triples) t1.push(wsum([[x, 0.5], [y, 0.5]]));
      aug.push({ swatch: pair(a.swatch, b.swatch), triples: t1, tier: 1 });
      for (let k = 0; k < keys.length; k++) {
        if (k === i || k === j) continue;
        const c = groups[keys[k]];
        const t2: Triple[] = [];
        for (const z of c.triples)
          for (const x of a.triples)
            for (const y of b.triples) t2.push(wsum([[z, 0.5], [x, 0.25], [y, 0.25]]));
        aug.push({ swatch: `avg(${c.swatch},${pair(a.swatch, b.swatch)})`, triples: t2, tier: 2 });
      }
    }
    tintLike(i, 0.75, "tint3", 3);
  }
  if (extras.avg3 && keys.length === 3) {
    const g3 = keys.map((k) => groups[k]);
    const t: Triple[] = [];
    for (const x of g3[0].triples)
      for (const y of g3[1].triples)
        for (const z of g3[2].triples) t.push(wsum([[x, 1 / 3], [y, 1 / 3], [z, 1 / 3]]));
    aug.push({ swatch: `avg(${g3.map((g) => g.swatch).join(",")})`, triples: t, tier: 4 });
  }
  if (extras.tint2) for (let i = 0; i < keys.length; i++) tintLike(i, 2 / 3, "tint2", 5);
  if (extras.tint4) for (let i = 0; i < keys.length; i++) tintLike(i, 0.8, "tint4", 6);
  return aug;
}

/** The augmented lookup (key → swatch), exactly as geometry/colors.ts builds it. */
function buildLookup(groups: Record<string, Group>, extras: Extras = {}): Map<string, string> {
  const aug = augment(groups, extras);
  const map = new Map<string, string>();
  for (const tier of [0, 1, 2, 3, 4, 5, 6])
    for (const g of aug)
      if (g.tier === tier)
        for (const t of g.triples) if (!map.has(key(t))) map.set(key(t), g.swatch);
  return map;
}

const swatchOf = (lookup: Map<string, string>, c: Triple) => lookup.get(key(c)) ?? "white";

// The one-hot ICOSAHEDRON reference scheme: what the lookup would be if the icosahedron
// were an atomic seed (faces [1,0,0], vertices [0,1,0], edges [0,0,1]).
const F1: Triple = [1, 0, 0], V1: Triple = [0, 1, 0], E1: Triple = [0, 0, 1];
const ONE_HOT_GROUPS: Record<string, Group> = {
  face: { swatch: "yellow", triples: [F1] },
  vert: { swatch: "red", triples: [V1] },
  edge: { swatch: "blue", triples: [E1] },
};
const IDEAL = buildLookup(ONE_HOT_GROUPS);

/** The icosahedral scheme's group triples, derived from the tetra one-hots through
 *  rectify (→ octahedron) then the candidate snub rules (→ icosahedron). */
function icoGroups(snubRules: Record<string, Rule>) {
  const R = config.colors.operations.rectify;
  const tet = { oldFace: [F1], oldVertex: [V1], oldEdge: [E1] };
  const octa = {
    oldFace: dedupe([...tet.oldFace, ...derive(R.newFace, tet)]),
    oldVertex: dedupe(derive(R.newVertex, tet)),
    oldEdge: dedupe(derive(R.newEdge, tet)),
  };
  return {
    face: { swatch: "yellow", triples: dedupe([...octa.oldFace, ...derive(snubRules.newFace, octa)]) },
    vert: { swatch: "red", triples: dedupe(derive(snubRules.newVertex, octa)) },
    edge: {
      swatch: "blue",
      triples: dedupe([...derive(snubRules.newEdge, octa), ...derive(snubRules.snubEdge, octa)]),
    },
  };
}

// ---------------------------------------------------------------------------
// Shapes: build everything with the REAL operations, in collapsed-triple color space.
// ---------------------------------------------------------------------------

const wrap = (r: { mesh: Mesh; colors: ColorSet }) => new Polyhedron(r.mesh, r.colors);
const firstEdge = (p: Polyhedron): [number, number] => [p.faces[0][0], p.faces[0][1]];

const OPS: Record<string, (p: Polyhedron) => Polyhedron> = {
  truncate: (p) => wrap(buildTruncate(p, 0, null).commit(0.3, false)),
  rectify: (p) => wrap(buildTruncate(p, 0, null).commit(1, true)),
  kis: (p) => wrap(buildKis(p, 0, null).commit(0.3, false)),
  join: (p) => wrap(buildKis(p, 0, null).commit(1, true)),
  subdivide: (p) => wrap(buildSubdivide(p, firstEdge(p)).commit(0.5, false)),
  "subdiv-weld": (p) => wrap(buildSubdivide(p, firstEdge(p)).commit(1, true)),
  chamfer: (p) => wrap(buildChamfer(p, firstEdge(p), 0).commit(0.3, false)),
  "chamfer-weld": (p) => wrap(buildChamfer(p, firstEdge(p), 0).commit(1, true)),
  snub: (p) => {
    const r = wrap(buildTruncate(p, 0, null).commit(1, true));
    return wrap(buildSnub(r, 0, r.vertices[0].clone()).commit(1, true));
  },
  gyro: (p) => {
    const j = wrap(buildKis(p, 0, null).commit(1, true));
    return wrap(buildGyro(j, 0, j.vertices[0].clone()).commit(1, true));
  },
};

const TETRA = () => new Polyhedron(getSeed("tetrahedron"), uniformColors(getSeed("tetrahedron"), V1, E1, F1));

/** A start shape: a mesh with BOTH its real (rule-derived) colors and the ideal one-hot colors. */
type Start = { label: string; mesh: Mesh; actual: ColorSet; ideal: ColorSet };

function starts(g: ReturnType<typeof icoGroups>): Start[] {
  const out: Start[] = [];
  // Built from the tetrahedron: tetra → rectify → octa → snub → icosahedron.
  const ico = OPS.snub(TETRA());
  out.push({
    label: "built ico",
    mesh: ico.mesh,
    actual: ico.colors,
    ideal: uniformColors(ico.mesh, V1, E1, F1),
  });
  // The dual: tetra → join → cube → gyro → dodecahedron. Its faces come from the
  // icosahedron's VERTICES, its vertices from the icosahedron's faces.
  const dod = OPS.gyro(TETRA());
  out.push({
    label: "built dodeca",
    mesh: dod.mesh,
    actual: dod.colors,
    ideal: uniformColors(dod.mesh, F1, E1, V1),
  });
  // A directly-LOADED icosahedron seed: uniform, taking each orbit's representative triple
  // (exactly what geometry/colors.ts `seedColors` does).
  const seed = getSeed("icosahedron");
  out.push({
    label: "loaded ico",
    mesh: seed,
    actual: uniformColors(seed, g.vert.triples[0], g.edge.triples[0], g.face.triples[0]),
    ideal: uniformColors(seed, V1, E1, F1),
  });
  return out;
}

/**
 * A mismatch comes in two flavours:
 *   HARD — the IDEAL gives a real swatch and the ACTUAL gives a different one. A face
 *          that should be tint(yellow) coming out red. These are the actual bug.
 *   SOFT — the IDEAL itself resolves to the fallback `white` (the color system has no
 *          name for that combination) and the ACTUAL names it (or vice versa). The two
 *          renders differ, but no *classified* color is wrong.
 */
type Fails = { hard: Map<string, number>; soft: Map<string, number> };

function mismatches(
  mesh: Mesh,
  actual: ColorSet,
  ideal: ColorSet,
  lookup: Map<string, string>,
  idealLookup: Map<string, string>,
  label: string,
  fails: Fails,
): void {
  const cmp = (what: string, a: GeomColor, i: GeomColor) => {
    const sa = swatchOf(lookup, a as Triple);
    const si = swatchOf(idealLookup, i as Triple);
    if (sa === si) return;
    const bucket = si === "white" || sa === "white" ? fails.soft : fails.hard;
    const m = `${label} ${what}: got ${sa} [${key(a as Triple)}], want ${si} [${key(i as Triple)}]`;
    bucket.set(m, (bucket.get(m) ?? 0) + 1);
  };
  mesh.faces.forEach((f, n) => cmp(`face(${f.length}-gon)`, actual.face[n], ideal.face[n]));
  mesh.vertices.forEach((_, n) => cmp("vert", actual.vertex[n], ideal.vertex[n]));
  for (const k of meshEdgeKeys(mesh)) cmp("edge", actual.edge.get(k)!, ideal.edge.get(k)!);
}

/** Run every op (and every depth-2 pair, when `depth` is 2) from each start shape and
 *  collect the ACTUAL-vs-IDEAL swatch mismatches. */
function evaluate(snubRules: Record<string, Rule>, depth: number, extras: Extras = {}): Fails {
  (config.colors.operations as any).snub = snubRules;
  const g = icoGroups(snubRules);
  const lookup = buildLookup(g, extras);
  const idealLookup = buildLookup(ONE_HOT_GROUPS, extras);
  const fails: Fails = { hard: new Map(), soft: new Map() };

  for (const s of starts(g)) {
    mismatches(s.mesh, s.actual, s.ideal, lookup, idealLookup, s.label, fails);
    const level1: Array<{ label: string; p: Polyhedron; ideal: Polyhedron }> = [];
    for (const [op, fn] of Object.entries(OPS)) {
      let a: Polyhedron, i: Polyhedron;
      try {
        a = fn(new Polyhedron(s.mesh, s.actual));
        i = fn(new Polyhedron(s.mesh, s.ideal));
      } catch {
        continue;
      }
      mismatches(a.mesh, a.colors, i.colors, lookup, idealLookup, `${s.label} → ${op}`, fails);
      level1.push({ label: `${s.label} → ${op}`, p: a, ideal: i });
    }
    if (depth < 2) continue;
    for (const l1 of level1) {
      for (const [op, fn] of Object.entries(OPS)) {
        let a: Polyhedron, i: Polyhedron;
        try {
          a = fn(l1.p);
          i = fn(l1.ideal);
        } catch {
          continue;
        }
        mismatches(a.mesh, a.colors, i.colors, lookup, idealLookup, `${l1.label} → ${op}`, fails);
      }
    }
  }
  return fails;
}

/**
 * A FAST, op-free necessary condition, and the one that actually decides the question.
 *
 * Every downstream color is a linear combination of the icosahedron's element colors,
 * and every scheme group (plain, avg, nested-avg, tint) is generated by applying the
 * SAME canonical weight patterns to the group representatives. So whenever the ideal
 * color has a name, the actual color is guaranteed to be *a member of* the matching
 * actual group — by construction. The only way it can come out wrong is TIER STEALING:
 * its key was already claimed by a different group. So a candidate is right for every
 * reachable shape, at every depth, exactly when no group's triple is claimed by another
 * group's swatch. This counts those stolen keys.
 */
function stolenKeys(groups: Record<string, Group>, extras: Extras = {}): string[] {
  const lookup = buildLookup(groups, extras);
  const out: string[] = [];
  for (const g of augment(groups, extras))
    for (const t of g.triples) {
      const got = lookup.get(key(t));
      if (got !== g.swatch) out.push(`[${key(t)}] belongs to ${g.swatch} but resolves to ${got}`);
    }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// 14-D ID uniqueness: the same structural check tests/colorIds runs — a candidate that
// makes two snub (or gyro) elements share an ID is not admissible however good its colors.
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generic(mesh: Mesh, seed: number): Polyhedron {
  const r = rng(seed);
  const v = (): GeomColor => [r(), r(), r(), r()];
  const edge = new Map<string, GeomColor>();
  for (const k of meshEdgeKeys(mesh)) edge.set(k, v());
  return new Polyhedron(mesh, { vertex: mesh.vertices.map(v), face: mesh.faces.map(v), edge });
}
function hasCollision(colors: ColorSet): boolean {
  const seen = new Set<string>();
  const all: GeomColor[] = [...colors.vertex, ...colors.face, ...colors.edge.values()];
  for (const c of all) {
    const k = c.map((x) => Math.round(x * 1e6)).join(",");
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}
/** True when snub AND gyro keep all IDs distinct (over several random generic inputs). */
function idsStayUnique(snubRules: Record<string, Rule>): boolean {
  (config.colors.operations as any).snub = snubRules;
  const rectified = OPS.rectify(new Polyhedron(getSeed("tetrahedron"))).mesh;
  const joined = OPS.join(new Polyhedron(getSeed("cube"))).mesh;
  for (const seed of [11, 23, 37]) {
    const s = generic(rectified, seed);
    if (hasCollision(buildSnub(s, 0, s.vertices[0].clone()).commit(1, true).colors)) return false;
    const j = generic(joined, seed);
    if (hasCollision(buildGyro(j, 0, j.vertices[0].clone()).commit(1, true).colors)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

const rule = (toks: Record<string, number>): Rule =>
  Object.fromEntries(Object.entries(toks).filter(([, v]) => v !== 0));

/** The call sites (operations/snub.ts) only offer these sources per rule:
 *    newFace   ← oldVertex, oldEdge          (the gap triangle: no single old face)
 *    newVertex ← oldVertex, oldEdge          (the split vertex sliding along its kept edge)
 *    newEdge   ← oldVertex                   (only source available → forced to {oldVertex: 1})
 *    snubEdge  ← oldFace, oldVertex, oldEdge (all three)  */
function candidate(a: number, b: number, gf: number, gv: number): Record<string, Rule> {
  return {
    newFace: rule({ oldVertex: a, oldEdge: 1 - a }),
    newEdge: rule({ oldVertex: 1 }),
    snubEdge: rule({ oldFace: gf, oldVertex: gv, oldEdge: 1 - gf - gv }),
    newVertex: rule({ oldVertex: b, oldEdge: 1 - b }),
  };
}

const ORIGINAL = JSON.parse(JSON.stringify(config.colors.operations.snub));

describe("snub color rules vs the one-hot icosahedron", () => {
  /** The committed fix, checked through the REAL geometry/colors.ts (its own derived
   *  scheme, its own seed colors, its own 14-D IDs) rather than this file's model. */
  it("VERIFY the shipped fix", () => {
    const real = (p: Polyhedron, label: string) => {
      const m = new Map<string, number>();
      p.faces.forEach((f, i) => {
        const k = `${f.length}-gon ${paletteSwatch(p.colors.face[i])}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      });
      console.log(`  ${label.padEnd(24)}: ${[...m].sort().map(([k, n]) => `${n}x ${k}`).join(", ")}`);
    };
    const tet = () => new Polyhedron(getSeed("tetrahedron")); // real one-hot 14-D seed IDs

    setColorScheme("icosahedral");
    const ico = OPS.snub(tet()); // tetra → rectify → octa → snub → icosahedron
    const idod = OPS.rectify(ico);
    console.log("\nICOSAHEDRAL (built from the tetrahedron):");
    real(ico, "icosahedron");
    real(idod, "icosidodecahedron");
    real(OPS.subdivide(idod), "subdivide(icosidodeca)"); // ← the reported bug
    real(OPS.snub(ico), "snub icosidodecahedron");
    real(OPS.gyro(ico), "pent. hexecontahedron");

    setColorScheme("octahedral");
    const cube = OPS.join(tet());
    console.log("\nOCTAHEDRAL (unchanged families):");
    real(OPS.snub(cube), "snub cuboctahedron");
    real(OPS.gyro(cube), "pent. icositetrahedron");
    real(OPS.subdivide(OPS.rectify(cube)), "subdivide(cuboctahedron)");
    setColorScheme("tetrahedral");
  }, 120_000);

  it("current rules: how far off are they?", () => {
    const fails = evaluate(ORIGINAL, 2);
    console.log(`\nCURRENT RULES (depth 2): ${fails.hard.size} HARD, ${fails.soft.size} soft`);
    console.log("\nstolen keys:");
    for (const s of stolenKeys(icoGroups(ORIGINAL))) console.log(`  ${s}`);
    console.log("\nHARD mismatches (a named color came out wrong):");
    for (const [m, n] of [...fails.hard].sort()) console.log(`  ${String(n).padStart(4)}x  ${m}`);
    (config.colors.operations as any).snub = ORIGINAL;
  }, 120_000);

  /**
   * `snub.newFace` is the rule that also colors the SNUB CUBE's 24 gap triangles (they
   * come from cuboctahedron edges), and today's `{oldEdge: 1}` is what lands them on
   * avg(red,yellow) in the octahedral scheme. So: is `{oldEdge: 1}` compatible with a
   * steal-free icosahedral scheme at all — i.e. can newFace be left alone?
   */
  it("can newFace stay {oldEdge: 1}?", () => {
    const FINE = [0, 1 / 6, 1 / 5, 1 / 4, 1 / 3, 2 / 5, 1 / 2, 3 / 5, 2 / 3, 3 / 4, 4 / 5, 5 / 6, 1];
    let best: { n: number; c: Record<string, Rule>; keys: string[] } | null = null;
    let clean = 0;
    for (const b of FINE)
      for (const gf of FINE)
        for (const gv of FINE) {
          if (gf + gv > 1 + 1e-9) continue;
          const c = candidate(0, b, gf, gv); // newFace = {oldEdge: 1}, untouched
          const g = icoGroups(c);
          const reps = [...g.face.triples, ...g.vert.triples, ...g.edge.triples];
          if (new Set(reps.map(key)).size !== reps.length) continue;
          const st = stolenKeys(g);
          if (st.length === 0) clean++;
          if (!best || st.length < best.n) best = { n: st.length, c, keys: st };
        }
    console.log(`\nnewFace = {oldEdge: 1} FIXED: ${clean} steal-free candidates found.`);
    console.log(`best has ${best!.n} stolen keys:  ${JSON.stringify(best!.c)}`);
    for (const k of best!.keys) console.log(`    ${k}`);
    (config.colors.operations as any).snub = ORIGINAL;
  }, 300_000);

  /**
   * The full search. A candidate must (a) leave no stolen key in the icosahedral scheme
   * — which is exactly "every named color an icosahedral solid can reach comes out right,
   * at any depth" — and (b) keep the 14-D IDs unique. Among those, we care what it does
   * to the four library solids the snub/gyro rules color at RUNTIME: their faces should
   * not fall back to the white default.
   */
  it("full search", () => {
    const FINE = [0, 1 / 6, 1 / 5, 1 / 4, 1 / 3, 2 / 5, 1 / 2, 3 / 5, 2 / 3, 3 / 4, 4 / 5, 5 / 6, 1];
    const name = (x: number) =>
      ({ 0: "0", 1: "1" } as any)[x] ??
      [[1, 6], [1, 5], [1, 4], [1, 3], [2, 5], [1, 2], [3, 5], [2, 3], [3, 4], [4, 5], [5, 6]]
        .filter(([n, d]) => Math.abs(n / d - x) < 1e-9)
        .map(([n, d]) => `${n}/${d}`)[0] ?? x.toFixed(3);

    // The octahedral scheme (rectify only — the snub rules don't define it, but they DO
    // feed it at runtime via snub(cube) / gyro(cube)).
    const R = config.colors.operations.rectify;
    const tet = { oldFace: [F1], oldVertex: [V1], oldEdge: [E1] };
    const OCTA_LOOKUP = buildLookup({
      face: { swatch: "yellow", triples: dedupe([...tet.oldFace, ...derive(R.newFace, tet)]) },
      vert: { swatch: "red", triples: dedupe(derive(R.newVertex, tet)) },
      edge: { swatch: "blue", triples: dedupe(derive(R.newEdge, tet)) },
    });

    const faceSwatches = (p: Polyhedron, lk: Map<string, string>) => {
      const m = new Map<string, number>();
      p.faces.forEach((f, i) => {
        const k = `${f.length}-gon ${swatchOf(lk, p.colors.face[i] as Triple)}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      });
      return [...m].sort().map(([k, n]) => `${n}x ${k}`).join(", ");
    };

    type Row = { label: string; white: number; shapes: string[] };
    const rows: Row[] = [];
    for (const a of FINE)
      for (const b of FINE)
        for (const gf of FINE)
          for (const gv of FINE) {
            if (gf + gv > 1 + 1e-9) continue;
            const c = candidate(a, b, gf, gv);
            const g = icoGroups(c);
            const reps = [...g.face.triples, ...g.vert.triples, ...g.edge.triples];
            if (new Set(reps.map(key)).size !== reps.length) continue;
            if (stolenKeys(g).length !== 0) continue;
            if (!idsStayUnique(c)) continue;
            (config.colors.operations as any).snub = c;
            const icoLookup = buildLookup(g);
            const cube = OPS.join(TETRA());
            const ico = OPS.snub(TETRA());
            const shapes = [
              `snub cuboctahedron   : ${faceSwatches(OPS.snub(cube), OCTA_LOOKUP)}`,
              `pent. icositetrahedron: ${faceSwatches(OPS.gyro(cube), OCTA_LOOKUP)}`,
              `snub icosidodecahedron: ${faceSwatches(OPS.snub(ico), icoLookup)}`,
              `pent. hexecontahedron : ${faceSwatches(OPS.gyro(ico), icoLookup)}`,
            ];
            rows.push({
              label: `newFace{oldVertex ${name(a)}} newVertex{oldVertex ${name(b)}} snubEdge{oldFace ${name(gf)}, oldVertex ${name(gv)}, oldEdge ${name(1 - gf - gv)}}`,
              white: shapes.filter((s) => s.includes("white")).length,
              shapes,
            });
          }
    // Baseline: what the CURRENT rules give for those same four solids.
    (config.colors.operations as any).snub = ORIGINAL;
    {
      const icoLookup = buildLookup(icoGroups(ORIGINAL));
      const cube = OPS.join(TETRA());
      const ico = OPS.snub(TETRA());
      console.log("\nCURRENT RULES baseline (4 stolen keys — the bug):");
      console.log(`      snub cuboctahedron   : ${faceSwatches(OPS.snub(cube), OCTA_LOOKUP)}`);
      console.log(`      pent. icositetrahedron: ${faceSwatches(OPS.gyro(cube), OCTA_LOOKUP)}`);
      console.log(`      snub icosidodecahedron: ${faceSwatches(OPS.snub(ico), icoLookup)}`);
      console.log(`      pent. hexecontahedron : ${faceSwatches(OPS.gyro(ico), icoLookup)}`);
    }

    rows.sort((x, y) => x.white - y.white);
    const best = rows.length ? rows[0].white : -1;
    console.log(`\n${rows.length} steal-free + ID-unique candidates; the fewest library ` +
      `solids left white is ${best}. All candidates achieving it:\n`);
    for (const r of rows.filter((x) => x.white === best)) {
      console.log(`  ${r.label}`);
      for (const s of r.shapes) console.log(`      ${s}`);
    }
    (config.colors.operations as any).snub = ORIGINAL;
  }, 900_000);

  /**
   * WHY the trade-off is forced, and whether an extra rule token could dodge it.
   *
   * `snub.newVertex` is also, dually, what colors the GYRO solids' pentagons
   * (dualRule(snub.newVertex) read against the JOIN). So one rule has to satisfy two
   * masters. Here we free it completely — let it weight oldVertex / oldEdge / oldFace
   * however it likes (oldFace would need a new source at the call site: the split
   * vertex's anchoring face, `aface` in snub.ts) — and ask whether ANY weighting both
   * leaves the icosahedral scheme steal-free AND keeps the gyro pentagon named.
   */
  it("could a 3-token newVertex satisfy both?", () => {
    // The join (rhombic dodecahedron) the gyro reads against, with real colors.
    (config.colors.operations as any).snub = ORIGINAL;
    const rd = OPS.join(OPS.join(TETRA())); // tetra → cube → rhombic dodecahedron
    const rdFace = dedupe(rd.colors.face as Triple[]);
    const rdVert = dedupe(rd.colors.vertex as Triple[]);
    const rdEdge = dedupe([...rd.colors.edge.values()] as Triple[]);
    const R = config.colors.operations.rectify;
    const tet = { oldFace: [F1], oldVertex: [V1], oldEdge: [E1] };
    const OCTA_LOOKUP = buildLookup({
      face: { swatch: "yellow", triples: dedupe([...tet.oldFace, ...derive(R.newFace, tet)]) },
      vert: { swatch: "red", triples: dedupe(derive(R.newVertex, tet)) },
      edge: { swatch: "blue", triples: dedupe(derive(R.newEdge, tet)) },
    });
    console.log("\nrhombic dodecahedron (what gyro reads):");
    console.log(`  faces ${rdFace.map(key).join(" | ")}  verts ${rdVert.map(key).join(" | ")}  edges ${rdEdge.map(key).join(" | ")}`);

    const FINE = [0, 1 / 8, 1 / 6, 1 / 5, 1 / 4, 1 / 3, 3 / 8, 2 / 5, 1 / 2, 3 / 5, 5 / 8, 2 / 3, 3 / 4, 4 / 5, 5 / 6, 7 / 8, 1];
    const hits: string[] = [];
    for (const b of FINE)
      for (const d of FINE) {
        if (b + d > 1 + 1e-9) continue;
        const e = 1 - b - d;
        // GYRO side: the pentagon is dualRule(newVertex) = {oldFace: b, oldVertex: d,
        // oldEdge: e} against the rhombic dodecahedron. Every source combination must
        // land on a named swatch.
        const gyroCols = derive({ oldFace: b, oldVertex: d, oldEdge: e },
          { oldFace: rdFace, oldVertex: rdVert, oldEdge: rdEdge });
        const named = gyroCols.every((c) => swatchOf(OCTA_LOOKUP, c) !== "white");
        if (!named) continue;
        // ICO side: steal-free with newFace left at {oldEdge: 1}?
        for (const gf of FINE)
          for (const gv of FINE) {
            if (gf + gv > 1 + 1e-9) continue;
            const c: Record<string, Rule> = {
              newFace: rule({ oldEdge: 1 }),
              newEdge: rule({ oldVertex: 1 }),
              snubEdge: rule({ oldFace: gf, oldVertex: gv, oldEdge: 1 - gf - gv }),
              newVertex: rule({ oldVertex: b, oldEdge: e, oldFace: d }),
            };
            const g = icoGroups(c);
            const reps = [...g.face.triples, ...g.vert.triples, ...g.edge.triples];
            if (new Set(reps.map(key)).size !== reps.length) continue;
            if (stolenKeys(g).length !== 0) continue;
            hits.push(`newVertex{oldVertex ${b.toFixed(3)}, oldEdge ${e.toFixed(3)}, oldFace ${d.toFixed(3)}} ` +
              `snubEdge{oldFace ${gf.toFixed(3)}, oldVertex ${gv.toFixed(3)}, oldEdge ${(1 - gf - gv).toFixed(3)}} ` +
              `→ gyro pentagon ${[...new Set(gyroCols.map((x) => swatchOf(OCTA_LOOKUP, x)))].join("/")}`);
          }
      }
    console.log(`\n${hits.length} weightings satisfy BOTH (steal-free ico AND named gyro pentagon):`);
    for (const h of hits.slice(0, 20)) console.log(`  ${h}`);
    (config.colors.operations as any).snub = ORIGINAL;
  }, 600_000);

  /** The two branches of the forced trade-off, with the simplest fractions in each. */
  it("branches", () => {
    const FRACS: Array<[string, number]> = [
      ["0", 0], ["1/4", 1 / 4], ["1/3", 1 / 3], ["2/5", 2 / 5], ["1/2", 1 / 2],
      ["3/5", 3 / 5], ["2/3", 2 / 3], ["3/4", 3 / 4], ["1", 1],
    ];
    const simplicity = (xs: number[]) =>
      xs.reduce((s, x) => s + (FRACS.find(([, v]) => Math.abs(v - x) < 1e-9)?.[0].length ?? 9), 0);

    for (const [branch, fix] of [
      ["A — keep newFace {oldEdge: 1}  (SNUB solids keep today's colors; GYRO pentagons go white)",
        (a: number) => a === 0],
      ["B — keep newVertex oldVertex 3/4 (GYRO solids keep today's colors; SNUB triangles go white)",
        (_a: number, b?: number) => Math.abs(b! - 0.75) < 1e-9],
    ] as Array<[string, (a: number, b?: number) => boolean]>) {
      const found: Array<{ s: number; txt: string; c: Record<string, Rule> }> = [];
      for (const [an, a] of FRACS)
        for (const [bn, b] of FRACS)
          for (const [gfn, gf] of FRACS)
            for (const [gvn, gv] of FRACS) {
              if (gf + gv > 1 + 1e-9) continue;
              if (!fix(a, b)) continue;
              const c = candidate(a, b, gf, gv);
              const g = icoGroups(c);
              const reps = [...g.face.triples, ...g.vert.triples, ...g.edge.triples];
              if (new Set(reps.map(key)).size !== reps.length) continue;
              if (stolenKeys(g).length !== 0) continue;
              if (!idsStayUnique(c)) continue;
              const gen = 1 - gf - gv;
              const gn = FRACS.find(([, v]) => Math.abs(v - gen) < 1e-9)?.[0] ?? gen.toFixed(3);
              found.push({
                s: simplicity([a, b, gf, gv, gen]),
                txt: `newFace{oldEdge ${an === "0" ? "1" : `1-${an}`}} newVertex{oldVertex ${bn}, oldEdge ${FRACS.find(([, v]) => Math.abs(v - (1 - b)) < 1e-9)?.[0]}} snubEdge{oldFace ${gfn}, oldVertex ${gvn}, oldEdge ${gn}}`,
                c,
              });
            }
      found.sort((x, y) => x.s - y.s);
      console.log(`\n${"=".repeat(80)}\nBRANCH ${branch}`);
      console.log(`  ${found.length} steal-free + ID-unique options. Simplest:`);
      for (const f of found.slice(0, 6)) console.log(`    ${f.txt}`);
      if (found.length) {
        const f = evaluate(found[0].c, 2);
        console.log(`  top option verified on real ops (depth 2): HARD=${f.hard.size} soft=${f.soft.size}`);
        console.log(`    ${JSON.stringify(found[0].c)}`);
      }
    }
    (config.colors.operations as any).snub = ORIGINAL;
  }, 600_000);

  /**
   * The "borders" reading of the snub rules:
   *   newFace   — the gap triangle borders two old edges and one new edge (whose color is
   *               the old vertex): (2·oldEdge + oldVertex)/3.
   *   snubEdge  — borders an old face and a new face: (oldFace + newFace)/2
   *               = 1/2 oldFace + 1/3 oldEdge + 1/6 oldVertex.
   * With those two pinned, what can newVertex be? It must (a) leave the icosahedral
   * scheme steal-free and (b) ideally still land the GYRO pentagons on a light blue.
   */
  it("newVertex options for the 'borders' rules", () => {
    const NEW_FACE = { oldEdge: 2 / 3, oldVertex: 1 / 3 };
    const SNUB_EDGE = { oldFace: 1 / 2, oldEdge: 1 / 3, oldVertex: 1 / 6 };

    // The octahedral scheme (rectify only) — what the snub cube / pentagonal
    // icositetrahedron are colored by.
    const R = config.colors.operations.rectify;
    const tet = { oldFace: [F1], oldVertex: [V1], oldEdge: [E1] };
    const OCTA_GROUPS: Record<string, Group> = {
      face: { swatch: "yellow", triples: dedupe([...tet.oldFace, ...derive(R.newFace, tet)]) },
      vert: { swatch: "red", triples: dedupe(derive(R.newVertex, tet)) },
      edge: { swatch: "blue", triples: dedupe(derive(R.newEdge, tet)) },
    };

    const OPTIONS: Array<[string, Rule]> = [
      ["{oldVertex 2/3, oldEdge 1/3}  ← your suggestion", { oldVertex: 2 / 3, oldEdge: 1 / 3 }],
      ["{oldVertex 3/4, oldEdge 1/4}  (today's)", { oldVertex: 3 / 4, oldEdge: 1 / 4 }],
      ["{oldVertex 1/2, oldEdge 1/2}  (the 'moved halfway' rule)", { oldVertex: 1 / 2, oldEdge: 1 / 2 }],
      ["{oldVertex 5/6, oldEdge 1/6}", { oldVertex: 5 / 6, oldEdge: 1 / 6 }],
      ["{oldVertex 3/5, oldEdge 2/5}", { oldVertex: 3 / 5, oldEdge: 2 / 5 }],
      ["{oldVertex 2/5, oldEdge 3/5}", { oldVertex: 2 / 5, oldEdge: 3 / 5 }],
      ["{oldVertex 1.0}  (pure)", { oldVertex: 1 }],
    ];
    const PALETTES: Array<[string, Extras]> = [
      ["today's families (avg / nested-avg / tint@3:1)", {}],
      ["+ avg3 ONLY (an equal 3-way mix — no tint2)", { avg3: true }],
      ["+ tint2 (a 2:1 tint)", { tint2: true }],
      ["+ tint2 + avg3", { tint2: true, avg3: true }],
    ];

    for (const [pname, extras] of PALETTES) {
      console.log(`\n${"#".repeat(80)}\nPALETTE: ${pname}\n${"#".repeat(80)}`);
      const octaLookup = buildLookup(OCTA_GROUPS, extras);
      for (const [label, nv] of OPTIONS) {
        const c: Record<string, Rule> = {
          newFace: NEW_FACE,
          newEdge: { oldVertex: 1 },
          snubEdge: SNUB_EDGE,
          newVertex: nv,
        };
        const g = icoGroups(c);
        const reps = [...g.face.triples, ...g.vert.triples, ...g.edge.triples];
        const distinct = new Set(reps.map(key)).size === reps.length;
        const st = stolenKeys(g, extras);
        const ids = idsStayUnique(c);
        const f = distinct ? evaluate(c, 2, extras) : null;

        (config.colors.operations as any).snub = c;
        const icoLookup = buildLookup(g, extras);
        const cube = OPS.join(TETRA());
        const ico = OPS.snub(TETRA());
        const faces = (p: Polyhedron, lk: Map<string, string>) => {
          const m = new Map<string, number>();
          p.faces.forEach((fc, i) => {
            const k = `${fc.length}-gon ${swatchOf(lk, p.colors.face[i] as Triple)}`;
            m.set(k, (m.get(k) ?? 0) + 1);
          });
          return [...m].sort().map(([k, n]) => `${n}x ${k}`).join(", ");
        };

        console.log(`\n  newVertex: ${label}`);
        console.log(`    ico vert triple ${g.vert.triples.map(key).join(" | ")}` +
          `   distinct=${distinct}  IDs-unique=${ids}  stolen=${st.length}` +
          `  HARD=${f ? f.hard.size : "-"}  soft=${f ? f.soft.size : "-"}`);
        for (const s of st.slice(0, 3)) console.log(`      steal: ${s}`);
        console.log(`      snub cuboctahedron    : ${faces(OPS.snub(cube), octaLookup)}`);
        console.log(`      pent. icositetrahedron: ${faces(OPS.gyro(cube), octaLookup)}`);
        console.log(`      snub icosidodecahedron: ${faces(OPS.snub(ico), icoLookup)}`);
        console.log(`      pent. hexecontahedron : ${faces(OPS.gyro(ico), icoLookup)}`);
        console.log(`      subdivide(icosidodeca): ${faces(OPS.subdivide(OPS.rectify(ico)), icoLookup)}`);
      }
    }
    // Which newVertex weights are admissible AT ALL under these rules (+ avg3)?
    console.log(`\n${"#".repeat(80)}\nEVERY steal-free newVertex (with the 'borders' newFace/snubEdge + avg3)\n${"#".repeat(80)}`);
    const octaLookupAvg3 = buildLookup(OCTA_GROUPS, { avg3: true });
    for (let d = 2; d <= 8; d++)
      for (let n = 1; n < d; n++) {
        if (n / d !== Math.round((n / d) * 1e6) / 1e6) continue;
        const g4 = (a: number, b: number) => Math.abs(a - b) < 1e-9;
        if ([...Array(d - 1)].some((_, k) => k + 1 < n && g4(n / d, (k + 1) / d) && d % (k + 1) === 0)) continue;
        const b = n / d;
        const c: Record<string, Rule> = {
          newFace: NEW_FACE, newEdge: { oldVertex: 1 }, snubEdge: SNUB_EDGE,
          newVertex: { oldVertex: b, oldEdge: 1 - b },
        };
        const g = icoGroups(c);
        const reps = [...g.face.triples, ...g.vert.triples, ...g.edge.triples];
        if (new Set(reps.map(key)).size !== reps.length) continue;
        const st = stolenKeys(g, { avg3: true });
        if (st.length !== 0 || !idsStayUnique(c)) continue;
        (config.colors.operations as any).snub = c;
        const pent = OPS.gyro(OPS.join(TETRA()));
        const sw = [...new Set(pent.faces.map((_, i) => swatchOf(octaLookupAvg3, pent.colors.face[i] as Triple)))];
        console.log(`  oldVertex ${n}/${d}  →  gyro pentagons: ${sw.join("/")}`);
      }
    (config.colors.operations as any).snub = ORIGINAL;
  }, 600_000);

  /**
   * A PRINCIPLED newVertex. The rectification's vertices always have degree 4, so a snub
   * split vertex ALWAYS borders exactly 2 rotated old faces and 3 new gap triangles
   * (check: icosahedron = 8 rotated × 3 + 12 gap × 3 = 60 = 12 verts × 5). So "the average
   * of the faces I border" is
   *     newVertex = (2·oldFace + 3·newFace)/5
   *               = 2/5 oldFace + 2/5 oldEdge + 1/5 oldVertex      (with the new newFace)
   * That needs an `oldFace` source at the call site (snub.ts already knows it: `aface`).
   * Does it survive? Compared against every other simple newVertex.
   */
  it("principled degree-5 newVertex", () => {
    const NEW_FACE = { oldEdge: 2 / 3, oldVertex: 1 / 3 };
    const SNUB_EDGE = { oldFace: 1 / 2, oldEdge: 1 / 3, oldVertex: 1 / 6 };
    const EXTRAS: Extras = { avg3: true, tint4: true };

    // What the gyro pentagons (dual of newVertex) read against: the rhombic dodecahedron.
    (config.colors.operations as any).snub = ORIGINAL;
    const rd = OPS.join(OPS.join(TETRA()));
    const rdSrc = {
      oldFace: dedupe(rd.colors.face as Triple[]),
      oldVertex: dedupe(rd.colors.vertex as Triple[]),
      oldEdge: dedupe([...rd.colors.edge.values()] as Triple[]),
    };
    const R = config.colors.operations.rectify;
    const tet = { oldFace: [F1], oldVertex: [V1], oldEdge: [E1] };
    const OCTA = buildLookup({
      face: { swatch: "yellow", triples: dedupe([...tet.oldFace, ...derive(R.newFace, tet)]) },
      vert: { swatch: "red", triples: dedupe(derive(R.newVertex, tet)) },
      edge: { swatch: "blue", triples: dedupe(derive(R.newEdge, tet)) },
    }, EXTRAS);
    const dual = (r: Rule): Rule => Object.fromEntries(Object.entries(r).map(([t, v]) =>
      [t === "oldVertex" ? "oldFace" : t === "oldFace" ? "oldVertex" : t, v]));

    const CASES: Array<[string, Rule]> = [
      ["(2·oldFace + 3·newFace)/5      — avg of the 5 FACES I border", { oldFace: 2 / 5, oldEdge: 2 / 5, oldVertex: 1 / 5 }],
      ["(newEdge + 4·snubEdge)/5       — avg of the 5 EDGES I border", { oldVertex: 1 / 3, oldFace: 2 / 5, oldEdge: 4 / 15 }],
      ["(oldVertex + newFace)/2        — your 2/3 suggestion", { oldVertex: 2 / 3, oldEdge: 1 / 3 }],
      ["(oldVertex + oldEdge)/2        — 'slid halfway'", { oldVertex: 1 / 2, oldEdge: 1 / 2 }],
      ["{oldVertex 5/8, oldEdge 3/8}   — the TRUE slide (snubEdgeFraction/2 = 3/8)", { oldVertex: 5 / 8, oldEdge: 3 / 8 }],
      ["{oldEdge 1}                    — pure: 'I am the edge I slide along'", { oldEdge: 1 }],
      ["{oldEdge 4/5, oldVertex 1/5}   — the OTHER way round", { oldEdge: 4 / 5, oldVertex: 1 / 5 }],
      ["{oldVertex 4/5, oldEdge 1/5}", { oldVertex: 4 / 5, oldEdge: 1 / 5 }],
      ["{oldVertex 3/5, oldEdge 2/5}", { oldVertex: 3 / 5, oldEdge: 2 / 5 }],
      ["{oldVertex 3/4, oldEdge 1/4}   — today's", { oldVertex: 3 / 4, oldEdge: 1 / 4 }],
    ];
    for (const [label, nv] of CASES) {
      const g = icoGroups({ newFace: NEW_FACE, newEdge: { oldVertex: 1 }, snubEdge: SNUB_EDGE, newVertex: nv });
      const reps = [...g.face.triples, ...g.vert.triples, ...g.edge.triples];
      const distinct = new Set(reps.map(key)).size === reps.length;
      const st = stolenKeys(g, EXTRAS);
      const pent = [...new Set(derive(dual(nv), rdSrc).map((c) => swatchOf(OCTA, c)))];
      // The `oldFace` variants would need a new source at the snub.ts call site, so they
      // can only be checked analytically; the rest run through the real operations.
      const runnable = !("oldFace" in nv);
      const c: Record<string, Rule> = { newFace: NEW_FACE, newEdge: { oldVertex: 1 }, snubEdge: SNUB_EDGE, newVertex: nv };
      const ids = runnable ? idsStayUnique(c) : "n/a";
      const f = runnable && distinct ? evaluate(c, 2, EXTRAS) : null;
      console.log(`\n  ${label}`);
      console.log(`    ico vert ${g.vert.triples.map(key).join(" | ")}  distinct=${distinct}  stolen=${st.length}` +
        `  IDs-unique=${ids}  HARD=${f ? f.hard.size : "-"}  → gyro pentagons: ${pent.join("/")}`);
      for (const s of st.slice(0, 4)) console.log(`      ${s}`);
    }
    (config.colors.operations as any).snub = ORIGINAL;
  }, 300_000);

  /** THE SHIPPING CONFIGURATION: the committed snub rules + the widened palette
   *  (tint3 = the old 3:1 tint, tint4 = a new 4:1 tint, avg(a,b,c) = an equal 3-way mix). */
  it("shipping config", () => {
    const EXTRAS: Extras = { avg3: true, tint4: true };
    const c = config.colors.operations.snub as unknown as Record<string, Rule>;
    const g = icoGroups(c);
    const st = stolenKeys(g, EXTRAS);
    const f = evaluate(c, 2, EXTRAS);
    console.log(`\nsnub rules: ${JSON.stringify(c)}`);
    console.log(`  ico face ${g.face.triples.map(key).join(" | ")}`);
    console.log(`  ico vert ${g.vert.triples.map(key).join(" | ")}`);
    console.log(`  ico edge ${g.edge.triples.map(key).join(" | ")}`);
    console.log(`  stolen keys = ${st.length}   HARD = ${f.hard.size}   soft = ${f.soft.size}`);
    for (const s of st) console.log(`      ${s}`);
    for (const [m] of [...f.hard].sort().slice(0, 8)) console.log(`      ${m}`);

    const R = config.colors.operations.rectify;
    const tet = { oldFace: [F1], oldVertex: [V1], oldEdge: [E1] };
    const octaLookup = buildLookup({
      face: { swatch: "yellow", triples: dedupe([...tet.oldFace, ...derive(R.newFace, tet)]) },
      vert: { swatch: "red", triples: dedupe(derive(R.newVertex, tet)) },
      edge: { swatch: "blue", triples: dedupe(derive(R.newEdge, tet)) },
    }, EXTRAS);
    const icoLookup = buildLookup(g, EXTRAS);
    const faces = (p: Polyhedron, lk: Map<string, string>) => {
      const m = new Map<string, number>();
      p.faces.forEach((fc, i) => {
        const k = `${fc.length}-gon ${swatchOf(lk, p.colors.face[i] as Triple)}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      });
      return [...m].sort().map(([k, n]) => `${n}x ${k}`).join(", ");
    };
    const cube = OPS.join(TETRA());
    const ico = OPS.snub(TETRA());
    console.log("\n  library solids the snub/gyro rules color:");
    console.log(`    snub cuboctahedron    : ${faces(OPS.snub(cube), octaLookup)}`);
    console.log(`    pent. icositetrahedron: ${faces(OPS.gyro(cube), octaLookup)}`);
    console.log(`    snub icosidodecahedron: ${faces(OPS.snub(ico), icoLookup)}`);
    console.log(`    pent. hexecontahedron : ${faces(OPS.gyro(ico), icoLookup)}`);
    console.log(`    icosahedron           : ${faces(ico, icoLookup)}`);
    console.log(`    icosidodecahedron     : ${faces(OPS.rectify(ico), icoLookup)}`);
    console.log(`    subdivide(icosidodeca): ${faces(OPS.subdivide(OPS.rectify(ico)), icoLookup)}`);
  }, 300_000);

  it("finalists", () => {
    const NAMED: Record<string, Record<string, Rule>> = {
      CURRENT: ORIGINAL,
      "BRANCH A (snub solids keep their color; gyro pentagons go white)": candidate(0, 2 / 5, 1 / 4, 1 / 4),
      "BRANCH B (gyro solids keep their color; snub triangles go white)": candidate(1 / 3, 3 / 4, 1 / 4, 1 / 4),
    };
    for (const [name, c] of Object.entries(NAMED)) {
      const g = icoGroups(c);
      const lookup = buildLookup(g);
      const f = evaluate(c, 2);
      console.log(`\n${"=".repeat(78)}\n${name}\n${"=".repeat(78)}`);
      console.log(`  ico face triples: ${g.face.triples.map(key).join("  |  ")}`);
      console.log(`  ico vert triples: ${g.vert.triples.map(key).join("  |  ")}`);
      console.log(`  ico edge triples: ${g.edge.triples.map(key).join("  |  ")}`);
      console.log(`  stolen keys: ${stolenKeys(g).length}`);
      for (const s of stolenKeys(g)) console.log(`      ${s}`);
      console.log(`  HARD mismatches: ${f.hard.size}`);
      for (const [m] of [...f.hard].sort().slice(0, 6)) console.log(`      ${m}`);
      console.log(`  soft mismatches: ${f.soft.size}`);
      for (const [m] of [...f.soft].sort()) console.log(`      ${m}`);

      // The user's case, plus the shapes the snub rules also color at RUNTIME.
      (config.colors.operations as any).snub = c;
      const ico = OPS.snub(TETRA());
      const idod = OPS.rectify(ico);
      const sub = OPS.subdivide(idod);
      // NB the colors here are ALREADY collapsed triples (the tetra starts as one), so
      // they feed the lookup directly — no `collapse` step.
      const show = (p: Polyhedron, label: string, lk: Map<string, string>) => {
        const m = new Map<string, number>();
        p.faces.forEach((fc, i) => {
          const k = `${fc.length}-gon ${swatchOf(lk, p.colors.face[i] as Triple)}`;
          m.set(k, (m.get(k) ?? 0) + 1);
        });
        console.log(`    ${label}: ${[...m].sort().map(([k, n]) => `${n}x ${k}`).join(", ")}`);
      };
      console.log("  face swatches:");
      show(ico, "icosahedron          ", lookup);
      show(idod, "icosidodecahedron    ", lookup);
      show(sub, "subdivide(icosidodec)", lookup);
      show(OPS.snub(ico), "snub icosidodecahedron", lookup);
      show(OPS.gyro(ico), "pent. hexecontahedron ", lookup);
      // Snub cube / snub dodeca live in the OCTAHEDRAL scheme, which the snub rules do
      // not define but DO feed at runtime — make sure they don't go white.
      const octaG = (() => {
        const R = config.colors.operations.rectify;
        const tet = { oldFace: [F1], oldVertex: [V1], oldEdge: [E1] };
        return {
          face: { swatch: "yellow", triples: dedupe([...tet.oldFace, ...derive(R.newFace, tet)]) },
          vert: { swatch: "red", triples: dedupe(derive(R.newVertex, tet)) },
          edge: { swatch: "blue", triples: dedupe(derive(R.newEdge, tet)) },
        };
      })();
      const octaLookup = buildLookup(octaG);
      const cube = OPS.join(TETRA());
      show(OPS.snub(cube), "snub cube (octa scheme)", octaLookup);
      show(OPS.gyro(OPS.rectify(TETRA())), "gyro octa (octa scheme)", octaLookup);
    }
    (config.colors.operations as any).snub = ORIGINAL;
  }, 300_000);

  it("sweep", () => {
    const G = [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
    // Stage 1 (fast, op-free): no group's key may be stolen by another group.
    const clean: Array<Record<string, Rule>> = [];
    let tried = 0;
    for (const a of G)
      for (const b of G)
        for (const gf of G)
          for (const gv of G) {
            if (gf + gv > 1 + 1e-9) continue;
            tried++;
            const c = candidate(a, b, gf, gv);
            const g = icoGroups(c);
            // The three plain groups must stay distinguishable at all.
            const reps = new Set([...g.face.triples, ...g.vert.triples, ...g.edge.triples].map(key));
            if (reps.size !== g.face.triples.length + g.vert.triples.length + g.edge.triples.length) continue;
            if (stolenKeys(g).length === 0) clean.push(c);
          }
    console.log(`\ntried ${tried}; ${clean.length} have no stolen keys`);

    // Stage 2: they must also keep the 14-D IDs unique (tests/colorIds), and then we
    // confirm on the real operations.
    const results: Array<{ c: Record<string, Rule>; hard: number; soft: number }> = [];
    for (const c of clean) {
      if (!idsStayUnique(c)) continue;
      const f = evaluate(c, 2);
      results.push({ c, hard: f.hard.size, soft: f.soft.size });
    }
    results.sort((x, y) => x.hard - y.hard || x.soft - y.soft);
    console.log(`${results.length} keep IDs unique. Best (depth-2, real ops):\n`);
    for (const r of results.slice(0, 25))
      console.log(`  HARD=${String(r.hard).padStart(3)} soft=${String(r.soft).padStart(3)}  ${JSON.stringify(r.c)}`);
    (config.colors.operations as any).snub = ORIGINAL;
  }, 900_000);
});
