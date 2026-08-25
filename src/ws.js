import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * @typedef {object} WebSocketConnection
 * @property {(text: string) => void} send one text frame
 * @property {(code?: number, reason?: string) => void} close send a close frame and end the socket
 * @property {(fn: () => void) => void} onClose run once when the connection is gone, however it went
 * @property {boolean} closed
 */

/**
 * Completes a WebSocket handshake on an HTTP upgrade and returns a minimal
 * server-side connection: text frames out; close and ping handled in. That is
 * all a one-way event stream needs, and it keeps the runtime dependency count
 * at zero. Writes a 400 and returns null if the request is not an upgrade.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head bytes received after the headers, if any
 * @returns {WebSocketConnection | null}
 */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);

  let closed = false;
  /** @type {Set<() => void>} */
  const closeListeners = new Set();
  let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

  const finish = () => {
    if (closed) return;
    closed = true;
    for (const fn of closeListeners) fn();
    closeListeners.clear();
  };
  /** @param {string} text */
  const send = (text) => {
    if (!closed) socket.write(frame(OP_TEXT, Buffer.from(text, "utf8")));
  };
  const close = (code = 1000, reason = "") => {
    if (closed) return;
    const payload = Buffer.concat([
      Buffer.from([code >> 8, code & 0xff]),
      Buffer.from(reason, "utf8"),
    ]);
    socket.write(frame(OP_CLOSE, payload));
    socket.end();
    finish();
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = readFrame(buffer);
      if (!parsed) break;
      buffer = buffer.subarray(parsed.length);
      if (parsed.opcode === OP_CLOSE) return close(1000);
      if (parsed.opcode === OP_PING) socket.write(frame(OP_PONG, parsed.payload));
      // Data frames from the client are ignored: the stream is one-way.
    }
  });
  socket.on("close", finish);
  socket.on("end", finish);
  socket.on("error", finish);

  return {
    send,
    close,
    onClose: (fn) => {
      if (closed) fn();
      else closeListeners.add(fn);
    },
    get closed() {
      return closed;
    },
  };
}

/** Builds an unmasked server frame. @param {number} opcode @param {Buffer} payload */
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parses one complete client frame from the front of `buf`, unmasking it.
 * @param {Buffer} buf
 * @returns {{opcode: number, payload: Buffer, length: number} | null} null until a whole frame is buffered
 */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  /** @type {Buffer | null} */
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, length: offset + len };
}
