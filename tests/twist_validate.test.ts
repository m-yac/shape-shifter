import { describe, it, expect } from "vitest";
import { Ray, Vector3 } from "three";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron, newellNormal } from "../src/geometry/polyhedron";
import { buildDCEL, counts } from "../src/geometry/HalfEdge";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildChamfer } from "../src/operations/chamfer";
import { buildSnub, buildVolute } from "../src/operations/snub";
import { buildGyro, buildWhirl } from "../src/operations/gyro";
import { buildSubdivide } from "../src/operations/subdivide";
import { computeSignature } from "../src/identify/configurations";
import { collapse, paletteSwatch, type ColorSet } from "../src/geometry/colors";

const seed = (n: string) => new Polyhedron(getSeed(n));
const sig = (mesh: { vertices: any; faces: number[][] }) => computeSignature(buildDCEL(mesh));

const PLATONICS = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];

describe("staged truncate/kis", () => {
  it("cube: t=0.5 = truncated cube, t=1 = cuboctahedron", () => {
    const t = buildTruncate(seed("cube"), 0, null);
    expect(sig(t.commit(0.5, false).mesh)).toMatchObject({ V: 24, E: 36, F: 14 });
    expect(sig(t.commit(1, true).mesh)).toMatchObject({ V: 12, E: 24, F: 14 });
  });
  it("cube: kis t=1 = rhombic dodecahedron", () => {
    expect(sig(buildKis(seed("cube"), 0, null).commit(1, true).mesh)).toMatchObject({ V: 14, E: 24, F: 12 });
  });
});

describe("snub twist (extends a rectification)", () => {
  const rectify = (s: string) => new Polyhedron(buildTruncate(seed(s), 0, null).commit(1, true).mesh);
  it("rectify(tetra)=octahedron -> snub -> icosahedron", () => {
    const R = rectify("tetrahedron");
    const s = sig(buildSnub(R, 0, R.vertices[0].clone()).commit(1, false).mesh);
    expect(s).toMatchObject({ V: 12, E: 30, F: 20 });
    expect(s.vertexConfigs).toEqual({ "3.3.3.3.3": 12 });
    expect(s.faceConfigs).toEqual({ "5.5.5": 20 });
  });
  it("rectify(cube)=cuboctahedron -> snub -> snub cube", () => {
    const R = rectify("cube");
    const c = counts(buildDCEL(buildSnub(R, 0, R.vertices[0].clone()).commit(1, false).mesh));
    expect(c).toEqual({ V: 24, E: 60, F: 38 });
  });

  // The snub hangs two straight handles off the rectify vertex the drag ended on, one per
  // chirality, at ±45° about the line back down the drag — so 90° apart, and both reachable.
  // They are placed by which side of that line each chirality's split-slide falls on, so a
  // line that doesn't truly lie between the two slides puts both handles in the same place:
  // the drag then shows one line where there should be two, and the chirality it can't reach
  // is the one whose slides get twisted around into a self-intersecting snub.
  PLATONICS.forEach((name) => {
    it(`snub(${name}): the two chiral handles are distinct and 90° apart`, () => {
      const P = seed(name);
      const origin = P.vertices[0].clone();
      const R = new Polyhedron(buildTruncate(P, 0, null).commit(1, true).mesh);
      // The drag ends on the rectify vertex of an edge at the vertex it collapsed: the
      // nearest one to where that vertex stood.
      let rVid = 0;
      R.vertices.forEach((p, i) => {
        if (p.distanceTo(origin) < R.vertices[rVid].distanceTo(origin)) rVid = i;
      });
      const plan = buildSnub(R, rVid, origin);
      const V = R.vertices[rVid];

      // Sweep the cursor around the rectify vertex, as a drag veering off it does: rays
      // straight down its radial, aimed at a ring of points in its tangent plane. `snap`
      // hands back the nearer handle, so every distinct line it returns is one the drag
      // can actually reach.
      const n = V.clone().normalize();
      const u = new Vector3(0, 0, 1).cross(n);
      if (u.lengthSq() < 1e-6) u.copy(new Vector3(1, 0, 0).cross(n));
      u.normalize();
      const w = new Vector3().crossVectors(n, u);
      const ends = new Map<string, Vector3>(); // chirality -> that handle's far end
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * 2 * Math.PI;
        const target = V.clone()
          .addScaledVector(u, 0.3 * Math.cos(a))
          .addScaledVector(w, 0.3 * Math.sin(a));
        const ray = new Ray(target.clone().addScaledVector(n, 5), n.clone().negate());
        const hit = plan.snap(ray);
        ends.set(plan.chirality!(), hit.highlight!.b.clone());
      }

      expect([...ends.keys()].sort()).toEqual(["L", "R"]);
      const dirs = ["L", "R"].map((c) => ends.get(c)!.clone().sub(V).normalize());
      const deg = (Math.acos(Math.max(-1, Math.min(1, dirs[0].dot(dirs[1])))) * 180) / Math.PI;
      expect(deg).toBeGreaterThan(80);
      expect(deg).toBeLessThan(100);
    });
  });
});

describe("gyro twist (extends a join)", () => {
  const join = (s: string) => new Polyhedron(buildKis(seed(s), 0, null).commit(1, true).mesh);
  it("join(tetra)=cube -> gyro -> dodecahedron", () => {
    const J = join("tetrahedron");
    const s = sig(buildGyro(J, 0, J.vertices[0].clone()).commit(1, true).mesh);
    expect(s).toMatchObject({ V: 20, E: 30, F: 12 });
    expect(s.vertexConfigs).toEqual({ "5.5.5": 20 });
    expect(s.faceConfigs).toEqual({ "3.3.3.3.3": 12 });
  });
  it("join(cube)=rhombic dodeca -> gyro -> pentagonal icositetrahedron", () => {
    const J = join("cube");
    const c = counts(buildDCEL(buildGyro(J, 0, J.vertices[0].clone()).commit(1, true).mesh));
    expect(c).toEqual({ V: 38, E: 60, F: 24 });
  });
});

// Whirl and volute are those same two twists with the weld's collapsed elements put back:
// the whirl truncates the join's apexes into the faces they came from, the volute kisses
// the rectify's vertex figures back into the vertices they came from. Both are standard
// Conway operators — whirl is `w`, volute is its dual `dwd` — so their element counts are
// forced: whirl(P) has V+4E vertices, 7E edges, F+2E faces (the originals plus two hexagons
// per edge), and volute(P) is exactly its dual, which the last describe checks directly.
//
// Both run out to a weld at t=1 (the propellor), so an un-welded commit part-way along the
// twist is what gives the whirl / volute themselves; t=1 is checked separately below.
const MID = 0.5;

// Whirl extends a chamfer's Join: the join's apexes are one per original face, appended
// after the original vertices, so the original vertex count is where they start.
const whirlPlan = (s: string) => {
  const V = seed(s).vertices.length;
  const J = new Polyhedron(buildKis(seed(s), 0, null).commit(1, true).mesh);
  return buildWhirl(J, V, J.vertices[V].clone());
};

// Volute extends a subdivide's Rectify: its figures are one per original vertex, appended
// after the original faces, so the original face count is where they start. Built from the
// subdivide's own weld, the way the drag reaches it — that rectification is the inflated
// one, which is what the volute's rescale rewinds.
const volutePlan = (s: string) => {
  const P = seed(s);
  const R = new Polyhedron(buildSubdivide(P, [P.faces[0][0], P.faces[0][1]]).commit(1, true).mesh);
  return buildVolute(R, 0, P.faces.length);
};

describe("whirl twist (extends a chamfer)", () => {
  it("whirl(cube) = the 6 original squares + 2 hexagons per edge", () => {
    const s = sig(whirlPlan("cube").commit(MID, false).mesh);
    expect(s).toMatchObject({ V: 56, E: 84, F: 30 });
    expect(s.faceConfigs).toEqual({ "3.3.3.3": 6, "3.3.3.3.3.3": 24 });
  });

  // The drag actually reaches the whirl through a *chamfer's* weld, not a kis's, and that
  // one welds by merging each face's inset corners (weld.ts renumbers as it compacts).
  // Whirl reads the apexes off the vertex count alone, so this pins the ordering that
  // relies on: original vertices first, then one apex per original face, in face order.
  for (const name of PLATONICS) {
    it(`chamfer's join of ${name} orders apexes the same way kis's does`, () => {
      const P = seed(name);
      const viaKis = buildKis(P, 0, null).commit(1, true).mesh;
      const viaChamfer = buildChamfer(P, [P.faces[0][0], P.faces[0][1]], 0).commit(1, true).mesh;
      expect(viaChamfer.vertices.length).toBe(viaKis.vertices.length);
      for (let i = 0; i < viaKis.vertices.length; i++) {
        expect(viaChamfer.vertices[i].distanceTo(viaKis.vertices[i])).toBeLessThan(1e-9);
      }
      // …so the whirl built on it is the same shape either way.
      const V = P.vertices.length;
      const J = new Polyhedron(viaChamfer);
      const w = buildWhirl(J, V, J.vertices[V].clone()).commit(MID, false).mesh;
      expect(sig(w)).toEqual(sig(whirlPlan(name).commit(MID, false).mesh));
    });
  }

  for (const name of PLATONICS) {
    it(`whirl(${name}) = V+4E, 7E, F+2E`, () => {
      const P = seed(name);
      const [V, E, F] = [P.vertices.length, counts(P.dcel).E, P.faces.length];
      const m = whirlPlan(name).commit(MID, false).mesh;
      expect(counts(buildDCEL(m))).toEqual({ V: V + 4 * E, E: 7 * E, F: F + 2 * E });
    });
  }
});

describe("volute twist (extends a subdivide)", () => {
  it("volute(cube) = the 6 original squares + a fan and a gap triangle per edge", () => {
    const s = sig(volutePlan("cube").commit(MID, false).mesh);
    expect(s).toMatchObject({ V: 32, E: 84, F: 54 });
    // The 6 squares, then 24 corner-fan triangles (one degree-3 corner: the restored cube
    // vertex) and 24 snub gap triangles (all-degree-6 corners).
    expect(s.faceConfigs).toEqual({ "6.6.6.6": 6, "3.6.6": 24, "6.6.6": 24 });
  });

  for (const name of PLATONICS) {
    it(`volute(${name}) = V+2E, 7E, F+4E`, () => {
      const P = seed(name);
      const [V, E, F] = [P.vertices.length, counts(P.dcel).E, P.faces.length];
      const m = volutePlan(name).commit(MID, false).mesh;
      expect(counts(buildDCEL(m))).toEqual({ V: V + 2 * E, E: 7 * E, F: F + 4 * E });
    });

    // The volute raises each kis apex straight out of its vertex figure: it starts flush in
    // the figure's plane, so the un-twisted rectify still reads as one flat face, and rises
    // along that plane's outward normal as the twist runs — never inward, which would dimple
    // the corner. The apexes are the last `V` vertices, the kis appending one per figure face.
    it(`volute(${name}) raises each apex out of its figure's plane`, () => {
      const P = seed(name);
      const plan = volutePlan(name);
      const [at0, at1] = [plan.positions(0), plan.positions(1)];
      const apexStart = at0.length - P.vertices.length;

      // Each apex's figure ring: its neighbours across the fan triangles it caps.
      const ring = new Map<number, Set<number>>();
      for (const f of plan.previewFaces) {
        const apex = f.find((i) => i >= apexStart);
        if (apex === undefined) continue;
        const r = ring.get(apex) ?? ring.set(apex, new Set()).get(apex)!;
        for (const i of f) if (i !== apex) r.add(i);
      }
      expect(ring.size).toBe(P.vertices.length);

      // Height of the apex above the plane of its ring, at either end of the twist.
      const heightIn = (verts: Vector3[], apex: number) => {
        const pts = [...ring.get(apex)!].map((i) => verts[i]);
        const c = new Vector3();
        for (const p of pts) c.add(p);
        c.multiplyScalar(1 / pts.length);
        const n = newellNormal(pts);
        if (n.dot(c) < 0) n.negate(); // outward (solid centred at the origin)
        return verts[apex].clone().sub(c).dot(n);
      };

      for (let i = apexStart; i < at0.length; i++) {
        const scale = at0[i].length();
        expect(Math.abs(heightIn(at0, i))).toBeLessThan(1e-9 * scale); // flush at rest
        expect(heightIn(at1, i)).toBeGreaterThan(1e-3 * scale); // risen outward, not in
      }
    });
  }
});

// The sharpest check that these are the operators they claim to be: whirl is Conway's `w`
// and volute is its dual `dwd`, so a volute and the whirl of the dual solid must be dual
// polyhedra — V↔F, and the configuration strings swapped wholesale, since a face
// configuration is the degrees around a face and a vertex configuration the face sizes
// around a vertex. Neither side knows anything about the other's construction.
describe("volute is the dual of whirl", () => {
  const DUALS: Array<[string, string]> = [
    ["tetrahedron", "tetrahedron"],
    ["cube", "octahedron"],
    ["dodecahedron", "icosahedron"],
  ];
  for (const [a, b] of DUALS) {
    for (const [x, y] of [[a, b], [b, a]]) {
      it(`volute(${x}) is dual to whirl(${y})`, () => {
        const v = sig(volutePlan(x).commit(MID, false).mesh);
        const w = sig(whirlPlan(y).commit(MID, false).mesh);
        expect([v.V, v.E, v.F]).toEqual([w.F, w.E, w.V]);
        expect(v.vertexConfigs).toEqual(w.faceConfigs);
        expect(v.faceConfigs).toEqual(w.vertexConfigs);
      });
    }
  }
});

// Both twists weld at t=1, and both weld into the same thing: the propellor, Conway's `p`
// — the solid's own faces, rotated, with two quads per edge filling in around them
// (V+2E, 5E, F+2E). The whirl arrives at it by running each apex cut out onto the gyro
// vertex it was heading for; the volute by raising each fan flush with the gap triangle
// beside it. They meet there because `p` is its own dual (dpd = p), and the whirl reaches
// it through the join while the volute reaches it through the rectification: `w` welds to
// `p`, so `dwd` welds to `dpd`, which is `p` again.
describe("propellor (the weld both twists run into)", () => {
  it("propellor(cube) = the 6 rotated squares + 2 quads per edge", () => {
    const s = sig(whirlPlan("cube").commit(1, true).mesh);
    expect(s).toMatchObject({ V: 32, E: 60, F: 30 });
    // Each square is ringed by degree-4 vertices; each quad has one corner at a restored
    // cube vertex (degree 3) and three at degree-4 ones.
    expect(s.faceConfigs).toEqual({ "4.4.4.4": 6, "3.4.4.4": 24 });
    expect(s.vertexConfigs).toEqual({ "4.4.4": 8, "4.4.4.4": 24 });
  });

  for (const name of PLATONICS) {
    it(`whirl(${name}) and volute(${name}) weld into the same propellor`, () => {
      const P = seed(name);
      const [V, E, F] = [P.vertices.length, counts(P.dcel).E, P.faces.length];
      const w = sig(whirlPlan(name).commit(1, true).mesh);
      const v = sig(volutePlan(name).commit(1, true).mesh);
      expect(w).toMatchObject({ V: V + 2 * E, E: 5 * E, F: F + 2 * E });
      expect(v).toEqual(w);
    });
  }

  // `p` is dual-invariant, so a propellor and the propellor of the dual solid are duals.
  for (const [x, y] of [["cube", "octahedron"], ["dodecahedron", "icosahedron"]]) {
    it(`propellor(${x}) is dual to propellor(${y})`, () => {
      const a = sig(whirlPlan(x).commit(1, true).mesh);
      const b = sig(whirlPlan(y).commit(1, true).mesh);
      expect([a.V, a.E, a.F]).toEqual([b.F, b.E, b.V]);
      expect(a.vertexConfigs).toEqual(b.faceConfigs);
      expect(a.faceConfigs).toEqual(b.vertexConfigs);
    });
  }
});

// The propellor isn't just the same shape from either twist — it is the same *coloring*.
// A propellor is self-dual, so its color rules must be symmetric under face↔vertex, keyed
// to the root solid X: the whirl reaches it off X's join (the dual side), the volute off
// X's rectification (the primal side), and the two used to disagree (each colored a new
// face the way the other colored a new vertex). `recolorPropellor` fixes both to the same
// X-keyed result. These helpers preserve colors through the chain (the earlier `*Plan`
// helpers reseed, since they only check topology), and the fingerprint is order-independent
// — the multiset of (element degree → swatch + provenance triple) — so it catches a
// per-element color difference without depending on how either twist orders its output.
describe("whirl and volute weld into an identically-colored propellor", () => {
  const swatchKey = (c: readonly number[]) =>
    `${paletteSwatch(c)}[${collapse(c).map((x) => x.toFixed(3)).join(",")}]`;
  const fingerprint = (mesh: { vertices: Vector3[]; faces: number[][] }, colors: ColorSet) => {
    const vdeg = new Array(mesh.vertices.length).fill(0);
    for (const f of mesh.faces) for (const v of f) vdeg[v]++;
    const bag = new Map<string, number>();
    const add = (s: string) => bag.set(s, (bag.get(s) ?? 0) + 1);
    mesh.faces.forEach((f, i) => add(`F${f.length}:${swatchKey(colors.face[i])}`));
    colors.vertex.forEach((c, i) => add(`V${vdeg[i]}:${swatchKey(c)}`));
    for (const [k, c] of colors.edge) {
      const [a, b] = k.split("_").map(Number);
      add(`E${[vdeg[a], vdeg[b]].sort((x, y) => x - y).join("-")}:${swatchKey(c)}`);
    }
    return [...bag.entries()].sort().map(([s, n]) => `${n}x ${s}`).join("\n");
  };
  const whirlP = (s: string) => {
    const P = seed(s);
    const j = buildKis(P, 0, null).commit(1, true);
    const J = new Polyhedron(j.mesh, j.colors);
    return buildWhirl(J, P.vertices.length, J.vertices[P.vertices.length].clone()).commit(1, true);
  };
  const voluteP = (s: string) => {
    const P = seed(s);
    const r = buildSubdivide(P, [P.faces[0][0], P.faces[0][1]]).commit(1, true);
    const R = new Polyhedron(r.mesh, r.colors);
    return buildVolute(R, 0, P.faces.length).commit(1, true);
  };
  for (const name of PLATONICS) {
    it(name, () => {
      const w = whirlP(name);
      const v = voluteP(name);
      expect(fingerprint(v.mesh, v.colors)).toEqual(fingerprint(w.mesh, w.colors));
    });
  }
});

// Max distance of a face's vertices from their best-fit (Newell normal + centroid)
// plane, in units of the face's mean edge length. 0 for a planar face.
function nonPlanarity(verts: Vector3[], face: number[]): number {
  const c = new Vector3();
  for (const i of face) c.add(verts[i]);
  c.multiplyScalar(1 / face.length);
  const nrm = new Vector3();
  for (let i = 0; i < face.length; i++) {
    const a = verts[face[i]], b = verts[face[(i + 1) % face.length]];
    nrm.x += (a.y - b.y) * (a.z + b.z);
    nrm.y += (a.z - b.z) * (a.x + b.x);
    nrm.z += (a.x - b.x) * (a.y + b.y);
  }
  if (nrm.lengthSq() < 1e-20) return 0;
  nrm.normalize();
  let maxd = 0, edge = 0;
  for (let i = 0; i < face.length; i++) {
    maxd = Math.max(maxd, Math.abs(verts[face[i]].clone().sub(c).dot(nrm)));
    edge += verts[face[i]].distanceTo(verts[face[(i + 1) % face.length]]);
  }
  edge /= face.length;
  return edge > 1e-9 ? maxd / edge : 0;
}

// The gyro splits each join quad into pentagons; only the t=1 end is exactly planar,
// but gyro.ts's `liftExponent` schedule advances the lift ahead of the slide so the
// intermediate faces stay near-planar rather than creasing along the old join edges.
describe("gyro faces stay ~planar through the drag", () => {
  const join = (s: string) => new Polyhedron(buildKis(seed(s), 0, null).commit(1, true).mesh);
  for (const s of PLATONICS) {
    it(`join(${s})`, () => {
      const J = join(s);
      const plan = buildGyro(J, 0, J.vertices[0].clone());
      const faces = plan.commit(1, true).mesh.faces;
      let worst = 0;
      for (let t = 0.05; t < 1; t += 0.05) {
        const P = plan.positions(t);
        for (const f of faces) if (f.length > 3) worst = Math.max(worst, nonPlanarity(P, f));
      }
      // Under 2% of edge length everywhere. A linear lift (∝ t) instead creases the
      // sharp cube join at ~4.4%.
      expect(worst).toBeLessThan(0.02);
    });
  }
});

// The whirl inherits that planarity: each cut rides out along an apex's own gyro edge, so
// the two cuts replacing a pentagon's apex corner land on that pentagon's two edges and
// the hexagon lies in the plane gyro already flattened. (Cutting back down the join edge
// toward the original vertex instead — where the chamfer's inset seam sat — leaves the
// cuts off that plane and bends the hexagons by up to 17% of an edge.)
describe("whirl faces stay ~planar through the drag", () => {
  for (const s of PLATONICS) {
    it(`chamfer→join(${s})`, () => {
      const V = seed(s).vertices.length;
      const J = new Polyhedron(buildKis(seed(s), 0, null).commit(1, true).mesh);
      const plan = buildWhirl(J, V, J.vertices[V].clone());
      const faces = plan.previewFaces; // the whirl's own; t=1 welds them into the propellor
      let worst = 0;
      for (let t = 0.05; t < 1; t += 0.05) {
        const P = plan.positions(t);
        for (const f of faces) if (f.length > 3) worst = Math.max(worst, nonPlanarity(P, f));
      }
      expect(worst).toBeLessThan(0.02);
    });
  }
});
