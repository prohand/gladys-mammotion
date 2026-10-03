# Mammotion

Control your Mammotion robot lawn mower (Luba, Luba 2, Luba mini, Yuka…) from
Gladys: start mowing, pause and resume, send the mower back to its dock, and
follow its battery, status and mowing progress.

## What you get

Each mower of your Mammotion account shows up with:

- **Mowing** (switch): on = start a job (or resume the paused one), off = pause;
- **Return to dock** (switch): on = go back to the dock, off = cancel. On a
  paused job, the job is ended first (like "Stop" in the app), or it would
  stay paused;
- **Refresh** (button): asks the mower for its state right now;
- **Status**: Mowing (45 %), Charging, Paused, Returning to dock, Offline…;
- **Battery** (%) and **Charging**;
- **Blade height** (mm), **Remaining mowing time** (min);
- **Total mowing time** (h), **Total distance** (km).

> **Start mowing** from Gladys (mower "Ready", on its dock or not), the way
> Home Assistant does:
>
> - a job that stopped halfway (battery, rain…) carries on where it was;
> - otherwise Gladys plans a route over **every zone** of the map (named or
>   not), or over those listed in "Zones to mow", with the settings of the
>   "New mowing job" section of the configuration (height, speed, spacing,
>   angle, pattern, perimeter laps, obstacle detection…), then starts the job.
>
> The Mammotion app keeps its settings on the phone: Gladys cannot read them,
> fill them in its configuration. This works with
> the mowers of the Mammotion broker (recent Luba 2, Luba mini, Yuka…), not
> with the Luba 1.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Enter the **email** and **password** of your Mammotion app account.
3. Set the **refresh interval** (300 s by default, between 30 and 3600 s): how
   often Gladys reads the mower status. Each read asks the mower for its
   state, which can briefly disturb the Mammotion app: keep 300 s or more.
4. Save, then click **Test the connection**: the number of mowers found is
   displayed.
5. Add your mowers from the **Discovery** tab. After an update of the
   integration, click **Update** in this tab to get the new features (the
   Refresh button for instance).

The **Charging** feature is deliberately **not** in the battery category.
Gladys warns "battery level under X%" for **every feature of the battery
category** below the threshold, whatever its type: a charging feature holds 0
or 1, so it was read as "0%". It is published as a **binary input** instead:
same yes/no value, same use in a scene, no false alert.

> Tip: create a second Mammotion account, share the mower with it from the
> app, and use that account here. Otherwise the app on your phone may be
> logged out when Gladys connects.

## Scene ideas

- Start mowing every Saturday at 10 am if it does not rain.
- Resume the paused job when the rain stops.
- Send the mower back to its dock when the rain sensor detects rain.
- Get a message when the status becomes "Location error".

## Troubleshooting

- **"Mammotion cloud unreachable"**: check the email and password, then click
  **Test the connection**.
- **No mower found**: make sure the mower shows up in the Mammotion app with
  this account (owner or shared).
- **Values do not change**: press **Refresh** (on the dashboard) or **Refresh
  the mowers now** (Configuration tab). Recent mowers
  (Mammotion broker) push their state on their own; Gladys asks them for a
  report at most every 5 minutes (and right after a command), to stay within
  the Mammotion cloud quota and not cut the app on your phone.
- **Mowing does not start**: read the logs. "The mower did not send its
  zones": the mower did not answer, try again. "Cannot start mowing now": the
  mower is not ready (returning to its dock, locked…).
- **"The battery level of … is under 20% (current: 0%)"** while the battery
  is full: that was the old **Charging** feature, filed in the battery
  category, which holds 0 whenever the mower is not charging. The new
  **Charging** feature is a binary input. The old one stays on the mowers
  added before: open the **Discovery** tab and click **Update** on the mower —
  Gladys deletes the features that are no longer published, and the alert
  stops.
- For details, read the integration logs with `LOG_LEVEL=debug`.
