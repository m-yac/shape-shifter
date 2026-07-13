import { type Polyhedron } from "../geometry/polyhedron";
import { type MarkerKind } from "../render/sceneView";
import { type OperationKind } from "./types";
import { type HistoryEntry } from "../history/history";
import { vertexConfig, faceConfig, formatConfig } from "../identify/configurations";
import { config } from "../config";

/**
 * How an operation's selection relates to the solid it acted on:
 *   "whole"  — every vertex/face of its kind, or no explicit selection;
 *   "arity"  — one or more complete arity classes (every degree-n vertex / n-gon face);
 *              `arities` lists those arities, sorted;
 *   "subset" — any other set, broken down per vertex/face figure (configuration).
 *
 * The reachable selections (with `commandAddsToSelection` off) map to these as:
 *   default drag → one complete arity class; Option-add → a union of them ("arity");
 *   Command → a single element ("subset" with one count-1 group).
 */
export type SelDesc =
  | { kind: "whole" }
  | { kind: "arity"; arities: number[] }
  | { kind: "subset"; groups: SubsetGroup[] };

/** One figure (vertex/face configuration) group within a "subset" selection. */
export interface SubsetGroup {
  /** How many selected elements share this figure. */
  count: number;
  /** The arity (vertex degree / face side-count) of this figure. */
  degree: number;
  /** Canonical configuration key (e.g. "3.6.6"), for the figure token. */
  config: string;
  /** True when the arity alone identifies the figure on the whole solid (every
   *  element of this degree shares one configuration), so the name can use the bare
   *  arity number ("4") instead of the full configuration ("3.6²"). */
  degreeDetermines: boolean;
}

/** The operation that produced a history entry (null for the seed root). Carries
 *  everything needed to build the entry's label and derived name. */
export interface OpDescriptor {
  kind: OperationKind;
  /** True at the welded max end (rectify / join, or a full snub / gyro). */
  weld: boolean;
  /** What the operation acted on (against the pre-operation shape). */
  sel: SelDesc;
  /** Handedness of a chiral op (snub / gyro), so the two enantiomorphs name apart. */
  chirality?: "R" | "L";
}

/** Per-vertex degree (incident-face count = edge count on a closed solid). */
function vertexDegrees(poly: Polyhedron): number[] {
  const deg = new Array<number>(poly.vertices.length).fill(0);
  for (const f of poly.faces) for (const i of f) deg[i]++;
  return deg;
}

/**
 * Classify a selection against the solid it acts on. A selection is "arity" when
 * every arity it touches is fully covered; otherwise it is a "subset" described by
 * figure (configuration) groups.
 */
export function classifySelection(
  poly: Polyhedron,
  sel: Set<number> | null,
  kind: MarkerKind,
): SelDesc {
  const onFaces = kind === "face";
  const elemCount = onFaces ? poly.faces.length : poly.vertices.length;
  if (sel === null || sel.size === 0 || sel.size === elemCount) {
    return { kind: "whole" };
  }

  const dcel = poly.dcel;
  const degrees = onFaces ? null : vertexDegrees(poly);
  const arityOf = (id: number): number =>
    onFaces ? poly.faces[id].length : degrees![id];
  const configOf = (id: number): string =>
    onFaces ? faceConfig(dcel, id) : vertexConfig(dcel, id);

  // How many elements of each arity exist in the whole solid, and which configs
  // each arity carries (so we know when the arity number alone names the figure).
  const totalByArity = new Map<number, number>();
  const configsByArity = new Map<number, Set<string>>();
  for (let id = 0; id < elemCount; id++) {
    const a = arityOf(id);
    totalByArity.set(a, (totalByArity.get(a) ?? 0) + 1);
    let set = configsByArity.get(a);
    if (!set) configsByArity.set(a, (set = new Set()));
    set.add(configOf(id));
  }

  // … and how many are selected per arity.
  const selByArity = new Map<number, number>();
  for (const id of sel) {
    const a = arityOf(id);
    selByArity.set(a, (selByArity.get(a) ?? 0) + 1);
  }

  // Every touched arity fully covered → a union of complete arity classes.
  let fullArity = true;
  for (const [a, n] of selByArity) {
    if (n !== totalByArity.get(a)) {
      fullArity = false;
      break;
    }
  }
  if (fullArity) {
    return { kind: "arity", arities: [...selByArity.keys()].sort((x, y) => x - y) };
  }

  // Otherwise group the selected elements by figure (configuration).
  const byConfig = new Map<string, { count: number; degree: number }>();
  for (const id of sel) {
    const c = configOf(id);
    const g = byConfig.get(c);
    if (g) g.count++;
    else byConfig.set(c, { count: 1, degree: arityOf(id) });
  }
  const groups: SubsetGroup[] = [...byConfig.entries()].map(([config, g]) => ({
    count: g.count,
    degree: g.degree,
    config,
    degreeDetermines: configsByArity.get(g.degree)!.size === 1,
  }));
  groups.sort((a, b) => a.degree - b.degree || (a.config < b.config ? -1 : a.config > b.config ? 1 : 0));
  return { kind: "subset", groups };
}

/** "vertex"/"vertices" or "face"/"faces" agreeing with `n`. */
function noun(kind: MarkerKind, n: number): string {
  if (kind === "face") return n === 1 ? "face" : "faces";
  return n === 1 ? "vertex" : "vertices";
}

/** The marker kind an operation acts on (truncate/snub on vertices, kis/gyro on faces). */
function kindFor(op: OperationKind): MarkerKind {
  return op === "kis" || op === "gyro" ? "face" : "vertex";
}

/** The base `[label, name]` verb pair for an operation in a given weld. */
function verbs(kind: OperationKind, weld: boolean): readonly [string, string] {
  return config.ui.operationLabels[kind][weld ? "welded" : "unwelded"];
}

/** The short figure token for the derived name: the bare arity ("4") when the degree pins
 *  the figure, else the parenthesized configuration ("(3.6²)"). */
function shortToken(g: SubsetGroup): string {
  return g.degreeDetermines ? String(g.degree) : `(${formatConfig(g.config)})`;
}

/** Apply the selection qualifier to a base verb for the derived name (short form). */
function qualifyName(verb: string, sel: SelDesc): string {
  if (sel.kind === "whole") return verb;
  if (sel.kind === "arity") return `${sel.arities.join(",")}-${verb}`;
  return `${verb} (${sel.groups.map((g) => `${g.count}×${shortToken(g)}`).join(", ")})`;
}

/** One verbose figure phrase for the HISTORY label, e.g. "1× degree-3 vertex",
 *  "2× 5-gon faces", or "1×(4.5³)" when the configuration is needed. */
function longGroup(g: SubsetGroup, kind: MarkerKind): string {
  if (g.degreeDetermines) {
    const shape = kind === "face" ? `${g.degree}-gon` : `degree-${g.degree}`;
    return `${g.count}× ${shape} ${noun(kind, g.count)}`;
  }
  return `${g.count}×(${formatConfig(g.config)})`;
}

/** Apply the selection qualifier to a base verb for the HISTORY label (verbose form). */
function qualifyLabel(verb: string, sel: SelDesc, kind: MarkerKind): string {
  if (sel.kind === "whole") return verb;
  if (sel.kind === "arity") return `${sel.arities.join(",")}-${verb}`;
  return `${verb} ${sel.groups.map((g) => longGroup(g, kind)).join(", ")}`;
}

/** Append the chirality suffix (snub / gyro) when present. */
function withChirality(s: string, chirality: "R" | "L" | undefined): string {
  return chirality ? `${s} (${chirality})` : s;
}

/**
 * The action label for a committed operation, shown in the HISTORY rows
 * (e.g. "Rectify", "2,3-Truncate", "Kis 1× degree-3 vertex (R)").
 */
export function operationLabel(op: OpDescriptor): string {
  const [labelVerb] = verbs(op.kind, op.weld);
  return withChirality(qualifyLabel(labelVerb, op.sel, kindFor(op.kind)), op.chirality);
}

/** The modifier prepended to an ancestor's name to derive this entry's name
 *  (e.g. "Truncated", "2,3-Truncated", "Truncated (2×(3.6²))", "Snub (R)"). */
function operationModifier(op: OpDescriptor): string {
  return withChirality(qualifyName(verbs(op.kind, op.weld)[1], op.sel), op.chirality);
}

/** Collapse runs of an identical modifier into an "Nx" prefix (keeping order), so
 *  ["Rectified","Rectified","Truncated"] reads ["2x Rectified", "Truncated"]. */
function collapseRuns(mods: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < mods.length; ) {
    let j = i + 1;
    while (j < mods.length && mods[j] === mods[i]) j++;
    const count = j - i;
    out.push(count > 1 ? `${count}x ${mods[i]}` : mods[i]);
    i = j;
  }
  return out;
}

/**
 * The display name for history entry `index`: its identified name when known,
 * otherwise the operation modifiers from here back to the nearest known-named
 * ancestor, prepended to that ancestor's name (so modifiers stack across
 * unidentified steps, with consecutive repeats collapsed to "Nx"). Returns null
 * for an invalid (non-planarizable) entry.
 */
export function composeName(
  entries: readonly HistoryEntry[],
  index: number,
): string | null {
  const e = entries[index];
  if (!e) return null;
  if (e.name) return e.name; // a known, identified shape
  if (e.invalid || !e.op) return null;

  // Walk back collecting this entry's modifier and those of any unidentified
  // ancestors, until a known-named ancestor (or the seed) supplies the base.
  const mods: string[] = [];
  let base: string | null = null;
  for (let j = index; j >= 0; j--) {
    const a = entries[j];
    if (j < index) {
      if (a.invalid) continue; // ignore non-planarizable intermediate states
      if (a.name) { base = a.name; break; } // nearest known-named ancestor
      if (!a.op) break; // seed without a name (shouldn't happen) — give up
    }
    if (a.op) mods.push(operationModifier(a.op));
  }
  if (base == null) return null;
  return [...collapseRuns(mods), base].join(" ");
}
