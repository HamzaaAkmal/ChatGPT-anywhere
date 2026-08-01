import { EventEmitter } from "node:events";
import crypto from "node:crypto";

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.isAlive = true;

    this.socket.on("data", (data) => this._processData(data));
    this.socket.on("close", () => {
      this.emit("close");
    });
    this.socket.on("error", (err) => {
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      }
    });
    this.socket.on("end", () => {
      this.emit("close");
    });

    this._buffer = Buffer.alloc(0);
    this._fragmentedOpcode = 0;
    this._fragmentedPayload = [];
  }

  ping() {
    this._sendFrame(0x09, Buffer.alloc(0));
  }

  pong() {
    this._sendFrame(0x0a, Buffer.alloc(0));
  }

  send(data) {
    const isBuffer = Buffer.isBuffer(data);
    const opcode = isBuffer ? 0x02 : 0x01;
    const payload = isBuffer ? data : Buffer.from(String(data));
    this._sendFrame(opcode, payload);
  }

  close(code = 1000, reason = "") {
    if (this.socket.destroyed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this._sendFrame(0x08, payload);
    this.socket.end();
  }

  _sendFrame(opcode, payload) {
    if (this.socket.destroyed) return;
    const length = payload.length;
    let headerLength = 2;
    if (length > 125 && length <= 65535) headerLength += 2;
    else if (length > 65535) headerLength += 8;

    const frame = Buffer.alloc(headerLength + length);
    frame[0] = 0x80 | opcode; // FIN bit set

    if (length <= 125) {
      frame[1] = length;
    } else if (length <= 65535) {
      frame[1] = 126;
      frame.writeUInt16BE(length, 2);
    } else {
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
    }

    payload.copy(frame, headerLength);
    this.socket.write(frame);
  }

  _processData(data) {
    this._buffer = Buffer.concat([this._buffer, data]);

    while (this._buffer.length >= 2) {
      const byte1 = this._buffer[0];
      const byte2 = this._buffer[1];

      const fin = (byte1 & 0x80) !== 0;
      let opcode = byte1 & 0x0f;
      const masked = (byte2 & 0x80) !== 0;
      let payloadLength = byte2 & 0x7f;

      let offset = 2;

      if (payloadLength === 126) {
        if (this._buffer.length < offset + 2) break;
        payloadLength = this._buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this._buffer.length < offset + 8) break;
        payloadLength = Number(this._buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskingKey;
      if (masked) {
        if (this._buffer.length < offset + 4) break;
        maskingKey = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this._buffer.length < offset + payloadLength) break;

      const payload = Buffer.alloc(payloadLength);
      this._buffer.copy(payload, 0, offset, offset + payloadLength);

      if (masked && maskingKey) {
        for (let i = 0; i < payloadLength; i++) {
          payload[i] ^= maskingKey[i % 4];
        }
      }

      this._buffer = this._buffer.subarray(offset + payloadLength);

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x00) {
      // Continuation frame
      opcode = this._fragmentedOpcode;
      this._fragmentedPayload.push(payload);
    } else if (opcode === 0x01 || opcode === 0x02) {
      if (!fin) {
        this._fragmentedOpcode = opcode;
        this._fragmentedPayload = [payload];
      }
    }

    if (!fin) return;

    let finalPayload = payload;
    if (this._fragmentedPayload.length > 0 && (opcode === 0x01 || opcode === 0x02 || opcode === 0x00)) {
      if (opcode === 0x00) {
        // Already pushed above for Continuation Frame
      } else {
        // Should not really happen as non-fin sets it, but just in case
        this._fragmentedPayload.push(payload);
      }
      finalPayload = Buffer.concat(this._fragmentedPayload);
      this._fragmentedPayload = [];
      this._fragmentedOpcode = 0;
    }

    switch (opcode) {
      case 0x01: // Text
        this.emit("message", finalPayload.toString("utf8"));
        break;
      case 0x02: // Binary
        this.emit("message", finalPayload);
        break;
      case 0x08: // Close
        this.emit("close");
        this.close();
        break;
      case 0x09: // Ping
        this.pong();
        break;
      case 0x0a: // Pong
        this.isAlive = true;
        break;
    }
  }
}

export class WebSocketServer extends EventEmitter {
  constructor(server, options = {}) {
    super();
    this.server = server;
    this.path = options.path;
    this.connections = new Set();
    this.keepAliveInterval = null;

    this.server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    if (options.keepAlive !== false) {
      this.keepAliveInterval = setInterval(() => {
        for (const conn of this.connections) {
          if (!conn.isAlive) {
            conn.close();
            this.connections.delete(conn);
          } else {
            conn.isAlive = false;
            conn.ping();
          }
        }
      }, 30000);
      this.keepAliveInterval.unref(); // Don't block Node.js exit
    }
  }

  handleUpgrade(req, socket, head) {
    if (this.path && new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname !== this.path) {
      return; // Not for us
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`
    ];

    socket.write(headers.join("\r\n") + "\r\n\r\n");

    const connection = new WebSocketConnection(socket);
    this.connections.add(connection);

    connection.on("close", () => {
      this.connections.delete(connection);
    });

    this.emit("connection", connection, req);
  }

  close() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections.clear();
  }
}
