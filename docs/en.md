# Mammotion

Control your Mammotion robot lawn mower (Luba, Luba 2, Luba mini, Yuka…) from
Gladys: pause and resume mowing, send the mower back to its dock, and follow
its battery, status and mowing progress.

## What you get

Each mower of your Mammotion account shows up with:

- **Mowing** (switch): on = resume a paused job, off = pause;
- **Return to dock** (switch): on = go back to the dock, off = cancel;
- **Status**: Mowing (45 %), Charging, Paused, Returning to dock, Offline…;
- **Battery** (%) and **Charging**;
- **Blade height** (mm), **Remaining mowing time** (min);
- **Total mowing time** (h), **Total distance** (km).

> A **new** job is still started from the Mammotion app: it needs a route
> planned on the map (zones, settings), which the integration cannot do yet.
> Gladys can then pause it, resume it and send the mower back to its dock.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Enter the **email** and **password** of your Mammotion app account.
3. Set the **refresh interval** (60 s by default, between 30 and 3600 s): how
   often Gladys reads the mower status.
4. Save, then click **Test the connection**: the number of mowers found is
   displayed.
5. Add your mowers from the **Discovery** tab.

> Tip: create a second Mammotion account, share the mower with it from the
> app, and use that account here. Otherwise the app on your phone may be
> logged out when Gladys connects.

## Scene ideas

- Resume the paused job when the rain stops.
- Send the mower back to its dock when the rain sensor detects rain.
- Get a message when the status becomes "Location error".

## Troubleshooting

- **"Mammotion cloud unreachable"**: check the email and password, then click
  **Test the connection**.
- **No mower found**: make sure the mower shows up in the Mammotion app with
  this account (owner or shared).
- **Values do not change**: click **Refresh the mowers now**. Recent mowers
  (Mammotion broker) push their state on their own; Gladys asks them for a
  report at most every 5 minutes (and right after a command), to stay within
  the Mammotion cloud quota and not cut the app on your phone.
- For details, read the integration logs with `LOG_LEVEL=debug`.
