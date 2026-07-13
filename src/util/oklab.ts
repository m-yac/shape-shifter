/**
 * OKLab color functions adapted from https://bottosson.github.io/posts/gamutclipping/
 * with two additional functions for projecting in the L direction
 */

/** A color in the OKLab perceptual space, the form the palette is stored in. */
export type OKLab = { readonly l: number; readonly a: number; readonly b: number };

/** A color in the RGB perceptual space. */
export type RGB = { readonly r: number, readonly g: number, readonly b: number };

export function oklab_to_linear_srgb(c: OKLab): RGB {
  const l_ = c.l + 0.3963377774 * c.a + 0.2158037573 * c.b;
  const m_ = c.l - 0.1055613458 * c.a - 0.0638541728 * c.b;
  const s_ = c.l - 0.0894841775 * c.a - 1.2914855480 * c.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

/**
 * Finds the maximum saturation possible for a given hue that fits in sRGB
 * Saturation here is defined as S = C/L
 * a and b must be normalized so a^2 + b^2 == 1
 * NOTE: iterations parameter added by @m-yac
 */
function compute_max_saturation(a: number, b: number, iterations: number = 1): number {
  // NOTE: Added by @m-yac
  if (a == 0 && b == 0) return 1;

  // Max saturation will be when one of r, g or b goes below zero.

  // Select different coefficients depending on which component goes below zero first
  let k0, k1, k2, k3, k4, wl, wm, ws;

  if (-1.88170328 * a - 0.80936493 * b > 1) {
    // Red component
    k0 = +1.19086277; k1 = +1.76576728; k2 = +0.59662641; k3 = +0.75515197; k4 = +0.56771245;
    wl = +4.0767416621; wm = -3.3077115913; ws = +0.2309699292;
  }
  else if (1.81444104 * a - 1.19445276 * b > 1) {
    // Green component
    k0 = +0.73956515; k1 = -0.45954404; k2 = +0.08285427; k3 = +0.12541070; k4 = +0.14503204;
    wl = -1.2684380046; wm = +2.6097574011; ws = -0.3413193965;
  }
  else {
    // Blue component
    k0 = +1.35733652; k1 = -0.00915799; k2 = -1.15130210; k3 = -0.50559606; k4 = +0.00692167;
    wl = -0.0041960863; wm = -0.7034186147; ws = +1.7076147010;
  }

  // Approximate max saturation using a polynomial:
  let S = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;

  // Do one step Halley's method to get closer
  // this gives an error less than 10e6, except for some blue hues where the dS/dh is close to infinite
  // this should be sufficient for most applications, otherwise do two/three steps 

  const k_l = +0.3963377774 * a + 0.2158037573 * b;
  const k_m = -0.1055613458 * a - 0.0638541728 * b;
  const k_s = -0.0894841775 * a - 1.2914855480 * b;

  for (let i = 0; i < iterations; i++) {
    const l_ = 1.0 + S * k_l;
    const m_ = 1.0 + S * k_m;
    const s_ = 1.0 + S * k_s;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    const l_dS = 3.0 * k_l * l_ * l_;
    const m_dS = 3.0 * k_m * m_ * m_;
    const s_dS = 3.0 * k_s * s_ * s_;

    const l_dS2 = 6.0 * k_l * k_l * l_;
    const m_dS2 = 6.0 * k_m * k_m * m_;
    const s_dS2 = 6.0 * k_s * k_s * s_;

    const f  = wl * l   + wm * m   + ws * s;
    const f1 = wl * l_dS  + wm * m_dS  + ws * s_dS;
    const f2 = wl * l_dS2 + wm * m_dS2 + ws * s_dS2;
    
    S = S - f * f1 / (f1*f1 - 0.5 * f * f2);
  }

  return S;
}

/**
 * Finds L_cusp and C_cusp for a given hue
 * a and b must be normalized so a^2 + b^2 == 1
 * NOTE: iterations parameter added by @m-yac
 */
type LC = { L: number, C: number };
function find_cusp(a: number, b: number, iterations: number = 1): LC {
  // First, find the maximum saturation (saturation S = C/L)
  let S_cusp = compute_max_saturation(a, b, iterations);

  // Convert to linear sRGB to find the first point where at least one of r,g or b >= 1:
  const rgb_at_max = oklab_to_linear_srgb({ l: 1, a: S_cusp * a, b: S_cusp * b });
  let L_cusp = Math.cbrt(1.0 / Math.max(Math.max(rgb_at_max.r, rgb_at_max.g), rgb_at_max.b));
  let C_cusp = L_cusp * S_cusp;

  return { L: L_cusp , C: C_cusp };
}

/**
 * Finds intersection of the line defined by 
 * L = L0 * (1 - t) + t * L1;
 * C = t * C1;
 * a and b must be normalized so a^2 + b^2 == 1
 * NOTE: doLowerHalf parameter added by @m-yac
 */
function find_gamut_intersection(a: number, b: number, L1: number, C1: number,
                                 L0: number, doLowerHalf: boolean = true): number {
  // Find the cusp of the gamut triangle
  const cusp = find_cusp(a, b);

  // Find the intersection for upper and lower half seprately
  let t;
  if (doLowerHalf && ((L1 - L0) * cusp.C - (cusp.L - L0) * C1) <= 0.0) {
    // Lower half

    t = cusp.C * L0 / (C1 * cusp.L + cusp.C * (L0 - L1));
  }
  else {
    // Upper half

    // First intersect with triangle
    t = cusp.C * (L0 - 1.0) / (C1 * (cusp.L - 1.0) + cusp.C * (L0 - L1));

    // Then one step Halley's method
    {
      const dL = L1 - L0;
      const dC = C1;

      const k_l = +0.3963377774 * a + 0.2158037573 * b;
      const k_m = -0.1055613458 * a - 0.0638541728 * b;
      const k_s = -0.0894841775 * a - 1.2914855480 * b;

      const l_dt = dL + dC * k_l;
      const m_dt = dL + dC * k_m;
      const s_dt = dL + dC * k_s;

      // If higher accuracy is required, 2 or 3 iterations of the following block can be used:
      {
        const L = L0 * (1.0 - t) + t * L1;
        const C = t * C1;

        const l_ = L + C * k_l;
        const m_ = L + C * k_m;
        const s_ = L + C * k_s;

        const l = l_ * l_ * l_;
        const m = m_ * m_ * m_;
        const s = s_ * s_ * s_;

        const ldt = 3 * l_dt * l_ * l_;
        const mdt = 3 * m_dt * m_ * m_;
        const sdt = 3 * s_dt * s_ * s_;

        const ldt2 = 6 * l_dt * l_dt * l_;
        const mdt2 = 6 * m_dt * m_dt * m_;
        const sdt2 = 6 * s_dt * s_dt * s_;

        const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s - 1;
        const r1 = 4.0767416621 * ldt - 3.3077115913 * mdt + 0.2309699292 * sdt;
        const r2 = 4.0767416621 * ldt2 - 3.3077115913 * mdt2 + 0.2309699292 * sdt2;

        const u_r = r1 / (r1 * r1 - 0.5 * r * r2);
        let t_r = -r * u_r;

        const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s - 1;
        const g1 = -1.2684380046 * ldt + 2.6097574011 * mdt - 0.3413193965 * sdt;
        const g2 = -1.2684380046 * ldt2 + 2.6097574011 * mdt2 - 0.3413193965 * sdt2;

        const u_g = g1 / (g1 * g1 - 0.5 * g * g2);
        let t_g = -g * u_g;

        const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s - 1;
        const b1 = -0.0041960863 * ldt - 0.7034186147 * mdt + 1.7076147010 * sdt;
        const b2 = -0.0041960863 * ldt2 - 0.7034186147 * mdt2 + 1.7076147010 * sdt2;

        const u_b = b1 / (b1 * b1 - 0.5 * b * b2);
        let t_b = -b * u_b;

        t_r = u_r >= 0.0 ? t_r : Number.MAX_VALUE;
        t_g = u_g >= 0.0 ? t_g : Number.MAX_VALUE;
        t_b = u_b >= 0.0 ? t_b : Number.MAX_VALUE;

        t += Math.min(t_r, Math.min(t_g, t_b));
      }
    }
  }

  return t;
}

/**
 * Finds the upper intersection of the line defined by 
 * L = t * L1;
 * C = C0 * (1 - t) + t * C1;
 * a and b must be normalized so a^2 + b^2 == 1
 * NOTE: Added by @m-yac
 */
function find_gamut_C_intersection(a: number, b: number, L1: number, C1: number,
                                   C0: number): number {
  // Find the cusp of the gamut triangle
  const cusp = find_cusp(a, b);

  if (L1 * (cusp.C - 1.0) + cusp.L * (C0 - C1) == 0) {
    return 1;
  }

  // First intersect with triangle
  let t = cusp.L * (C0 - 1.0) / (L1 * (cusp.C - 1.0) + cusp.L * (C0 - C1));
  
  // Then one step Halley's method
  {
    const dL = L1;
    const dC = C1 - C0;

    const k_l = +0.3963377774 * a + 0.2158037573 * b;
    const k_m = -0.1055613458 * a - 0.0638541728 * b;
    const k_s = -0.0894841775 * a - 1.2914855480 * b;

    const l_dt = dL + dC * k_l;
    const m_dt = dL + dC * k_m;
    const s_dt = dL + dC * k_s;

    // If higher accuracy is required, 2 or 3 iterations of the following block can be used:
    {
      const L = t * L1;
      const C = C0 * (1.0 - t) + t * C1;

      const l_ = L + C * k_l;
      const m_ = L + C * k_m;
      const s_ = L + C * k_s;

      const l = l_ * l_ * l_;
      const m = m_ * m_ * m_;
      const s = s_ * s_ * s_;

      const ldt = 3 * l_dt * l_ * l_;
      const mdt = 3 * m_dt * m_ * m_;
      const sdt = 3 * s_dt * s_ * s_;

      const ldt2 = 6 * l_dt * l_dt * l_;
      const mdt2 = 6 * m_dt * m_dt * m_;
      const sdt2 = 6 * s_dt * s_dt * s_;

      const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s - 1;
      const r1 = 4.0767416621 * ldt - 3.3077115913 * mdt + 0.2309699292 * sdt;
      const r2 = 4.0767416621 * ldt2 - 3.3077115913 * mdt2 + 0.2309699292 * sdt2;

      const u_r = r1 / (r1 * r1 - 0.5 * r * r2);
      let t_r = -r * u_r;

      const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s - 1;
      const g1 = -1.2684380046 * ldt + 2.6097574011 * mdt - 0.3413193965 * sdt;
      const g2 = -1.2684380046 * ldt2 + 2.6097574011 * mdt2 - 0.3413193965 * sdt2;

      const u_g = g1 / (g1 * g1 - 0.5 * g * g2);
      let t_g = -g * u_g;

      const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s - 1;
      const b1 = -0.0041960863 * ldt - 0.7034186147 * mdt + 1.7076147010 * sdt;
      const b2 = -0.0041960863 * ldt2 - 0.7034186147 * mdt2 + 1.7076147010 * sdt2;

      const u_b = b1 / (b1 * b1 - 0.5 * b * b2);
      let t_b = -b * u_b;

      t_r = u_r >= 0.0 ? t_r : Number.MAX_VALUE;
      t_g = u_g >= 0.0 ? t_g : Number.MAX_VALUE;
      t_b = u_b >= 0.0 ? t_b : Number.MAX_VALUE;

      t += Math.min(t_r, Math.min(t_g, t_b));
    }
  }

  return t;
}

/**
 * Lightness is kept constant if it is between zero and one, otherwise it is
 * clamped. This is done by projecting towards (L0, C0) = (clamp(L1, 0, 1), C0)
 */
export function gamut_clip_L_preserve_chroma(lab: OKLab): OKLab {
  const L = lab.l;
	const eps = 0.00001;
	const C = Math.max(eps, Math.sqrt(lab.a * lab.a + lab.b * lab.b));
	const a_ = lab.a / C;
	const b_ = lab.b / C;

	const L0 = Math.max(0, Math.min(1, lab.l));

	const t = find_gamut_intersection(a_, b_, L, C, L0);
	const L_clipped = L0 * (1 - t) + t * L;
	const C_clipped = t * C;

	return { l: L_clipped, a: C_clipped * a_, b: C_clipped * b_ };
}

/**
 * Chroma is kept constant if it is in gamut and lightness is maximized
 * NOTE: Added by @m-yac
 */
export function gamut_clip_C_preserve_chroma(lab: OKLab): OKLab {
  const L = lab.l;
	const eps = 0.00001;
	const C = Math.max(eps, Math.sqrt(lab.a * lab.a + lab.b * lab.b));
	const a_ = lab.a / C;
	const b_ = lab.b / C;

	const t = find_gamut_C_intersection(a_, b_, L, C, C);
	const L_clipped = t * L;

	return { l: L_clipped, a: lab.a, b: lab.b };
}

/**
 * Colors are projected towards the bottom of the valid grayscale colors
 * NOTE: Adapted from gamut_clip_project_to_0_5 by @m-yac
 */
export function gamut_clip_project_to_0(lab: OKLab): OKLab {
	const L = lab.l;
	const eps = 0.00001;
	const C = Math.max(eps, Math.sqrt(lab.a * lab.a + lab.b * lab.b));
	const a_ = lab.a / C;
	const b_ = lab.b / C;

	const L0 = 0.0;

	const t = find_gamut_intersection(a_, b_, L, C, L0, false);
	const L_clipped = L0 * (1 - t) + t * L;
	const C_clipped = t * C;

	return { l: L_clipped, a: C_clipped * a_, b: C_clipped * b_ };
}

/**
 * Colors are set to their hue's cusp
 * NOTE: Adapted from gamut_clip_project_to_0_5 by @m-yac
 */
export function gamut_clip_cusp(lab: OKLab): OKLab {
	const eps = 0.00001;
	const C = Math.max(eps, Math.sqrt(lab.a * lab.a + lab.b * lab.b));
	const a_ = lab.a / C;
	const b_ = lab.b / C;

	const cusp = find_cusp(a_, b_, 10);

	return { l: cusp.L, a: cusp.C * a_, b: cusp.C * b_ };
}