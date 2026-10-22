# DisCache — Distributed In-Memory Cache

**DisCache** is a dependency-free distributed in-memory caching system built in **C++20**, with an interactive browser experience for exploring request routing, cache behavior, recovery and benchmark provenance.

It demonstrates distributed key routing via consistent hashing (`MurmurHash3_x86_32`), an in-memory LRU cache built from average-case O(1) hash-map operations and O(1) list updates, raw TCP sockets with a custom binary protocol (`0xDC`), `select()` I/O multiplexing, bounded worker thread pools, `std::shared_mutex` synchronization, per-node write-ahead logs, sequential recovery, and multi-threaded Python benchmarking.

---

## 1. System Architecture

```text
Python Load Tester (load_tester.py — 50+ Concurrent Worker Threads)
        │
        │  Raw TCP · Custom Binary Protocol (0xDC)
        ▼
Coordinator Process (127.0.0.1:8000)
        │  MurmurHash3_x86_32(key)
        │  std::map<uint32_t, VirtualNode>::lower_bound (300 Virtual Positions)
        ├───► Data Node 1 (127.0.0.1:8001) ──► [ LRU Cache ] + [ node_1.log WAL ]
        ├───► Data Node 2 (127.0.0.1:8002) ──► [ LRU Cache ] + [ node_2.log WAL ]
        └───► Data Node 3 (127.0.0.1:8003) ──► [ LRU Cache ] + [ node_3.log WAL ]
```

### Key Architectural Facts
- **1 Coordinator Process (`:8000`)**: Routing server that hashes incoming keys with 32-bit `MurmurHash3` and locates the clockwise successor virtual node using `std::map::lower_bound`. It does not store cache values.
- **3 Independent Data Node Processes (`:8001`, `:8002`, `:8003`)**: Isolated OS processes. Each node manages its own in-memory `LRUCache` (default capacity: `100,000` entries) and its own local Write-Ahead Log (`node_1.log`, `node_2.log`, `node_3.log`).
- **100 Virtual Nodes per Physical Data Node**: `300` total virtual positions on the $[0, 2^{32}-1]$ hash ring for fine-grained keyspace partitioning.
- **No Replication or Hidden Frameworks**: Built strictly from C++20 standard library primitives and POSIX TCP sockets without Redis, Memcached, gRPC, HTTP/REST inside C++, or external caching libraries.
- **WAL Durability Boundary**: Mutations append to the local log and call C++ stream `flush()` before cache mutation. The code does not call `fsync()`/`fdatasync()`; this is not a power-loss durability guarantee.

---

## 2. Binary Protocol

The protocol implemented in `include/BinaryProtocol.h` is authoritative for the current C++ services and clients. Integer lengths and metadata use network byte order.

| Request offset | Field |
| --- | --- |
| `0` | Magic byte `0xDC` |
| `1` | Opcode: `0x01 GET`, `0x02 PUT`, `0x03 DELETE`, `0x04 INSPECT`, `0x05 RECOVER`, `0x06 CONFIG`, `0x07 PING` |
| `2..5` | Key length (`uint32`, network byte order) |
| `6..9` | Value length (`uint32`, network byte order) |
| `10..` | Key bytes followed by value bytes |

The 16-byte response header contains magic, status (`0x00 OK`, `0x01 NOT_FOUND`, `0x02 ERROR`), node ID (`uint16`), key hash (`uint32`), vnode hash (`uint32`), and payload length (`uint32`), followed by the payload. The browser packet inspector and clients use this implemented contract. If another copy of the SRS specifies different opcodes, update that specification rather than changing the working wire protocol without a migration plan.

---

## 3. UI Pages

The browser app uses the existing Node bridge and a small set of History API routes:

- `/` — Home
- `/playground` — PUT / GET / DELETE request demo
- `/how-it-works` — Architecture, hash routing, LRU and WAL
- `/performance` — Performance
- `/guide` — Getting started, interactive tour, concepts and troubleshooting

The earlier `/hash-ring`, `/cache`, `/recovery`, and `/architecture` URLs redirect to the consolidated How it works page.

---

## 4. Repository Structure

```text
.
├── include/
│   ├── BinaryProtocol.h       # Custom binary protocol (0xDC) framing & TCP I/O
│   ├── ConsistentHashRing.h   # std::map<uint32_t, VirtualNode> ring (3 × 100 VNodes)
│   ├── CoordinatorServer.h    # Coordinator TCP server (:8000)
│   ├── DataNodeServer.h       # Data Node TCP server (:8001–:8003)
│   ├── LRUCache.h             # std::unordered_map + Doubly Linked List + std::shared_mutex
│   ├── MurmurHash3.h          # Deterministic 32-bit MurmurHash3_x86_32
│   ├── ThreadPool.h           # Bounded worker thread pool
│   └── WAL.h                  # Per-node sequential Write-Ahead Log & replay engine
├── src/
│   ├── ConsistentHashRing.cpp
│   ├── CoordinatorServer.cpp
│   ├── DataNodeServer.cpp
│   ├── LRUCache.cpp
│   ├── MurmurHash3.cpp
│   ├── WAL.cpp
│   ├── coordinator_main.cpp   # Entry point for discache_coordinator
│   └── node_main.cpp          # Entry point for discache_node
├── public/
│   ├── index.html             # Four-page DisCache product experience
│   ├── product.css            # Responsive product interface and theme tokens
│   ├── styles.css             # Legacy visualization styles (kept for simulator internals)
│   └── app.js                 # Simulation engine, visualizations and live bridge sync
├── docs/
│   └── UI_AUDIT.md            # Verified implementation and UI audit
├── tests/
│   ├── protocol_test.cpp      # POSIX C++ framing regression test
│   └── test_protocol.py       # Python client and benchmark regression tests
├── bridge.js                  # Separate WebSocket-to-Binary-TCP integration adapter
├── load_tester.py             # Multi-threaded Python load tester (50+ concurrent workers)
├── Makefile                   # C++20 build rules
└── package.json
```

---

## 5. Building & Running the C++20 Cluster

### Compile on Linux / macOS / WSL (Ubuntu)

```bash
g++ -std=c++20 -Wall -Wextra -pthread -O2 -Iinclude \
  src/MurmurHash3.cpp src/ConsistentHashRing.cpp src/LRUCache.cpp src/WAL.cpp \
  src/CoordinatorServer.cpp src/coordinator_main.cpp -o discache_coordinator

g++ -std=c++20 -Wall -Wextra -pthread -O2 -Iinclude \
  src/MurmurHash3.cpp src/ConsistentHashRing.cpp src/LRUCache.cpp src/WAL.cpp \
  src/DataNodeServer.cpp src/node_main.cpp -o discache_node
```

### Start the 4 Independent C++ Processes

```bash
./discache_node 1 8001 node_1.log &
./discache_node 2 8002 node_2.log &
./discache_node 3 8003 node_3.log &
./discache_coordinator 8000 &
```

---

## 6. Starting the Interactive Web Application

```bash
npm install
npm start
```

Open `http://localhost:8080`.

- **Self-Contained Demo Mode**: Starts with an empty simulated cache and a ready-to-run `session:4092` / `user=8810` example. The browser uses deterministic `MurmurHash3_x86_32`, the 300-virtual-node ring, map/list LRU simulation, and simulated WAL replay.
- **Performance Data**: Live results run `load_tester.py` against the connected C++ cluster. Saved measurements are labeled historical; generated sample values are labeled simulated and are not measurements.
- **Live C++20 Cluster Mode**: When the 4 C++ processes are running on `:8000–:8003`, click the mode badge in the top navigation bar to execute real binary TCP operations and run the live 50-worker Python benchmark directly from the Performance Lab.

---

## 7. Tests and Load Testing

Run the Python protocol and benchmark tests:

```bash
python -m unittest discover -s tests -v
```

On Linux/macOS/WSL, compile and run the C++ framing test:

```bash
g++ -std=c++20 -Wall -Wextra -pthread -Iinclude tests/protocol_test.cpp -o /tmp/discache-protocol-test
/tmp/discache-protocol-test
```

Benchmark the full Coordinator-routed cluster (`:8000`) with 50 concurrent worker threads:

```bash
python load_tester.py --host 127.0.0.1 --port 8000 --target coordinator --workers 50 --requests 2500 --get-pct 70 --put-pct 20 --delete-pct 10 --out benchmark_results.json
```

Benchmark an individual Data Node (`:8001`) directly:

```bash
python load_tester.py --host 127.0.0.1 --port 8001 --target node_1 --workers 50 --requests 2500 --out benchmark_node1.json
```

## 8. Using DisCache from a Node.js Project

The `client/` directory contains an installable Node.js client for the real C++ cluster. Start the coordinator and all three data nodes, then install the SDK from an application directory:

```bash
npm install ../DISCACHE/client
```

Use it from JavaScript:

```js
const { DisCacheClient } = require('@discache/client');

const cache = new DisCacheClient({ host: '127.0.0.1', port: 8000 });
await cache.put('user:42', JSON.stringify({ name: 'Alice' }));
const value = await cache.get('user:42');
console.log(value === null ? 'cache miss' : JSON.parse(value));
```

The client speaks the DisCache binary protocol, not Redis protocol. See [client/README.md](client/README.md) for TypeScript signatures and method behavior.

## Project readiness notes

- The browser demo runs without the C++ cluster; operations in that mode are simulations.
- The live UI and benchmark require the coordinator and all three data nodes.
- The included benchmark report is a historical measurement, not a live result.
- The WAL flushes its C++ output stream before cache mutation but does not call `fsync`/`fdatasync`; do not treat it as a power-loss durability guarantee.
- The C++ services and framing test use POSIX sockets. A POSIX-compatible toolchain is required to build and run them.
- See [docs/PHASE3_READINESS_AUDIT.md](docs/PHASE3_READINESS_AUDIT.md), [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md), and [docs/PHASE3_PRESENTATION_OUTLINE.md](docs/PHASE3_PRESENTATION_OUTLINE.md) for evidence and handoff guidance.