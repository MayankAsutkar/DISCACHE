# @discache/client

Small Node.js client for the DisCache coordinator's custom binary TCP protocol.
It connects to the coordinator on `127.0.0.1:8000` by default and provides
`get`, `put`, `delete`, and `ping` methods. It does not implement the Redis
wire protocol and cannot be used with Redis client libraries.

## Install from a local checkout

In another Node.js project, install the client directory:

```bash
npm install ../DISCACHE/client
```

The path should point to the `client` directory in this repository. Start the
DisCache coordinator and its three data nodes first; see the repository
[README](../README.md#3-building--running-the-c20-cluster).

## Use

```js
const { DisCacheClient } = require('@discache/client');

async function main() {
  const cache = new DisCacheClient({
    host: '127.0.0.1',
    port: 8000,
    timeoutMs: 3000,
  });

  await cache.put('user:42', JSON.stringify({ name: 'Alice' }));
  const value = await cache.get('user:42');
  console.log(value === null ? 'cache miss' : JSON.parse(value));

  const removed = await cache.delete('user:42');
  console.log('Removed:', removed);
}

main().catch((error) => {
  console.error('DisCache request failed:', error);
  process.exitCode = 1;
});
```

`get` returns `null` for a missing key, `delete` returns `false` if the key
did not exist, and server/network errors reject with an error. Keys and values
are UTF-8 strings; serialize objects (for example, with `JSON.stringify`)
before storing them. Each operation uses one TCP request to the coordinator.
