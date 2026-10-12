import { connect } from "node:net";
import { lstatSync, realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

// The native app-server speaks RFC 6455 on its Unix socket. Node's built-in
// WebSocket does not accept Unix sockets, so this bounded local transport uses net.
export async function openAppServer(endpoint) {
  if (!endpoint?.startsWith("unix://") || !isAbsolute(endpoint.slice(7)))
    throw new Error(
      "An exact original local Unix app-server endpoint is required; no default endpoint inference",
    );
  const path = endpoint.slice(7),
    parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw new Error("App-server endpoint requires owner-private parent");
  const socket = connect(`${realpathSync(dirname(path))}/${path.split("/").at(-1)}`);
  const key = randomBytes(16).toString("base64"),
    accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
  const pending = new Map(),
    listeners = new Set(),
    closeListeners = new Set();
  let sequence = 0,
    buffer = Buffer.alloc(0),
    closed = false,
    upgraded = false,
    fragments = [],
    fragmentBytes = 0;
  let readyResolve, readyReject;
  const ready = new Promise((r, j) => {
    readyResolve = r;
    readyReject = j;
  });
  const fail = (error) => {
    if (closed) return;
    closed = true;
    readyReject(error);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
    for (const listener of closeListeners) listener(error);
  };
  const send = (text, opcode = 1) => {
    const body = Buffer.isBuffer(text) ? text : Buffer.from(text),
      mask = randomBytes(4);
    const header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);
    header[0] = 0x80 | opcode;
    if (body.length < 126) header[1] = 0x80 | body.length;
    else if (body.length < 65536) {
      header[1] = 0xfe;
      header.writeUInt16BE(body.length, 2);
    } else {
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  };
  const message = (body) => {
    const r = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      p = pending.get(r.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(r.id);
      if (r.error) p.reject(new Error(r.error.message));
      else p.resolve(r.result);
    } else if (r.method && r.id === undefined)
      for (const listener of listeners) listener(r.method, r.params);
    // Native requests can be broadcast to every subscriber. An observer must
    // leave approvals, user input, tools, and authentication to the original UI.
  };
  const handshakeTimer = setTimeout(() => {
    socket.destroy();
    fail(new Error("Native WebSocket handshake timed out"));
  }, 5000);
  socket.on("error", fail);
  socket.on("close", () => {
    clearTimeout(handshakeTimer);
    fail(new Error("Original app-server connection ended; never reconnect to a replacement"));
  });
  socket.on("connect", () =>
    socket.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ),
  );
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    try {
      if (buffer.length > 32 * 1024 * 1024) throw new Error("Oversized native WebSocket frame");
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > 8192) throw new Error("Oversized upgrade headers");
          return;
        }
        const lines = buffer.subarray(0, end).toString().split("\r\n"),
          headers = new Map(
            lines.slice(1).map((l) => {
              const i = l.indexOf(":");
              return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()];
            }),
          );
        if (
          !/^HTTP\/1\.1 101\b/.test(lines[0]) ||
          headers.get("sec-websocket-accept") !== accept ||
          headers.get("upgrade")?.toLowerCase() !== "websocket"
        )
          throw new Error("Native WebSocket upgrade was refused");
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        clearTimeout(handshakeTimer);
        readyResolve();
      }
      while (buffer.length >= 2) {
        const first = buffer[0],
          opcode = first & 15,
          fin = !!(first & 128);
        if (first & 0x70 || buffer[1] & 128)
          throw new Error("Unsupported native WebSocket frame flags");
        let size = buffer[1] & 127,
          offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        } else if (size === 127) {
          if (buffer.length < 10) return;
          const n = buffer.readBigUInt64BE(2);
          if (n > 32n * 1024n * 1024n) throw new Error("Oversized native message");
          size = Number(n);
          offset = 10;
        }
        if (opcode >= 8 && (!fin || size > 125)) throw new Error("Invalid native control frame");
        if (buffer.length < offset + size) return;
        const body = buffer.subarray(offset, offset + size);
        buffer = buffer.subarray(offset + size);
        if (opcode === 8) {
          socket.end();
          fail(new Error("Original app-server closed its connection"));
          return;
        }
        if (opcode === 9) {
          send(body, 10);
          continue;
        }
        if (opcode === 10) continue;
        if (opcode !== 1 && opcode !== 0) throw new Error("Unsupported native binary frame");
        if ((opcode === 0 && !fragments.length) || (opcode === 1 && fragments.length))
          throw new Error("Invalid native message continuation");
        fragments.push(body);
        fragmentBytes += size;
        if (fragmentBytes > 32 * 1024 * 1024)
          throw new Error("Oversized fragmented native message");
        if (fin) {
          message(Buffer.concat(fragments));
          fragments = [];
          fragmentBytes = 0;
        }
      }
    } catch (error) {
      socket.destroy();
      fail(error);
    }
  });
  await ready;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error("Original app-server endpoint is disconnected"));
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Native ${method} receipt timed out`));
        }, 10000);
      pending.set(id, { resolve, reject, timer });
      send(JSON.stringify({ id, method, params }));
    });
  try {
    await request("initialize", {
      clientInfo: { name: "hunk_turn_review", version: "1.0.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    send(JSON.stringify({ method: "initialized", params: {} }));
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return {
    request,
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      if (closed) queueMicrotask(() => listener(new Error("Original connection already ended")));
      else closeListeners.add(listener);
    },
    close() {
      socket.end();
    },
  };
}
