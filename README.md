# OPC4 Cisco Heartbeat Monitor

A Cisco RoomOS macro that supervises an Ochno OPC4. It receives the OPC4 heartbeat and status (connected ports, active port, UC/BYOD mode), raises an alert when the heartbeat stops and another when it comes back, and can optionally show the status on the touch panel.

One macro file, no manual UI work: the macro creates any panel it needs by itself.

**Contents**
1. [Quick start](#1-quick-start)
2. [Installing the macro](#2-installing-the-macro)
3. [Touch UI panel (optional)](#3-touch-ui-panel-optional)
4. [How the OPC4 sends data (transports)](#4-how-the-opc4-sends-data-transports)
5. [All configuration options](#5-all-configuration-options)
6. [Alerts](#6-alerts)
7. [Log messages](#7-log-messages)
8. [Status after a restart](#8-status-after-a-restart)
9. [Removing everything](#9-removing-everything)
10. [Emulator, files, product support](#10-emulator-files-product-support)

---

## 1. Quick start

1. Codec web UI → **Customization → Macro Editor** → create a macro (e.g. `opc4_heartbeat_monitor_v2`).
2. Paste the whole content of `opc4-heartbeat-monitor.js`.
3. Optional: change the `CONFIG` block at the top (see [section 5](#5-all-configuration-options)). For a visible panel set `showStatusPanel: true`.
4. **Save** and switch the macro **on**.
5. Check the log: `Starting OPC4 heartbeat monitor v2`, followed by heartbeats such as `Heartbeat received via widget: seq=81 (ok)`.

That is all. With the default settings the macro works with the current OPC4 firmware and creates nothing visible.

---

## 2. Installing the macro

### Access and permissions

Two different accounts are involved. Keep them separate.

**1. Installer account (a person, one-off)**

| Task | Role needed |
| --- | --- |
| Open the Macro Editor, paste / save / enable the macro | **Admin** |
| Run `deploy-macro.ps1` (it also turns on `Macros Mode`) | **Admin** |
| Open the UI Extensions editor (only if you build your own panel) | **Admin** or **Integrator** |
| Read the macro log | **Admin** |

The installer account is not needed after installation. The macro itself runs inside the codec with full rights; it needs no account.

**2. OPC4 service account (the OPC4 device, permanent)**

Create a dedicated local user on the codec that only the OPC4 uses, with the lowest role that fits the transport:

| OPC4 sends via | Role for the OPC4 user |
| --- | --- |
| Widget (current firmware) | **RoomControl** |
| Peripheral heartbeat (optional) | **RoomControl** |
| Message Send (future firmware) | **Integrator** |

Do **not** give the OPC4 an Admin account. RoomControl can only operate UI extensions and room controls; it cannot change configuration, read call history or install macros. Roles per command can be checked in the RoomOS xAPI reference (roomos.cisco.com) for the codec's software version.

**3. Codec settings**

| Setting | Value | Why |
| --- | --- | --- |
| `NetworkServices HTTP Mode` | `HTTPS` (recommended) or `HTTP+HTTPS` | The OPC4 posts to `https://<codec>/putxml` |
| `Macros Mode` | `On` | Lets the macro run (the Macro Editor offers to switch it on; `deploy-macro.ps1` does it) |
| `HttpClient Mode` | `On`, only if alerts go to a webhook | Set automatically by the macro when `teamsMsgUrl` is filled in |

**4. Network**

| From → To | Port | When |
| --- | --- | --- |
| OPC4 → codec | TCP 443 (HTTPS) or 80 (HTTP) | Always |
| Installer PC → codec | TCP 443 / 80 | During installation only |
| Codec → webhook (Teams, Power Automate...) | TCP 443 | Only if `teamsMsgUrl` is set |

**5. Cloud-registered codecs (Webex / Control Hub)**

Only a Control Hub admin can create local users: **Control Hub → Devices → (device) → Support → Launch Local Device Controls → Users → Create User**. From RoomOS 11.27.2.0 a new user must change the default passphrase at first login, so log in once as the OPC4 user and set its password before configuring the OPC4. Macros can also be pushed from Control Hub (shared-mode devices only).

**Security recommendations**
- Use HTTPS between OPC4 and codec; plain HTTP sends the OPC4 password in clear text on the network.
- One OPC4 user per codec with a strong password; never reuse the admin password.
- Remove the installer's temporary accounts / passwords after installation if they were created only for this.

### Option A: Macro Editor (copy and paste)

Paste the file into the Macro Editor, save, switch on. Saving restarts the macro.

Make sure **only one** heartbeat macro is enabled. Switch off the old v1 macro or any second copy, otherwise both write the same widgets.

### Option B: `deploy-macro.ps1` (no web UI, good for many codecs)

```powershell
.\deploy-macro.ps1 -CiscoHost 192.168.6.1 -Username admin -Password '...' -UseHttp
```

Uploads the macro as `opc4_heartbeat_monitor_v2`, enables macros, activates it and restarts the macro runtime. Needs an **Admin** user. **Note:** a runtime restart restarts *all* macros on the codec for a few seconds; run it outside meetings on codecs with other macros. Options: `-MacroFile`, `-MacroName`, `-UseHttp`, `-AllowUntrustedCertificate`, `-Remove`.

To deploy with a different configuration, edit `CONFIG` in the file before running the script.

---

### Requirements and restrictions

**Software version**

| Feature | Minimum RoomOS | Note |
| --- | --- | --- |
| Macro itself (heartbeat, alerts, widget / message / peripheral transports) | **RoomOS 11.14** recommended | Written for the QuickJS macro engine: the default on-prem from 11.14.2.3, cloud from 11.11 (Dec 2023). Older firmware is not tested. |
| Status panel in the Control Panel (`showStatusPanel: true`) | **RoomOS 11.14.2.3** | Custom panels in the Control Panel were introduced in that release. On older software the panel is not created (logged as `Unable to install status panel`); the rest of the macro keeps working. |
| RoomOS 26 / 27 | Supported | The macro uses `import xapi from 'xapi'` (no `require`), so it is not affected by the removal of the Babel transpiler in RoomOS 27. |

Check the version: web interface → **Home**, or `xStatus SystemUnit Software Version`.

**Devices**

| Device / mode | Status |
| --- | --- |
| Room Bar, Room Bar Pro, Room Kit (Mini), Codec Plus / Pro / EQ, Room 55 / 70 / Panorama, Board / Board Pro (G2), Desk / Desk Mini / Desk Pro on RoomOS 11+ | Supported |
| Legacy CE devices (SX, MX, DX series) | Not supported (not on RoomOS 11) |
| Standalone Room Navigator / Navigator in Persistent Web App mode | Not supported (no Message Send / Peripherals; UI extensions not shown in PWA mode) |
| **Personal mode** devices | Not supported in practice: a local admin needs a factory reset before registration, and Control Hub macro deployment is shared-mode only |
| **Microsoft Teams Rooms (MTR) mode** | Limited: Cisco states macros are only partially supported and UI extensions appear in the Control Panel only. The Control Panel panel fits this, but test on the device before rollout. |

**Other restrictions**

| Restriction | Impact |
| --- | --- |
| **Message Send** requires role **Integrator** or Admin | A RoomControl OPC4 user is enough for the Widget transport, not for Message Send |
| Macros run as **Admin** by default | Do not lower the macro's role (`Macros Macro Roles`): saving the last known status (`Macros Macro Save`) and webhook alerts (`HttpClient Post`) need Admin |
| Webhook over plain `http://` | Needs `HttpClient AllowHTTP: True`. A self-signed HTTPS certificate needs `HttpClient AllowInsecureHTTPS: True`. A normal public HTTPS webhook (Teams, Power Automate) needs nothing extra. |
| HttpClient handles one request at a time | Alerts are sent one by one; an alert that fails is logged, not retried |
| Plain HTTP between OPC4 and codec | Needs `NetworkServices HTTP Mode: HTTP+HTTPS` (default is HTTPS only) |
| `deploy-macro.ps1` runtime restart | Restarts all macros on the codec for a few seconds |
| RoomOS 11.14.2.3 known issue | Saving macros via the API needed `Transpile: False` on that release. If `deploy-macro.ps1` fails there, paste the macro in the Macro Editor instead. |

Sources: RoomOS 11 release notes and xAPI reference (roomos.cisco.com), Webex help articles on the macro engine (help.webex.com/article/n449irj) and local users (help.webex.com/article/jkhs20), Cisco Live 2025 BRKCOL-2185 (MTR).

---

## 3. Touch UI panel (optional)

The macro can show the OPC4 status on the Touch Controller / Room Navigator:

| Row | Widget ID | Shows | Width |
| --- | --- | --- | --- |
| Active Port | `opc_active` | `1`-`4`, `none`, or `unknown` | 2 |
| Connected Ports | `opc_connected` | e.g. `1, 4`, `none`, or `unknown` | 2 |
| Mode | `opc_uc` | `UC` / `BYOD` / `unknown` | 2 |
| State | `opc_state` | `OK` / `HEARTBEAT MISSING` | 2 |
| Last Heartbeat | `opc_heartbeat` | `2026-11-24 14:45:52` or `never` | 4 |

Values update on every heartbeat and status change.

### Three ways to use the UI

| You want | Set | Result |
| --- | --- | --- |
| **No visible UI** (default) | `showStatusPanel: false` | Nothing visible is created. Only a hidden panel for `opc_status` (needed by the Widget transport). |
| **Panel created by the macro** | `showStatusPanel: true` | The macro builds "OPC4 Status" with the layout above in the **Control Panel**. Nothing to import. |
| **Your own panel** | `showStatusPanel: false` and build / import a panel with any of the widget IDs above | The macro fills whatever widgets it finds, on any panel, in any layout. Missing widgets are skipped. Panels added while the macro runs are picked up at the next heartbeat. |

### Where the panel appears

Always in the **Control Panel** (opened from the top-right corner of the Touch Controller / Room Navigator), in and outside calls. It is never placed on the home screen, so meeting users are not distracted by service information.

Name and icon can be changed:

```js
showStatusPanel: true,
statusPanelName: 'OPC4 Status',
statusPanelIcon: 'Info',   // e.g. Info, Lightbulb, Helpdesk, Laptop, Tv, Sliders
```

### Changing the layout

The macro **re-saves its own panel on every start**, so:

- Change the order, names or widths in `STATUS_PANEL_ROWS` in the macro (each entry is `[row name, widget ID, width 1-4]`), not in the UI Extensions editor. Edits made in the editor to "OPC4 Status" are overwritten at the next restart.
- If you want to design the panel freely in the editor, use **Your own panel** above instead (`showStatusPanel: false`, your own panel with the same widget IDs). `opc4-heartbeat-panel.xml` is a ready-made example to import.

### Turning the panel off again

Set `showStatusPanel: false` and delete the "OPC4 Status" panel (`opc4_hb_v2_status`) in the UI Extensions editor, or run `deploy-macro.ps1 -Remove`. Turning the setting off alone does not delete a panel that was already created.

---

## 4. How the OPC4 sends data (transports)

A macro cannot receive HTTP requests, so the OPC4 POSTs an xAPI command to `/putxml` and the macro picks it up. Three paths are supported and can be on at the same time.

| Transport | OPC4 sends | Minimum user role | Notes |
| --- | --- | --- | --- |
| **Widget** (current firmware, default on) | `UserInterface Extensions Widget SetValue`, widget `opc_status` | RoomControl | Works today. The macro reads the widget every second (`widgetPollSeconds`). The widget holds only the latest value, so two updates within one second overwrite each other; heartbeat detection and the final status are not affected. |
| **Message** (recommended, default on) | `Message Send`, text `opc4:<payload>` | Integrator | Instant, nothing is lost, no widget needed. Needs an OPC4 firmware change. |
| **Peripheral** (optional, default off) | `Peripherals Connect` once, then `Peripherals HeartBeat` | RoomControl | RoomOS tracks liveness itself and lists the OPC4 under Peripherals / Control Hub. Carries no port/mode data, so combine with Widget or Message. Set `transports.peripheral: true` and `peripheralId`. |

Example `/putxml` bodies:

```xml
<!-- Widget (current firmware) -->
<Command><UserInterface><Extensions><Widget><SetValue>
  <WidgetId>opc_status</WidgetId><Value>alive=4,connected=4,active=0,mode=uc</Value>
</SetValue></Widget></Extensions></UserInterface></Command>

<!-- Message (recommended) -->
<Command><Message><Send><Text>opc4:alive=4,connected=4,active=0,mode=uc</Text></Send></Message></Command>

<!-- Peripheral (optional) -->
<Command><Peripherals><Connect><ID>OPC4-SERIAL</ID><Name>Ochno OPC4</Name><Type>Other</Type></Connect></Peripherals></Command>
<Command><Peripherals><HeartBeat><ID>OPC4-SERIAL</ID><Timeout>90</Timeout></HeartBeat></Peripherals></Command>
```

### Payload

Comma-separated `key=value` pairs:

| Field | Meaning |
| --- | --- |
| `alive=<0-255>` | Heartbeat sequence; increments and wraps at 255. Lets the macro detect missed updates. |
| `connected=<0-15>` | Bitmap of connected ports: port 1 = 1, port 2 = 2, port 3 = 4, port 4 = 8 (e.g. `9` = ports 1 and 4). |
| `active=<0-4>` | Active port, `0` = none. |
| `mode=uc\|byod` | UC or BYOD mode (shown in capitals on the panel). |

A plain heartbeat is just `alive=N`; the status fields are sent when something changes.

---

## 5. All configuration options

Everything is in the `CONFIG` block at the top of the macro.

### General and alerts

| Option | Default | Description |
| --- | --- | --- |
| `company` | `'_COMPANY_NAME'` | Included in every alert |
| `site` | `'_COMPANY_SITE'` | Included in every alert |
| `teamsMsgUrl` | `''` | Webhook URL (Teams, Power Automate, ServiceNow...). Empty = alerts only go to the macro log. When set, the macro turns on `HttpClient Mode`. |
| `debug` | `true` | Extra log lines (raw payloads, panel installation, widget discovery). Set `false` for a quieter log. |

### Transports

| Option | Default | Description |
| --- | --- | --- |
| `transports.widget` | `true` | Read the `opc_status` widget |
| `transports.message` | `true` | Listen for `Message Send` |
| `transports.peripheral` | `false` | Watch the peripheral `peripheralId` |
| `statusWidgetId` | `'opc_status'` | Widget the OPC4 writes to |
| `autoCreateHiddenPanel` | `true` | Create a hidden panel holding `opc_status` if the widget does not exist yet. If it exists (e.g. your own hidden panel) nothing is created. |
| `widgetPollSeconds` | `1` | How often the widget is read |
| `messagePrefix` | `'opc4:'` | Prefix expected on `Message Send` text; other integrations' messages are ignored |
| `acceptUnprefixedMessages` | `true` | Also accept messages that start with `alive=` without the prefix |
| `peripheralId` | `''` | ID the OPC4 uses in `Peripherals Connect` (e.g. its serial or MAC) |

### Touch UI panel

| Option | Default | Description |
| --- | --- | --- |
| `showStatusPanel` | `false` | `true` = macro creates / updates its "OPC4 Status" panel in the Control Panel (see [section 3](#3-touch-ui-panel-optional)) |
| `statusPanelName` | `'OPC4 Status'` | Panel title and button label |
| `statusPanelIcon` | `'Info'` | Panel icon, e.g. `Info`, `Lightbulb`, `Helpdesk` |
| `STATUS_PANEL_ROWS` (constant below `CONFIG`) | see section 3 | Row order, names and widths |

### Heartbeat supervision

| Option | Default | Description |
| --- | --- | --- |
| `heartbeatIntervalSeconds` | `30` | How often the OPC4 sends a heartbeat |
| `missedHeartbeatThreshold` | `2` | Heartbeats that may be missed before alerting |
| `timeoutGraceSeconds` | `5` | Extra margin |
| `watchdogSeconds` | `5` | How often the timeout is checked |

Alert timeout = interval × threshold + grace = **65 s** with the defaults.

---

## 6. Alerts

| Alert | When |
| --- | --- |
| **Heartbeat missing** | Nothing received on any transport within the timeout (also when nothing arrives after the macro starts) |
| **Heartbeat recovered** | First payload after a "missing" alert; includes the current status |
| **Peripheral lost / connected again** | Only with the Peripheral transport |

With `teamsMsgUrl` set, each alert is posted as JSON:

```json
{"location": "<room name>", "device": "<codec model>", "message": "OPC4 heartbeat missing. ...", "company": "...", "site": "..."}
```

On the panel, State switches to `HEARTBEAT MISSING` and back to `OK`. See `INTEGRATION.md` for other ways to use the data.

---

## 7. Log messages

| Log line | Meaning |
| --- | --- |
| `seq=81 (ok)` | Normal heartbeat |
| `seq=93 (initial)` | First heartbeat after the macro started |
| `baseline value 'alive=67' (not counted as heartbeat)` | Value left in the widget from before the restart; ignored so a stale value doesn't count as alive |
| `ok, 1 update overwritten between polls (78)` | Widget transport: two updates within one poll; the earlier one was replaced. Harmless. |
| `1 update not received (78)` | Message transport: an update really did not arrive |
| `jumped from 82 to 200 (OPC4 restarted or counter reset?)` | Large sequence jump, usually an OPC4 restart |
| `duplicate` | Same sequence number twice |
| `status unknown (waiting for the first status change from the OPC4)` | No status known yet, see [section 8](#8-status-after-a-restart) |
| `Restored last known status from <time>` | Status loaded from the saved copy at start |
| `Sending status to display widgets: ...` | Which visible widgets were found and are being updated |
| `Status panel 'OPC4 Status' installed in the Control Panel.` | Macro created / updated its panel |
| `Display widgets already exist on another panel; no status panel created.` | `showStatusPanel: true`, but your own panel has the widgets; it is used instead |

---

## 8. Status after a restart

Heartbeats only contain `alive=N`, so after a macro restart or codec reboot the macro would not know ports and mode until the OPC4 reports a change. The macro therefore saves the last known status in an **inactive** macro named `opc4_heartbeat_state` and restores it on start.

- You will see `opc4_heartbeat_state` in the Macro Editor. Leave it switched off and do not delete it.
- With no saved status yet (first install), the panel shows `unknown` until the first status change.
- The restored status is the *last known* one. If ports changed while the codec was down, it is corrected at the next status change.
- Best long-term fix on the OPC4 side: send the full status in every heartbeat (`alive=N,connected=..,active=..,mode=..`).

---

## 9. Removing everything

```powershell
.\deploy-macro.ps1 -CiscoHost 192.168.6.1 -Username admin -Password '...' -UseHttp -Remove
```

Removes the macro `opc4_heartbeat_monitor_v2`, the saved status `opc4_heartbeat_state`, and the panels the macro created (`opc4_hb_v2_status`, `opc4_hb_v2_source`). Panels you created yourself and other macros are not touched.

By hand: delete those two macros in the Macro Editor and those two panels in the UI Extensions editor.

---

## 10. Emulator, files, product support

### Emulator

`opc4-heartbeat-emulator.ps1` behaves like an OPC4 for testing:

```powershell
# Widget transport (current firmware)
.\opc4-heartbeat-emulator.ps1 -CiscoHost 192.168.6.1 -Username opc4 -Password '...' -UseHttp

# Message transport
.\opc4-heartbeat-emulator.ps1 -CiscoHost 192.168.6.1 -Username opc4 -Password '...' -UseHttp -Transport Message

# Also register as a RoomOS peripheral
.\opc4-heartbeat-emulator.ps1 -CiscoHost 192.168.6.1 -Username opc4 -Password '...' -UseHttp -Transport Message -RegisterPeripheral -PeripheralId OPC4-0001
```

Options: `-Transport Widget|Message`, `-MessagePrefix`, `-RegisterPeripheral`, `-PeripheralId`, `-PeripheralName`. Interactive commands: `connected=`, `active=`, `mode=`, `send`, `status`, `help`, `quit`.

### Files

| File | Purpose |
| --- | --- |
| `opc4-heartbeat-monitor.js` | The macro |
| `deploy-macro.ps1` | Install / update / remove the macro without the web UI |
| `opc4-heartbeat-emulator.ps1` | OPC4 emulator |
| `opc4-heartbeat-panel.xml` | Example panel to import if you build your own UI (optional) |
| `INTEGRATION.md` | Short guide for integrators on using the OPC4 data |
| `SETUP-GUIDE.md` | Short step-by-step setup guide for clients |

### Product support

Message Send, Widget SetValue, Panel Save and Peripherals commands are available on Room Bar, Room Bar Pro, Codec EQ, Codec Pro / Pro G2, Room 70 G2, Room Panorama, Board Pro (G2) and Desk Series (RoomOS xAPI reference, roomos.cisco.com).
