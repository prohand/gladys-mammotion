// -----------------------------------------------------------------------------
// Mowing setting ranges of each mower model.
//
// The app only offers the values a model accepts: a Luba 2 cuts from 25 to
// 70 mm, a Luba mini from 20 to 65 mm, a Yuka has no height to set… The
// ranges come from the PyMammotion capability tables
// (data/model/device_capabilities.py) and from the app itself (Luba 2 X:
// 0.2 to 0.8 m/s, 20 to 32 cm). Those tables are keyed by an internal model
// code the cloud does not give: the family is read from the technical name
// of the mower ("Luba-VS…", "Yuka-MN…"), the most common variant of the
// family wins. The "H" variants (high cut, 55 to 100 mm) cannot be told
// apart by their name: the reported blade height widens the range (see
// heightRange).
// -----------------------------------------------------------------------------

import { MOWING_BOUNDS } from '../config.js';

// Families by technical name prefix, most specific first.
const FAMILIES = [
  {
    // Luba 2 X / Luba 2 AWD X (Luba-VP…): the app goes up to 0.8 m/s and 32 cm.
    name: /^luba-vp/i,
    limits: { blade_height: [25, 70], mowing_speed: [0.2, 0.8], line_spacing: [20, 32] },
  },
  {
    // Luba 2 (Luba-VS…, Luba-VA…).
    name: /^luba-v[sa]/i,
    limits: { blade_height: [25, 70], mowing_speed: [0.2, 1.2], line_spacing: [20, 35] },
  },
  {
    // Luba mini / Luba 2 Lidar (Luba-MN…, Luba-LD…).
    name: /^luba-(mn|ld)/i,
    limits: { blade_height: [20, 65], mowing_speed: [0.2, 1.2], line_spacing: [8, 14] },
  },
  {
    // Yuka mini (Yuka-MN…, Yuka-YM…): no height to set.
    name: /^yuka-(mn|ym|vp)/i,
    limits: { blade_height: null, mowing_speed: [0.2, 1.2], line_spacing: [8, 12] },
  },
  {
    // Yuka: no height to set.
    name: /^yuka-/i,
    limits: { blade_height: null, mowing_speed: [0.2, 1.2], line_spacing: [15, 30] },
  },
  {
    // Luba 1 (Luba-…).
    name: /^luba-/i,
    limits: { blade_height: [30, 70], mowing_speed: [0.2, 1.2], line_spacing: [20, 35] },
  },
];

// High cut variants ("H"): 55 to 100 mm on every family that has one.
const HIGH_CUT = [55, 100];

const DEFAULT_LIMITS = {
  blade_height: MOWING_BOUNDS.blade_height,
  mowing_speed: MOWING_BOUNDS.mowing_speed,
  line_spacing: MOWING_BOUNDS.line_spacing,
};

/**
 * Ranges of the model-dependent settings of a mower. A null range means the
 * setting does not apply (Yuka blade height).
 * @param {{ deviceName?: string, bladeHeightMm?: number | null }} mower
 * @returns {{ blade_height: [number, number] | null, mowing_speed: [number, number],
 *   line_spacing: [number, number] }}
 */
export function modelLimits(mower) {
  const family = FAMILIES.find((f) => f.name.test(mower?.deviceName ?? ''));
  const limits = { ...(family?.limits ?? DEFAULT_LIMITS) };
  limits.blade_height = heightRange(limits.blade_height, mower?.bladeHeightMm);
  return limits;
}

/**
 * Blade height range, widened to the high cut range when the mower reports a
 * height above its family range (an "H" variant).
 */
function heightRange(range, reported) {
  if (!range || !Number.isFinite(reported) || reported <= range[1]) {
    return range;
  }
  return HIGH_CUT;
}

/** Clamp a value in a [min, max] range (no range: unchanged). */
export function clampTo(value, range) {
  if (!range) {
    return value;
  }
  return Math.min(range[1], Math.max(range[0], value));
}
