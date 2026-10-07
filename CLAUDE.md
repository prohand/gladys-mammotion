# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 20+, ESM, no build step) for **Mammotion**
robot mowers (Luba, Luba 2, Luba mini, Yuka…). Each mower becomes a Gladys device: mowing switch,
return to dock, stop job, refresh button, status text, battery, charging, blade height, job
progress / elapsed / remaining, area, lifetime counters, zone switches and setting selects for the
next job; plus a separate camera device carrying the rendered map. The user signs in with their
Mammotion app account.

Runtime dependencies: `@gladysassistant/integration-sdk`, `mqtt` (Aliyun IoT and Mammotion
brokers) and `jpeg-js` (map image).

## Commands

```bash
npm install
npm test                                     # node --test (built-in runner)
node --test test/commands.test.js            # one file
node --test --test-name-pattern "zigzag"     # one test by name
npm run lint                                 # eslint .
npm run format:check                         # prettier --check . (CI gate)
npm run format                               # prettier --write .
```

CI runs `format:check`, `lint`, `test`. Releases: **Actions → Release** only (bumps
`package.json`, manifest `version` + `docker_image`, tags, builds). The release rewrites the
manifest with `jq`: run `npm run format` afterwards or CI fails.

## Architecture

```
index.js                  SDK wiring + orchestration: polls, commands, pushes, map, settings
src/config.js             defaults (account, interval, language, next-job settings), clamps
src/mammotion/http.js     Mammotion cloud HTTP (login, device list)
src/mammotion/aliyun.js   Aliyun IoT gateway (mowers bound there): auth, invoke, properties
src/mammotion/mqtt.js     Mammotion broker MQTT (mowers bound there): status pushes, commands
src/mammotion/client.js   one client hiding which backend a mower uses
src/mammotion/protobuf.js minimal protobuf encoder/decoder (no dependency)
src/mammotion/commands.js mower orders (start job, pause, dock, stop, sync, report request)
src/mammotion/report.js   device report parsing
src/mammotion/telemetry.js status mapping (work mode -> text, progress, counters)
src/mammotion/models.js   model families and their ranges (blade height, speed, spacing...)
src/devices/mower.js      discovery payload and states of a mower
src/devices/settings.js   next-job settings as select features
src/devices/index.js      device lookup helpers
src/map/render.js, font.js  map rendering to JPEG for the camera device
src/scenes.js             scene triggers (transitions) and scene action outputs (pure)
src/widgets.js            dashboard widget `mower` (pure, built from the last status)
```

### Invariants worth knowing

- **Two backends**: mowers bound on Aliyun are read and driven through the Aliyun IoT gateway;
  mowers on the Mammotion broker push their state over MQTT (published at most every 15 s,
  `PUSH_THROTTLE_MS`). `client.js` hides which one a mower uses.
- **Every message to the mower disturbs the Mammotion app**: a refused or useless order sends
  nothing; the mower is synced before an order, and a report is only requested when needed.
- **Starting a job is a real job**: zones (none switched on = every zone) and the configured
  settings (blade height, speed, spacing, angle, pattern, laps, obstacle detection) are sent. The
  app keeps its own settings on the phone; the mower cannot give them back.
- **Polling**: Gladys `poll_frequency` is an enum in ms (1 s–60 s, any other value rejects the
  whole discovery); `devicePollFrequency()` picks the tick and `onPoll` skips calls inside the
  configured interval. Devices carry `should_poll: true` (without it Gladys never polls them;
  the flag is read at creation only), and index.js runs its own one-minute loop over the
  created mowers; both paths go through `pollMowerIfDue()`.
- **No fake values**: the 0 % battery a mower reports while asleep is not published (it fired
  false low-battery alerts).
- **The map is a camera image** refreshed by a keep-alive timer so Gladys never shows it stale.
- **Every feature declares `min`/`max`** (NOT NULL in Gladys); text states go in the `text` field.
- The account password and tokens are secrets: never log them.
- **Gladys 5.1 capabilities** (`gladys_version >=5.1.0`): the widget and `get_mower_status`
  answer from the last status in memory (`lastStatuses`), never from a message to the mower.
  Scene triggers are transitions computed by `MowerEventTracker` on every status (poll or
  push): the first status after a start only records, an unknown work mode moves nothing, and
  a recharge in the middle of a job does not end it. The order actions and the widget buttons
  go through `controlMower`, the same path as the device features. Widget, trigger, action,
  field, variable, output and option keys are stored by users: never rename them.

### Manifest

`test/manifest.test.js` keeps `gladys-assistant-integration.json` in sync with `DEFAULT_CONFIG`,
the bounds and the select options.

## Testing

No network: MQTT and HTTP are faked; protobuf frames and telemetry come from captured payloads;
`test/helpers/fakeGladys.js` stands in for the SDK.

## Conventions

Prettier formats, ESLint catches mistakes. Comments explain **why**. The README and `docs/fr.md`
are French, `docs/en.md` English: keep them in sync. The container rootfs is read-only: write
nothing.
