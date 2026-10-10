import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type JsonRecord = Record<string, unknown>;
type MessageHandler = (message: JsonRecord) => void;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function encodeFrame(opcode: number, payload: Buffer) {
  const mask = randomBytes(4);
  const extendedLength =
    payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const headerLength = 2 + extendedLength + 4;
  const frame = Buffer.allocUnsafe(headerLength + payload.length);
  frame[0] = 0x80 | opcode;
  if (extendedLength === 0) {
    frame[1] = 0x80 | payload.length;
  } else if (extendedLength === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskOffset = 2 + extendedLength;
  mask.copy(frame, maskOffset);
  for (let index = 0; index < payload.length; index += 1)
    frame[headerLength + index] = payload[index]! ^ mask[index % 4]!;
  return frame;
}

export class CodexUnixAppServerConnection {
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private websocketReady = false;
  private closed = false;
  private nextRequestId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect() {
    if (this.socket) throw new Error("Codex connection already opened.");
    const socket = connect(this.socketPath);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve();
      });
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Codex socket closed.")));

    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`)
      .digest("base64");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Codex WebSocket upgrade timed out.")),
        REQUEST_TIMEOUT_MS,
      );
      let response = Buffer.alloc(0);
      const onUpgrade = (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        const end = response.indexOf("\r\n\r\n");
        if (end < 0) return;
        clearTimeout(timer);
        socket.off("data", onUpgrade);
        const headers = response.subarray(0, end).toString("utf8");
        const acceptHeader = headers
          .split("\r\n")
          .find((header) =>
            header.toLowerCase().startsWith("sec-websocket-accept:"),
          );
        if (
          !/^HTTP\/1\.1 101\b/.test(headers) ||
          acceptHeader?.slice(acceptHeader.indexOf(":") + 1).trim() !==
            expectedAccept
        ) {
          reject(new Error("Codex Unix socket refused WebSocket upgrade."));
          return;
        }
        this.websocketReady = true;
        this.buffer = response.subarray(end + 4);
        socket.on("data", (data) => this.consume(data));
        this.consumeFrames();
        resolve();
      };
      socket.on("data", onUpgrade);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      );
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "pi-subagents-issue-13-proof",
        title: "Pi Codex exact-thread proof",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method: string, params: JsonRecord = {}) {
    if (!this.websocketReady || this.closed)
      return Promise.reject(new Error("Codex WebSocket is not connected."));
    const id = ++this.nextRequestId;
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request ${method} timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: JsonRecord = {}) {
    if (!this.websocketReady || this.closed)
      throw new Error("Codex WebSocket is not connected.");
    this.write({ method, params });
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  close() {
    if (this.closed) return;
    if (this.websocketReady && this.socket?.writable)
      this.writeFrame(8, Buffer.from([0x03, 0xe8]));
    this.closed = true;
    this.socket?.end();
    this.fail(new Error("Codex connection closed."));
  }

  private write(message: JsonRecord) {
    this.writeFrame(1, Buffer.from(JSON.stringify(message)));
  }

  private writeFrame(opcode: number, payload: Buffer) {
    const socket = this.socket;
    if (!socket?.writable) throw new Error("Codex Unix socket is not writable.");
    socket.write(encodeFrame(opcode, payload));
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES + 14) {
      this.fail(new Error("Codex WebSocket frame exceeded the proof limit."));
      this.socket?.destroy();
      return;
    }
    this.consumeFrames();
  }

  private consumeFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const bigLength = this.buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(MAX_FRAME_BYTES)) {
          this.fail(new Error("Codex WebSocket frame exceeded the proof limit."));
          this.socket?.destroy();
          return;
        }
        length = Number(bigLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.fail(new Error("Codex WebSocket frame exceeded the proof limit."));
        this.socket?.destroy();
        return;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1)
          payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      if (opcode === 8) {
        this.socket?.end();
        this.fail(new Error("Codex WebSocket peer closed."));
      } else if (opcode === 9) {
        this.writeFrame(10, payload);
      } else if (opcode === 0 || opcode === 1 || opcode === 2) {
        if (opcode !== 0 && this.fragments.length !== 0) {
          this.fail(new Error("Codex sent an invalid fragmented message."));
          this.socket?.destroy();
          return;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_FRAME_BYTES) {
          this.fail(new Error("Codex WebSocket message exceeded the proof limit."));
          this.socket?.destroy();
          return;
        }
        if (final) {
          this.consumeMessage(Buffer.concat(this.fragments).toString("utf8"));
          this.fragments = [];
          this.fragmentBytes = 0;
        }
      }
    }
  }

  private consumeMessage(text: string) {
    let message: JsonRecord | undefined;
    try {
      message = record(JSON.parse(text));
    } catch {
      this.fail(new Error("Codex sent invalid JSON over its Unix socket."));
      return;
    }
    if (!message) return;
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const error = record(message.error);
        pending.reject(
          new Error(
            typeof error?.message === "string"
              ? error.message
              : "Codex app-server request failed.",
          ),
        );
      } else {
        pending.resolve(record(message.result) ?? {});
      }
      return;
    }
    for (const handler of this.messageHandlers) handler(message);
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

type ItemEvidenceSource = "notification" | "history";

export function reconcileExactThreadItems(
  threadId: string,
  notifications: readonly unknown[],
  history: unknown,
) {
  const thread = record(record(history)?.thread);
  if (thread?.id !== threadId)
    throw new Error("Codex history did not match the assigned thread.");

  const items = new Map<
    string,
    { item: JsonRecord; sources: Set<ItemEvidenceSource> }
  >();
  const addItem = (
    candidate: unknown,
    source: ItemEvidenceSource,
    authoritative: boolean,
  ) => {
    const item = record(candidate);
    if (typeof item?.id !== "string") return;
    const current = items.get(item.id);
    if (current) {
      if (authoritative || source === "notification") current.item = item;
      current.sources.add(source);
      return;
    }
    items.set(item.id, { item, sources: new Set([source]) });
  };

  for (const notification of notifications) {
    const envelope = record(notification);
    const params = record(envelope?.params);
    if (
      (envelope?.method === "item/started" ||
        envelope?.method === "item/completed") &&
      params?.threadId === threadId
    ) {
      addItem(params.item, "notification", false);
    }
  }

  if (Array.isArray(thread.turns)) {
    for (const turn of thread.turns) {
      const turnRecord = record(turn);
      if (!Array.isArray(turnRecord?.items)) continue;
      for (const item of turnRecord.items) addItem(item, "history", true);
    }
  }

  const reconciledItems = [...items.values()].map(({ item, sources }) => ({
    item,
    sources: [...sources],
  }));
  return {
    items: reconciledItems,
    overlapItemIds: reconciledItems
      .filter(({ sources }) =>
        sources.includes("notification") && sources.includes("history"),
      )
      .map(({ item }) => item.id as string),
  };
}

export async function attachToExactThread(
  connection: CodexUnixAppServerConnection,
  threadId: string,
) {
  const result = await connection.request("thread/resume", { threadId });
  const thread = record(result.thread);
  if (thread?.id !== threadId)
    throw new Error("Codex resumed a thread other than the assigned thread.");
  return thread;
}
