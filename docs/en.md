# Mammotion

Control your Mammotion robot lawn mower (Luba, Luba 2, Luba mini, Yuka…) from
Gladys: start mowing, pause, send the mower back to its dock, and follow its
battery and status.

## What you get

Each mower of your Mammotion account shows up with:

- **Mowing** (switch): on = start or resume mowing, off = pause;
- **Return to dock** (switch): on = go back to the dock, off = cancel;
- **Status**: Mowing, Charging, Paused, Returning to dock, Offline…;
- **Battery** (%) and **Charging**;
- **Blade height** (mm), **Total mowing time** (h), **Total distance** (km).

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

- Start mowing on Saturday at 10 am if the battery is above 80%.
- Send the mower back to its dock when the rain sensor detects rain.
- Get a message when the status becomes "Location error".

## Troubleshooting

- **"Mammotion cloud unreachable"**: check the email and password, then click
  **Test the connection**.
- **No mower found**: make sure the mower shows up in the Mammotion app with
  this account (owner or shared).
- **Values do not change**: click **Refresh the mowers now**, or lower the
  refresh interval.
- For details, read the integration logs with `LOG_LEVEL=debug`.
