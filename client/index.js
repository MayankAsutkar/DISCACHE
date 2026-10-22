'use strict';

const net = require('node:net');

const PROTOCOL_MAGIC = 0xdc;
const RESPONSE_HEADER_SIZE = 16;
const MAX_FIELD_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const OP = Object.freeze({
  GET: 0x01,
  PUT: 0x02,
  DELETE: 0x03,
  PING: 0x07,
});

const STATUS = Object.freeze({
  OK: 0x00,
  NOT_FOUND: 0x01,
});

class DisCacheError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'DisCacheError';
    this.status = status;
  }
}

function encodeRequest(opcode, key, value) {
  if (typeof key !== 'string' || typeof value !== 'string') {
    throw new TypeError('DisCache keys and values must be strings');
  }

  const keyBytes = Buffer.from(key, 'utf8');
  const valueBytes = Buffer.from(value, 'utf8');
  if (keyBytes.length > MAX_FIELD_BYTES || valueBytes.length > MAX_FIELD_BYTES) {
    throw new RangeError('DisCache keys and values must be no larger than 10 MiB each');
  }

  const header = Buffer.alloc(10);
  header.writeUInt8(PROTOCOL_MAGIC, 0);
  header.writeUInt8(opcode, 1);
  header.writeUInt32BE(keyBytes.length, 2);
  header.writeUInt32BE(valueBytes.length, 6);
  return Buffer.concat([header, keyBytes, valueBytes]);
}

class DisCacheClient {
  constructor({ host = '127.0.0.1', port = 8000, timeoutMs = 3000 } = {}) {
    if (typeof host !== 'string' || host.trim() === '') {
      throw new TypeError('host must be a non-empty string');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError('port must be an integer between 1 and 65535');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive number');
    }

    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  async get(key) {
    const response = await this._request(OP.GET, key, '');
    if (response.status === STATUS.NOT_FOUND) return null;
    this._throwForStatus(response);
    return response.payload;
  }

  async put(key, value) {
    const response = await this._request(OP.PUT, key, value);
    this._throwForStatus(response);
  }

  async delete(key) {
    const response = await this._request(OP.DELETE, key, '');
    if (response.status === STATUS.NOT_FOUND) return false;
    this._throwForStatus(response);
    return true;
  }

  async ping() {
    const response = await this._request(OP.PING, '', '');
    this._throwForStatus(response);
    return true;
  }

  _throwForStatus(response) {
    if (response.status !== STATUS.OK) {
      const detail = response.payload ? `: ${response.payload}` : '';
      throw new DisCacheError(
        `DisCache request failed with status ${response.status}${detail}`,
        response.status,
      );
    }
  }

  _request(opcode, key, value) {
    const requestFrame = encodeRequest(opcode, key, value);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let received = Buffer.alloc(0);
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.setTimeout(this.timeoutMs, () => {
        fail(new DisCacheError(`DisCache request timed out after ${this.timeoutMs} ms`));
      });
      socket.once('error', fail);
      socket.once('close', () => {
        if (!settled) {
          fail(new DisCacheError('Connection closed before a complete DisCache response arrived'));
        }
      });
      socket.once('connect', () => socket.write(requestFrame));

      socket.on('data', (chunk) => {
        if (settled) return;
        received = Buffer.concat([received, chunk]);
        if (received.length < RESPONSE_HEADER_SIZE) return;

        if (received.readUInt8(0) !== PROTOCOL_MAGIC) {
          fail(new DisCacheError('Invalid DisCache response magic byte'));
          return;
        }

        const payloadLength = received.readUInt32BE(12);
        if (payloadLength > MAX_RESPONSE_BYTES) {
          fail(new DisCacheError('DisCache response payload exceeds the 20 MiB limit'));
          return;
        }
        if (received.length < RESPONSE_HEADER_SIZE + payloadLength) return;

        const response = {
          status: received.readUInt8(1),
          payload: received.subarray(RESPONSE_HEADER_SIZE, RESPONSE_HEADER_SIZE + payloadLength).toString('utf8'),
        };
        settled = true;
        socket.end();
        resolve(response);
      });
    });
  }
}

module.exports = { DisCacheClient, DisCacheError };
