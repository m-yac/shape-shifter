import { describe, it, vi } from "vitest";

/**
 * Why the icosahedral family's colors are asymmetric.
 *
 * The library builds EVERY solid from the tetrahedron, so the icosahedron arrives as
 * snub(rectify(tetra)). Its 20 faces then carry THREE distinct provenance triples (the
 * 4 tetra-face octa faces, the 4 tetra-vertex octa faces, and the 12 snub gap triangles)
 * and its 30 edges three more — all of which render `yellow` / `blue`, so the icosahedron
 * itself looks right. But a later operation combines those triples, and the combinations
 * do NOT all land on the same swatch: some collide with a synthesized group of a
 * higher-precedence tier. Hence e.g. the Subdivided dodecahedron's 60 new triangles come
 * out part `tint(yellow)`, part `avg(blue,avg(red,yellow))`.
 *
 * The invariant we WANT (call it the color CONGRUENCE): the swatch of a new element must
 * depend only on the SWATCHES of the old elements it derives from, never on which
 * representative triple of that swatch's orbit was used. This file measures it: every
 * solid is built twice —
 *
 *   REAL  — the tetrahedron-rooted chain the library actually runs;
 *   IDEAL — the same chain, but with the Platonic root's colors CANONICALIZED first
 *           (every element replaced by one representative triple per swatch), which is
 *           what you get by operating on a freshly-loaded dodecahedron.
 *
 * Both produce the same mesh in the same element order, so the swatches can be compared
 * element by element. Any REAL≠IDEAL element is a congruence violation.
 *
 * It then SWEEPS candidate `config.colors.operations.snub` rules for one that is
 * congruent everywhere while leaving the IDEAL swatches (the colors the solids are
 * supposed to have) untouched.
 */

// The rule shapes we sweep. `newEdge` is pinned to {oldVertex: 1} throughout.
type Rule = Record<string, number>;
type SnubRules = { newFace: Rule; newEdge: Rule; snubEdge: Rule; newVertex: Rule };

interface Loaded {
  swatchesOf(p: any, scheme: string): { face: string[]; vert: string[]; edge: string[] };
  chains(): Map<string, { scheme: string; real: any; ideal: any; library: boolean }>;
  ops: Record<string, (p: any) => any>;
  roots: Record<string, { poly: any; scheme: string }>;
  triples(p: any): { face: string[]; vert: string[]; edge: string[] };
}

/** The library's own solids (data/namedPolyhedra), as root + operation chain. Their
 *  swatches are the SPEC: a candidate rule set may not change any of them. */
const LIBRARY: Array<[string, string[]]> = [
  ["tetrahedron", []], ["tetrahedron", ["truncate"]], ["tetrahedron", ["kis"]],
  ["tetrahedron", ["chamfer"]], ["tetrahedron", ["subdivide"]],
  ["octahedron", []], ["cube", []],
  ["octahedron", ["truncate"]], ["cube", ["truncate"]],
  ["octahedron", ["rectify"]], ["octahedron", ["join"]],
  ["octahedron", ["rectify", "truncate"]], ["octahedron", ["rectify", "rectify"]],
  ["octahedron", ["snub"]], ["octahedron", ["gyro"]],
  ["octahedron", ["kis"]], ["cube", ["kis"]],
  ["octahedron", ["join", "kis"]], ["octahedron", ["rectify", "join"]],
  ["cube", ["chamfer"]], ["octahedron", ["chamfer"]],
  ["cube", ["subdivide"]], ["octahedron", ["subdivide"]],
  ["icosahedron", []], ["dodecahedron", []],
  ["icosahedron", ["truncate"]], ["dodecahedron", ["truncate"]],
  ["icosahedron", ["rectify"]], ["icosahedron", ["join"]],
  ["icosahedron", ["rectify", "truncate"]], ["icosahedron", ["rectify", "rectify"]],
  ["icosahedron", ["snub"]], ["icosahedron", ["gyro"]],
  ["icosahedron", ["kis"]], ["dodecahedron", ["kis"]],
  ["icosahedron", ["join", "kis"]], ["icosahedron", ["rectify", "join"]],
  ["dodecahedron", ["chamfer"]], ["icosahedron", ["chamfer"]],
  ["dodecahedron", ["subdivide"]], ["icosahedron", ["subdivide"]],
];
const libKey = (root: string, ops: string[]) => (ops.length ? `${root}: ${ops.join(" → ")}` : root);
const LIBRARY_KEYS = new Set(LIBRARY.map(([r, o]) => libKey(r, o)));

/** Re-import the whole color/operation stack with `snub` (and optionally `subdivide`)
 *  rules overridden, then build every solid of interest twice (REAL / IDEAL). */
async function load(over?: { snub?: Partial<SnubRules>; subdivide?: Rule extends never ? never : any }): Promise<Loaded> {
  vi.resetModules();
  const cfg = (await import("../src/config")).config as any;
  if (over?.snub) Object.assign(cfg.colors.operations.snub, over.snub);
  if (over?.subdivide) Object.assign(cfg.colors.operations.subdivide, over.subdivide);

  const { getSeed } = await import("../src/geometry/seeds");
  const { Polyhedron } = await import("../src/geometry/polyhedron");
  const C = await import("../src/geometry/colors");
  const { buildTruncate } = await import("../src/operations/truncate");
  const { buildKis } = await import("../src/operations/kis");
  const { buildSnub } = await import("../src/operations/snub");
  const { buildGyro } = await import("../src/operations/gyro");
  const { buildChamfer } = await import("../src/operations/chamfer");
  const { buildSubdivide } = await import("../src/operations/subdivide");

  const wrap = (r: any) => new Polyhedron(r.mesh, r.colors);
  const truncate = (p: any) => wrap(buildTruncate(p, 0, null).commit(0.5, false));
  const rectify = (p: any) => wrap(buildTruncate(p, 0, null).commit(1, true));
  const kis = (p: any) => wrap(buildKis(p, 0, null).commit(0.5, false));
  const join = (p: any) => wrap(buildKis(p, 0, null).commit(1, true));
  /** kis restricted to the n-gons (the "3-kis" gesture on an icosidodecahedron). */
  const faceLen = (f: any) => {
    let h = f.halfedge, n = 0;
    const s = h;
    do { n++; h = h.next; } while (h !== s);
    return n;
  };
  const kisN = (n: number) => (p: any) => {
    const sel = new Set<number>(p.dcel.faces.filter((f: any) => faceLen(f) === n).map((f: any) => f.id));
    if (sel.size === 0 || sel.size === p.dcel.faces.length) throw new Error(`no ${n}-gon subset`);
    // A PARTIAL kis only builds apexes on the selected faces below t = 0.5 (above it the
    // unselected faces start rising too, and every face gets one) — so commit at 0.25.
    return wrap(buildKis(p, [...sel][0], sel).commit(0.25, false));
  };
  const snub = (p: any) => {
    const r = rectify(p);
    return wrap(buildSnub(r, 0, r.vertices[0].clone()).commit(1, true));
  };
  const gyro = (p: any) => {
    const j = join(p);
    return wrap(buildGyro(j, 0, j.vertices[0].clone()).commit(1, true));
  };
  const firstEdge = (p: any): [number, number] => {
    const he = p.dcel.halfedges[0];
    return [he.origin.id, he.next.origin.id];
  };
  const chamfer = (p: any) => {
    const he = p.dcel.halfedges[0];
    return wrap(buildChamfer(p, firstEdge(p), he.face.id).commit(0.5, false));
  };
  const subdivide = (p: any) => wrap(buildSubdivide(p, firstEdge(p)).commit(0.5, false));

  const swatchesOf = (p: any, scheme: string) => {
    C.setColorScheme(scheme as any);
    return {
      face: p.colors.face.map((c: any) => C.paletteSwatch(c)),
      vert: p.colors.vertex.map((c: any) => C.paletteSwatch(c)),
      edge: [...p.colors.edge.values()].map((c: any) => C.paletteSwatch(c)),
    };
  };

  /** Replace every element's color by ONE representative per swatch — the coloring a
   *  freshly-loaded seed of this solid has (single triple per orbit). */
  const canonicalize = (p: any, scheme: string): any => {
    C.setColorScheme(scheme as any);
    const rep = new Map<string, any>();
    const cn = (c: any) => {
      const s = C.paletteSwatch(c);
      if (!rep.has(s)) rep.set(s, c);
      return rep.get(s)!;
    };
    const colors = {
      face: p.colors.face.map(cn),
      vertex: p.colors.vertex.map(cn),
      edge: new Map([...p.colors.edge].map(([k, c]: any) => [k, cn(c)])),
    };
    return new Polyhedron(p.mesh, colors);
  };

  const tetMesh = getSeed("tetrahedron");
  const tet = new Polyhedron(tetMesh);

  // The Platonic roots, exactly as the library builds them.
  const roots: Record<string, { poly: any; scheme: string }> = {
    tetrahedron: { poly: tet, scheme: "tetrahedral" },
    octahedron: { poly: rectify(tet), scheme: "octahedral" },
    cube: { poly: join(tet), scheme: "octahedral" },
    icosahedron: { poly: snub(tet), scheme: "icosahedral" },
    dodecahedron: { poly: gyro(tet), scheme: "icosahedral" },
  };

  const OPS: Record<string, (p: any) => any> = {
    truncate, rectify, kis, join, snub, gyro, chamfer, subdivide,
    kis3: kisN(3), kis4: kisN(4), kis5: kisN(5),
  };

  // Every chain worth checking: the library's own solids plus the deeper ones the user
  // reaches by hand (rectify → 3-kis, etc.).
  const CHAINS: Array<[string, string, string[]]> = [];
  for (const root of Object.keys(roots)) {
    for (const op of ["", "truncate", "rectify", "kis", "join", "snub", "gyro", "chamfer", "subdivide"])
      CHAINS.push([root, root, op ? [op] : []]);
    // second-order: everything reachable from the rectification / join
    for (const op of ["truncate", "rectify", "kis", "join", "snub", "gyro", "chamfer", "subdivide", "kis3", "kis4", "kis5"]) {
      CHAINS.push([`${root}/rectify+${op}`, root, ["rectify", op]]);
      CHAINS.push([`${root}/join+${op}`, root, ["join", op]]);
    }
  }

  const chains = () => {
    const out = new Map<string, { scheme: string; real: any; ideal: any; library: boolean }>();
    for (const [, root, ops] of CHAINS) {
      const { poly, scheme } = roots[root];
      let real = poly;
      let ideal = canonicalize(poly, scheme);
      try {
        for (const op of ops) {
          real = OPS[op](real);
          ideal = OPS[op](ideal);
        }
      } catch {
        continue; // e.g. kis4 on a solid with no quads
      }
      const label = libKey(root, ops);
      out.set(label, { scheme, real, ideal, library: LIBRARY_KEYS.has(label) });
    }
    return out;
  };

  const key = (c: any) => c.map((x: number) => Math.round(x * 10000) / 10000).join(",");
  const triples = (p: any) => ({
    face: p.colors.face.map(key),
    vert: p.colors.vertex.map(key),
    edge: [...p.colors.edge.values()].map(key),
  });

  return { swatchesOf, chains, ops: OPS, roots, triples };
}

/** Multiset of swatch names. */
const counts = (xs: string[]): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Element-wise REAL vs IDEAL comparison for one solid. */
function violations(L: Loaded, entry: { scheme: string; real: any; ideal: any }) {
  const r = L.swatchesOf(entry.real, entry.scheme);
  const i = L.swatchesOf(entry.ideal, entry.scheme);
  const out: Record<string, string[]> = {};
  for (const kind of ["face", "vert", "edge"] as const) {
    const bad = new Map<string, number>();
    (r as any)[kind].forEach((s: string, k: number) => {
      const want = (i as any)[kind][k];
      if (s !== want) bad.set(`${want} → ${s}`, (bad.get(`${want} → ${s}`) ?? 0) + 1);
    });
    if (bad.size) out[kind] = [...bad].map(([k, n]) => `${n}× ${k}`);
  }
  return { real: r, ideal: i, out };
}

/** The full report for one candidate: which chains break congruence (and how), and
 *  which LIBRARY solids come out a different color than they are supposed to be. */
async function report(label: string, cand: Partial<SnubRules>, baseIdeal: Map<string, unknown>) {
  const L = await load({ snub: cand });
  const bad = new Map<string, string[]>(); // "kind: want → got" → chains
  const recolored: string[] = [];
  for (const [name, e] of L.chains()) {
    const { out, real } = violations(L, e);
    for (const [kind, lines] of Object.entries(out))
      for (const line of lines) {
        const k = `${kind}  ${line.replace(/^\d+× /, "")}`;
        bad.set(k, [...(bad.get(k) ?? []), name]);
      }
    if (!e.library) continue;
    const want = baseIdeal.get(name) as any[];
    const got = [counts(real.face), counts(real.vert), counts(real.edge)];
    if (!same(got, want)) recolored.push(`      ${name}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
  }
  console.log(`\n### ${label}\n    ${JSON.stringify(cand)}`);
  console.log(`  congruence violations: ${bad.size === 0 ? "NONE ✓" : ""}`);
  for (const [k, chains] of bad)
    console.log(`    ${k}   (${chains.length} chains, e.g. ${chains.slice(0, 3).join("; ")})`);
  console.log(`  library solids recolored: ${recolored.length === 0 ? "NONE ✓" : ""}`);
  console.log(recolored.join("\n"));
}

describe("snub color symmetry", () => {
  it("reports congruence violations under the CURRENT rules", async () => {
    const L = await load();
    const ch = L.chains();
    console.log("\n=== CURRENT RULES: REAL vs IDEAL (want: no violations) ===");
    for (const [name, entry] of ch) {
      const { out, ideal } = violations(L, entry);
      if (Object.keys(out).length === 0) continue;
      console.log(`\n${name}  [${entry.scheme}]`);
      for (const [kind, lines] of Object.entries(out))
        console.log(`   ${kind.padEnd(5)} ${lines.join(", ")}`);
      console.log(`   ideal faces: ${JSON.stringify(counts(ideal.face))}`);
    }
  });

  // Subdivide IS "rectify, then kis the vertex-faces": rectify turns every old vertex
  // into a face and every old edge into a vertex, and kissing just those vertex-faces
  // fans them back out — the exact subdivision. So subdivide's color rules are forced by
  // the rectify + kis rules. This checks the two paths agree, element for element.
  it("subdivide should equal partial-kis of a rectification", async () => {
    const check = async (label: string, over?: any) => {
      const L = await load(over);
      console.log(`\n--- ${label} ---`);
      for (const root of ["cube", "octahedron", "dodecahedron", "icosahedron"]) {
        const p = L.roots[root].poly;
        const degree = new Set(p.dcel.vertices.map((v: any) => {
          let h = v.halfedge, n = 0; const s = h;
          do { n++; h = h.twin.next; } while (h !== s);
          return n;
        }));
        const d = [...degree][0]; // the vertex-face arity in the rectification
        const viaSub = L.triples(L.ops.subdivide(p));
        const viaKis = L.triples(L.ops[`kis${d}`](L.ops.rectify(p)));
        for (const kind of ["face", "vert", "edge"] as const) {
          const a = counts((viaSub as any)[kind].sort());
          const b = counts((viaKis as any)[kind].sort());
          console.log(`   ${root.padEnd(13)} ${kind.padEnd(5)} ${same(a, b) ? "match" : `DIFFER\n      subdivide:   ${JSON.stringify(a)}\n      kis(rectify):${JSON.stringify(b)}`}`);
        }
      }
    };
    await check("current config");
    await check("subdivFaceEdge = {oldFace: 0.5, oldVertex: 0.5}", {
      subdivide: { subdivFaceEdge: { oldFace: 0.5, oldVertex: 0.5 } },
    });
  }, 300_000);

  // The collision behind the whole bug is an ALGEBRAIC IDENTITY, and it holds in the full
  // 14-D ID space, not just the collapsed one:
  //
  //   the gap triangle   X   = the rectify edge  = (Fi + Fj)/2   — the average of the two
  //                                                 rectify faces it sits between
  //   a boundary edge    B   = (Fi + X)/2        — snubEdge, "the average of its 2 faces"
  //   so   0.75·X + 0.25·V   ==   0.5·B + 0.25·Fj + 0.25·V
  //        ^ tint(face)            ^ avg(edge, avg(face,vert))   ← wins (lower tier)
  //
  // i.e. because X is the exact midpoint of two OTHER face colors, a tint of it is
  // indistinguishable from a blend involving an edge. Nothing downstream can undo that;
  // the gap triangle has to stop being that midpoint. These candidates push it off the
  // midpoint by mixing in the rectify VERTEX it opens at.
  it("diagnoses principled candidates", async () => {
    const base = await load();
    const baseIdeal = new Map<string, unknown>();
    for (const [name, e] of base.chains()) {
      const s = base.swatchesOf(e.ideal, e.scheme);
      baseIdeal.set(name, [counts(s.face), counts(s.vert), counts(s.edge)]);
    }
    // snubEdge follows the "an edge is the average of the two faces it separates" rule:
    // 0.5·(rotated face) + 0.5·(gap triangle) = 0.5·oldFace + 0.5·newFace.
    const withAvgEdge = (a: number): Partial<SnubRules> => ({
      newFace: a === 0 ? { oldEdge: 1 } : { oldEdge: 1 - a, oldVertex: a },
      snubEdge: { oldFace: 0.5, oldEdge: 0.5 * (1 - a), ...(a > 0 ? { oldVertex: 0.5 * a } : {}) },
    });
    await report("CURRENT", {}, baseIdeal);
    await report("current newFace, but snubEdge = avg of its two faces", withAvgEdge(0), baseIdeal);
    for (const a of [0.25, 0.5, 0.75]) await report(`gap triangle = ${1 - a}·edge + ${a}·vertex`, withAvgEdge(a), baseIdeal);
    // gap triangle = the rectify vertex only (no edge at all).
    await report("gap triangle = the rectify vertex", { newFace: { oldVertex: 1 }, snubEdge: { oldFace: 0.5, oldVertex: 0.5 } }, baseIdeal);
    // The sweep's one library-clean candidate: only `snubEdge` moves.
    await report("WINNER: snubEdge = 0.75·oldFace + 0.25·oldVertex", { snubEdge: { oldFace: 0.75, oldVertex: 0.25 } }, baseIdeal);
  }, 900_000);

  it("sweeps snub rules for a congruent set that keeps the library's swatches", async () => {
    // Baseline: the swatches every LIBRARY solid is SUPPOSED to have (the IDEAL build
    // under the current rules — the Subdivided dodecahedron's 60 triangles all
    // `tint(yellow)`, not the broken mix it currently shows). A candidate must reproduce
    // these exactly AND be congruent.
    const base = await load();
    const baseIdeal = new Map<string, unknown>();
    for (const [name, e] of base.chains()) {
      const s = base.swatchesOf(e.ideal, e.scheme);
      baseIdeal.set(name, [counts(s.face), counts(s.vert), counts(s.edge)]);
    }

    // The candidate space. Every rule is a convex combination of the tokens its call site
    // in snub.ts actually supplies:
    //   newFace   (gap triangle)  ← the rectify EDGE it opens across, the rectify VERTEX
    //                               it opens at
    //   snubEdge  (boundary edge) ← the rotated FACE it borders, the rectify EDGE it is a
    //                               shrunk copy of, the rectify VERTEX it runs to
    //   newVertex (split vertex)  ← the rectify VERTEX, the rectify EDGE it slides along
    //   newEdge   (center edge)   ← pinned to {oldVertex: 1}, as requested
    const Q = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
    const mixes = (toks: string[]): Rule[] => {
      const out: Rule[] = [];
      const rec = (i: number, left: number, acc: Rule) => {
        if (i === toks.length - 1) {
          const r = { ...acc, [toks[i]]: left };
          out.push(Object.fromEntries(Object.entries(r).filter(([, v]) => v > 0)));
          return;
        }
        for (const q of Q) if (q <= left) rec(i + 1, left - q, { ...acc, [toks[i]]: q });
      };
      rec(0, 1, {});
      return out.filter((r) => Object.keys(r).length > 0);
    };

    type Scored = { tag: string; libBad: number; libRecolor: number; total: number; detail: string[] };
    const scored: Scored[] = [];
    for (const newFace of mixes(["oldEdge", "oldVertex"]))
      for (const snubEdge of mixes(["oldFace", "oldEdge", "oldVertex"]))
        for (const newVertex of mixes(["oldVertex", "oldEdge"])) {
          const cand: SnubRules = { newFace, newEdge: { oldVertex: 1 }, snubEdge, newVertex };
          const L = await load({ snub: cand });
          let libBad = 0, total = 0, libRecolor = 0;
          const detail: string[] = [];
          for (const [name, e] of L.chains()) {
            const { out, real } = violations(L, e);
            const n = Object.keys(out).length;
            if (n) total++;
            if (!e.library) continue;
            if (n) { libBad++; detail.push(`      ${name}: ${JSON.stringify(out)}`); }
            const want = baseIdeal.get(name) as any[];
            const got = [counts(real.face), counts(real.vert), counts(real.edge)];
            if (!same(got, want)) {
              libRecolor++;
              detail.push(`      ${name}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
            }
          }
          const tag = `newFace=${JSON.stringify(newFace)} snubEdge=${JSON.stringify(snubEdge)} newVertex=${JSON.stringify(newVertex)}`;
          scored.push({ tag, libBad, libRecolor, total, detail });
        }

    // Rank by: (1) never recolor a library solid, (2) fewest violating chains overall.
    // (Every chain here is a solid the player can actually reach in ≤ 2 operations, and
    // the same named solid is reachable from either dual root — snub(ico) and snub(dodec)
    // are both the Snub Icosidodecahedron — so ALL of them ought to come out congruent.)
    scored.sort((a, b) => a.libRecolor - b.libRecolor || a.total - b.total || a.libBad - b.libBad);
    console.log(`\n=== SWEEP: ${scored.length} candidates, best first ===`);
    for (const s of scored.slice(0, 12))
      console.log(
        `   libRecolors=${s.libRecolor}  violatingChains=${s.total}  (of which library: ${s.libBad})\n      ${s.tag}`,
      );
  }, 3_600_000);
});
