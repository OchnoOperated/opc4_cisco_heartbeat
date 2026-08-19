import xapi from 'xapi';

//
// Proof-of-concept monitor for an external OPC4 device.
// The external client updates a UI Extensions text widget through the Cisco xAPI:
//   xCommand UserInterface Extensions Widget SetValue
//
// Expected payloads:
//   alive=17
//   alive=18,connected=5,active=3,mode=uc
//

const company = '_COMPANY_NAME';
const site = '_COMPANY_SITE';
const teamsMsgUrl = '';

const widgetIds = {
  source: 'opc_status',
  heartbeat: 'opc_heartbeat',
  uc: 'opc_uc',
  connected: 'opc_connected',
  active: 'opc_active',
};
const heartbeatIntervalSeconds = 30;
const missedHeartbeatThreshold = 2;
const pollIntervalSeconds = 5;
const timeoutGraceSeconds = 5;
const portMappings = [
  { bit: 1, port: '1' },
  { bit: 2, port: '2' },
  { bit: 4, port: '3' },
  { bit: 8, port: '4' },
];

const DEBUG = 1;

let location = 'Unknown_room_name';
let device = 'Unknown_device_type';
let lastWidgetValue = '';
let lastHeartbeatAtMs = 0;
let heartbeatMissing = false;
let lastAliveSequence = null;
let lastDiscoveredWidgetIds = '';
let sourceWidgetMissingLogged = false;
let sourceWidgetEmptyLogged = false;
let currentStatus = {
  heartbeat: '',
  connectedDisplay: '0',
  active: '0',
  mode: '',
};

function log(message) {
  if (DEBUG) {
    console.log(message);
  }
}

async function getDeviceInformation() {
  try {
    location = await xapi.Status.SystemUnit.BroadcastName.get();
  } catch (error) {
    console.error('Unable to get device information: Broadcast Name', error);
  }

  try {
    device = await xapi.Status.SystemUnit.ProductId.get();
  } catch (error) {
    console.error('Unable to get device information: Product ID', error);
  }
}

async function sendTeamsMessage(message) {
  if (!teamsMsgUrl) {
    log(`Monitoring URL not configured. Message would have been: ${JSON.stringify(message)}`);
    return;
  }

  await xapi.Command.HttpClient.Post(
    { Header: 'Content-Type: application/json', Url: teamsMsgUrl },
    JSON.stringify(message)
  );
}

async function sendAlert(message) {
  const payload = { location, device, message, company, site };
  log(`Sending alert: ${message}`);
  await sendTeamsMessage(payload);
}

async function initHttpClient() {
  try {
    await xapi.Config.HttpClient.Mode.set('On');
  } catch (error) {
    console.error('Unable to enable HttpClient mode', error);
  }
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value) {
    return [];
  }

  return [value];
}

function parseStatusPayload(widgetValue) {
  const parsed = {};

  String(widgetValue)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const separatorIndex = part.indexOf('=');

      if (separatorIndex === -1) {
        parsed[part] = true;
        return;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();

      if (key) {
        parsed[key] = value;
      }
    });

  return parsed;
}

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(dateMs) {
  const date = new Date(dateMs);

  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
}

function formatConnectedPorts(connectedValue) {
  const bitmap = Number.parseInt(connectedValue, 10);
  if (Number.isNaN(bitmap) || bitmap < 0) {
    return String(connectedValue || '');
  }

  const connectedPorts = portMappings
    .filter(({ bit }) => (bitmap & bit) === bit)
    .map(({ port }) => port);

  return connectedPorts.length ? connectedPorts.join(', ') : '0';
}

function mergeStatus(parsedStatus) {
  currentStatus.heartbeat = formatTimestamp(lastHeartbeatAtMs);

  if ('connected' in parsedStatus) {
    currentStatus.connectedDisplay = formatConnectedPorts(parsedStatus.connected);
  }

  if ('active' in parsedStatus) {
    currentStatus.active = parsedStatus.active;
  }

  if ('mode' in parsedStatus) {
    currentStatus.mode = parsedStatus.mode;
  }
}

function buildStatusSummary(status) {
  return `heartbeat=${status.heartbeat}, uc=${status.mode}, connected=${status.connectedDisplay}, active=${status.active}`;
}

function isStatusChange(parsedStatus) {
  return 'connected' in parsedStatus || 'active' in parsedStatus || 'mode' in parsedStatus;
}

function parseAliveSequence(parsedStatus) {
  if (!('alive' in parsedStatus)) {
    return null;
  }

  const sequence = Number.parseInt(parsedStatus.alive, 10);
  if (Number.isNaN(sequence) || sequence < 0 || sequence > 255) {
    return null;
  }

  return sequence;
}

function describeSequenceProgress(sequence) {
  if (sequence === null) {
    return 'invalid or missing';
  }

  if (lastAliveSequence === null) {
    return 'initial';
  }

  const expectedNext = (lastAliveSequence + 1) % 256;
  if (sequence === expectedNext) {
    if (lastAliveSequence === 255 && sequence === 0) {
      return 'wrap';
    }

    return 'ok';
  }

  if (sequence === lastAliveSequence) {
    return 'duplicate';
  }

  return `unexpected (expected ${expectedNext})`;
}

function getSequenceInfo(parsedStatus) {
  const aliveSequence = parseAliveSequence(parsedStatus);
  const sequenceState = describeSequenceProgress(aliveSequence);
  const aliveValue = aliveSequence === null ? 'missing' : aliveSequence;

  return { aliveSequence, aliveValue, sequenceState };
}

function logHeartbeat(parsedStatus) {
  const { aliveValue, sequenceState } = getSequenceInfo(parsedStatus);
  console.log(`Heartbeat received: seq=${aliveValue} (${sequenceState})`);
  console.log(`Current OPC4 status: ${buildStatusSummary(currentStatus)}`);
}

function logStatusChange(parsedStatus) {
  const { aliveValue, sequenceState } = getSequenceInfo(parsedStatus);
  console.log(`Status Change received: seq=${aliveValue} (${sequenceState})`);
  console.log(`OPC4 status: ${buildStatusSummary(currentStatus)}`);

  if ('connected' in parsedStatus) {
    console.log(`Connected bitmap (decimal): ${parsedStatus.connected}`);
    console.log(`Connected ports: ${currentStatus.connectedDisplay}`);
  }

  if ('active' in parsedStatus) {
    console.log(`Active port: ${parsedStatus.active}`);
  }

  if ('mode' in parsedStatus) {
    console.log(`Mode: ${parsedStatus.mode}`);
  }
}

function logDiscoveredWidgets(widgets) {
  if (!widgets.length) {
    if (lastDiscoveredWidgetIds !== '(none)') {
      lastDiscoveredWidgetIds = '(none)';
      console.log('No UI extension widgets are currently exposed by the device. Make sure the panel XML is loaded and the widget exists.');
    }

    return;
  }

  const widgetIds = widgets.map((widget) => widget.WidgetId).join(', ');
  if (widgetIds !== lastDiscoveredWidgetIds) {
    lastDiscoveredWidgetIds = widgetIds;
    console.log(`Discovered widgets: ${widgetIds}`);
  }
}

async function getSourceWidgetValue() {
  const widgets = toArray(await xapi.Status.UserInterface.Extensions.Widget.get());
  logDiscoveredWidgets(widgets);

  const match = widgets.find((widget) => widget.WidgetId === widgetIds.source);
  if (!match) {
    if (!sourceWidgetMissingLogged) {
      console.log(`Widget '${widgetIds.source}' was not found. Available widget IDs: ${lastDiscoveredWidgetIds}`);
      sourceWidgetMissingLogged = true;
    }

    return null;
  }

  sourceWidgetMissingLogged = false;
  return String(match.Value || '');
}

async function setWidgetValue(widgetId, value) {
  try {
    await xapi.Command.UserInterface.Extensions.Widget.SetValue({
      WidgetId: widgetId,
      Value: String(value || ''),
    });
  } catch (error) {
    console.error(`Unable to set widget '${widgetId}'`, error);
  }
}

async function updateStatusWidgets() {
  await setWidgetValue(widgetIds.heartbeat, currentStatus.heartbeat);
  await setWidgetValue(widgetIds.uc, currentStatus.mode);
  await setWidgetValue(widgetIds.connected, currentStatus.connectedDisplay);
  await setWidgetValue(widgetIds.active, currentStatus.active);
}

async function onWidgetValueReceived(widgetValue) {
  console.log(`Raw OPC4 widget value: ${String(widgetValue)}`);
  const parsedStatus = parseStatusPayload(widgetValue);
  const statusChanged = isStatusChange(parsedStatus);
  const aliveSequence = parseAliveSequence(parsedStatus);

  lastHeartbeatAtMs = Date.now();
  lastWidgetValue = widgetValue;

  mergeStatus(parsedStatus);
  await updateStatusWidgets();

  if (statusChanged) {
    logStatusChange(parsedStatus);
  } else {
    logHeartbeat(parsedStatus);
  }

  if (aliveSequence !== null) {
    lastAliveSequence = aliveSequence;
  }

  if (heartbeatMissing) {
    heartbeatMissing = false;
    await sendAlert(`OPC4 heartbeat recovered on widget ${widgetIds.source}. Current status: ${buildStatusSummary(currentStatus)}.`);
  }
}

function getHeartbeatTimeoutMs() {
  return ((heartbeatIntervalSeconds * missedHeartbeatThreshold) + timeoutGraceSeconds) * 1000;
}

async function checkHeartbeat() {
  try {
    const currentValue = await getSourceWidgetValue();

    if (currentValue === null) {
      return;
    }

    if (!currentValue) {
      if (!sourceWidgetEmptyLogged) {
        log(`Heartbeat widget ${widgetIds.source} has no value yet.`);
        sourceWidgetEmptyLogged = true;
      }
    } else if (currentValue !== lastWidgetValue) {
      sourceWidgetEmptyLogged = false;
      await onWidgetValueReceived(currentValue);
    } else {
      sourceWidgetEmptyLogged = false;
    }

    if (!lastHeartbeatAtMs) {
      return;
    }

    const ageMs = Date.now() - lastHeartbeatAtMs;
    if (ageMs <= getHeartbeatTimeoutMs()) {
      return;
    }

    if (!heartbeatMissing) {
      heartbeatMissing = true;
      const ageSeconds = Math.floor(ageMs / 1000);
      await sendAlert(
        `OPC4 heartbeat missing. No new value received on widget ${widgetIds.source} for ${ageSeconds} seconds. Last known status: ${buildStatusSummary(currentStatus)}.`
      );
    }
  } catch (error) {
    console.error('Error while checking OPC4 heartbeat', error);
  }
}

function start() {
  console.log('Starting OPC4 heartbeat monitor macro');
  initHttpClient();
  getDeviceInformation();
  checkHeartbeat();
  setInterval(checkHeartbeat, pollIntervalSeconds * 1000);
}

start();
