import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_CDP_METHODS,
  MAX_OUTSTANDING_FRAMES,
  createFrameLedger,
  transitionFrameLedger,
  selectPageFromVerifiedMetadata,
  validateBindingRequest,
  validateCdpCommand,
  validateViewportObservation,
} from "../home/.agents/skills/browser-routing/contracts/passive-page-cdp.mjs";

const origin = "http://127.0.0.1:3030";
const exactURL = `${origin}/task`;
const limits = {
  maxPayloadBytes: 100,
  maxOutstandingBytes: 300,
  ackDeadlineMs: 100,
  drainDeadlineMs: 25,
  firstFrameDeadlineMs: 50,
  startResponseDeadlineMs: 75,
  totalDurationMs: 1_000_000,
};
const expectedViewport = {
  cssWidth: 800,
  cssHeight: 600,
  visualScale: 1,
  visualZoom: 1,
  dipWidth: 800,
  dipHeight: 600,
  pixelWidth: 1600,
  pixelHeight: 1200,
};

function binding(overrides = {}) {
  return {
    targetId: "page_1",
    exactURL,
    expectedViewport: { ...expectedViewport },
    epoch: 7,
    limits: { ...limits },
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    id: "page_1",
    type: "page",
    url: exactURL,
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page_1",
    ...overrides,
  };
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error?.code === code);
}

function goodObservation() {
  return {
    cssLayout: { width: 800, height: 600 },
    cssVisual: { width: 800, height: 600, scale: 1, zoom: 1 },
    screencastDip: { width: 800, height: 600 },
    bitmapPixels: { width: 1600, height: 1200 },
  };
}

function frame(overrides = {}) {
  return {
    sessionId: 3,
    captureTimestampSeconds: 123.25,
    payloadBytes: 40,
    pixelWidth: 1600,
    pixelHeight: 1200,
    ...overrides,
  };
}

function ledger(overrides = {}) {
  return createFrameLedger(binding(overrides), 1000);
}

function accept(state, input = frame(), receivedAtMs = 1001) {
  return transitionFrameLedger(state, { type: "frame", atMs: receivedAtMs, frame: input });
}

function acknowledgeScreencastFrame(state, acknowledgement, nowMs) {
  return transitionFrameLedger(state, { type: "ack", atMs: nowMs, ack: acknowledgement }).state;
}

function recordStartResponse(state, nowMs) {
  return transitionFrameLedger(state, { type: "start-response", atMs: nowMs }).state;
}

function invalidateCapture(state, reason) {
  return transitionFrameLedger(state, { type: "failure", reason }).state;
}

function beginFrameDrain(state, nowMs) {
  return transitionFrameLedger(state, { type: "stop", atMs: nowMs }).state;
}

function finishFrameDrain(state, nowMs) {
  return transitionFrameLedger(state, { type: "drain-finished", atMs: nowMs }).state;
}

test("binding schema is strict, bounded, and rejects unsupported URL forms", () => {
  assert.equal(validateBindingRequest(binding()).targetId, "page_1");
  assert.equal(
    validateBindingRequest(binding({ exactURL: "about:blank" })).exactURL,
    "about:blank",
  );
  expectCode("INVALID_BINDING", () => validateBindingRequest({ ...binding(), extra: true }));
  expectCode("INVALID_VIEWPORT", () =>
    validateBindingRequest(
      binding({
        expectedViewport: { ...expectedViewport, maxWidth: 800 },
      }),
    ),
  );
  expectCode("INVALID_LIMITS", () =>
    validateBindingRequest(
      binding({
        limits: { ...limits, maxPayloadBytes: Number.MAX_SAFE_INTEGER },
      }),
    ),
  );
  expectCode("INVALID_LIMITS", () =>
    validateBindingRequest(
      binding({
        limits: { ...limits, maxOutstandingBytes: 99 },
      }),
    ),
  );
  expectCode("INVALID_BINDING", () =>
    validateBindingRequest(binding({ exactURL: "file:///tmp/page" })),
  );
  expectCode("INVALID_BINDING", () =>
    validateBindingRequest(binding({ exactURL: "http://user:pass@127.0.0.1:3030/task" })),
  );
  expectCode("INVALID_BINDING", () =>
    validateBindingRequest(binding({ exactURL: `${exactURL}#fragment` })),
  );
  for (const invalidURL of [
    "https://127.0.0.1:3030/task",
    "http://example.test:3030/task",
    "http://127.0.0.1/task",
  ]) {
    expectCode("INVALID_BINDING", () => validateBindingRequest(binding({ exactURL: invalidURL })));
  }
  expectCode("INVALID_LIMITS", () =>
    validateBindingRequest(binding({ limits: { ...limits, firstFrameDeadlineMs: 120_001 } })),
  );
  expectCode("INVALID_LIMITS", () =>
    validateBindingRequest(binding({ limits: { ...limits, totalDurationMs: 1_800_001 } })),
  );
});

test("selection requires one exact page target and an exact loopback page websocket endpoint", () => {
  const selected = selectPageFromVerifiedMetadata([page()], binding(), 9222, [origin]);
  assert.deepEqual(selected, {
    targetId: "page_1",
    exactURL,
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page_1",
  });
  assert.equal(
    selectPageFromVerifiedMetadata(
      [page({ url: "about:blank" })],
      binding({
        exactURL: "about:blank",
      }),
      9222,
      [],
    ).exactURL,
    "about:blank",
  );
  expectCode("TARGET_NOT_FOUND", () =>
    selectPageFromVerifiedMetadata([], binding(), 9222, [origin]),
  );
  expectCode("AMBIGUOUS_TARGET", () =>
    selectPageFromVerifiedMetadata([page(), page()], binding(), 9222, [origin]),
  );
  expectCode("TARGET_TYPE_MISMATCH", () =>
    selectPageFromVerifiedMetadata([page({ type: "service_worker" })], binding(), 9222, [origin]),
  );
  expectCode("TARGET_NOT_FOUND", () =>
    selectPageFromVerifiedMetadata([page({ id: "other" })], binding(), 9222, [origin]),
  );
  expectCode("TARGET_URL_MISMATCH", () =>
    selectPageFromVerifiedMetadata([page({ url: `${origin}/other` })], binding(), 9222, [origin]),
  );
  expectCode("UNDECLARED_ORIGIN", () =>
    selectPageFromVerifiedMetadata([page()], binding(), 9222, ["http://localhost:3030"]),
  );
  for (const invalidOrigin of [
    "https://127.0.0.1:3030",
    "http://example.test:3030",
    "http://127.0.0.1",
  ]) {
    expectCode("INVALID_ORIGIN", () =>
      selectPageFromVerifiedMetadata([page()], binding(), 9222, [invalidOrigin]),
    );
  }
});

test("selection rejects websocket foreign ports, browser paths, credentials, query, and hash", () => {
  for (const endpoint of [
    "ws://127.0.0.1:9223/devtools/page/page_1",
    "ws://127.0.0.1:9222/devtools/browser/browser_1",
    "ws://user@127.0.0.1:9222/devtools/page/page_1",
    "ws://127.0.0.1:9222/devtools/page/page_1?x=1",
    "ws://127.0.0.1:9222/devtools/page/page_1#fragment",
    "ws://127.0.0.1:9222/devtools/page/other",
  ]) {
    expectCode("INVALID_CDP_ENDPOINT", () =>
      selectPageFromVerifiedMetadata([page({ webSocketDebuggerUrl: endpoint })], binding(), 9222, [
        origin,
      ]),
    );
  }
});

test("synthetic transport records connect only after page selection succeeds", () => {
  const transportSpy = [];
  const selectThenConnect = (pages, request, port, origins) => {
    const selected = selectPageFromVerifiedMetadata(pages, request, port, origins);
    transportSpy.push({ operation: "connect", endpoint: selected.webSocketDebuggerUrl });
    return selected;
  };

  expectCode("TARGET_URL_MISMATCH", () =>
    selectThenConnect([page({ url: `${origin}/wrong` })], binding(), 9222, [origin]),
  );
  assert.deepEqual(transportSpy, []);
  selectThenConnect([page()], binding(), 9222, [origin]);
  assert.deepEqual(transportSpy, [
    { operation: "connect", endpoint: "ws://127.0.0.1:9222/devtools/page/page_1" },
  ]);
});

test("viewport contract keeps CSS, visual, screencast DIP, and inspected pixels distinct", () => {
  assert.equal(validateViewportObservation(expectedViewport, goodObservation()), true);
  for (const [field, replacement] of [
    ["cssLayout", { width: 801, height: 600 }],
    ["cssVisual", { width: 800, height: 600, scale: 1.25, zoom: 1 }],
    ["screencastDip", { width: 1600, height: 1200 }],
    ["bitmapPixels", { width: 800, height: 600 }],
  ]) {
    expectCode("VIEWPORT_MISMATCH", () =>
      validateViewportObservation(expectedViewport, {
        ...goodObservation(),
        [field]: replacement,
      }),
    );
  }
  expectCode("INVALID_VIEWPORT", () =>
    validateViewportObservation(expectedViewport, {
      ...goodObservation(),
      bitmapPixels: { width: 1600, height: 1200, resize: true },
    }),
  );
});

test("only the fixed passive Page command set and exact parameter shapes validate", () => {
  assert.deepEqual(ALLOWED_CDP_METHODS, [
    "Page.enable",
    "Page.getFrameTree",
    "Page.getLayoutMetrics",
    "Page.startScreencast",
    "Page.screencastFrameAck",
    "Page.stopScreencast",
  ]);
  assert.deepEqual(
    validateCdpCommand("Page.startScreencast", { format: "png", everyNthFrame: 1 }).params,
    { format: "png", everyNthFrame: 1 },
  );
  assert.equal(
    validateCdpCommand("Page.screencastFrameAck", { sessionId: 3 }).method,
    "Page.screencastFrameAck",
  );
  for (const method of [
    "Runtime.evaluate",
    "Input.dispatchKeyEvent",
    "Emulation.setDeviceMetricsOverride",
    "Page.bringToFront",
    "Network.enable",
  ]) {
    expectCode("METHOD_NOT_ALLOWED", () => validateCdpCommand(method, {}));
  }
  for (const forbiddenOption of ["maxWidth", "maxHeight", "resize", "crop"]) {
    expectCode("INVALID_COMMAND_PARAMS", () =>
      validateCdpCommand("Page.startScreencast", {
        format: "png",
        everyNthFrame: 1,
        [forbiddenOption]: 1,
      }),
    );
  }
  expectCode("INVALID_COMMAND_PARAMS", () =>
    validateCdpCommand("Page.screencastFrameAck", { sessionId: 3, sequence: 1 }),
  );
});

test("synthetic command spy never records a forbidden dispatch", () => {
  const dispatchSpy = [];
  const attemptForTest = (method, params) => {
    const command = validateCdpCommand(method, params);
    dispatchSpy.push(command);
  };
  expectCode("METHOD_NOT_ALLOWED", () => attemptForTest("Runtime.evaluate", { expression: "1+1" }));
  assert.deepEqual(dispatchSpy, []);
  attemptForTest("Page.enable", {});
  assert.deepEqual(
    dispatchSpy.map(({ method }) => method),
    ["Page.enable"],
  );
});

test("an early frame event is retained before the start response", () => {
  const earlyFrame = accept(ledger());
  assert.equal(earlyFrame.state.startResponseSeen, false);
  assert.equal(earlyFrame.frame.sequence, 1);
  const afterResponse = recordStartResponse(earlyFrame.state, 1002);
  assert.equal(afterResponse.startResponseSeen, true);
  assert.deepEqual(
    afterResponse.outstanding.map(({ sequence }) => sequence),
    [1],
  );
});

test("sequence is guard-assigned from one; repeated opaque CDP session IDs do not sequence frames", () => {
  let state = ledger();
  const first = accept(state, frame({ sessionId: 3, captureTimestampSeconds: 40.5 }), 1001);
  const second = accept(first.state, frame({ sessionId: 3, captureTimestampSeconds: 40.75 }), 1002);
  assert.equal(first.frame.sequence, 1);
  assert.equal(second.frame.sequence, 2);
  assert.equal(first.frame.sessionId, second.frame.sessionId);
  assert.equal(first.frame.captureTimestampSeconds, 40.5);
  assert.equal(first.frame.receivedAtMs, 1001);
  assert.equal(second.frame.captureTimestampSeconds, 40.75);
  state = acknowledgeScreencastFrame(
    second.state,
    {
      epoch: 7,
      sequence: 1,
      sessionId: 3,
      durableAccepted: true,
    },
    1003,
  );
  assert.equal(state.outstanding.length, 1);
  state = acknowledgeScreencastFrame(
    state,
    {
      epoch: 7,
      sequence: 2,
      sessionId: 3,
      durableAccepted: true,
    },
    1004,
  );
  assert.equal(state.outstanding.length, 0);
});

test("ACK requires exact epoch, sequence, session ID, and durable acceptance", () => {
  const accepted = accept(ledger());
  const ack = { epoch: 7, sequence: 1, sessionId: 3, durableAccepted: true };
  const staleEpoch = acknowledgeScreencastFrame(accepted.state, { ...ack, epoch: 8 }, 1002);
  assert.equal(staleEpoch.status, "INCOMPLETE");
  assert.equal(staleEpoch.reason, "STALE_OR_DUPLICATE_ACK");
  const wrongSession = acknowledgeScreencastFrame(accepted.state, { ...ack, sessionId: 4 }, 1002);
  assert.equal(wrongSession.status, "INCOMPLETE");
  const notDurable = acknowledgeScreencastFrame(
    accepted.state,
    { ...ack, durableAccepted: false },
    1002,
  );
  assert.equal(notDurable.reason, "CONSUMER_FAILURE");
  const acked = acknowledgeScreencastFrame(accepted.state, ack, 1002);
  const duplicate = acknowledgeScreencastFrame(acked, ack, 1003);
  assert.equal(duplicate.status, "INCOMPLETE");
  assert.equal(duplicate.reason, "STALE_OR_DUPLICATE_ACK");
});

test("backwards clock, malformed bitmap inspection, and payload overflow fail closed", () => {
  const accepted = accept(ledger());
  assert.equal(accept(accepted.state, frame(), 1000).state.reason, "CLOCK_REGRESSION");
  assert.equal(accept(ledger(), frame({ pixelWidth: 800 }), 1001).state.reason, "INVALID_FRAME");
  assert.equal(accept(ledger(), frame({ payloadBytes: 101 }), 1001).state.reason, "INVALID_FRAME");
});

test("three outstanding frames and the byte budget bound buffering without dropping", () => {
  assert.equal(MAX_OUTSTANDING_FRAMES, 3);
  let state = ledger();
  for (let i = 0; i < 3; i += 1) {
    const result = accept(state, frame({ sessionId: i, payloadBytes: 40 }), 1001 + i);
    state = result.state;
    assert.equal(result.frame.sequence, i + 1);
  }
  const overCount = accept(state, frame(), 1004);
  assert.equal(overCount.frame, null);
  assert.equal(overCount.state.reason, "BACKPRESSURE");

  const byteLimited = ledger({
    limits: { ...limits, maxPayloadBytes: 50, maxOutstandingBytes: 50 },
  });
  const one = accept(byteLimited, frame({ payloadBytes: 40 }), 1001);
  const overBytes = accept(one.state, frame({ payloadBytes: 20 }), 1002);
  assert.equal(overBytes.frame, null);
  assert.equal(overBytes.state.reason, "BACKPRESSURE");
});

test("an ACKed damage-driven quiet page stays active beyond the ACK budget", () => {
  const accepted = accept(ledger());
  const acked = acknowledgeScreencastFrame(
    accepted.state,
    { epoch: 7, sequence: 1, sessionId: 3, durableAccepted: true },
    1002,
  );
  const started = recordStartResponse(acked, 1003);
  const quiet = transitionFrameLedger(started, { type: "check-deadlines", atMs: 20_000 }).state;
  assert.equal(quiet.status, "ACTIVE");
  assert.equal(quiet.reason, null);
  assert.deepEqual(quiet.outstanding, []);
});

test("first-frame deadline and outstanding ACK timeout are polled explicitly", () => {
  const noFrame = transitionFrameLedger(ledger(), {
    type: "check-deadlines",
    atMs: 1050,
  }).state;
  assert.equal(noFrame.status, "INCOMPLETE");
  assert.equal(noFrame.reason, "FIRST_FRAME_TIMEOUT");

  const accepted = recordStartResponse(accept(ledger()).state, 1002);
  const timedOut = transitionFrameLedger(accepted, {
    type: "check-deadlines",
    atMs: 1101,
  }).state;
  assert.equal(timedOut.status, "INCOMPLETE");
  assert.equal(timedOut.reason, "ACK_TIMEOUT");
  expectCode("INVALID_LEDGER_EVENT", () =>
    transitionFrameLedger(accepted, { type: "check-deadlines", atMs: 1002, extra: true }),
  );
});

test("total active duration is bounded independently of frame arrival", () => {
  const accepted = accept(ledger());
  const acked = acknowledgeScreencastFrame(
    accepted.state,
    { epoch: 7, sequence: 1, sessionId: 3, durableAccepted: true },
    1002,
  );
  const started = recordStartResponse(acked, 1003);
  const timedOut = transitionFrameLedger(started, {
    type: "check-deadlines",
    atMs: 1_001_000,
  }).state;
  assert.equal(timedOut.status, "INCOMPLETE");
  assert.equal(timedOut.reason, "TOTAL_DURATION_TIMEOUT");
});

test("source timestamp regression is an incomplete discontinuity, not encoder chronology", () => {
  const first = accept(ledger(), frame({ captureTimestampSeconds: 40.5 }), 1001);
  const regressed = accept(first.state, frame({ captureTimestampSeconds: 39.25 }), 1002);
  assert.equal(regressed.state.status, "INCOMPLETE");
  assert.equal(regressed.state.reason, "TIMESTAMP_DISCONTINUITY");
  assert.equal(regressed.frame, null);
});

test("an early durable frame cannot bypass the separate missing start-response deadline", () => {
  const early = accept(ledger());
  const acked = acknowledgeScreencastFrame(
    early.state,
    { epoch: 7, sequence: 1, sessionId: 3, durableAccepted: true },
    1002,
  );
  const missing = transitionFrameLedger(acked, { type: "check-deadlines", atMs: 1075 }).state;
  assert.equal(missing.status, "INCOMPLETE");
  assert.equal(missing.reason, "START_RESPONSE_TIMEOUT");
});

test("resize, replacement, hidden page, disconnect, and consumer failure invalidate", () => {
  assert.deepEqual(
    [
      invalidateCapture(ledger(), "resize").status,
      invalidateCapture(ledger(), "replacement").status,
      invalidateCapture(ledger(), "hidden").status,
      invalidateCapture(ledger(), "disconnect").status,
      invalidateCapture(ledger(), "consumer-failure").status,
    ],
    ["INCOMPLETE", "UNKNOWN", "UNKNOWN", "UNKNOWN", "INCOMPLETE"],
  );
});

test("drain accepts already-received late frames and remains nonterminal until drain-finished", () => {
  let draining = beginFrameDrain(ledger(), 1001);
  const lateFrame = accept(draining, frame({ sessionId: 9 }), 1002);
  assert.equal(lateFrame.state.status, "DRAINING");
  assert.equal(lateFrame.frame.sequence, 1);
  draining = finishFrameDrain(lateFrame.state, 1003);
  assert.equal(draining.status, "DRAINING");
  draining = acknowledgeScreencastFrame(
    draining,
    { epoch: 7, sequence: 1, sessionId: 9, durableAccepted: true },
    1004,
  );
  const drained = finishFrameDrain(draining, 1005);
  assert.equal(drained.status, "DRAINED");
  expectCode("FRAME_AFTER_TERMINAL", () => accept(drained, frame(), 1006));
});

test("drain timeout is incomplete and terminal frames require quarantine", () => {
  const timedOut = finishFrameDrain(beginFrameDrain(ledger(), 1001), 1026);
  assert.equal(timedOut.status, "INCOMPLETE");
  assert.equal(timedOut.reason, "DRAIN_TIMEOUT");
  expectCode("FRAME_AFTER_TERMINAL", () => accept(timedOut, frame(), 1027));
  expectCode("FRAME_AFTER_TERMINAL", () => accept(invalidateCapture(ledger(), "hidden")));
});
