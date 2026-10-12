// Pure contract helpers for a future guard-owned passive page screencast adapter.
// Inputs are observations, not authorization. The selector name describes caller-supplied
// metadata, not proof that an existing signed live guard authorized access. This module performs no I/O, does
// not connect to CDP, and does not replace the existing signed live guard.

const MAX_DIMENSION = 8192;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_OUTSTANDING_BYTES = 24 * 1024 * 1024;
const MAX_DEADLINE_MS = 120_000;
const MAX_TOTAL_DURATION_MS = 1_800_000;
export const MAX_OUTSTANDING_FRAMES = 3;

export class ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new ContractError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, code) {
  if (!isRecord(value)) fail(code);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(code);
  }
}

function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function positiveFinite(value, max = 10) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

function validateExpectedViewport(viewport) {
  const keys = [
    "cssWidth",
    "cssHeight",
    "visualScale",
    "visualZoom",
    "dipWidth",
    "dipHeight",
    "pixelWidth",
    "pixelHeight",
  ];
  exactKeys(viewport, keys, "INVALID_VIEWPORT");
  for (const key of [
    "cssWidth",
    "cssHeight",
    "dipWidth",
    "dipHeight",
    "pixelWidth",
    "pixelHeight",
  ]) {
    if (!boundedInteger(viewport[key], 1, MAX_DIMENSION)) fail("INVALID_VIEWPORT");
  }
  if (!positiveFinite(viewport.visualScale) || !positiveFinite(viewport.visualZoom))
    fail("INVALID_VIEWPORT");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, viewport[key]])));
}

function isGuardLoopbackUrl(url) {
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    boundedInteger(Number(url.port), 1, 65535)
  );
}

function validateExactUrl(exactURL) {
  if (exactURL === "about:blank") return;
  if (typeof exactURL !== "string" || exactURL.length > 4096) fail("INVALID_BINDING");
  let url;
  try {
    url = new URL(exactURL);
  } catch {
    fail("INVALID_BINDING");
  }
  if (
    !isGuardLoopbackUrl(url) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== exactURL
  ) {
    fail("INVALID_BINDING");
  }
}

export function validateBindingRequest(value) {
  exactKeys(
    value,
    ["targetId", "exactURL", "expectedViewport", "epoch", "limits"],
    "INVALID_BINDING",
  );
  if (typeof value.targetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.targetId))
    fail("INVALID_BINDING");
  validateExactUrl(value.exactURL);
  if (!boundedInteger(value.epoch, 1, Number.MAX_SAFE_INTEGER)) fail("INVALID_BINDING");

  exactKeys(
    value.limits,
    [
      "maxPayloadBytes",
      "maxOutstandingBytes",
      "ackDeadlineMs",
      "drainDeadlineMs",
      "firstFrameDeadlineMs",
      "startResponseDeadlineMs",
      "totalDurationMs",
    ],
    "INVALID_LIMITS",
  );
  const {
    maxPayloadBytes,
    maxOutstandingBytes,
    ackDeadlineMs,
    drainDeadlineMs,
    firstFrameDeadlineMs,
    startResponseDeadlineMs,
    totalDurationMs,
  } = value.limits;
  if (
    !boundedInteger(maxPayloadBytes, 1, MAX_PAYLOAD_BYTES) ||
    !boundedInteger(maxOutstandingBytes, maxPayloadBytes, MAX_OUTSTANDING_BYTES) ||
    !boundedInteger(ackDeadlineMs, 1, MAX_DEADLINE_MS) ||
    !boundedInteger(drainDeadlineMs, 1, MAX_DEADLINE_MS) ||
    !boundedInteger(firstFrameDeadlineMs, 1, MAX_DEADLINE_MS) ||
    !boundedInteger(startResponseDeadlineMs, 1, MAX_DEADLINE_MS) ||
    !boundedInteger(totalDurationMs, 1, MAX_TOTAL_DURATION_MS)
  )
    fail("INVALID_LIMITS");

  return Object.freeze({
    targetId: value.targetId,
    exactURL: value.exactURL,
    expectedViewport: validateExpectedViewport(value.expectedViewport),
    epoch: value.epoch,
    limits: Object.freeze({
      maxPayloadBytes,
      maxOutstandingBytes,
      ackDeadlineMs,
      drainDeadlineMs,
      firstFrameDeadlineMs,
      startResponseDeadlineMs,
      totalDurationMs,
    }),
  });
}

function validateOrigin(origin) {
  if (typeof origin !== "string") fail("INVALID_ORIGIN");
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail("INVALID_ORIGIN");
  }
  if (
    !isGuardLoopbackUrl(url) ||
    url.origin !== origin ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    fail("INVALID_ORIGIN");
  return origin;
}

export function selectPageFromVerifiedMetadata(pages, bindingInput, port, signedOrigins) {
  const binding = validateBindingRequest(bindingInput);
  if (!Array.isArray(pages) || !boundedInteger(port, 1, 65535) || !Array.isArray(signedOrigins)) {
    fail("INVALID_PAGE_METADATA");
  }
  const origins = new Set(signedOrigins.map(validateOrigin));
  if (binding.exactURL !== "about:blank") {
    const origin = new URL(binding.exactURL).origin;
    if (!origins.has(origin)) fail("UNDECLARED_ORIGIN");
  }

  const matches = pages.filter((page) => isRecord(page) && page.id === binding.targetId);
  if (matches.length === 0) fail("TARGET_NOT_FOUND");
  if (matches.length !== 1) fail("AMBIGUOUS_TARGET");
  const page = matches[0];
  if (page.type !== "page") fail("TARGET_TYPE_MISMATCH");
  if (page.url !== binding.exactURL) fail("TARGET_URL_MISMATCH");
  if (binding.exactURL !== "about:blank" && !origins.has(new URL(page.url).origin))
    fail("UNDECLARED_ORIGIN");

  const expectedEndpoint = `ws://127.0.0.1:${port}/devtools/page/${binding.targetId}`;
  if (page.webSocketDebuggerUrl !== expectedEndpoint) fail("INVALID_CDP_ENDPOINT");
  return Object.freeze({
    targetId: page.id,
    exactURL: page.url,
    webSocketDebuggerUrl: expectedEndpoint,
  });
}

const EMPTY_PARAMS = Object.freeze({});
export const ALLOWED_CDP_METHODS = Object.freeze([
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.startScreencast",
  "Page.screencastFrameAck",
  "Page.stopScreencast",
]);

export function validateCdpCommand(method, params = EMPTY_PARAMS) {
  if (!ALLOWED_CDP_METHODS.includes(method)) fail("METHOD_NOT_ALLOWED");
  if (method === "Page.startScreencast") {
    exactKeys(params, ["format", "everyNthFrame"], "INVALID_COMMAND_PARAMS");
    if (params.format !== "png" || params.everyNthFrame !== 1) fail("INVALID_COMMAND_PARAMS");
  } else if (method === "Page.screencastFrameAck") {
    exactKeys(params, ["sessionId"], "INVALID_COMMAND_PARAMS");
    if (!boundedInteger(params.sessionId, 0, Number.MAX_SAFE_INTEGER))
      fail("INVALID_COMMAND_PARAMS");
  } else {
    exactKeys(params, [], "INVALID_COMMAND_PARAMS");
  }
  return Object.freeze({ method, params: Object.freeze({ ...params }) });
}

// bitmapPixels must come from a future injected decoder inspection. Matching
// dimensions alone does not validate PNG encoding or content.
export function validateViewportObservation(expectedInput, observation) {
  const expected = validateExpectedViewport(expectedInput);
  exactKeys(
    observation,
    ["cssLayout", "cssVisual", "screencastDip", "bitmapPixels"],
    "INVALID_VIEWPORT",
  );
  exactKeys(observation.cssLayout, ["width", "height"], "INVALID_VIEWPORT");
  exactKeys(observation.cssVisual, ["width", "height", "scale", "zoom"], "INVALID_VIEWPORT");
  exactKeys(observation.screencastDip, ["width", "height"], "INVALID_VIEWPORT");
  exactKeys(observation.bitmapPixels, ["width", "height"], "INVALID_VIEWPORT");
  const equal = (actual, wanted) =>
    typeof actual === "number" && Number.isFinite(actual) && actual === wanted;
  if (
    !equal(observation.cssLayout.width, expected.cssWidth) ||
    !equal(observation.cssLayout.height, expected.cssHeight) ||
    !equal(observation.cssVisual.width, expected.cssWidth) ||
    !equal(observation.cssVisual.height, expected.cssHeight) ||
    !equal(observation.cssVisual.scale, expected.visualScale) ||
    !equal(observation.cssVisual.zoom, expected.visualZoom) ||
    !equal(observation.screencastDip.width, expected.dipWidth) ||
    !equal(observation.screencastDip.height, expected.dipHeight) ||
    !equal(observation.bitmapPixels.width, expected.pixelWidth) ||
    !equal(observation.bitmapPixels.height, expected.pixelHeight)
  )
    fail("VIEWPORT_MISMATCH");
  return true;
}

function isTerminal(state) {
  return ["DRAINED", "INCOMPLETE", "UNKNOWN"].includes(state.status);
}

function result(state, frame = null) {
  const snapshot = Object.freeze({ ...state, outstanding: Object.freeze([...state.outstanding]) });
  return Object.freeze({ state: snapshot, frame });
}

function failed(state, reason, status = "INCOMPLETE") {
  return isTerminal(state) ? state : { ...state, status, reason };
}

export function createFrameLedger(bindingInput, startedAtMs) {
  const binding = validateBindingRequest(bindingInput);
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || startedAtMs < 0)
    fail("INVALID_CLOCK");
  return Object.freeze({
    epoch: binding.epoch,
    expectedViewport: binding.expectedViewport,
    limits: binding.limits,
    status: "ACTIVE",
    reason: null,
    sequence: 1,
    startResponseSeen: false,
    firstFrameSeen: false,
    lastCaptureTimestampSeconds: null,
    startedAtMs,
    lastClockMs: startedAtMs,
    drainStartedAtMs: null,
    outstanding: Object.freeze([]),
    outstandingBytes: 0,
  });
}

// Decoder dimensions and durableAccepted are observations, not PNG validation or authority.
export function transitionFrameLedger(state, event) {
  const types = [
    "failure",
    "start-response",
    "frame",
    "ack",
    "stop",
    "drain-finished",
    "check-deadlines",
  ];
  if (!isRecord(state) || !isRecord(event) || !types.includes(event.type))
    fail("INVALID_LEDGER_EVENT");
  if (isTerminal(state)) {
    if (event.type === "frame") fail("FRAME_AFTER_TERMINAL");
    return result(state);
  }
  if (event.type === "check-deadlines") exactKeys(event, ["type", "atMs"], "INVALID_LEDGER_EVENT");
  if (event.type === "failure") {
    exactKeys(event, ["type", "reason"], "INVALID_LEDGER_EVENT");
    const outcomes = {
      resize: ["INCOMPLETE", "RESIZE"],
      "consumer-failure": ["INCOMPLETE", "CONSUMER_FAILURE"],
      hidden: ["UNKNOWN", "PAGE_HIDDEN"],
      replacement: ["UNKNOWN", "TARGET_REPLACED"],
      disconnect: ["UNKNOWN", "DISCONNECTED"],
    };
    const outcome = outcomes[event.reason];
    if (!Object.hasOwn(outcomes, event.reason)) fail("INVALID_FAILURE_REASON");
    return result(failed(state, outcome[1], outcome[0]));
  }
  const atMs = event.atMs;
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0 || atMs < state.lastClockMs)
    return result(failed(state, "CLOCK_REGRESSION"));
  // An early frame does not prove the start command completed successfully.
  if (!state.startResponseSeen && atMs - state.startedAtMs >= state.limits.startResponseDeadlineMs)
    return result(failed(state, "START_RESPONSE_TIMEOUT"));
  if (!state.firstFrameSeen && atMs - state.startedAtMs >= state.limits.firstFrameDeadlineMs)
    return result(failed(state, "FIRST_FRAME_TIMEOUT"));
  if (state.outstanding.some((frame) => atMs - frame.receivedAtMs >= state.limits.ackDeadlineMs))
    return result(failed(state, "ACK_TIMEOUT"));
  if (state.status === "ACTIVE" && atMs - state.startedAtMs >= state.limits.totalDurationMs)
    return result(failed(state, "TOTAL_DURATION_TIMEOUT"));
  if (state.status === "DRAINING" && atMs - state.drainStartedAtMs >= state.limits.drainDeadlineMs)
    return result(failed(state, "DRAIN_TIMEOUT"));
  let next = { ...state, lastClockMs: atMs };
  if (event.type === "check-deadlines") return result(next);

  if (event.type === "start-response") {
    exactKeys(event, ["type", "atMs"], "INVALID_LEDGER_EVENT");
    return result({ ...next, startResponseSeen: true });
  }
  if (event.type === "frame") {
    exactKeys(event, ["type", "atMs", "frame"], "INVALID_FRAME");
    const f = event.frame;
    if (
      !isRecord(f) ||
      Reflect.ownKeys(f).length !== 5 ||
      !["sessionId", "captureTimestampSeconds", "payloadBytes", "pixelWidth", "pixelHeight"].every(
        (key) => Object.hasOwn(f, key),
      ) ||
      !boundedInteger(f.sessionId, 0, Number.MAX_SAFE_INTEGER) ||
      typeof f.captureTimestampSeconds !== "number" ||
      !Number.isFinite(f.captureTimestampSeconds) ||
      f.captureTimestampSeconds < 0 ||
      !boundedInteger(f.payloadBytes, 1, next.limits.maxPayloadBytes) ||
      f.pixelWidth !== next.expectedViewport.pixelWidth ||
      f.pixelHeight !== next.expectedViewport.pixelHeight
    )
      return result(failed(next, "INVALID_FRAME"));
    // Epoch-clock discontinuities are retained as failures, never silently retimed by an encoder.
    if (
      next.lastCaptureTimestampSeconds !== null &&
      f.captureTimestampSeconds < next.lastCaptureTimestampSeconds
    )
      return result(failed(next, "TIMESTAMP_DISCONTINUITY"));
    if (
      next.outstanding.length >= MAX_OUTSTANDING_FRAMES ||
      next.outstandingBytes + f.payloadBytes > next.limits.maxOutstandingBytes
    )
      return result(failed(next, "BACKPRESSURE"));
    const accepted = Object.freeze({
      epoch: next.epoch,
      sequence: next.sequence,
      ...f,
      receivedAtMs: atMs,
    });
    next = {
      ...next,
      sequence: next.sequence + 1,
      firstFrameSeen: true,
      lastCaptureTimestampSeconds: f.captureTimestampSeconds,
      outstanding: [...next.outstanding, accepted],
      outstandingBytes: next.outstandingBytes + f.payloadBytes,
    };
    return result(next, accepted);
  }
  if (event.type === "ack") {
    exactKeys(event, ["type", "atMs", "ack"], "INVALID_ACK");
    const ack = event.ack;
    if (
      !isRecord(ack) ||
      Reflect.ownKeys(ack).length !== 4 ||
      !["epoch", "sequence", "sessionId", "durableAccepted"].every((key) => Object.hasOwn(ack, key))
    )
      return result(failed(next, "INVALID_ACK"));
    if (ack.durableAccepted !== true) return result(failed(next, "CONSUMER_FAILURE"));
    const index = next.outstanding.findIndex(
      (f) => f.epoch === ack.epoch && f.sequence === ack.sequence && f.sessionId === ack.sessionId,
    );
    if (index < 0) return result(failed(next, "STALE_OR_DUPLICATE_ACK"));
    const outstanding = next.outstanding.filter((_, i) => i !== index);
    return result({
      ...next,
      outstanding,
      outstandingBytes: next.outstandingBytes - next.outstanding[index].payloadBytes,
    });
  }
  if (event.type === "stop") {
    exactKeys(event, ["type", "atMs"], "INVALID_LEDGER_EVENT");
    if (next.status !== "ACTIVE") return result(failed(next, "INVALID_STOP"));
    return result({ ...next, status: "DRAINING", drainStartedAtMs: atMs });
  }
  exactKeys(event, ["type", "atMs"], "INVALID_LEDGER_EVENT");
  if (next.status !== "DRAINING") return result(failed(next, "INVALID_DRAIN"));
  // DRAINED describes only this ledger, not a transport stop response or socket closure.
  return result(next.outstanding.length ? next : { ...next, status: "DRAINED", reason: null });
}
