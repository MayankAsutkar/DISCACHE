'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { DisCacheClient, DisCacheError } = require('../index');

const MAGIC = 0xdc;

function responseFrame(status, payload = '', nodeId = 1) {
  const payloadBytes = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt8(MAGIC, 0);
  header.writeUInt8(status, 1);
  header.writeUInt16BE(nodeId, 2);
  header.writeUInt32BE(0x12345678, 4);
  header.writeUInt32BE(0xabcdef01, 8);
  header.writeUInt32BE(payloadBytes.length, 12);
  return Buffer.concat([header, payloadBytes]);
}

async function createClient(t, handler) {
  const server = net.createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (request.length < 10) return;

      const keyLength = request.readUInt32BE(2);
      const valueLength = request.readUInt32BE(6);
      if (request.length < 10 + keyLength + valueLength) return;

      const key = request.subarray(10, 10 + keyLength).toString('utf8');
      const value = request.subarray(10 + keyLength, 10 + keyLength + valueLength).toString('utf8');
      const result = await handler({
        opcode: request.readUInt8(1),
        key,
        value,
      });
      const frame = responseFrame(result.status, result.payload, result.nodeId);
      socket.write(frame.subarray(0, 7));
      setImmediate(() => socket.end(frame.subarray(7)));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return new DisCacheClient({
    host: '127.0.0.1',
    port: server.address().port,
  });
}

test('PUT sends the binary request and GET returns the stored value', async (t) => {
  const seen = [];
  const client = await createClient(t, (request) => {
    seen.push(request);
    return request.opcode === 0x02
      ? { status: 0, payload: 'INSERTED' }
      : { status: 0, payload: 'café' };
  });

  await client.put('user:42', 'Alice');
  assert.equal(await client.get('user:42'), 'café');
  assert.deepEqual(seen, [
    { opcode: 0x02, key: 'user:42', value: 'Alice' },
    { opcode: 0x01, key: 'user:42', value: '' },
  ]);
});

test('GET and DELETE distinguish missing keys', async (t) => {
  const client = await createClient(t, () => ({ status: 1, payload: 'NOT_FOUND' }));

  assert.equal(await client.get('absent'), null);
  assert.equal(await client.delete('absent'), false);
});

test('DELETE returns true when a key is removed', async (t) => {
  const client = await createClient(t, () => ({ status: 0, payload: 'DELETED' }));

  assert.equal(await client.delete('user:42'), true);
});

test('server errors reject with DisCacheError and retain the status', async (t) => {
  const client = await createClient(t, () => ({ status: 2, payload: 'WAL_WRITE_FAILED' }));

  await assert.rejects(client.put('key', 'value'), (error) => {
    assert.ok(error instanceof DisCacheError);
    assert.equal(error.status, 2);
    assert.match(error.message, /WAL_WRITE_FAILED/);
    return true;
  });
});

test('PING succeeds against a responding coordinator', async (t) => {
  const client = await createClient(t, () => ({ status: 0, payload: 'PONG_COORDINATOR', nodeId: 0 }));

  assert.equal(await client.ping(), true);
});

test('rejects invalid connection options and non-string values', async () => {
  assert.throws(() => new DisCacheClient({ port: 0 }), RangeError);
  assert.throws(() => new DisCacheClient({ timeoutMs: 0 }), RangeError);

  const client = new DisCacheClient();
  await assert.rejects(client.put('key', 42), TypeError);
});
