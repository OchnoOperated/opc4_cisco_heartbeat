import xapi from 'xapi';

/*
 * OPC4 heartbeat monitor for Cisco RoomOS (v2)
 * ============================================
 *
 * Self-contained macro: upload it, enable it, done. No manual UI Extensions
 * editor work is required.
 *
 * Supported ways for the OPC4 to deliver its status (all can be on at once):
 *
 *  1. MESSAGE  (recommended, no widget at all, event driven)
 *     OPC4 POSTs to /putxml:
 *       <Command><Message><Send><Text>opc4:alive=4,connected=4,active=0,mode=uc</Text></Send></Message></Command>
 *     The macro receives it instantly through xapi.Event.Message.Send.
 *     Needs a device user with the Integrator (or Admin) role.
 *
 *  2. WIDGET   (current OPC4 firmware with ability to send heartbeat starts from 1.3.1.5 BETA FW,)
 *     OPC4 POSTs UserInterface Extensions Widget SetValue to widget "opc_status".
 *     The macro creates the hidden panel holding that widget by itself on start,
 *     so nobody has to build it in the UI editor. Works with the RoomControl role.
 *
 *  3. PERIPHERAL (optional, native RoomOS liveness tracking)
 *     OPC4 registers once with Peripherals Connect and then sends
 *     Peripherals HeartBeat. RoomOS itself tracks the connection and lists the
 *     OPC4 under Peripherals in the web UI / Control Hub. The macro watches the
 *     peripheral status and alerts on loss/recovery.
 *
 * Payload format (unchanged from the spec):
 *   alive=<0-255>[,connected=<0-15>][,active=<0-4>][,mode=uc|byod]
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  company: '_COMPANY_NAME',
  site: '_COMPANY_SITE',
  teamsMsgUrl: '', // Optional webhook (Teams / Power Automate / etc.). Empty = log only.

  transports: {
    message: true,     // listen for xCommand Message Send
    widget: true,      // read the opc_status widget (current firmware)
    peripheral: false, // watch Peripherals ConnectedDevice with peripheralId
  },

  // Message transport
  messagePrefix: 'opc4:',        // OPC4 should prefix its Message Send text with this
  acceptUnprefixedMessages: true, // also accept bare "alive=..." texts (no prefix)

  // Widget transport
  statusWidgetId: 'opc_status',
  autoCreateHiddenPanel: true,   // macro installs the hidden source panel itself
  widgetPollSeconds: 1,          // how often the widget is read; RoomOS sends no change
                                 // event for SetValue, so this is what catches updates

  // Peripheral transport
  peripheralId: '',              // ID the OPC4 uses in Peripherals Connect, e.g. its MAC

  // Visible status panel (see README "Touch UI panel").
  // false (default): the macro creates nothing visible on the touch UI.
  // true: the macro creates/updates its own "OPC4 Status" panel in the
  //       Control Panel on every start, unless the display widgets already live
  //       on another panel (then that one is used).
  // Either way, any existing display widgets (opc_state, opc_heartbeat, opc_uc,
  // opc_connected, opc_active) on any panel always receive the status.
  showStatusPanel: false,
  statusPanelName: 'OPC4 Status',
  statusPanelIcon: 'Info', // e.g. Info, Lightbulb, Helpdesk, Tv, Laptop

  // Heartbeat supervision
  heartbeatIntervalSeconds: 30,
  missedHeartbeatThreshold: 2,
  timeoutGraceSeconds: 5,
  watchdogSeconds: 5,

  debug: true,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Unique IDs so v2 never overwrites panels created by hand or by the v1 setup.
const SOURCE_PANEL_ID = 'opc4_hb_v2_source';
const DISPLAY_PANEL_ID = 'opc4_hb_v2_status';
const DISPLAY_WIDGETS = {
  state: 'opc_state',
  heartbeat: 'opc_heartbeat',
  mode: 'opc_uc',
  connected: 'opc_connected',
  active: 'opc_active',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  location: 'Unknown_room_name',
  device: 'Unknown_device_type',
  lastWidgetValue: null,
  lastHeartbeatAtMs: 0,
  lastSource: '',
  heartbeatMissing: false,
  lastAliveSequence: null,
  peripheralConnected: null,
  displayTargets: [], // display widget IDs the macro writes to (existing or installed)
  // null = not known yet. Heartbeats carry only alive=N, so the status is only
  // known after a status change, the widget baseline, or the saved last-known status.
  status: { connected: null, active: null, mode: null },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(message) {
  if (CONFIG.debug) console.log(message);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function timeStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function heartbeatTimeoutMs() {
  return ((CONFIG.heartbeatIntervalSeconds * CONFIG.missedHeartbeatThreshold)
    + CONFIG.timeoutGraceSeconds) * 1000;
}

function parseStatusPayload(text) {
  const parsed = {};
  String(text)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i === -1) {
        parsed[part] = true;
        return;
      }
      const key = part.slice(0, i).trim().toLowerCase();
      const value = part.slice(i + 1).trim();
      if (key) parsed[key] = value;
    });
  return parsed;
}

function parseAliveSequence(parsed) {
  if (!('alive' in parsed)) return null;
  const seq = Number.parseInt(parsed.alive, 10);
  return Number.isNaN(seq) || seq < 0 || seq > 255 ? null : seq;
}

function describeSequence(seq, source) {
  if (seq === null) return 'invalid or missing';
  if (state.lastAliveSequence === null) return 'initial';
  const last = state.lastAliveSequence;
  const expected = (last + 1) % 256;
  if (seq === expected) return last === 255 ? 'wrap' : 'ok';
  if (seq === last) return 'duplicate';

  const missed = (seq - last - 1 + 256) % 256;
  if (missed > 10) {
    return `jumped from ${last} to ${seq} (OPC4 restarted or counter reset?)`;
  }
  const ids = Array.from({ length: missed }, (_, i) => (last + 1 + i) % 256).join(', ');
  const plural = missed === 1 ? '' : 's';
  // The widget only holds the latest value, so several updates inside one
  // poll interval overwrite each other. Message transport never loses updates.
  return source === 'widget'
    ? `ok, ${missed} update${plural} overwritten between polls (${ids})`
    : `${missed} update${plural} not received (${ids})`;
}

function decodeConnectedPorts(bitmap) {
  if (bitmap === null || bitmap === undefined) return 'unknown';
  const value = Number.parseInt(bitmap, 10);
  if (Number.isNaN(value) || value <= 0) return 'none';
  const ports = [];
  for (let port = 1; port <= 4; port += 1) {
    if (value & (1 << (port - 1))) ports.push(port);
  }
  return ports.length ? ports.join(', ') : 'none';
}

function summary() {
  const s = state.status;
  if (s.connected === null && s.active === null && s.mode === null) {
    return 'status unknown (waiting for the first status change from the OPC4)';
  }
  const v = (x) => (x === null ? 'unknown' : x);
  return `connected=${v(s.connected)} (ports ${decodeConnectedPorts(s.connected)}), `
    + `active=${v(s.active)}, mode=${v(s.mode)}`;
}

// ---------------------------------------------------------------------------
// Last-known status, kept across macro restarts and codec reboots
// ---------------------------------------------------------------------------
// Stored as an inactive macro, the usual way to persist data on RoomOS.
const STORE_MACRO = 'opc4_heartbeat_state';
const STATUS_KEYS = ['connected', 'active', 'mode'];

// Apply status fields from a payload. Returns true if anything changed.
function applyStatus(parsed) {
  let changed = false;
  STATUS_KEYS.forEach((k) => {
    if (k in parsed && state.status[k] !== parsed[k]) {
      state.status[k] = parsed[k];
      changed = true;
    }
  });
  if (changed) saveStatus();
  return changed;
}

async function saveStatus() {
  const body = `// Written by the OPC4 heartbeat monitor. Do not activate or edit.\n`
    + `const saved = ${JSON.stringify({ status: state.status, savedAt: timeStamp() })};\n`;
  try {
    await xapi.Command.Macros.Macro.Save({ Name: STORE_MACRO, Overwrite: 'True' }, body);
  } catch (error) {
    log(`Unable to save last known status: ${error.message || error}`);
  }
}

async function loadSavedStatus() {
  try {
    const result = await xapi.Command.Macros.Macro.Get({ Name: STORE_MACRO, Content: 'True' });
    const macro = toArray(result && result.Macro)[0];
    const content = (macro && macro.Content) || '';
    const match = content.match(/const saved = (\{.*\});/);
    if (!match) return;
    const saved = JSON.parse(match[1]);
    STATUS_KEYS.forEach((k) => {
      if (saved.status && saved.status[k] !== undefined) state.status[k] = saved.status[k];
    });
    console.log(`Restored last known status from ${saved.savedAt}: ${summary()}. `
      + 'It is replaced as soon as the OPC4 reports a status change.');
  } catch (error) {
    log('No saved status yet; status unknown until the OPC4 reports a change.');
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
async function sendAlert(message) {
  const payload = {
    location: state.location,
    device: state.device,
    message,
    company: CONFIG.company,
    site: CONFIG.site,
  };
  console.log(`ALERT: ${message}`);

  if (!CONFIG.teamsMsgUrl) {
    log(`Alert URL not configured. Payload would have been: ${JSON.stringify(payload)}`);
    return;
  }

  try {
    await xapi.Command.HttpClient.Post(
      { Header: 'Content-Type: application/json', Url: CONFIG.teamsMsgUrl },
      JSON.stringify(payload),
    );
  } catch (error) {
    console.error('Failed to post alert', error);
  }
}

// ---------------------------------------------------------------------------
// UI (hidden source panel + optional display panel)
// ---------------------------------------------------------------------------
// size = widget width in the row (1-4), as in the UI Extensions editor.
function textRow(name, widgetId, size = 4, align = 'left') {
  return `<Row><Name>${name}</Name><Widget><WidgetId>${widgetId}</WidgetId>`
    + `<Type>Text</Type><Options>size=${size};fontSize=normal;align=${align}</Options></Widget></Row>`;
}

function panelXml(panelId, name, location, rows, icon = 'Info') {
  return '<Extensions><Version>1.11</Version><Panel>'
    + `<PanelId>${panelId}</PanelId><Origin>local</Origin><Location>${location}</Location>`
    + `<Icon>${icon}</Icon><Name>${name}</Name><ActivityType>Custom</ActivityType>`
    + `<Page><Name>${name}</Name>${rows.join('')}<Options/></Page>`
    + '</Panel></Extensions>';
}

// Layout of the panel the macro builds (showStatusPanel = true). Edit here,
// not in the UI Extensions editor: the macro re-saves its panel on every start.
const STATUS_PANEL_ROWS = [
  ['Active Port', DISPLAY_WIDGETS.active, 2],
  ['Connected Ports', DISPLAY_WIDGETS.connected, 2],
  ['Mode', DISPLAY_WIDGETS.mode, 2],
  ['State', DISPLAY_WIDGETS.state, 2],
  ['Last Heartbeat', DISPLAY_WIDGETS.heartbeat, 4],
];

async function panelExists(panelId) {
  try {
    const result = await xapi.Command.UserInterface.Extensions.List();
    const panels = toArray(result && result.Extensions && result.Extensions.Panel);
    return panels.some((p) => p.PanelId === panelId);
  } catch (error) {
    return false;
  }
}

async function installPanels() {
  if (CONFIG.transports.widget && CONFIG.autoCreateHiddenPanel) {
    try {
      // If the widget already exists (e.g. an existing hidden panel), reuse it
      // and leave that panel untouched. Only create our own when it is missing.
      if ((await readWidgetValue()) !== null) {
        log(`Widget '${CONFIG.statusWidgetId}' already exists on the device; reusing it, no panel created.`);
        return installDisplayPanel();
      }
      await xapi.Command.UserInterface.Extensions.Panel.Save(
        { PanelId: SOURCE_PANEL_ID },
        panelXml(SOURCE_PANEL_ID, 'OPC4 Heartbeat Source', 'Hidden',
          [textRow('Status Source', CONFIG.statusWidgetId)]),
      );
      log(`Hidden source panel '${SOURCE_PANEL_ID}' with widget '${CONFIG.statusWidgetId}' is installed.`);
    } catch (error) {
      console.error('Unable to install hidden source panel', error);
    }
  }

  return installDisplayPanel();
}

async function existingWidgetIds() {
  const widgets = toArray(await xapi.Status.UserInterface.Extensions.Widget.get());
  return new Set(widgets.map((w) => w.WidgetId));
}

// Display widgets are found by ID on whatever panel holds them (the v1 panel,
// a panel someone built by hand, or our own). Re-scanned on every update, so a
// panel imported while the macro runs starts receiving data on the next heartbeat.
async function refreshDisplayTargets() {
  try {
    const existing = await existingWidgetIds();
    const present = Object.values(DISPLAY_WIDGETS).filter((id) => existing.has(id));
    if (present.join(',') !== state.displayTargets.join(',')) {
      log(present.length
        ? `Sending status to display widgets: ${present.join(', ')}.`
        : 'No display widgets on the device; nothing visible to update.');
    }
    state.displayTargets = present;
  } catch (error) {
    console.error('Unable to list existing widgets', error);
  }
}

async function installDisplayPanel() {
  // Default (showStatusPanel = false): never create anything visible. Existing
  // display widgets are still updated through refreshDisplayTargets().
  await refreshDisplayTargets();
  if (!CONFIG.showStatusPanel) return;

  // Our own panel is always re-saved so layout/location changes in CONFIG take
  // effect. Only skip when the display widgets live on someone else's panel
  // (e.g. a hand-made or v1 panel), to avoid duplicate widgets.
  const ownPanel = await panelExists(DISPLAY_PANEL_ID);
  if (state.displayTargets.length && !ownPanel) {
    log('Display widgets already exist on another panel; no status panel created.');
    return;
  }

  {
    try {
      await xapi.Command.UserInterface.Extensions.Panel.Save(
        { PanelId: DISPLAY_PANEL_ID },
        panelXml(DISPLAY_PANEL_ID, CONFIG.statusPanelName, 'ControlPanel',
          STATUS_PANEL_ROWS.map(([name, id, size]) => textRow(name, id, size, 'center')),
          CONFIG.statusPanelIcon),
      );
      log(`Status panel '${CONFIG.statusPanelName}' installed in the Control Panel.`);
      await refreshDisplayTargets();
    } catch (error) {
      console.error('Unable to install status panel', error);
    }
  }
}

async function setWidget(widgetId, value) {
  try {
    await xapi.Command.UserInterface.Extensions.Widget.SetValue({ WidgetId: widgetId, Value: String(value) });
  } catch (error) {
    log(`Unable to update widget ${widgetId}: ${error.message || error}`);
  }
}

async function updateDisplay() {
  await refreshDisplayTargets();
  if (!state.displayTargets.length) return;
  const s = state.status;
  const values = {
    [DISPLAY_WIDGETS.state]: state.heartbeatMissing ? 'HEARTBEAT MISSING' : 'OK',
    [DISPLAY_WIDGETS.heartbeat]:
      state.lastHeartbeatAtMs ? timeStamp(new Date(state.lastHeartbeatAtMs)) : 'never',
    [DISPLAY_WIDGETS.mode]: s.mode === null ? 'unknown' : String(s.mode).toUpperCase(), // UC / BYOD
    [DISPLAY_WIDGETS.connected]: decodeConnectedPorts(s.connected),
    [DISPLAY_WIDGETS.active]: s.active === null ? 'unknown' : (s.active === '0' ? 'none' : s.active),
  };
  // Only write widgets that exist, so an older panel without e.g. opc_state
  // does not produce an error log on every heartbeat.
  await Promise.all(state.displayTargets.map((id) => setWidget(id, values[id])));
}

// ---------------------------------------------------------------------------
// Core: one entry point for every transport
// ---------------------------------------------------------------------------
async function onPayload(rawText, source) {
  const parsed = parseStatusPayload(rawText);
  const seq = parseAliveSequence(parsed);
  const seqState = describeSequence(seq, source);
  const isStatusChange = STATUS_KEYS.some((k) => k in parsed);
  applyStatus(parsed);

  state.lastHeartbeatAtMs = Date.now();
  state.lastSource = source;
  if (seq !== null) state.lastAliveSequence = seq;

  log(`[${source}] raw='${rawText}'`);
  console.log(`${isStatusChange ? 'Status change' : 'Heartbeat'} received via ${source}: `
    + `seq=${seq === null ? 'missing' : seq} (${seqState}). ${summary()}`);

  if (state.heartbeatMissing) {
    state.heartbeatMissing = false;
    await sendAlert(`OPC4 heartbeat recovered (via ${source}). Current status: ${summary()}.`);
  }

  await updateDisplay();
}

// --- Transport 1: Message Send ---------------------------------------------
function extractMessagePayload(text) {
  const value = String(text || '').trim();
  const prefix = CONFIG.messagePrefix;
  if (prefix && value.toLowerCase().startsWith(prefix.toLowerCase())) {
    return value.slice(prefix.length).trim();
  }
  if (CONFIG.acceptUnprefixedMessages && /(^|,)\s*alive\s*=/i.test(value)) {
    return value;
  }
  return null; // Someone else's message; ignore.
}

function startMessageTransport() {
  xapi.Event.Message.Send.on((event) => {
    const payload = extractMessagePayload(event && event.Text);
    if (payload !== null) {
      onPayload(payload, 'message').catch((e) => console.error('Message handling failed', e));
    }
  });
  log('Listening for xCommand Message Send (prefix '
    + `'${CONFIG.messagePrefix}'${CONFIG.acceptUnprefixedMessages ? ' or bare alive=...' : ''}).`);
}

// --- Transport 2: Widget ------------------------------------------------------
async function handleWidgetValue(value) {
  const text = String(value || '');
  // The first read after a macro (re)start is a baseline, possibly a stale
  // value from before the restart; remember it but do not count it as a heartbeat.
  if (state.lastWidgetValue === null) {
    state.lastWidgetValue = text;
    log(`Widget '${CONFIG.statusWidgetId}' baseline value '${text}' (not counted as heartbeat).`);
    // A baseline with status fields is newer than the saved status, so it wins.
    if (applyStatus(parseStatusPayload(text))) {
      log(`Status taken from widget baseline: ${summary()}.`);
      await updateDisplay();
    }
    return;
  }
  if (!text || text === state.lastWidgetValue) return;
  state.lastWidgetValue = text;
  await onPayload(text, 'widget');
}

async function readWidgetValue() {
  const widgets = toArray(await xapi.Status.UserInterface.Extensions.Widget.get());
  const match = widgets.find((w) => w.WidgetId === CONFIG.statusWidgetId);
  return match ? String(match.Value || '') : null;
}

async function pollWidget() {
  try {
    const value = await readWidgetValue();
    if (value === null) {
      if (!state.widgetMissingLogged) {
        state.widgetMissingLogged = true;
        console.warn(`Widget '${CONFIG.statusWidgetId}' not found. Is the hidden panel installed?`);
      }
      if (state.lastWidgetValue === null) state.lastWidgetValue = '';
      return;
    }
    await handleWidgetValue(value);
  } catch (error) {
    console.error('Widget poll failed', error);
  }
}

function startWidgetTransport() {
  // Event-driven path: status feedback on the widget list. If the firmware
  // emits feedback for SetValue we react instantly; polling stays as a safety net.
  try {
    xapi.Status.UserInterface.Extensions.Widget.on((change) => {
      toArray(change)
        .filter((w) => w && w.WidgetId === CONFIG.statusWidgetId && 'Value' in w)
        .forEach((w) => handleWidgetValue(w.Value).catch((e) => console.error(e)));
    });
  } catch (error) {
    log('Widget status feedback not available, relying on polling.');
  }

  pollWidget();
  setInterval(pollWidget, CONFIG.widgetPollSeconds * 1000);
  log(`Watching widget '${CONFIG.statusWidgetId}' (feedback + ${CONFIG.widgetPollSeconds}s poll).`);
}

// --- Transport 3: Peripheral --------------------------------------------------
async function checkPeripheral() {
  if (!CONFIG.peripheralId) return;
  try {
    const devices = toArray(await xapi.Status.Peripherals.ConnectedDevice.get());
    const match = devices.find((d) => d.ID === CONFIG.peripheralId);
    const connected = Boolean(match && match.Status === 'Connected');

    if (state.peripheralConnected === null) {
      log(`Peripheral '${CONFIG.peripheralId}' initial state: ${match ? match.Status : 'not registered'}.`);
    } else if (connected && !state.peripheralConnected) {
      await sendAlert(`OPC4 peripheral '${CONFIG.peripheralId}' is connected again.`);
    } else if (!connected && state.peripheralConnected) {
      await sendAlert(`OPC4 peripheral '${CONFIG.peripheralId}' lost connection `
        + `(status: ${match ? match.Status : 'removed'}).`);
    }
    state.peripheralConnected = connected;
  } catch (error) {
    console.error('Peripheral check failed', error);
  }
}

function startPeripheralTransport() {
  if (!CONFIG.peripheralId) {
    console.warn('Peripheral transport enabled but CONFIG.peripheralId is empty; skipping.');
    return;
  }
  checkPeripheral();
  log(`Watching peripheral '${CONFIG.peripheralId}'.`);
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------
async function watchdog() {
  if (CONFIG.transports.peripheral) await checkPeripheral();

  const reference = state.lastHeartbeatAtMs || state.startedAtMs;
  const ageMs = Date.now() - reference;
  if (ageMs <= heartbeatTimeoutMs() || state.heartbeatMissing) return;

  state.heartbeatMissing = true;
  const ageSeconds = Math.floor(ageMs / 1000);
  const what = state.lastHeartbeatAtMs
    ? `No heartbeat for ${ageSeconds} s (last via ${state.lastSource}).`
    : `No heartbeat received since macro start ${ageSeconds} s ago.`;
  await sendAlert(`OPC4 heartbeat missing. ${what} Last known status: ${summary()}.`);
  await updateDisplay();
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
async function loadDeviceInfo() {
  try { state.location = await xapi.Status.SystemUnit.BroadcastName.get(); } catch (e) { /* optional */ }
  try { state.device = await xapi.Status.SystemUnit.ProductId.get(); } catch (e) { /* optional */ }
}

async function start() {
  console.log('Starting OPC4 heartbeat monitor v2');
  state.startedAtMs = Date.now();

  if (CONFIG.teamsMsgUrl) {
    try { await xapi.Config.HttpClient.Mode.set('On'); } catch (e) { console.error('Unable to enable HttpClient', e); }
  }

  await loadDeviceInfo();
  await loadSavedStatus();
  await installPanels();

  if (CONFIG.transports.message) startMessageTransport();
  if (CONFIG.transports.widget) startWidgetTransport();
  if (CONFIG.transports.peripheral) startPeripheralTransport();

  await updateDisplay();
  setInterval(() => watchdog().catch((e) => console.error('Watchdog failed', e)), CONFIG.watchdogSeconds * 1000);
  log(`Heartbeat timeout: ${heartbeatTimeoutMs() / 1000} s.`);
}

start();
