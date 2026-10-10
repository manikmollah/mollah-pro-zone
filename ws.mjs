/**
 * EventHub: tiny zero-dependency WebSocket broadcaster (RFC6455, text frames only).
 * Pushes live state to the desktop UI.
 */

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class EventHub {
  #clients = new Set();
  #maxClients = 24;

  /** handle an HTTP upgrade request */
  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return false;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const client = { socket, alive: true };
    this.#clients.add(client);
    if (this.#clients.size > this.#maxClients) {
      const first = this.#clients.values().next().value;
      if (first && first !== client) this.#drop(first);
    }

    socket.on('data', (buf) => {
      // handle close + ping/pong minimally
      const op = buf[0] & 0x0f;
      if (op === 0x8) this.#drop(client);
      else if (op === 0x9) this.#write(client, buf[0] === 0x89 ? buf : Buffer.from([0x8a, 0x00]));
    });
    socket.on('close', () => this.#clients.delete(client));
    socket.on('error', () => this.#drop(client));

    this.sendTo(client, { type: 'hello', at: Date.now() });
    return true;
  }

  #drop(client) {
    this.#clients.delete(client);
    try {
      client.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  #frame(text) {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  #write(client, buf) {
    try {
      client.socket.write(buf);
    } catch {
      this.#drop(client);
    }
  }

  sendTo(client, obj) {
    this.#write(client, this.#frame(JSON.stringify(obj)));
  }

  broadcast(obj) {
    if (!this.#clients.size) return;
    const frame = this.#frame(JSON.stringify(obj));
    for (const c of [...this.#clients]) this.#write(c, frame);
  }

  get clientCount() {
    return this.#clients.size;
  }
}
