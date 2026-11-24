# OPC4 Heartbeat Monitor: Setup Guide

This macro lets your Cisco video system check that the Ochno OPC4 is alive. It raises an alert if the OPC4 stops responding and can show the OPC4 status on the touch panel.

## What you need

- A Cisco device on **RoomOS 11.14.2.3 or later**, in **shared mode** (not personal mode). Microsoft Teams Rooms devices: test first, as Cisco only partly supports macros in that mode.
- **Admin** access to the Cisco device's web interface (only during setup).
- The file `opc4-heartbeat-monitor.js` (provided by Ochno).
- The IP address of the Cisco device.
- Optional: a webhook URL (e.g. Microsoft Teams / Power Automate) if alerts should be sent somewhere.

## Steps

1. **Create a user for the OPC4.**
   Web interface → **Users** → add a new user (e.g. `opc4`) with the role **RoomControl** only and a strong password. Do not use an Admin account for the OPC4.
   Webex cloud-registered device: Control Hub → Devices → your device → Support → **Launch Local Device Controls** → Users. Log in once as the new user to set its password (required from RoomOS 11.27).

2. **Allow HTTPS access.**
   Web interface → **Settings** → `NetworkServices` → `HTTP Mode` = **HTTPS**.

3. **Install the macro.**
   Web interface → **Customization** → **Macro Editor** → **Create new macro** → name it `opc4_heartbeat_monitor` → paste the full content of `opc4-heartbeat-monitor.js`.
   If you are asked to enable macros, choose **Yes**.

4. **Choose your options** (at the top of the macro, in `CONFIG`):
   - `showStatusPanel: true` adds an **OPC4 Status** panel in the **Control Panel** of the touch panel. Leave it `false` for no visible UI.
   - `teamsMsgUrl: 'https://...'` sends alerts to your webhook. Leave it empty to only log them.
   - `company` / `site` are your names, included in alerts.

5. **Save and enable.** Press **Save** and switch the macro toggle **on**.

6. **Connect the OPC4.** In the OPC4 settings, enter the Cisco device IP address and the `opc4` user and password from step 1.

7. **Check it works.** In the Macro Editor log you should see, within about 30 seconds:
   `Heartbeat received via widget: seq=... (ok)`
   With the panel enabled, open the **Control Panel** on the touch panel → **OPC4 Status**.

## Good to know

- Only one copy of the macro should be enabled.
- Right after the macro starts, the panel shows `N/A` and `Waiting for update` until the OPC4 reports its status. `None` means the OPC4 reported that nothing is connected / no port is active.
- **State** on the panel: `ONLINE` = the OPC4 is responding. `OFFLINE` = no heartbeat from the OPC4 for over a minute: check its power, network and login details. `N/A` = nothing received yet since the macro started.
- Changes to the panel layout are made in the macro, not in the UI Extensions editor.
- To remove: delete the macro in the Macro Editor and the **OPC4 Status** / **OPC4 Heartbeat Source** panels in the UI Extensions editor.

For details and troubleshooting, see `README.md`, or contact Ochno support.
