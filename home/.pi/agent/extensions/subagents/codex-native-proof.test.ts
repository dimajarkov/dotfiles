import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexUnixAppServerConnection,
  attachToExactThread,
  reconcileExactThreadItems,
} from "./codex-native-proof.ts";

const threadId = "thr_assigned_native_thread";

function websocketAccept(key: string) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function websocketText(payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  assert.ok(body.length < 126);
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

function readClientFrames(
  socket: Socket,
  onMessage: (message: Record<string, unknown>) => void,
) {
  let buffer = Buffer.alloc(0);
  let handshake = false;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshake) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers = buffer.subarray(0, end).toString("utf8");
      const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(headers)?.[1]?.trim();
      assert.ok(key);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
      );
      buffer = buffer.subarray(end + 4);
      handshake = true;
    }
    while (handshake && buffer.length >= 6) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      assert.equal(second & 0x80, 0x80);
      const lengthCode = second & 0x7f;
      const headerLength = lengthCode === 126 ? 4 : 2;
      if (buffer.length < headerLength + 4) return;
      const length =
        lengthCode === 126 ? buffer.readUInt16BE(2) : lengthCode;
      const mask = buffer.subarray(headerLength, headerLength + 4);
      const payloadStart = headerLength + 4;
      if (buffer.length < payloadStart + length) return;
      const payload = Buffer.from(
        buffer.subarray(payloadStart, payloadStart + length),
      );
      for (let index = 0; index < payload.length; index += 1)
        payload[index] = payload[index]! ^ mask[index % 4]!;
      buffer = buffer.subarray(payloadStart + length);
      if (opcode === 8) return;
      assert.equal(opcode, 1);
      onMessage(JSON.parse(payload.toString("utf8")) as Record<string, unknown>);
    }
  });
}

test("server requests with a colliding client id are not mistaken for replies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-proof-collision-"));
  const socketPath = join(directory, "app-server.sock");
  const server = createServer();
  server.on("connection", (socket) => {
    readClientFrames(socket, (message) => {
      if (message.method === "initialized") return;
      if (message.method === "initialize") {
        socket.write(websocketText({ id: message.id, result: { userAgent: "fixture" } }));
        return;
      }
      if (message.method === "client/request") {
        socket.write(
          Buffer.concat([
            websocketText({
              id: message.id,
              method: "approval/request",
              params: { prompt: "server-originated request" },
            }),
            websocketText({
              method: "turn/started",
              params: { threadId, turnId: "turn_server_notification" },
            }),
            websocketText({ id: message.id, result: { acknowledgement: "client reply" } }),
          ]),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { path: socketPath, readableAll: false, writableAll: false },
      resolve,
    );
  });

  const connection = new CodexUnixAppServerConnection(socketPath);
  t.after(async () => {
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await connection.connect();
  await connection.initialize();

  const incoming: Record<string, unknown>[] = [];
  connection.onMessage((message) => incoming.push(message));
  const response = await connection.request("client/request");

  assert.deepEqual(response, { acknowledgement: "client reply" });
  assert.deepEqual(incoming, [
    {
      id: 2,
      method: "approval/request",
      params: { prompt: "server-originated request" },
    },
    {
      method: "turn/started",
      params: { threadId, turnId: "turn_server_notification" },
    },
  ]);
});

test("history reconciliation deduplicates exact-thread item notifications and drops auxiliary threads", () => {
  const notifications = [
    {
      method: "item/completed",
      params: {
        threadId,
        item: { id: "item_shared", text: "live item" },
      },
    },
    {
      method: "item/started",
      params: {
        threadId,
        item: { id: "item_notification_only", text: "started item" },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId,
        item: { id: "item_notification_only", text: "completed item" },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thr_auxiliary_thread",
        item: { id: "item_aux", text: "auxiliary item" },
      },
    },
  ];
  const history = {
    thread: {
      id: threadId,
      turns: [
        {
          items: [
            { id: "item_shared", text: "authoritative history item" },
            { id: "item_history", text: "history-only item" },
          ],
        },
      ],
    },
  };

  const reconciled = reconcileExactThreadItems(threadId, notifications, history);

  assert.deepEqual(reconciled.items, [
    {
      item: { id: "item_shared", text: "authoritative history item" },
      sources: ["notification", "history"],
    },
    {
      item: { id: "item_notification_only", text: "completed item" },
      sources: ["notification"],
    },
    {
      item: { id: "item_history", text: "history-only item" },
      sources: ["history"],
    },
  ]);
  assert.deepEqual(reconciled.overlapItemIds, ["item_shared"]);
});

test("history reconciliation rejects a response from another thread", () => {
  assert.throws(
    () =>
      reconcileExactThreadItems(threadId, [], {
        thread: { id: "thr_auxiliary_thread", turns: [] },
      }),
    /history did not match the assigned thread/,
  );
});

test("native proof controller resumes only the assigned exact thread", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-native-proof-"));
  const socketPath = join(directory, "app-server.sock");
  const server = createServer();
  const received: Array<{ method: unknown; params: unknown }> = [];
  let resumedThreadId = threadId;
  server.on("connection", (socket) => {
    readClientFrames(socket, (message) => {
      if (message.method === "initialized") return;
      if (message.method === "initialize") {
        socket.write(
          websocketText({ id: message.id, result: { userAgent: "fixture" } }),
        );
        return;
      }
      received.push({ method: message.method, params: message.params });
      socket.write(
        websocketText({
          id: message.id,
          result: { thread: { id: resumedThreadId, cwd: "/private/workdir" } },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { path: socketPath, readableAll: false, writableAll: false },
      resolve,
    );
  });
  t.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const connection = new CodexUnixAppServerConnection(socketPath);
  t.after(() => connection.close());
  await connection.connect();
  await connection.initialize();

  const thread = await attachToExactThread(connection, threadId);

  assert.equal(thread.id, threadId);
  resumedThreadId = "thr_auxiliary_thread";
  await assert.rejects(attachToExactThread(connection, threadId), /assigned thread/);
  assert.deepEqual(received, [
    { method: "thread/resume", params: { threadId } },
    { method: "thread/resume", params: { threadId } },
  ]);
});
