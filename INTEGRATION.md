# Using OPC4 data: integrator guide

The macro gives you two kinds of information about the OPC4:

- **Is it alive?** It raises alerts when the heartbeat stops and when it comes back.
- **What is it doing?** It tracks which ports are connected, which port is active, and whether the room is in UC or BYOD mode.

## 1. Where to get the data

| Source | Contains | How to read it |
| --- | --- | --- |
| **Alert webhook** | Heartbeat missing / recovered (plus peripheral lost / connected, if enabled) | Set `teamsMsgUrl` in the macro. It POSTs JSON: `{location, device, message, company, site}` |
| **`opc_status` widget** (widget transport) | The latest raw payload, e.g. `alive=81,connected=9,active=1,mode=byod` | `xStatus UserInterface Extensions Widget`, or HTTP `GET /getxml?location=/Status/UserInterface/Extensions/Widget` |
| **Display widgets** (only if a panel holding them exists) | Status decoded into readable values: `opc_connected`=`1, 4`, `opc_active`, `opc_uc`, `opc_heartbeat`, `opc_state` | Same xStatus path as above |
| **Message Send events** (Message transport) | Every payload, delivered the moment it arrives | Subscribe to `xFeedback register /Event/Message/Send` (SSH / WebSocket) and filter on the `opc4:` prefix |
| **Peripherals** (if enabled) | Whether the OPC4 is connected to the codec | `xStatus Peripherals ConnectedDevice`, Control Hub device view |

Payload fields: `alive` is a sequence number from 0 to 255. `connected` is a port bitmap (port 1 = 1, port 2 = 2, port 3 = 4, port 4 = 8). `active` is the active port (0 = none). `mode` is `uc` or `byod`.

## 2. Typical uses

- **Helpdesk alerting.** Point `teamsMsgUrl` at a Teams / Power Automate / ServiceNow webhook. A "heartbeat missing" alert opens a ticket, and "recovered" closes it. The `location` field names the room.
- **Room automation.** A control system (Crestron, Q-SYS, Extron) or a second macro watches `active` / `mode`. For example, it switches the codec input or layout when a laptop becomes active, or shows a "BYOD in use" hint.
- **Fleet monitoring.** Poll the widget status through `getxml` across all rooms. Flag rooms where the "Last Heartbeat" time is old or no ports are ever connected.
- **Usage analytics.** Log changes in `connected` / `active` / `mode` over time to see how often rooms are used, which ports are used, and the BYOD vs UC split. That helps with planning and justifying hardware.
- **Native device health.** Turn on the peripheral transport so the OPC4 appears in Control Hub next to other room peripherals, with no extra tooling.

## 3. Good to know

- **No webhook for status changes.** Only alerts are pushed. To get status changes, read the widget or subscribe to Message Send events.
- **No stored status with the Message transport.** It has no widget, so nothing can be read later. Use event subscriptions, or keep the widget transport on as well.
- **Fast changes can be overwritten with the widget transport.** If two updates arrive within one second, only the latest is kept. The final status is always correct.
- **User roles.** The read-only examples above need a codec user with at least the RoomControl role. Subscribing to Message Send events needs the Integrator role.
