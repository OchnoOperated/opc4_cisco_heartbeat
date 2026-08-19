# OPC4 Cisco Heartbeat Monitor

Small Cisco RoomOS macro setup for monitoring an external OPC4 device heartbeat.

The OPC4 device posts a single raw status payload into a hidden widget named `opc_status`. The Cisco macro reads that raw value, detects heartbeat loss/recovery, and fans the payload out to four user-facing widgets:

- `opc_heartbeat`: last time any heartbeat was received
- `opc_uc`: UC mode string copied from the payload
- `opc_connected`: decoded connected port list
- `opc_active`: active port value copied as-is

## Repository Files

- [opc4-heartbeat-monitor.js](./opc4-heartbeat-monitor.js): Cisco macro that reads `opc_status`, updates the UI widgets, and sends optional alerts
- [opc4-heartbeat-emulator.ps1](./opc4-heartbeat-emulator.ps1): local test sender that posts Cisco XML commands to a device
- [opc4-heartbeat-panel.xml](./opc4-heartbeat-panel.xml): full example panel XML with a visible status panel and a hidden `opc_status` source panel

## Expected OPC4 Payload

The monitor expects the external sender to write a comma-separated string into `opc_status`.

Examples:

```text
alive=17
alive=18,connected=5,active=3,mode=uc
```

Recognized fields:

- `alive`: heartbeat sequence counter, expected to increment from `0` to `255` and wrap
- `connected`: decimal bitmask for connected ports
- `active`: active port value, copied to `opc_active` unchanged
- `mode`: copied to `opc_uc` unchanged

## Connected Port Mapping

`connected` is decoded as a bitmask:

- `1` = port 1
- `2` = port 2
- `4` = port 3
- `8` = port 4

Examples:

- `1` -> `1`
- `3` -> `1, 2`
- `5` -> `1, 3`
- `9` -> `1, 4`

## Required Widgets

The macro expects these widget IDs to exist on the Cisco device:

- `opc_status`
- `opc_heartbeat`
- `opc_uc`
- `opc_connected`
- `opc_active`

Important:

- `opc_status` should remain present even if it is not shown to users
- `opc_status` is the source widget used by the external OPC4 POST
- the four `opc_*` display widgets are the values the macro updates for the user interface

The checked-in [opc4-heartbeat-panel.xml](./opc4-heartbeat-panel.xml) includes:

- one visible panel with `opc_heartbeat`, `opc_uc`, `opc_connected`, and `opc_active`
- one hidden panel that keeps `opc_status` available for the external POST source

If your room UI is already built separately, keep that UI and make sure the five widget IDs above still exist.

## How The Monitor Works

1. The OPC4 sender writes a raw value into `opc_status`.
2. The macro polls the widget list and reads `opc_status`.
3. On every new value, the macro:
   - logs the raw unparsed payload
   - updates the last heartbeat timestamp
   - parses `connected`, `active`, and `mode`
   - writes the mapped values to the four user-facing widgets
4. If no new heartbeat arrives within the configured timeout window, the macro raises a missing-heartbeat alert.
5. When a new heartbeat arrives again, the macro raises a recovery alert.

Default timing:

- expected heartbeat interval: 30 seconds
- missed heartbeat threshold: 2 intervals
- macro poll interval: 5 seconds
- extra timeout grace: 5 seconds

Effective timeout:

```text
(heartbeatIntervalSeconds * missedHeartbeatThreshold) + timeoutGraceSeconds
```

With the defaults, the alert threshold is 65 seconds.

## Optional Teams Alerting

Set `teamsMsgUrl` inside [opc4-heartbeat-monitor.js](./opc4-heartbeat-monitor.js) to enable alerts through `xapi.Command.HttpClient.Post`.

If `teamsMsgUrl` is empty, the macro keeps running and only logs what it would have sent.

The alert payload includes:

- `location`
- `device`
- `message`
- `company`
- `site`

## Deploying The Cisco Macro

1. Upload [opc4-heartbeat-monitor.js](./opc4-heartbeat-monitor.js) to the Cisco device as a macro.
2. Ensure `HttpClient` is allowed on the device if you want alert posting.
3. Load [opc4-heartbeat-panel.xml](./opc4-heartbeat-panel.xml), or equivalent UI XML that provides:
   - a hidden `opc_status` widget
   - visible `opc_heartbeat`, `opc_uc`, `opc_connected`, and `opc_active` widgets
4. Verify the external OPC4 sender posts to `opc_status`.
5. Confirm the macro console shows incoming raw payloads and mapped status updates.

## Using The Emulator

The PowerShell emulator can send heartbeats and status changes to a Cisco device over `/putxml`.

Basic usage:

```powershell
.\opc4-heartbeat-emulator.ps1 `
  -CiscoHost <device-or-ip> `
  -Username <username> `
  -Password <password>
```

Useful options:

- `-WidgetId opc_status`
- `-IntervalSeconds 30`
- `-InitialConnected 5`
- `-InitialActive 3`
- `-InitialMode uc`
- `-UseHttp`
- `-AllowUntrustedCertificate`

Interactive emulator commands:

- `connected=<0-15>`
- `active=<0-4>`
- `mode=uc`
- `mode=byod`
- `status`
- `send`
- `help`
- `quit`

## Notes

- `node_modules/` is intentionally ignored and not part of the repository
- the Cisco macro keeps `import xapi from 'xapi';` because that is the correct runtime import on the device

For a quick syntax check:

```powershell
node --check .\opc4-heartbeat-monitor.js
```
