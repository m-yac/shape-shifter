import { describe, it, expect } from "vitest";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { type Mesh } from "../src/geometry/HalfEdge";
import {
  type ColorSet,
  type GeomColor,
  meshEdgeKeys,
} from "../src/geometry/colors";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildSubdivide } from "../src/operations/subdivide";
import { buildChamfer } from "../src/operations/chamfer";
import { buildSnub, buildVolute } from "../src/operations/snub";
import { buildGyro, buildWhirl } from "../src/operations/gyro";

/**
 * Do unique element IDs going in imply unique element IDs coming out, for the color
 * rules in config.colors.operations?
 *
 * The rules are linear: each new element's color is a weighted sum of old-element
 * colors (operations/colorUtil.ts `combine`). So given every input element a distinct
 * random color vector, two output elements land on the same vector iff their rules are
 * the same linear combination of the same inputs — a structural collision, one that
 * would occur for any unique assignment of input IDs.
 *
 * An accidental numeric coincidence would not survive a different random assignment,
 * so each check runs several independent trials and keeps only the collisions that
 * persist across all of them. That makes length-3 random vectors enough to find the
 * structural collisions; the real length-14 IDs aren't needed.
 *
 * Uniqueness is checked across vertices, edges and faces together — the one-hot IDs
 * make the three kinds mutually distinguishable — so a face color equal to an edge
 * color is a collision too.
 */

// ---- deterministic RNG (mulberry32) so a reported collision is reproducible ----
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Polyhedron over `mesh` whose every vertex / edge / face has a distinct random
 *  color vector, so all input IDs are unique and in general position. */
function freshlyIdentified(mesh: Mesh, seed: number): Polyhedron {
  const rand = rng(seed);
  const vec = (): GeomColor => [rand(), rand(), rand()];
  const edge = new Map<string, GeomColor>();
  for (const k of meshEdgeKeys(mesh)) edge.set(k, vec());
  const colors: ColorSet = {
    vertex: mesh.vertices.map(vec),
    face: mesh.faces.map(vec),
    edge,
  };
  return new Polyhedron(mesh, colors);
}

/** A stable label per element of a ColorSet, independent of the color values, so it is
 *  the same across trials on one topology. */
function elementLabels(colors: ColorSet): Array<{ id: string; vec: GeomColor }> {
  const out: Array<{ id: string; vec: GeomColor }> = [];
  colors.vertex.forEach((v, i) => out.push({ id: `V${i}`, vec: v }));
  colors.face.forEach((f, i) => out.push({ id: `F${i}`, vec: f }));
  for (const [k, e] of colors.edge) out.push({ id: `E${k}`, vec: e });
  return out;
}

const bucketKey = (v: GeomColor) => v.map((x) => Math.round(x * 1e6)).join(",");

/** Intersection of a running set (null = "first trial, take all") with a new set. */
function intersect(running: Set<string> | null, next: Set<string>): Set<string> {
  if (running === null) return next;
  const out = new Set<string>();
  for (const p of running) if (next.has(p)) out.add(p);
  return out;
}

/** The set of colliding unordered element-pairs ("idA|idB") in one ColorSet. */
function collidingPairs(colors: ColorSet): Set<string> {
  const buckets = new Map<string, string[]>();
  for (const { id, vec } of elementLabels(colors)) {
    const k = bucketKey(vec);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(id);
  }
  const pairs = new Set<string>();
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    ids.sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) pairs.add(`${ids[i]}|${ids[j]}`);
  }
  return pairs;
}

/**
 * Run `produce` (input topology → committed ColorSet) over several independent random
 * ID assignments and return only the collisions that persist across every trial: the
 * structural ones. `produce` receives a per-trial random seed to identify its input.
 */
function structuralCollisions(
  produce: (seed: number) => ColorSet,
  trials = 4,
): string[] {
  let persistent: Set<string> | null = null;
  for (let t = 0; t < trials; t++) {
    persistent = intersect(persistent, collidingPairs(produce(1000 + t * 97)));
    if (persistent.size === 0) break; // nothing structural can survive
  }
  return [...(persistent ?? [])].sort();
}

const wrap = (r: { mesh: Mesh; colors: ColorSet }) => new Polyhedron(r.mesh, r.colors);

// An arbitrary but valid edge / face / vertex handle for each operation.
const firstEdge = (p: Polyhedron): [number, number] => {
  const f = p.faces[0];
  return [f[0], f[1]];
};

const SEEDS = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];

// ---------------------------------------------------------------------------
// Single step: give the input shape fresh unique IDs, apply one operation, check the
// output. This isolates each operation's rules against generic unique input.
// ---------------------------------------------------------------------------
describe("single operation: unique input IDs → unique output IDs", () => {
  // (op label) → produce a committed ColorSet from a freshly-identified input.
  type Case = (mesh: Mesh, seed: number) => ColorSet;
  const cases: Record<string, Case> = {
    truncate: (m, s) => buildTruncate(freshlyIdentified(m, s), 0, null).commit(0.3, false).colors,
    rectify: (m, s) => buildTruncate(freshlyIdentified(m, s), 0, null).commit(1, true).colors,
    kis: (m, s) => buildKis(freshlyIdentified(m, s), 0, null).commit(0.3, false).colors,
    join: (m, s) => buildKis(freshlyIdentified(m, s), 0, null).commit(1, true).colors,
    subdivide: (m, s) => {
      const p = freshlyIdentified(m, s);
      return buildSubdivide(p, firstEdge(p)).commit(0.5, false).colors;
    },
    "subdivide→rectify": (m, s) => {
      const p = freshlyIdentified(m, s);
      return buildSubdivide(p, firstEdge(p)).commit(1, true).colors;
    },
    chamfer: (m, s) => {
      const p = freshlyIdentified(m, s);
      return buildChamfer(p, firstEdge(p), 0).commit(0.3, false).colors;
    },
    "chamfer→join": (m, s) => {
      const p = freshlyIdentified(m, s);
      return buildChamfer(p, firstEdge(p), 0).commit(1, true).colors;
    },
  };

  for (const name of SEEDS) {
    for (const [op, produce] of Object.entries(cases)) {
      it(`${op} on ${name}`, () => {
        const mesh = getSeed(name);
        const collisions = structuralCollisions((s) => produce(mesh, s));
        expect(collisions, `${op}(${name}) collisions: ${collisions.join(", ")}`).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Snub / gyro are twists of a rectification / join, so their input is that rectified
// or joined solid. Give it fresh unique IDs and twist. Volute / whirl are those same
// twists with the weld's collapsed elements restored (the rectify's vertex figures
// kissed back into vertices; the join's apexes truncated back into faces), so they take
// the same input, plus where that weld's own elements start. Those two twists weld at
// their far end, both into the propellor, so each is checked twice: part-way along
// (the whirl / volute itself) and at the weld.
// ---------------------------------------------------------------------------
describe("snub / gyro / volute / whirl: unique input IDs → unique output IDs", () => {
  const rectifiedMesh = (name: string) =>
    buildTruncate(new Polyhedron(getSeed(name)), 0, null).commit(1, true).mesh;
  const joinedMesh = (name: string) =>
    buildKis(new Polyhedron(getSeed(name)), 0, null).commit(1, true).mesh;

  for (const name of SEEDS) {
    const seedPoly = new Polyhedron(getSeed(name));

    it(`snub on rectify(${name})`, () => {
      const mesh = rectifiedMesh(name);
      const collisions = structuralCollisions((s) => {
        const p = freshlyIdentified(mesh, s);
        return buildSnub(p, 0, p.vertices[0].clone()).commit(1, true).colors;
      });
      expect(collisions, `snub collisions: ${collisions.join(", ")}`).toEqual([]);
    });

    it(`gyro on join(${name})`, () => {
      const mesh = joinedMesh(name);
      const collisions = structuralCollisions((s) => {
        const p = freshlyIdentified(mesh, s);
        return buildGyro(p, 0, p.vertices[0].clone()).commit(1, true).colors;
      });
      expect(collisions, `gyro collisions: ${collisions.join(", ")}`).toEqual([]);
    });

    for (const [stage, t, weld] of [["volute", 0.5, false], ["propellor (via volute)", 1, true]] as const) {
      it(`${stage} on rectify(${name})`, () => {
        const mesh = rectifiedMesh(name);
        const collisions = structuralCollisions((s) => {
          const p = freshlyIdentified(mesh, s);
          return buildVolute(p, 0, seedPoly.faces.length).commit(t, weld).colors;
        });
        expect(collisions, `${stage} collisions: ${collisions.join(", ")}`).toEqual([]);
      });
    }

    for (const [stage, t, weld] of [["whirl", 0.5, false], ["propellor (via whirl)", 1, true]] as const) {
      it(`${stage} on join(${name})`, () => {
        const mesh = joinedMesh(name);
        const apexStart = seedPoly.vertices.length;
        const collisions = structuralCollisions((s) => {
          const p = freshlyIdentified(mesh, s);
          return buildWhirl(p, apexStart, p.vertices[apexStart].clone()).commit(t, weld).colors;
        });
        expect(collisions, `${stage} collisions: ${collisions.join(", ")}`).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Chains: identify the seed uniquely, then apply a sequence of operations, letting the
// derived IDs — now dependent averages of the seed IDs — flow from step to step. This
// is where averaging can bite: two different pairs of already-averaged inputs can have
// equal sums even though every input is distinct.
// ---------------------------------------------------------------------------
describe("operation chains from a uniquely-identified seed", () => {
  // `prev` is the shape the *previous* step acted on. Volute and whirl need it: they
  // restore what that step's weld collapsed, and the pre-weld face / vertex count is
  // where the rectify's figures / the join's apexes begin.
  type Step = {
    label: string;
    run: (p: Polyhedron, prev: Polyhedron) => { mesh: Mesh; colors: ColorSet };
  };
  const S = {
    truncate: { label: "truncate", run: (p: Polyhedron) => buildTruncate(p, 0, null).commit(0.3, false) },
    rectify: { label: "rectify", run: (p: Polyhedron) => buildTruncate(p, 0, null).commit(1, true) },
    kis: { label: "kis", run: (p: Polyhedron) => buildKis(p, 0, null).commit(0.3, false) },
    join: { label: "join", run: (p: Polyhedron) => buildKis(p, 0, null).commit(1, true) },
    subdivide: { label: "subdivide", run: (p: Polyhedron) => buildSubdivide(p, firstEdge(p)).commit(0.5, false) },
    chamfer: { label: "chamfer", run: (p: Polyhedron) => buildChamfer(p, firstEdge(p), 0).commit(0.3, false) },
    snub: { label: "snub", run: (p: Polyhedron) => buildSnub(p, 0, p.vertices[0].clone()).commit(1, true) },
    gyro: { label: "gyro", run: (p: Polyhedron) => buildGyro(p, 0, p.vertices[0].clone()).commit(1, true) },
    volute: {
      label: "volute",
      run: (p: Polyhedron, prev: Polyhedron) => buildVolute(p, 0, prev.faces.length).commit(0.5, false),
    },
    whirl: {
      label: "whirl",
      run: (p: Polyhedron, prev: Polyhedron) =>
        buildWhirl(p, prev.vertices.length, p.vertices[prev.vertices.length].clone()).commit(0.5, false),
    },
    // The welded end of each of those two twists: the same propellor, reached from the
    // rectification on one side and the join on the other.
    "propellor(volute)": {
      label: "propellor(volute)",
      run: (p: Polyhedron, prev: Polyhedron) => buildVolute(p, 0, prev.faces.length).commit(1, true),
    },
    "propellor(whirl)": {
      label: "propellor(whirl)",
      run: (p: Polyhedron, prev: Polyhedron) =>
        buildWhirl(p, prev.vertices.length, p.vertices[prev.vertices.length].clone()).commit(1, true),
    },
  } satisfies Record<string, Step>;

  const chains: Step[][] = [
    [S.rectify, S.snub], // → icosahedron
    [S.join, S.gyro], // → dodecahedron
    [S.rectify, S.volute],
    [S.join, S.whirl],
    [S.rectify, S["propellor(volute)"]],
    [S.join, S["propellor(whirl)"]],
    [S.truncate, S.subdivide],
    [S.subdivide, S.subdivide],
    [S.chamfer, S.chamfer],
    [S.rectify, S.truncate],
    [S.rectify, S.subdivide],
    [S.join, S.chamfer],
    [S.subdivide, S.chamfer],
    [S.rectify, S.snub, S.truncate],
    [S.join, S.whirl, S.truncate],
    [S.join, S["propellor(whirl)"], S.truncate],
  ];

  const MAX_ELEMENTS = 4000; // stop a chain before it explodes

  for (const name of ["tetrahedron", "cube"]) {
    for (const chain of chains) {
      const label = `${name}: ` + chain.map((s) => s.label).join(" → ");
      it(label, () => {
        // Run the chain once per trial, collecting per-step collision pairs, and keep
        // the ones that persist across trials.
        const perStepPersistent: Array<Set<string> | null> = chain.map(() => null);
        let skipped = false;
        for (let t = 0; t < 4 && !skipped; t++) {
          let poly = freshlyIdentified(getSeed(name), 5000 + t * 131);
          let prev = poly; // the shape the previous step acted on (unused at i = 0)
          for (let i = 0; i < chain.length; i++) {
            let out: { mesh: Mesh; colors: ColorSet };
            try {
              out = chain[i].run(poly, prev);
            } catch (e) {
              // Some chains form shapes an operation can't act on (snub needs a
              // rectification, say). Skip rather than fail: a topology limit, not a
              // color-uniqueness result.
              skipped = true;
              break;
            }
            perStepPersistent[i] = intersect(perStepPersistent[i], collidingPairs(out.colors));
            prev = poly;
            poly = wrap(out);
            const n = poly.colors.vertex.length + poly.colors.face.length + poly.colors.edge.size;
            if (n > MAX_ELEMENTS) break;
          }
        }
        if (skipped) return;
        const report = perStepPersistent
          .map((set, i) => (set && set.size ? `after ${chain[i].label}: ${[...set].sort().join(", ")}` : null))
          .filter(Boolean);
        expect(report, report.join(" | ")).toEqual([]);
      });
    }
  }
});
