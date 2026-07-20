/**
 * =============================================================================
 *  SHAPE SHIFTER 99 — CONFIGURATION
 * =============================================================================
 *
 *  Every tunable value and on/off switch in the app. Booleans turn features on
 *  and off; numbers tune thresholds, the solver and the look. Edit a value and
 *  the dev server hot-reloads.
 * =============================================================================
 */

export const config = {
  // ---------------------------------------------------------------------------
  // FEATURES — turn whole capabilities on or off.
  // ---------------------------------------------------------------------------
  features: {
    // Each operation can be disabled independently; its gesture then does nothing.
    operations: {
      truncate: true, // drag a vertex inward
      rectify: true, // the welded end of the truncate drag (drag fully in)
      kis: true, // drag a face center outward
      join: true, // the welded end of the kis drag (drag fully out)
      snub: true, // continue a full-rectify vertex drag onto the twist arc
      gyro: true, // continue a full-join face drag onto the twist arc
      chamfer: true, // drag an edge midpoint sideways along a bordering face
      subdivide: true, // drag an edge midpoint outward along the edge normal
      whirl: true, // continue a full-join chamfer drag onto the twist arc
      volute: true, // continue a full-rectify subdivide drag onto the twist arc
      propeller: true, // the welded end of both twists (drag the whirl / volute fully out)
    },

    multiSelect: true, // Cmd (macOS) / Ctrl: select several elements before dragging
    // When false, Command/Ctrl operates on a single element and clears the selection.
    // When true, it toggles elements into the current selection instead, allowing
    // arbitrary multi-figure subsets. Shape names are only guaranteed to be a
    // well-defined surjection onto makeable shapes with this off — see
    // operations/naming.ts.
    commandAddsToSelection: false,
    hoverHighlight: true, // highlight draggable vertices / face-centers under the mouse
    identification: true, // identify & name the current polyhedron after each edit
    isomorphismCheck: true, // background graph-isomorphism verification (the ✓ mark)
    textReadout: true, // show the name + ✓ in the bottom-left corner overlay
    logToConsole: true, // also print identification results to the dev console
  },

  // ---------------------------------------------------------------------------
  // INTERACTION — how dragging, snapping and selection feel.
  // ---------------------------------------------------------------------------
  interaction: {
    // A release with a t value (between 0 and 1) below this is treated as no change
    minCommitT: 1e-3,

    // Pixel radius around a vertex / face-center within which hovering counts as
    // over it: the marker takes its prominent appearance and is grabbable.
    hoverPixelRadius: 22,

    // Larger radius: when the cursor is merely near the polyhedron, the closest
    // drag point becomes subtly visible as a hint, without being grabbable.
    proximityPixelRadius: 60,

    // A marker is pickable only while at least one of its faces points toward the
    // camera by more than this margin (degrees) past perpendicular. Faces that are
    // edge-on (within the margin of 90°) or back-facing count as occluded, so a
    // handle on the far/silhouette side of the solid can't be grabbed.
    pickNormalMarginDeg: 4,

    // Snap the mouse to the relevant edge / normal line when computing how far it
    // has been dragged. With this off, the raw cursor distance drives the parameter.
    snapTruncateToEdge: true,
    snapKisToNormal: true,

    // Edge handles (chamfer / subdivide). An edge midpoint can be dragged along
    // three lines: perpendicular to the edge within each bordering face (chamfer),
    // or along the edge normal, the mean of the two face normals (subdivide). On
    // drag start the axis whose infinite line passes nearest the cursor ray is
    // chosen and the drag is constrained to it.
    snapEdgeToAxis: true,

    // How far (in pixels) the pointer must move after pressing on a handle before
    // the press becomes a drag rather than a click.
    dragStartPixels: 4,

    // When the welded max (rectify / join) is disabled, the drag stops at this t,
    // just short of it, so coincident vertices / faces don't go degenerate.
    maxTWithoutWeld: 0.94,
  },

  // ---------------------------------------------------------------------------
  // SOLVER — the relaxation that runs after the mouse is released. Stage 1 makes
  //   every face planar; stage 2 nudges faces toward regular polygons. If faces
  //   won't flatten, the canonical step keeps trying (the SHAPE panel notes it
  //   after a few seconds) rather than declaring the shape invalid.
  // ---------------------------------------------------------------------------
  solver: {
    enabled: true,

    // The form newly-committed shapes relax toward until another is picked in the
    // OPTIONS panel. "edges" is the canonical / midsphere form, which stays convex
    // and never collapses a face; "faces" makes every face a regular polygon;
    // "jumbled" wanders and never planarizes. See solver/solver.ts.
    defaultStrategy: "edges" as "jumbled" | "edges" | "faces",

    // Holding an OPTIONS strategy button keeps stepping the relaxation until release;
    // a single click still runs for at least this long, so it does something visible
    // rather than one imperceptible step.
    holdMinMs: 350,

    // The rendered shape eases toward the solver's live vertices by this fraction
    // each frame (0..1) instead of snapping, so size/strategy changes read as a
    // smooth morph. 1 = no smoothing; smaller = softer, slower catch-up.
    displaySmoothing: 0.25,

    planarity: {
      // Max iterations the dedicated planarize phase spends before handing off to
      // the canonical step, which keeps trying to flatten faces indefinitely.
      maxIterations: 256,
      // Wall-clock budget (ms) for that phase, before the same hand-off.
      timeBudgetMs: 4000,
      // A face counts as planar when its max out-of-plane distance (relative to
      // the shape's size) is below this.
      tolerance: 1e-3,
      // How aggressively vertices are pulled onto their face plane each step (0..1).
      stepFactor: 1.5,
      // If faces still haven't planarized after this long, the SHAPE panel shows
      // `warnText`, cleared the moment they do. The canonical step keeps running
      // at full strength meanwhile.
      warnAfterMs: 3000,
      warnText: "faces won't planarize",
    },

    regularity: {
      // Iterations spent improving regularity once the shape is planar.
      iterations: 256,
      // Step size for the regularizing nudge each iteration (0..1).
      stepFactor: 2,
      // Damping starts here and decays by `dampingRate` each iteration so the motion
      // settles instead of oscillating. Effective step = stepFactor * damping.
      dampingStart: 1.0,
      dampingRate: 0.997,
      // Stop early when the largest per-vertex move drops below this (relative).
      convergeTolerance: 1e-5,
      // While an OPTIONS button is held, the damping ramp is bypassed and this fixed
      // strength is used instead (contractive: stepFactor * holdDamping ~ 1), so the
      // relaxation keeps going. It still stops below `holdConvergeTolerance`, which
      // is looser, so a settled shape ends even while the button is held.
      holdDamping: 0.5,
      holdConvergeTolerance: 1e-4,
      // Re-flatten faces between regularity steps so they never drift off-plane.
      keepPlanar: true,
      // Planarization sub-steps applied after each regularity step.
      planarSubsteps: 2,

      // The solid is rescaled so the average vertex distance from the origin equals
      // this target, keeping its apparent size constant across edits and strategy
      // switches. `rescaleRate` is the fraction applied each iteration; 1 snaps fully
      // every frame, so the size never lurches and then drifts back.
      targetAverageRadius: 1,
      rescaleRate: 1,
    },
  },

  // ---------------------------------------------------------------------------
  // OPERATIONS — geometric constants for the snub / gyro twist arc.
  // ---------------------------------------------------------------------------
  operations: {
    // Snub and gyro are reached by continuing a full rectify/join drag onto a twist
    // arc handle. For a dragged element of arity n (vertex degree for snub, face
    // sides for gyro) the arc reaches 360 / (twistArcDivisor · n) degrees in each
    // direction, the two chiralities. The limit is 360/(2n), a second rectify/join,
    // so the divisor must exceed 2 to stop short of it.
    twistArcDivisor: 2.5,

    // The gyro / whirl rotation arc's radius, as a fraction of the swept spoke's length
    // in the arc's own plane: how far out from the apex the arc sits.
    gyroArcRadiusFraction: 0.35,

    // Snub: the full-twist length of each chiral drag line, set so the two vertices a
    // rectify vertex splits into end up this fraction of a rectification edge apart,
    // i.e. the new snub edge is this fraction of the old edge. The regular snubs all
    // want ≈0.744 (snub cube, icosahedron, …), so this both sizes the handle and lands
    // the preview on the true snub before the relaxer refines it.
    snubEdgeFraction: 0.75,

    // Gyro: how far each new edge-midpoint vertex lifts outward, off the join face, at
    // the full gyro. Unlike snub, the lift can't be a fixed fraction of the edge: a
    // sharp join (cube, 90° dihedral) must lift a lot to fold its quads into pentagons,
    // while a nearly-flat join (rhombic triacontahedron, 144°) barely lifts at all.
    // Empirically the lift is
    //     gyroLiftFactor · cot(dihedral/2) · (½ · joinEdge)
    // so this one coefficient, derived across the Platonic joins and rectifications,
    // lands every regular gyro (≈0.62·|v0| for the cube up to ≈0.69·|v0| for the round
    // ones) close to its canonical form before the relaxer refines it.
    gyroLiftFactor: 0.6,

    // Gyro: the in-plane part of that same slide — how far the new vertex slides along
    // the line from its edge midpoint toward the opposite edge's midpoint at full gyro.
    gyroFaceSlide: 0.2,

    // While twisting, the dragged face / vertex-star also shrinks toward the axis to
    // give the split gaps room; this is the scale it reaches at the full twist.
    twistShrink: 0.72,

    // Whirl and volute both run to a weld — the propeller — so neither has a depth to
    // tune: the drag's t is the fraction of the way to that weld, and the geometry is
    // solved backwards from it.
    //
    // A whirl cuts each join apex back into the face it was collapsed from, the corners
    // sliding out along the apex's gyro edges (the spokes to its surrounding new
    // vertices). At t=1 each corner reaches its spoke's far end and welds into the vertex
    // there: every hexagon loses two corners and closes into a quad, and the apex's n-gon
    // is left ringed by the vertices it slid onto. Dually, a volute raises each vertex
    // figure into a pyramid whose apex heads back out toward the vertex it was cut from;
    // at t=1 it reaches the height where every fan triangle is coplanar with the snub gap
    // triangle beside it, and the two weld into that same quad. Both limits are the
    // propeller (Conway's `p`, which is its own dual), so the two drags meet there.
  },

  // ---------------------------------------------------------------------------
  // COLORS — system for coloring solids.
  // ---------------------------------------------------------------------------
  colors: {
    // A geometric color is an id vector: the tetrahedron's 14 elements (4 faces,
    // 6 edges, 4 vertices) each get a distinct one-hot of length 14, and every other
    // element's color is a weighted combination of those, produced by the `operations`
    // rules below. Each rule maps old tokens to the coefficients their vectors are
    // weighted by, so `{oldVertex: 1.0, oldFace: 0.5}` means oldVertexVec +
    // oldFaceVec/2. Every rule's weights sum to 1, so an id is always a convex
    // combination: barycentric coordinates over the tetrahedron's elements.
    //
    // Which swatch each symmetry orbit renders as is a separate concern, declared in
    // `render.schemes`; geometry/colors.ts groups the derived id vectors accordingly,
    // and a vector matching no group falls back to `defaultSwatch`. Swatch names are
    // the keys of `render.palette`, the one color source of truth.

    // The swatch for any computed triple that matches no scheme group. It is also one
    // leg of the synthesized blend swatches (see geometry/colors.ts): an `avg(<a>,<b>)`
    // equal average (0.5 each, e.g. octahedral face+vert) renders as an equal 3-way
    // split of the two base swatches and this default; a `tint(<base>)` swatch is the
    // base mixed 0.75/0.25 toward this default. An `avg(<base>,avg(<n1>,<n2>))` swatch
    // is a 0.5 : 0.25 : 0.25 blend of the base and its two neighbor swatches, and an
    // `avg(<a>,<b>,<c>)` swatch — the equal mix of all three groups, which is what a
    // snub's gap triangles are — is an even 3-way blend of them; neither uses the
    // default. These splits are intrinsic; only which families are derived at all is
    // tunable, via `avgArguments` / `secondOrderAvgSwatches` / `tintSwatches` below.
    defaultSwatch: "white",
    // The color scheme selected on load (a key of `render.schemes`). A freshly-loaded
    // seed is colored under the scheme its topology matches (see schemeForMesh in
    // geometry/colors.ts): the tetrahedron gets its per-element one-hot ids, and any
    // other directly-loaded seed takes the first triple of each matching orbit, so it
    // looks like the one built up from the tetrahedron. Operations then layer the
    // combination rules on top.
    defaultScheme: "tetrahedral",

    // The max number of arguments to allow in a derived
    // `avg(...)` swatch (less than 2 disables `avg(...)`)
    avgArguments: 3,
    // If `avgArguments` is at least 2, whether to derive
    // `avg(c1, avg(c2, c3))` swatches
    secondOrderAvgSwatches: true,
    // Whether to derive `tint(c)` swatches: a 3:1 mix of the
    // given color with the `defaultSwatch` - representing all
    // possible 3:1 weighted averages of the given color with an
    // average of `n` distinct colors, where n ranges from 1 to
    // the value of `avgArguments`
    tintSwatches: true,

    // How to color new elements for each operation
    operations: {
      // Operations on a vertex, where n is in {1, ..., degree}:
      // - oldVertex is the color of the vertex being operated on
      // - oldEdge is the color of the nth edge adjacent to it
      // - oldFace is the color of the nth face adjacent to it
      // (Dual operations are automatically derived)
      truncate: {
        // Each new face comes from an old vertex, so is given its color
        newFace: {oldVertex: 1.0},
        // Each new edge borders an old face and a new face, so is given the
        // average of the two colors
        newEdge: {oldFace: 1/2, oldVertex: 1/2},
        // Each new vertex comes from an old vertex moved part-way along an
        // edge, so is given the average of the two colors
        newVertex: {oldEdge: 1/2, oldVertex: 1/2},
      },
      rectify: {
        // Each face and edge shares the same origin and adjacency as its
        // analog in truncation, so are colored the same as the above
        newFace: {oldVertex: 1.0},
        newEdge: {oldFace: 1/2, oldVertex: 1/2},
        // Each new vertex comes from an old edge, so is given its color
        newVertex: {oldEdge: 1.0},
      },
      // NB: Snub is built as an operation on the vertices of a rectified
      // solid, so "old" here refers to the faces/edges/vertices of the
      // rectification of the shape being snubbed, not of that original shape.
      // Each degree-4 vertex splits into two based on a chosen chiral
      // direction, thus where n is in {1,2,3,4} and m is in either {1,3} or
      // {2,4} depending on the chirality:
      // - oldVertex is the color of the rectified vertex being operated on
      // - oldFace is the color of the nth rectified face adjacent to it
      // - oldEdge is the color of the mth rectified edge along the chosen
      //   chiral direction
      // (Dual operation is automatically derived)
      snub: {
        // Each new face borders two old edges and one new edge, so it is given
        // the average of their colors
        newFace: {oldEdge: 2/3, oldVertex: 1/3},
        // Each new edge between two of the new faces comes from an old
        // rectify vertex, so it is given its color
        newEdge: {oldVertex: 1.0},
        // Each other new edge borders an old face and a new face, so is given
        // the average of the two colors
        snubEdge: {oldFace: 1/2, oldEdge: 1/3, oldVertex: 1/6},
        // Each new vertex comes from an old vertex moved part-way along an
        // old edge, so is given the average of the two colors weighted 3:1
        // towards the old vertex color (the exact weighting is arbitrary, but
        // this is the simplest choice that keeps every derived color distinct,
        // see investigations/ico_snub_color_rules)
        newVertex: {oldVertex: 3/4, oldEdge: 1/4},
      },
      // Operations on an edge, where n is in {1,2}:
      // - oldEdge is the color of the edge being operated on
      // - oldVertex is the color of the nth vertex adjacent to it
      // - oldFace is the color of the nth face adjacent to it
      // (Dual operation is automatically derived)
      // NB: Subdividing should be equivalent to rectifying, then kis-ing (the
      // dual operation to truncating) only the new faces that were created by
      // the rectification. This explanation is used for all the rules below.
      subdivide: {
        // Each new face comes from kis-ing one of the new rectify faces, so
        // following the newVertex rule of truncate, it is given the average of
        // the rectify edge and the rectify face colors, which following the
        // rectify rules, have the average of the colors of the old face
        // and old vertex, and the color of the old vertex, respectively
        newFace: {oldFace: 1/4, oldVertex: 3/4},
        // Each new edge that splits an old edge comes from kis-ing one of the
        // new rectify faces, so following the newEdge rule of truncate, it is
        // given the average of the rectify vertex and rectify face colors,
        // which following the rectify rules, have the color of the old edge
        // and old vertex, respectively
        subdivEdgeEdge: {oldEdge: 1/2, oldVertex: 1/2},
        // Each new edge that splits an old face comes from rectifying one of
        // the old vertices, so following the newEdge rule of rectify it is
        // given the average of the old face and old vertex colors
        subdivFaceEdge: {oldFace: 1/2, oldVertex: 1/2},
        // Each new vertex comes from rectifying one of the old vertices, so
        // following the newVertex rule of rectify, it is given the color of
        // the old edge
        // (NB: The new vertices created from kis-ing are not new in this
        // context, since they are just the old vertices that were turned into
        // faces via rectify - they keep their color via the newFace rule of
        // truncate)
        newVertex: {oldEdge: 1.0},
      },
      // NB: Unlike snub, propeller does operate directly on the original
      // elements of the shape. Also note that it is its own dual, so if you
      // switch "vert" and "face", you should get the same set of rules
      propeller: {
        // Each new face connects an old face to an old edge, so it is given
        // the average of the two colors
        newFace: { oldFace: 1/2, oldEdge: 1/2 },
        // Each new edge between an old face and a new face is given the
        // average of the two colors
        newFaceEdge: { oldFace: 3/4, oldEdge: 1/4 },
        // Each new edge between an old vertex and a new vertex is given the
        // average of the two colors
        newVertEdge: { oldVertex: 3/4, oldEdge: 1/4 },
        // Each new face connects an old vertex to an old edge, so it is given
        // the average of the two colors
        newVert: { oldVertex: 1/2, oldEdge: 1/2 },
      },
    },
  },


  // ---------------------------------------------------------------------------
  // IDENTIFY — naming + verification.
  // ---------------------------------------------------------------------------
  identify: {
    // Skip the potentially expensive isomorphism brute-force if the candidate has
    // more than this many vertices.
    isomorphismMaxVertices: 200,
  },

  // ---------------------------------------------------------------------------
  // SEEDS — which starting solids exist, and which loads on launch.
  //   Names must match entries in geometry/seeds.ts.
  // ---------------------------------------------------------------------------
  seeds: {
    enabled: [
      "tetrahedron",
      "cube",
      "octahedron",
      "dodecahedron",
      "icosahedron",
    ],
    initial: "tetrahedron",
    // Whether the digit keys load a seed.
    numberKeyToLoadSeed: false,
    // Press R to reset to the current seed.
    resetKey: "r",
  },

  // ---------------------------------------------------------------------------
  // DEBUG — manual relaxation controls for experimenting with the post-release
  //   solve. `relaxKey` re-runs the active strategy on the current shape; the
  //   strategy keys switch the active strategy and re-solve, like the OPTIONS
  //   panel's buttons.
  // ---------------------------------------------------------------------------
  debug: {
    manualRelax: true, // enable the keys below
    relaxKey: "g", // re-relax the current shape with the active strategy
    facesKey: "f", // switch to regular-faces regularization + re-solve
    edgesKey: "c", // switch to canonical / midsphere (edges) + re-solve
    jumbledKey: "v", // switch to the jumbled relaxation + re-solve
  },

  // ---------------------------------------------------------------------------
  // INTRO CUTSCENE.
  // ---------------------------------------------------------------------------

  intro: {
    cameraDistance: 7, // initial camera distance from origin
    // Power-on flash: the console starts at the bright monitor color and settles to
    // the dark glass over this long before the boot text appears.
    warmupDuration: 0.6, // second(s)
    // The 3D shape fades in behind the boot sequence's closing message; once it has
    // fully faded in the console is hidden and the app takes over.
    shapeFadeInDuration: 10, // second(s)
  },

  // ---------------------------------------------------------------------------
  // GLITCH — a corruption overlay on the character grid: random cells flip to
  //   random glyphs. A single intensity (0..1) drives it: at 0 it is off, at 1 the
  //   whole grid churns with random characters. Low intensities don't just thin the
  //   coverage, they also make the corruption arrive in occasional bursts rather
  //   than a steady fill, so each flicker is both smaller and rarer.
  //
  //   The same overlay is used twice: choreographed across the boot sequence
  //   (interaction/bootSequence.ts), and as the flash when a new shape is
  //   discovered (see `discovery` below).
  // ---------------------------------------------------------------------------
  glitch: {
    enabled: true,
    // The pool of glyphs a corrupted cell can show, one picked at random per cell
    // per refresh. Edit this to change the texture of the corruption.
    chars: "█▓▒░▚▞▙▟◣◢╳╱╲@#$%&*?/\\<>=+-:;01ABEFΔΞΣΨΦ",
    // The glitch glyph color, a CSS color string (white, like the lit pixels).
    color: "#ffffff",
    // How often (ms) the whole random field is regenerated: the flicker rate.
    refreshMs: 55,

    // Clustering. Corrupted cells aren't scattered uniformly; they are carved out of
    // an animated value-noise field, so the corruption appears in moving blobs rather
    // than evenly spread static. `scale` is how many grid cells span one noise lattice
    // cell (bigger = larger, smoother blobs); `timeScale` is how fast the blobs drift
    // and morph, in units per second. The coverage (0..1) is the slice of the noise
    // field that lights up, so it still reads as a percentage, just clumped.
    noise: {
      scale: 5,
      timeScale: 1.6,
    },

    // Auto-burst. When an auto intensity p (0..1) is set, bursts pop up at random with
    // no steady fill: the gap between them eases from `maxGapMs` (at p→0, rare) to
    // `minGapMs` (at p→1, constant), and each burst peaks at p * `peakScale` coverage
    // before decaying linearly to 0 over a random duration in [minBurstMs, maxBurstMs].
    burst: {
      minGapMs: 110,
      maxGapMs: 2400,
      minBurstMs: 90,
      maxBurstMs: 340,
      peakScale: 1.0,
    },
    // The boot-sequence glitch choreography lives inline as "glitch" steps in
    // config.bootText, so the whole arc is editable there.
  },

  // ---------------------------------------------------------------------------
  // DISCOVERY — the celebration the first time a named shape is made (Platonic,
  //   Archimedean and Catalan for now; Johnson solids, their duals and a few
  //   dihedral solids eventually, hence the 99). The shape glows, the screen
  //   glitches, then a popup names the kind of solid. The session's first
  //   discovery is amplified by the `first*` multipliers below.
  // ---------------------------------------------------------------------------
  discovery: {
    enabled: false,
    total: 99, // the eventual shape count (shown in the SHAPES panel as N/99)

    // Remember discoveries across page reloads (localStorage). When on, the set of
    // made shapes and each shape's construction history (history/historyStore.ts)
    // survive a refresh, and a returning visitor skips the boot intro.
    persist: true,
    storageKey: "ShapeShifter99:discovered",
    // Where the per-shape construction histories are stored (history/historyStore.ts),
    // so clicking a shape in the LIBRARY reopens it in the main view with its history.
    historyStorageKey: "ShapeShifter99:histories",

    // Shapes already held at launch, which therefore never trigger a discovery. The
    // boot story finds exactly the tetrahedron (1/99), so it starts discovered.
    preDiscovered: ["Tetrahedron"],

    // The emissive glow pulse on the shape, picked up by the 3D bloom.
    glowStrength: 1.6, // peak emissive intensity
    glowDurationS: 1.6,

    // The glitch flash over the screen: peak coverage and how long it decays over.
    // Kept well below the boot sequence's peak, so a discovery sparkles with clustered
    // corruption rather than blacking out the screen.
    glitchBurst: 0.22,
    glitchDurationS: 0.9,

    // The session's first discovery multiplies both effects. The glow goes big; the
    // glitch only nudges up, keeping coverage comfortable.
    firstGlowMultiplier: 2.4,
    firstGlitchMultiplier: 1.6,

    // The congratulations popup: how long after the glitch it appears, and how long it
    // stays before auto-dismissing (0 = stay until clicked or keyed away).
    popupDelayS: 0.35,
    popupHoldS: 6,
  },

  // ---------------------------------------------------------------------------
  // UI TEXT — the titles drawn in each panel's box-drawing frame, plus the contents
  //   of the SHAPES panel and the new-shape discovery popup. Tokens in {braces} are
  //   substituted at runtime:
  //     SHAPES panel:     {count} {total}
  //     DISCOVERY popup:  {banner} {name} {type} {count} {total}
  // ---------------------------------------------------------------------------
  ui: {
    // Frame titles for each panel / popup.
    titles: {
      polyhedron: "SHAPE", // bottom-left status box (ui/readout.ts)
      selection: "SELECTION", //   top-left selection box (ui/readout.ts)
      history: "HISTORY", //       top-right operation list (ui/historyPanel.ts)
      shapes: "OPTIONS", //         top-left options / library panel (ui/shapesPanel.ts)
      library: "LIBRARY", //       full-screen browse diagram (ui/libraryBrowser.ts)
      discovery: "WOW", //   new-shape popup (ui/discoveryPopup.ts)
      help: "HELP & INFO", //       the bezel Help & Info popup (ui/helpDialog.ts)
      confirm: "CONFIRM", //        the reset-everything confirmation (ui/confirmDialog.ts)
    },

    // The bezel Help & Info popup (ui/helpDialog.ts): an intro paragraph, word-wrapped
    // to the dialog width, followed by one line per operation.
    helpDialog: {
      intro:
        "It turns out you can make essentially every 3D shape (polyhedron) that " +
        "mathematicians have given a name out of just chopping up and grabbing at " +
        "a pyramid! Here are these operations:",
      operations: [
        "- Truncate: drag a vertex (corner) inwards to chop it off and add a new face (flat side)",
        "- Rectify: keep dragging until the old edges disappear",
        "- Snub: drag left or right to twist the new faces",
        "",
        "- Kis: drag the center of a face (flat side) outwards to pull out a new vertex (corner)",
        "- Join: keep dragging until until the old edges disappear",
        "- Gyro: drag left or right to twist the new vertices",
        "",
        "- Chamfer: drag the middle of an edge sideways across a face (the limit is Join)",
        "- Whirl: drag left or right to twist the joined faces back in",
        "- Propeller: keep dragging until the old faces are fully expanded",
        "",
        "- Subdivide: drag the middle of an edge straight outwards (the limit is Rectify)",
        "- Volute: drag left or right to twist the rectified vertices back in",
        "- Propeller (again): keep dragging until the new faces rejoin where they came from",
        "",
        "Try messing with the \"Regular\" option to get some funky effects, and check out the library!"
      ],
      // Column width the intro paragraph wraps to (capped to the screen width).
      wrapCols: 80,
      // The same dialog shows this blurb instead while the LIBRARY browse screen is
      // open, explaining the map rather than the controls.
      library: {
        intro:
          "This is a view of how all the shapes currently supported are " +
          "connected. Click on a shape to view it on the main screen! Currently " +
          "you can view all:",
        operations: [
          "- 5 Platonic solids, where every face is the same regular polygon",
          "- 13 Archimedean solids, where the faces are all regular but not all the sames",
          "- 13 Catalan solids, where the faces are all the same but not all regular",
          "- 5 Chamfered solids, with every edge bevelled into a hexagon",
          "- 5 Subdivided solids, with every edge split down its middle",
        ],
      },
    },

    // The LIBRARY screen's own OPTIONS panel + reset confirmation (ui/libraryBrowser.ts).
    libraryOptions: {
      buttons: { reveal: "Reveal all", reset: "Reset" },
      confirm: {
        lines: [
          "Reset everything?",
          "",
          "This erases every shape you've made",
          "and restarts from the beginning.",
          ""
        ],
        yes: "Reset",
        no: "Cancel",
        bgAlpha: 0.85,
      },
    },

    // Columns by which the continuation lines of a readout box hang-indent under
    // their label (ui/readout.ts). Whole cells, so the indent stays on the grid.
    readoutIndentCols: 2,

    // Longest line (characters) of the SHAPE box's name and abbreviated summary
    // before they break — the name at a space, the summary between its clauses
    // (ui/readout.ts, identify/configurations.ts).
    readoutSummaryMaxChars: 35,

    // Initial / max width (columns) of the HISTORY panel (ui/historyPanel.ts).
    historyCols: 28,

    // The present-participle verb shown while a drag is in progress, keyed by the
    // operation and whether the drag has reached its welded max end.
    dragVerbs: {
      truncate: ["Truncating", "Rectifying"],
      kis: ["Kis-ing", "Joining"],
      snub: ["Snubbing", "Snubbing"],
      gyro: ["Gyro-ing", "Gyro-ing"],
      chamfer: ["Chamfering", "Joining"],
      subdivide: ["Subdividing", "Rectifying"],
      whirl: ["Whirling", "Propelling"],
      volute: ["Voluting", "Propelling"],
    } as Record<string, [unwelded: string, welded: string]>,

    // The OPTIONS panel. Each line is "Label: <content>": `buttons` fire on click,
    // while `radios` are a mutually-exclusive group with one always chosen. Captions
    // are bare; the surrounding brackets are added by the control widgets themselves
    // (ui/controls.ts).
    optionsPanel: {
      libraryLine: {
        label: "Library",
        text: "{count}/{total}",
        buttons: { browse: "Browse" },
        // When shapes have been discovered since the browser was last opened, the
        // button reads "Browse (N new)". Each discovery flashes it to the hover color,
        // which decays back to normal over this many seconds; hovering cancels the
        // decay and pins the color. The count resets when the browser is opened.
        newFlashSeconds: 1.2,
      },
      formLine: {
        label: "Form",
        radios: { edges: "Canonical", faces: "Regular", jumbled: "Jumbled" },
      },
      colorsLine: {
        label: "Colors",
        radios: { tetrahedral: "Tetra", octahedral: "Octa", icosahedral: "Icosa" },
      },
    },

    // The new-shape discovery popup. `banner` is the headline, though the run's first
    // discovery uses `bannerFirst` instead; `lines` is the body, one entry per centered
    // row (an empty string is a blank row).
    discoveryPopup: {
      banner: ["CONGRATULATIONS YOU MADE A MISSING SHAPE"],
      bannerFirst: ["CONGRATULATIONS YOU MADE A MISSING SHAPE", 
                    "",
                    "Keep dragging corners in and faces out",
                    "to keep going, or undo to try something new"],
      lines: [
        "Its name is: {name}",
        "({type})",
        "",
        "Library: {count} / {total} total shapes",
      ],
    },

    // Operation text, keyed `operation → weld → [label, name]`, giving the base verb pair:
    //   • label — the action verb shown in the HISTORY rows: Truncate, Rectify, Kis.
    //   • name  — the modifier prepended to the nearest named ancestor to derive a shape
    //             name (Truncated Cube), shown in the readout and exported filenames.
    // `weld` is the unwelded vs welded end of the drag: the rectify / join a base op runs
    // into, or the propeller a whirl / volute does. A full snub / gyro welds nothing, so
    // both of its entries read the same.
    // operations/naming.ts adds the selection qualifier programmatically:
    //   whole  → the bare verb;
    //   arity  → an "a,b-" prefix listing the affected arities (degree-n vertices, n-gon
    //            faces), as in "2,3-Truncated";
    //   subset → a per-figure "count×figure" breakdown, short and parenthesized for the
    //            name ("Truncated (1×4)", "Truncated (2×(3.6²))") and verbose for the
    //            label ("Truncate 1× degree-3 vertex", "Kis 1×(4.5³)").
    // The chiral operations get an "L-" or "R-" chirality prefix ("L-Snub").
    operationLabels: {
      truncate: { unwelded: ["Truncate", "Truncated"], welded: ["Rectify", "Rectified"] },
      kis:      { unwelded: ["Kis", "Kis"], welded: ["Join", "Joined"] },
      snub:     { unwelded: ["Snub", "Snub"], welded: ["Snub", "Snub"] },
      gyro:     { unwelded: ["Gyro", "Gyro"], welded: ["Gyro", "Gyro"] },
      chamfer:  { unwelded: ["Chamfer", "Chamfered"], welded: ["Join", "Joined"] },
      subdivide: { unwelded: ["Subdivide", "Subdivided"], welded: ["Rectify", "Rectified"] },
      whirl:    { unwelded: ["Whirl", "Whirled"], welded: ["Propeller", "Propellerized"] },
      volute:   { unwelded: ["Volute", "Voluted"], welded: ["Propeller", "Propellerized"] },
    },
  },

  // ---------------------------------------------------------------------------
  // LIBRARY BROWSE SCREEN
  // ---------------------------------------------------------------------------
  library: {
    // Distance the browse camera sits from the focused solid when the diagram opens.
    // Larger than the main view's `camera.startDistance`, so a solid and its
    // neighbours are visible at once. The main view's orientation is kept.
    startDistance: 12,
    // After a pan, the focus eases to the nearest solid, covering this fraction of
    // the remaining distance each frame (0..1; higher is snappier).
    snapSmoothing: 0.18,
    // The on-screen display radius each little solid is scaled to (world units, < 1).
    shapeRadius: 0.62,
    // Colored-edge tube radius for the little library solids (see
    // render.coloredEdgeTubeRadius). Kept separate from the main view's so the two can
    // be tuned independently; both calibrate against `camera.startDistance`, so equal
    // values look the same thickness in each view.
    coloredEdgeTubeRadius: 0.00175,
    // Arrows start and end this many `shapeRadius` out from a solid's center, so they
    // run between the solids rather than through them.
    arrowGapFactor: 1,
    // The connecting arrows' color (dim grey, like the panel frame).
    arrowColor: 0x8b94a3,
    // Arrowhead, a flat camera-facing triangle: its length along the line and its base
    // width, in world units. The tip sits exactly at the line's end.
    arrowheadLength: 0.34,
    arrowheadWidth: 0.26,
    // Dashed arrows, the ":>…" chamfer / subdivide branches: the lit dash and the gap
    // between dashes, in world units. See parseArrow in data/libraryDiagram.ts.
    dashSize: 0.12,
    gapSize: 0.1,
    // Undiscovered but visible solids render in this color at this opacity; discovered
    // ones use their full colors.
    ghostColor: 0x8b94a3,
    ghostOpacity: 0.125,
    // Type this to reveal everything in the library until it is closed.
    revealAllCode: "idkfa",
    diagram: [
      // Tetrahedron family
      [ -1,  0,  1, "Chamfered Tetrahedron", []  ],
      [  0,  6,  0, "Icosahedron", [">d3l4", ">d3r4", ":>l4d5f4", ":>r4d5b4"] ],
      [  0,  4,  0, "Octahedron", [">d2l2", ">d2r2", "u2>", ":>l2d3f2", ":>r2d3b2"] ],
      [  0,  2,  0, "Truncated Tetrahedron", ["u2"] ],
      [  0,  0,  0, "Tetrahedron", [">u2", ">d2", ":>fl", ":>br"] ],
      [  0, -2,  0, "Triakis Tetrahedron", ["d2"] ],
      [  0, -4,  0, "Cube", [">u2l2", ">u2r2", "d2>", ":>l2u3f2", ":>r2u3b2"] ],
      [  0, -6,  0, "Dodecahedron", [">u3l4", ">u3r4", ":>l4u5f4", ":>r4u5b4"] ],
      [  1,  0, -1, "Subdivided Tetrahedron", []  ],
      // Octahedron / Cube family
      [ -2,  2,  0, "Triakis Octahedron", ["d2l2"] ],
      [  2,  2,  0, "Truncated Octahedron", ["d2r2"] ],
      [ -6,  0,  0, "Pentagonal Icositetrahedron", [] ],
      [ -4,  0,  0, "Rhombic Dodecahedron", [">f2r2d1", ">f2r2u1", ">b2r2", "l2>"] ],
      [  4,  0,  0, "Cuboctahedron", [">b2l2d1", ">b2l2u1", ">f2l2", "r2>"] ],
      [  6,  0,  0, "Snub Cube", [] ],
      [ -2, -2,  0, "Tetrakis Hexahedron", ["u2l2"] ],
      [  2, -2,  0, "Truncated Cube", ["u2r2"] ],
      // Icosahedron / Dodecahedron family
      [ -4,  3,  0, "Triakis Icosahedron", ["d3l4"] ],
      [  4,  3,  0, "Truncated Icosahedron", ["d3r4"] ],
      [-10,  0,  0, "Pentagonal Hexecontahedron", [] ],
      [ -8,  0,  0, "Rhombic Triacontahedron", [">f4r4d1", ">f4r4u1", ">b4r4", "l2>"] ],
      [  8,  0,  0, "Icosidodecahedron", [">b4l4d1", ">b4l4u1", ">f4l4", "r2>"] ],
      [ 10,  0,  0, "Snub Dodecahedron", [] ],
      [ -4, -3,  0, "Pentakis Dodecahedron", ["u3l4"] ],
      [  4, -3,  0, "Truncated Dodecahedron", ["u3r4"] ],
      // Cuboctahedron / Rhombic Dodecahedron family
      [ -2, -1,  2, "Chamfered Cube", ["f2r2u1"] ],
      [ -2,  1,  2, "Chamfered Octahedron", ["f2r2d1"] ],
      [  2,  0,  2, "Truncated Cuboctahedron", ["f2l2"] ],
      [  0,  0, -4, "Deltoidal Icositetrahedron", ["l2>"] ],
      [  0,  0,  4, "Rhombicuboctahedron", ["r2>"] ],
      [ -2,  0, -2, "Disdyakis Dodecahedron", ["b2r2"] ],
      [  2, -1, -2, "Subdivided Cube", ["b2l2u1"] ],
      [  2,  1, -2, "Subdivided Octahedron", ["b2l2d1"] ],
      // Icosidodecahedron / Rhombic Triacontahedron family
      [ -4, -1,  4, "Chamfered Dodecahedron", ["f4r4u1"] ],
      [ -4,  1,  4, "Chamfered Icosahedron", ["f4r4d1"] ],
      [  4,  0,  4, "Truncated Icosidodecahedron", ["f4l4"] ],
      [  0,  0, -8, "Deltoidal Hexecontahedron", ["l2>"] ],
      [  0,  0,  8, "Rhombicosidodecahedron", ["r2>"] ],
      [ -4,  0, -4, "Disdyakis Triacontahedron", ["b4r4"] ],
      [  4, -1, -4, "Subdivided Dodecahedron", ["b4l4u1"] ],
      [  4,  1, -4, "Subdivided Icosahedron", ["b4l4d1"] ],
    ]
  },

  // ---------------------------------------------------------------------------
  // LETTER TEXT
  // ---------------------------------------------------------------------------

  letterText: [
    [
      "Alice,",
      "Installed on this machine is a strange operating system completely unknown to everyone else to which it has been shown, even other old-timers such as ourselves. Thus, I suspect it will be of great interest to you.",
      "I’ve only been able to get it to run only one program: SHAPE SHIFTER 99. A fully intact version of this program likely acts as a tool for viewing and modifying polyhedra, but the disk I received was quite damaged. Instead, the program fails to load all but a few shapes and… well you’ll see.",
      "I’ve included my notes on the following pages if they are of any help to you, but if you are at all intrigued I encourage you to boot it up and start clicking.",
      "Good luck",
      "Charlie"
    ],
    [
      "[page 2 to be filled in later]"
    ],
    [
      "[page 3 to be filled in later]"
    ]
  ],

  // ---------------------------------------------------------------------------
  // LETTER — the worn typewritten letter (text in `letterText`) that rises from the
  //   bottom of the screen on load, before the program boots. See
  //   interaction/letterIntro.ts.
  //
  //   The pages are a stack: the front page covers the center and the rest peek out
  //   behind it. Clicking a peeking page, or the right edge of the front page, pages
  //   forward; the left edge pages back. Clicking the center of a page, or off to the
  //   side, drops the stack down until it just peeks from the bottom edge and lets the
  //   program start; clicking the peeking stack raises it again.
  //
  //   The letter sits on top of the whole monitor, above the plastic bezel. Lowered,
  //   it slides down until it only covers the bottom bezel, leaving the screen clear.
  // ---------------------------------------------------------------------------
  letter: {
    enabled: false,
    widthFrac: 0.52, // front page width  as a fraction of the screen
    heightFrac: 0.86, // front page height as a fraction of the screen
    peekX: 26, // px each page behind is offset to the right, so it peeks out
    peekY: 16, // px each page behind is offset downward
    peekRotateDeg: 1.2, // slight rotation per page back, for a loose-stack look
    riseDurationS: 0.55, // how quickly the stack rises in on load
    dropDurationS: 0.6, // how quickly it drops to / rises from the bottom peek
    // When lowered, the stack covers the bottom bezel; this is how far past the top of
    // that bezel, onto the glass edge, it pokes. 0 leaves the whole screen clear.
    peekExtraPx: 0,
    edgeZoneFrac: 0.24, // left/right strips of the front page that page back / forward
  },

  // ---------------------------------------------------------------------------
  // BOOT TEXT — the script for the faux-BIOS boot sequence (see
  //   interaction/bootSequence.ts). Each screen below is a flat list, played top to
  //   bottom, so the power-on story is re-skinned by editing lines.
  //
  //   A bare string is one printed line (empty for a blank line). An object is a line
  //   with extra behaviour, set by `kind`:
  //     (none)      a normal line of text, same as a bare string
  //     "pause"     no text, just wait (use with `delay`)
  //     "memory"    a memory test after `text` that counts up in place to `totalK`
  //     "check"     a POST subsystem check: "text ........ [ OK ]"
  //     "command"   print `prompt`, then type out `text` and press Enter
  //     "load"      a shape-library entry, "NNN  text ..... [ OK | ERR ]", after
  //                 `wait` seconds; `ok` picks OK vs ERR and `n` auto-increments
  //     "glitch"    drive the corruption overlay: `level` (over `ramp` seconds) sets
  //                 the steady coverage, `auto` enables intermittent bursts, and
  //                 `burst` fires one transient burst over `burstS`
  //     "clear"     wipe the screen
  //     "reveal"    clear, go transparent to show the 3D view, fade in, show the cursor
  //     "shape"     start the real polyhedron fading in behind the text
  //     "vcenter"   pad with blanks so the lines printed below are centered
  //   A text entry with `center: true` types itself out from the screen center, and
  //   `delay` (seconds) on any entry is an extra pause after it. The leader dots and
  //   the [ OK ] / [ ERR ] tokens are generated by bootSequence.ts.
  // ---------------------------------------------------------------------------
  bootText: [
    [
      { kind: "command", prompt: "C:\\> ", delayAfterPrompt: 1.0,
                         text: "ss99.exe", delayAfterCommand: 0.8, delay: 0.5 },
      "   _____ __  _____    ____  ______        ",
      "  / ___// / / /   |  / __ \\/ ____/        ",
      "  \\__ \\/ /_/ / /| | / /_/ / __/           ",
      " ___/ / __  / ___ |/ ____/ /___           ",
      "/____/_/ /_/_/__|_/_/___/_____/__________ ",
      "  / ___// / / /  _/ ____/_  __/ ____/ __ \\",
      "  \\__ \\/ /_/ // // /_    / / / __/ / /_/ /",
      " ___/ / __  // // __/   / / / /___/ _, _/ ",
      "/____/_/ /_/___/_/     /_/ /_____/_/ |_|  ",
      "  / __ \\/ __ \\                            ",
      " / /_/ / /_/ /                            ",
      " \\__, /\\__, /                             ",
      "/____//____/                              ",
      "",
      "SHAPE SHIFTER 99",
      "© 1988 Working Mathematician Supply Inc.",
      { text: "", delay: 1.2 },
      { text: "Loading shape library:", delay: 0.4 },
      { kind: "load", text: "Tetrahedron", ok: true, wait: 1.9 },
      { kind: "glitch", level: 0.15, ramp: 3 },
      { kind: "load", text: "Cube", ok: false, wait: 4 },
      { kind: "glitch", level: 0.25, ramp: 3.5 },
      { text: "", delay: 1.0 },
      { text: "[ PANIC ] UNEXPECTED ERROR", delay: 0.1 },
      { text: "", delay: 0.8 },
      { text: "Could not access shape library.", delay: 1.0 },
      { text: "", delay: 0.8 },
      { text: "Trying again:", delay: 0.4 },
      { kind: "load", text: "Tetrahedron", ok: true, wait: 0.8 },
      { kind: "glitch", level: 0.4, ramp: 3.0 },
      { kind: "load", text: "Cube", ok: false, wait: 4 },
      { kind: "glitch", level: 0.5, ramp: 3.5 },
      "",
      { text: "[ PANIC ] OUTSIDE INTERFERENCE DETECTED", delay: 0.1 },
      { kind: "glitch", level: 0.8, ramp: 2.0, delay: 1.2 },
    ],
    [
      { kind: "reveal" },
      { kind: "glitch", level: 0, ramp: 0, auto: 0.2 },
      { kind: "pause", delay: 1.2 },
      { kind: "vcenter" },
      { kind: "shape" },
      { text: "Sorry.", center: true, delay: 1.4, lnAfterDelay: true },
      "",
      "",
      { text: "Looks like you'll have to make", center: true, lnAfterDelay: true },
      { text: "all the shapes yourself.", center: true },
      { kind: "pause", delay: 0.6 },
      { kind: "glitch", level: 0, ramp: 1.0, auto: 0 },
    ],
  ],

  // ---------------------------------------------------------------------------
  // CAMERA.
  // ---------------------------------------------------------------------------
  camera: {
    fov: 45,
    startDistance: 3.5, // distance from origin (the polyhedron is normalized ~unit)
    minDistance: 1.5,
    maxDistance: 25,
    rotateSpeed: 2.0,
    scaleFactor: 1.2,
    dampingFactor: 8,
    autoFrame: true, // reframe distance to fit each newly loaded seed
  },

  // ---------------------------------------------------------------------------
  // SCREEN — the vintage-monitor frame and the character grid inside it.
  //
  //   The whole app lives on a centered screen smaller than the browser window. Both
  //   the text and the 3D canvas are laid out on a grid of character cells from the
  //   AST PremiumExec font, an 8x19px PC font drawn at 2x, so one cell is 16px wide by
  //   38px tall. The screen interior is always a whole number of cells, so HTML
  //   positioned with the grid helpers (ui/screen.ts) lines up like text on a terminal.
  // ---------------------------------------------------------------------------
  screen: {
    fontPx: 38, // font-size that makes a cell exactly colW x rowH
    colW: 16, // character cell width  (font advance 800/1900 * 38px)
    rowH: 38, // character cell height (em box 1900/1900 * 38px = line-height)
    viewportMargin: -20, // min gap from the browser edge to the monitor's outer frame
    bezel: 40, // plastic-frame thickness around the glass (always >= this)
    extraBezelBottom: 50, // space for the buttons and/or letter
    padding: 24, // dark glass margin between the bezel and the lit pixel grid
  },

  // ---------------------------------------------------------------------------
  // THEME — the look of the pixel display and its plastic housing. The screen is a
  //   plain white-pixel display under an old glass cover, and the glass is what
  //   blooms. All CSS-side colors live here and are pushed to CSS custom properties
  //   at startup (see Screen.applyTheme). The text and shape glow is not a fixed
  //   color: it is derived per element from that element's own color (Screen.applyTheme
  //   and textGlow), so darker text blooms less.
  // ---------------------------------------------------------------------------
  theme: {
    text: "#ffffff", // base text color (white)
    textBright: "#ffffff", // emphasized text (titles, current entry)
    textDim: "#7c8693", // de-emphasized text (redo tail, hints); dimmer, so less bloom
    textWarn: "#e0a36a", // invalid / warning text (amber)
    backlight: "#10141c", // backlight color that's the 3D background
    glass: "#0a0f0c", // glass color behind the 3D canvas
    monitorBright: "25, 29, 38", // rgb of the monitor when it starts up
    room: "#04060a", // the void behind the monitor
    bezelLight: "#3b3e37", // plastic frame: lit edge
    bezelDark: "#1c1e19", // plastic frame: shadowed edge

    // The pixel mask: a faint grid aligned to the font's pixel size. The 8x19 font
    // drawn at 2x makes one source pixel exactly 2 CSS px, so a 2px grid lands on every
    // font pixel and gives each one a little definition.
    pixelMask: true,
    pixelMaskStyle: "dots" as "lines" | "dots", // "lines": dark grid; "dots": a lit dot per pixel
    pixelSize: 2, // px period of the mask (one font pixel at 2x)
    pixelOpacity: 0.5, // darkness of the mask gridlines / gaps between dots

    // Render the 3D view at the font-pixel resolution instead of full res: the WebGL
    // buffer is one texel per `pixelSize` CSS px, i.e. per font pixel, then upscaled
    // nearest-neighbor, so the polyhedron is drawn on the same chunky pixel grid as the
    // text. Since a cell is 16x38 = (8x19) * pixelSize, the buffer is always a whole
    // number of texels and the upscale is an exact integer.
    pixelateRender: true,

    vignette: true, // darkened screen corners, hinting at old-glass falloff
    vignetteOpacity: 0.55,

    // Bloom. One intensity drives both the CSS text glow and the WebGL UnrealBloom over
    // the 3D view, so they read as a single glass bloom. The glow color is derived from
    // whatever the lit pixels are, so white text gives a white bloom. radius and
    // threshold shape only the 3D pass.
    bloom: {
      intensity: 1.2, // master glow strength for both text and 3D (0 = off)
      scale_3d: 0.2, // glow strength multiplier for 3D only
      radius: 0, // 3D bloom spread
      threshold: 0.05, // 3D bloom luminance threshold (only brighter pixels bloom)
    },
  },

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  render: {
    backgroundColor: 0x10141c, // backlight color

    faceColor: 0xffffff, // base/fallback shape color; per-face colors come from `palette`
    faceOpacity: 0.92,

    // Face colors for both dark and light modes, keyed by swatch name — the same names
    // the `colors.schemes` groups pick. Each is stored as OKLab `{ l, a, b }` (l ≈ 0..1
    // lightness, a green↔red, b blue↔yellow), the perceptual space the synthesized tint
    // and blend swatches are mixed in (geometry/colors.ts), so blending needs no
    // sRGB↔OKLab round-trip. `face` is the on-screen color against the dark backlight;
    // `l_face` is its light-export variant. These come from the sRGB face hexes: white
    // #ffffff / #e6e6e6, yellow #ffd24a / #f2c230, red #e0524a, blue #4a78e0.
    palette: {
      white:   {   face: { l: 1, a: 0, b: 0 },
                 l_face: { l: 0.92494, a: 0, b: 0 } }, // fallback color
      yellow:  {   face: { l: 0.87967, a: -0.00016, b:  0.15541 },
                 l_face: { l: 0.83396, a:  0.00287, b:  0.15841 } },
      red:     {   face: { l: 0.62816, a:  0.15962, b:  0.08035 },
                 l_face: { l: 0.62816, a:  0.15962, b:  0.08035 } },
      blue:    {   face: { l: 0.59351, a: -0.01719, b: -0.16530 },
                 l_face: { l: 0.59351, a: -0.01719, b: -0.16530 } },
    },

    // Color schemes: the swatch each symmetry orbit renders as, holding color
    // information only. The geometric id vectors that resolve to each orbit are derived
    // in geometry/colors.ts: the tetrahedral orbits are the tetrahedron's one-hot
    // element ids, and the octahedral / icosahedral ones are those pushed through the
    // `colors.operations` rules (the octahedron is a rectify of the tetrahedron, the
    // icosahedron a snub of the octahedron), so editing an operation rule automatically
    // recolors the directly-loaded Platonic solids to match. Each `swatch` names an
    // entry in `palette` above; edit one to recolor that whole orbit.
    schemes: {
      tetrahedral: {
        face: { swatch: "white" },
        vert: { swatch: "yellow" },
        edge: { swatch: "red" },
      },
      octahedral: {
        // Each face of the octahedron comes from either a face of the tetrahedron or,
        // via rectification, a vertex of it. Dually, each vertex of the cube comes from
        // a vertex of the tetrahedron or, via joining, a face of it.
        face: { swatch: "yellow" },
        // Each vertex of the octahedron comes from an edge of the tetrahedron via
        // rectification. Dually, each face of the cube comes from an edge, via joining.
        vert: { swatch: "red" },
        // Each edge of the octahedron comes from a vertex of the tetrahedron truncated
        // into an adjacent face. Dually, each edge of the cube from a face, via joining.
        edge: { swatch: "blue" },
      },
      icosahedral: {
        // Each face of the icosahedron comes from a face of the octahedron, or an edge
        // of it opened as a vertex via snubbing. Dually, each vertex of the dodecahedron
        // comes from a vertex of the cube, or an edge split as a face via gyro-ing.
        face: { swatch: "yellow" },
        // Each vertex of the icosahedron comes from a vertex of the octahedron slid
        // along an edge via snubbing. Dually, each face of the dodecahedron from a face
        // of the cube expanded from an edge via gyro-ing.
        vert: { swatch: "red" },
        // Each edge of the icosahedron comes from a vertex of the octahedron or a face
        // adjacent to it. Dually, each edge of the dodecahedron from a face of the cube,
        // or a face or edge gyro-ed around a vertex.
        edge: { swatch: "blue" },
      },
    },

    // How long (seconds) the face colors fade from the drag colors to the committed
    // colors after release. Also drives the special-solid recolor.
    colorFadeSeconds: 0.4,

    showEdges: true,

    // Colored edge tubes. An edge whose color is not the default swatch, i.e. one in a
    // distinctly-colored symmetry orbit, is hard to make out as a thin line, so it is
    // drawn as a small tube instead, in both the main view and the library browser.
    // This radius is the main view's (the library has its own,
    // `library.coloredEdgeTubeRadius`): the tube's world radius at the default camera
    // distance, `camera.startDistance`. Like the drag line and markers, it rescales with
    // distance so the tube keeps a constant apparent thickness at any zoom, and since
    // both views calibrate against that same distance, equal radii look equally thick in
    // each. `coloredEdgeTubeSegments` is how many sides the tube's cross-section has
    // (higher is rounder, with more triangles).
    coloredEdgeTubeRadius: 0.00175,
    coloredEdgeTubeSegments: 6,

    // An edge whose color is a primary swatch — one of the base swatches in `palette`,
    // rather than a synthesized `avg(...)` / `tint(...)` blend — is drawn this many times
    // thicker than a blend-colored edge, so the pure symmetry-orbit edges stand out. 1
    // disables the emphasis (every tube the same radius).
    primarySwatchEdgeThickness: 2,

    // Pickable handle markers. Radii are the on-screen size at the default camera
    // distance; markers rescale with zoom to keep that apparent size.
    vertexMarkerColor: 0xe0e0e0,
    vertexMarkerRadius: 0.04,
    faceMarkerColor: 0xe0e0e0,
    faceMarkerRadius: 0.05,
    edgeMarkerColor: 0xe0e0e0,
    edgeMarkerRadius: 0.04,
    showVertexMarkers: true,
    showFaceMarkers: true,
    showEdgeMarkers: true,
    // Opacity of a marker when it is only a proximity hint, not yet in range.
    markerProximityOpacity: 0.32,

    // Feedback colors.
    hoverColor: 0xffffff, // element under the cursor, in range
    selectedColor: 0x5ad7ff, // multi-selected elements: a cyan accent, distinct from hover
    dragColor: 0xff7043, // reserved: drag state for markers

    // The drag range line, from the current point to the max. A white tube whose radius
    // is its on-screen width at the default camera distance, rescaling with zoom.
    dragLineColor: 0xffffff,
    dragLineRadius: 0.005,

    // Small sphere on the vertex currently targeted by the drag, like the hover marker
    // but smaller. Radius is the on-screen size at the default camera distance.
    dragMarkerColor: 0xffffff,
    dragMarkerRadius: 0.025,

    // The gyro rotation-arc handle. It reuses the drag range line's color and tube
    // radius (dragLineColor / dragLineRadius) so it matches the other drag lines. The
    // full-extent arc is drawn at this opacity, a faint guide to the available sweep,
    // while the progress sub-arc drawn during a twist is fully opaque.
    twistArcHintOpacity: 0.5,
    twistArcSegments: 40, // tube segments across the full arc span

    // Translucent overlay drawn over the hovered face.
    faceHighlightColor: 0xffffff,
    faceHighlightOpacity: 0.22,

    // The light export look, used only by the <name>_light.png save: a clean printable
    // render, square, high-res, no bloom, white background. The on-screen palette is
    // tuned for a dark backlight, so each palette entry carries an `l_face` light
    // variant (white becomes light grey, so it reads on white paper), and its light edge
    // is the same darken of `l_face`. The faces are drawn opaque.
    light: {
      resolution: 2048, // square px of the exported image
      backgroundColor: 0xffffff, // white paper background
      faceOpacity: 1, // opaque, unlike the translucent on-screen faces
    },
  },
} as const;

export type Config = typeof config;
