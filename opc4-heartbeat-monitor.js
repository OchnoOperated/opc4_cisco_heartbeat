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
  // null = not reported yet. Heartbeats carry only alive=N, so the status is
  // only known after a status change or from the widget baseline.
  status: { connected: null, active: null, mode: null },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(message) {
  if (CONFIG.debug) console.log(message);
}

// xAPI calls normally answer in milliseconds. If one never answers (codec busy,
// runtime hiccup), give up after `ms` so polling and the watchdog never hang.
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const XAPI_TIMEOUT_MS = 8000;
const DISPLAY_REFRESH_MS = 60000; // rewrite the panel at least this often

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

// Text shown on the panel while a value has not been reported by the OPC4.
// "None" is reserved for a reported 0 (no port active / nothing connected).
const DEFAULT_TEXT = {
  active: 'N/A',
  connected: 'N/A',
  mode: 'N/A',
  state: 'N/A',
  updatedAt: 'Waiting for update',
};

// Not reported yet (null) shows N/A; a reported 0 ("nothing connected") shows None.
function decodeConnectedPorts(bitmap) {
  if (bitmap === null || bitmap === undefined) return DEFAULT_TEXT.connected;
  const value = Number.parseInt(bitmap, 10);
  if (Number.isNaN(value) || value <= 0) return 'None';
  const ports = [];
  for (let port = 1; port <= 4; port += 1) {
    if (value & (1 << (port - 1))) ports.push(port);
  }
  return ports.length ? ports.join(', ') : 'None';
}

function summary() {
  const s = state.status;
  if (s.connected === null && s.active === null && s.mode === null) {
    return 'no port / mode status reported yet';
  }
  const v = (x) => (x === null ? 'not reported' : x);
  return `connected=${v(s.connected)} (ports ${decodeConnectedPorts(s.connected)}), `
    + `active=${v(s.active)}, mode=${v(s.mode)}`;
}

// ---------------------------------------------------------------------------
// Status handling
// ---------------------------------------------------------------------------
// The status is never restored from earlier sessions: a stale saved value
// (e.g. "ports 1, 4") would stay on the panel while nothing is connected,
// because the OPC4 only reports changes. The panel starts at the defaults.
const STATUS_KEYS = ['connected', 'active', 'mode'];
const OLD_STORE_MACRO = 'opc4_heartbeat_state'; // used by earlier versions

// Apply status fields from a payload. Returns true if anything changed.
function applyStatus(parsed) {
  let changed = false;
  STATUS_KEYS.forEach((k) => {
    if (k in parsed && state.status[k] !== parsed[k]) {
      state.status[k] = parsed[k];
      changed = true;
    }
  });
  return changed;
}

// Earlier versions kept the status in an inactive helper macro; remove it.
async function removeOldStatusStore() {
  try {
    await xapi.Command.Macros.Macro.Remove({ Name: OLD_STORE_MACRO });
    log(`Removed '${OLD_STORE_MACRO}' left by an earlier version.`);
  } catch (error) {
    // Not there: nothing to clean up.
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
// Alerts are queued and sent one at a time (RoomOS HttpClient cannot run two
// requests at once) and never awaited by the caller, so a slow or unreachable
// webhook can never delay heartbeat handling or the panel.
let alertQueue = Promise.resolve();

function sendAlert(message) {
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

  alertQueue = alertQueue
    .then(() => withTimeout(xapi.Command.HttpClient.Post(
      { Header: 'Content-Type: application/json', Url: CONFIG.teamsMsgUrl, Timeout: 10 },
      JSON.stringify(payload),
    ), 15000, 'Alert post'))
    .catch((error) => console.error('Failed to post alert', error.message || error));
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
// [row name, widget ID, width 1-4, text alignment left|center|right]
const STATUS_PANEL_ROWS = [
  ['Active Port', DISPLAY_WIDGETS.active, 2, 'center'],
  ['Connected Ports', DISPLAY_WIDGETS.connected, 2, 'center'],
  ['Mode', DISPLAY_WIDGETS.mode, 2, 'center'],
  ['State', DISPLAY_WIDGETS.state, 2, 'center'],
  ['Updated At', DISPLAY_WIDGETS.heartbeat, 4, 'right'],
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
  const widgets = toArray(await withTimeout(
    xapi.Status.UserInterface.Extensions.Widget.get(), XAPI_TIMEOUT_MS, 'Widget list'));
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
          STATUS_PANEL_ROWS.map(([name, id, size, align]) => textRow(name, id, size, align)),
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
    await withTimeout(xapi.Command.UserInterface.Extensions.Widget.SetValue(
      { WidgetId: widgetId, Value: String(value) }), XAPI_TIMEOUT_MS, `SetValue ${widgetId}`);
  } catch (error) {
    log(`Unable to update widget ${widgetId}: ${error.message || error}`);
  }
}

// Panel writes run one at a time. A request that arrives while a write is in
// progress is merged into one more pass with the newest state, so an older
// write can never land after a newer one and leave stale values on the panel.
let displayBusy = false;
let displayDirty = false;

async function updateDisplay() {
  if (displayBusy) {
    displayDirty = true;
    return;
  }
  displayBusy = true;
  try {
    do {
      displayDirty = false;
      await writeDisplay();
    } while (displayDirty);
  } finally {
    displayBusy = false;
  }
}

async function writeDisplay() {
  state.lastDisplayAtMs = Date.now();
  await refreshDisplayTargets();
  if (!state.displayTargets.length) return;
  const s = state.status;
  let stateText = DEFAULT_TEXT.state; // no heartbeat yet
  if (state.heartbeatMissing) stateText = 'OFFLINE'; // no heartbeat within the timeout
  else if (state.lastHeartbeatAtMs) stateText = 'ONLINE';
  const values = {
    [DISPLAY_WIDGETS.state]: stateText,
    [DISPLAY_WIDGETS.heartbeat]: state.lastHeartbeatAtMs
      ? timeStamp(new Date(state.lastHeartbeatAtMs)) : DEFAULT_TEXT.updatedAt,
    [DISPLAY_WIDGETS.mode]: s.mode === null ? DEFAULT_TEXT.mode : String(s.mode).toUpperCase(), // UC / BYOD
    [DISPLAY_WIDGETS.connected]: decodeConnectedPorts(s.connected),
    [DISPLAY_WIDGETS.active]: s.active === null ? DEFAULT_TEXT.active : (s.active === '0' ? 'None' : s.active),
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
  // "Status change" only when a port / mode value actually changed; a payload
  // that repeats the current status is logged as a heartbeat.
  const isStatusChange = applyStatus(parsed);

  state.lastHeartbeatAtMs = Date.now();
  state.lastSource = source;
  if (seq !== null) state.lastAliveSequence = seq;

  log(`[${source}] raw='${rawText}'`);
  console.log(`${isStatusChange ? 'Status change' : 'Heartbeat'} received via ${source}: `
    + `seq=${seq === null ? 'missing' : seq} (${seqState}). ${summary()}`);

  if (state.heartbeatMissing) {
    state.heartbeatMissing = false;
    sendAlert(`OPC4 heartbeat recovered (via ${source}). Current status: ${summary()}.`);
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
// A widget only holds text, and polling cannot see the OPC4 writing the SAME
// text again (e.g. an identical heartbeat every 30 s). So the macro marks a
// value it has read by prefixing it ("read:alive=5,..."); the next OPC4 write,
// identical or not, replaces the mark and is detected.
//
// The mark is written only once the widget has been quiet for MARK_DELAY_MS.
// The macro and the OPC4 write the same widget, so writing the mark right
// after a read could overwrite an OPC4 update that arrives a few ms later
// (e.g. a port change right after a heartbeat). During such bursts the macro
// never writes; in the quiet time before the next heartbeat it does.
const READ_PREFIX = 'read:';
const MARK_DELAY_MS = Math.min(3000, (CONFIG.heartbeatIntervalSeconds * 1000) / 4);

function scheduleMark(text) {
  state.markText = text;
  state.markDueAtMs = Date.now() + MARK_DELAY_MS;
}

async function markWidgetRead(text) {
  const marked = READ_PREFIX + text;
  state.lastWidgetValue = marked;
  state.markText = null;
  await setWidget(CONFIG.statusWidgetId, marked);
}

async function handleWidgetValue(value) {
  const text = String(value || '');
  const alreadyRead = text.startsWith(READ_PREFIX);

  // The first read after a macro (re)start is a baseline, possibly a stale
  // value from before the restart: use its status, but do not count it as a heartbeat.
  if (state.lastWidgetValue === null) {
    state.lastWidgetValue = text;
    log(`Widget '${CONFIG.statusWidgetId}' baseline value '${text}' (not counted as heartbeat).`);
    if (applyStatus(parseStatusPayload(alreadyRead ? text.slice(READ_PREFIX.length) : text))) {
      log(`Status taken from widget baseline: ${summary()}.`);
      await updateDisplay();
    }
    if (text && !alreadyRead) scheduleMark(text);
    return;
  }

  // Unchanged since the last read: mark it as read once it has been quiet long enough.
  if (text && text === state.lastWidgetValue) {
    if (state.markText === text && Date.now() >= state.markDueAtMs) await markWidgetRead(text);
    return;
  }

  // Empty or our own "read:" mark: nothing new.
  if (!text || alreadyRead) return;

  state.lastWidgetValue = text;
  scheduleMark(text);
  await onPayload(text, 'widget');
}

async function readWidgetValue() {
  const widgets = toArray(await withTimeout(
    xapi.Status.UserInterface.Extensions.Widget.get(), XAPI_TIMEOUT_MS, 'Widget read'));
  const match = widgets.find((w) => w.WidgetId === CONFIG.statusWidgetId);
  return match ? String(match.Value || '') : null;
}

// One poll at a time: if the codec is slow, polls are skipped instead of piling up.
let pollBusy = false;

async function pollWidget() {
  if (pollBusy) return;
  pollBusy = true;
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
    console.error('Widget poll failed', error.message || error);
  } finally {
    pollBusy = false;
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
    const devices = toArray(await withTimeout(
      xapi.Status.Peripherals.ConnectedDevice.get(), XAPI_TIMEOUT_MS, 'Peripheral read'));
    const match = devices.find((d) => d.ID === CONFIG.peripheralId);
    const connected = Boolean(match && match.Status === 'Connected');

    if (state.peripheralConnected === null) {
      log(`Peripheral '${CONFIG.peripheralId}' initial state: ${match ? match.Status : 'not registered'}.`);
    } else if (connected && !state.peripheralConnected) {
      sendAlert(`OPC4 peripheral '${CONFIG.peripheralId}' is connected again.`);
    } else if (!connected && state.peripheralConnected) {
      sendAlert(`OPC4 peripheral '${CONFIG.peripheralId}' lost connection `
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
let watchdogBusy = false;

async function watchdog() {
  if (watchdogBusy) return;
  watchdogBusy = true;
  try {
    if (CONFIG.transports.peripheral) await checkPeripheral();

    const reference = state.lastHeartbeatAtMs || state.startedAtMs;
    const ageMs = Date.now() - reference;
    if (ageMs > heartbeatTimeoutMs() && !state.heartbeatMissing) {
      state.heartbeatMissing = true;
      const ageSeconds = Math.floor(ageMs / 1000);
      const what = state.lastHeartbeatAtMs
        ? `No heartbeat for ${ageSeconds} s (last via ${state.lastSource}).`
        : `No heartbeat received since macro start ${ageSeconds} s ago.`;
      sendAlert(`OPC4 heartbeat missing. ${what} Last known status: ${summary()}.`);
      await updateDisplay();
    } else if (Date.now() - (state.lastDisplayAtMs || 0) > DISPLAY_REFRESH_MS) {
      // Periodic rewrite: repairs the panel if anything else overwrote it, and
      // covers a panel that was (re)imported while the OPC4 sends nothing new.
      await updateDisplay();
    }
  } finally {
    watchdogBusy = false;
  }
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
  await removeOldStatusStore();
  await installPanels();

  if (CONFIG.transports.message) startMessageTransport();
  if (CONFIG.transports.widget) startWidgetTransport();
  if (CONFIG.transports.peripheral) startPeripheralTransport();

  await updateDisplay();
  setInterval(() => watchdog().catch((e) => console.error('Watchdog failed', e.message || e)),
    CONFIG.watchdogSeconds * 1000);
  log(`Heartbeat timeout: ${heartbeatTimeoutMs() / 1000} s.`);
}

start().catch((error) => console.error('Start-up failed', error.message || error));
