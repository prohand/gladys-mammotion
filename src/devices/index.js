// -----------------------------------------------------------------------------
// Mower registry.
//
// Unlike a fixed catalog, the devices of this integration come from the
// Mammotion account: `setMowers()` stores the list returned by the cloud, and
// the helpers below build the discovery payload and route Gladys events
// (onPoll / onSetValue) back to the right mower.
// -----------------------------------------------------------------------------

import { buildMapDevice, buildMowerDevice, featureKeyOf, mapIds, mowerIds } from './mower.js';

/** @type {Array<{ iotId: string, name: string, productKey: string, deviceName: string, series: string }>} */
let mowers = [];

// Last known work mode per iotId, to choose "start" vs "resume".
const lastWorkMode = new Map();

export function setMowers(list) {
  mowers = [...list];
}

export function getMowers() {
  return mowers;
}

export function rememberWorkMode(mower, workMode) {
  if (workMode !== null && workMode !== undefined) {
    lastWorkMode.set(mower.iotId, workMode);
  }
}

export function lastKnownWorkMode(mower) {
  return lastWorkMode.get(mower.iotId) ?? null;
}

/** Discovery payload for Gladys (per mower: the mower and its map). */
export function buildDiscoveredDevices(gladys, config) {
  return mowers.flatMap((mower) => [
    buildMowerDevice(gladys, mower, config),
    buildMapDevice(gladys, mower, config),
  ]);
}

/** Find the mower behind a Gladys device, from its external_id. */
export function findMowerByDevice(gladys, device) {
  return mowers.find((mower) => mowerIds(gladys, mower).device === device.external_id);
}

/** Find the mower behind a map device, from its external_id. */
export function findMowerByMap(gladys, device) {
  return mowers.find((mower) => mapIds(gladys, mower).device === device.external_id);
}

/** Find the mower and the feature key behind a feature external_id. */
export function findMowerFeature(gladys, featureExternalId) {
  for (const mower of mowers) {
    const key = featureKeyOf(gladys, mower, featureExternalId);
    if (key) {
      return { mower, key };
    }
  }
  return null;
}
