# DisCache — Distributed In-Memory Caching System & Interactive Lab

**DisCache** is a dependency-free distributed in-memory caching system built from scratch in **C++20** with an interactive browser-based **Distributed Systems Laboratory**.

It demonstrates distributed key routing via consistent hashing (`MurmurHash3_x86_32`), $O(1)$ in-memory LRU cache data structures, raw TCP socket programming with a custom binary protocol (`0xDC`), `select()` I/O multiplexing, bounded worker thread pools, `std::shared_mutex` reader-writer synchronization, per-node Write-Ahead Logging (WAL), sequential crash recovery, and multi-threaded Python performance benchmarking.

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
        ├───► Data Node 1 (127.0.0.1:8001) ──► [ O(1) LRU Cache ] + [ node_1.log WAL ]
        ├───► Data Node 2 (127.0.0.1:8002) ──► [ O(1) LRU Cache ] + [ node_2.log WAL ]
        └───► Data Node 3 (127.0.0.1:8003) ──► [ O(1) LRU Cache ] + [ node_3.log WAL ]
```

### Key Architectural Facts
- **1 Coordinator Process (`:8000`)**: Stateless routing server that hashes incoming keys with 32-bit `MurmurHash3` and locates the clockwise successor virtual node using `std::map::lower_bound`.
- **3 Independent Data Node Processes (`:8001`, `:8002`, `:8003`)**: Isolated OS processes. Each node manages its own in-memory `LRUCache` (default capacity: `100,000` entries) and its own local Write-Ahead Log (`node_1.log`, `node_2.log`, `node_3.log`).
- **100 Virtual Nodes per Physical Data Node**: `300` total virtual positions on the $[0, 2^{32}-1]$ hash ring for fine-grained keyspace partitioning.
- **No Replication or Hidden Frameworks**: Built strictly from C++20 standard library primitives and POSIX TCP sockets without Redis, Memcached, gRPC, HTTP/REST inside C++, or external caching libraries.

---

## 2. Repository Structure

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
│   ├── index.html             # DisCache Interactive Distributed Systems Lab
│   ├── styles.css             # Pure black-and-white systems-engineering design system
│   └── app.js                 # Deterministic simulation engine, SVG ring/charts & live bridge sync
├── bridge.js                  # Separate WebSocket-to-Binary-TCP integration adapter
├── load_tester.py             # Multi-threaded Python load tester (50+ concurrent workers)
├── Makefile                   # C++20 build rules
└── package.json
```

---

## 3. Building & Running the C++20 Cluster

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

## 4. Starting the Interactive Web Laboratory

```bash
npm install
npm start
```

Open `http://localhost:8080`.

- **Self-Contained Demo Mode**: Works immediately in the browser using deterministic `MurmurHash3_x86_32`, the 300-virtual-node ring, $O(1)$ LRU cache simulation, and sequential WAL recovery.
- **Live C++20 Cluster Mode**: When the 4 C++ processes are running on `:8000–:8003`, click the mode badge in the top navigation bar to execute real binary TCP operations and run the live 50-worker Python benchmark directly from the Performance Lab.

---

## 5. Running the Multi-Threaded Python Load Tester

Benchmark the full Coordinator-routed cluster (`:8000`) with 50 concurrent worker threads:

```bash
python load_tester.py --host 127.0.0.1 --port 8000 --target coordinator --workers 50 --requests 2500 --get-pct 70 --put-pct 20 --delete-pct 10 --out benchmark_results.json
```

Benchmark an individual Data Node (`:8001`) directly:

```bash
python load_tester.py --host 127.0.0.1 --port 8001 --target node_1 --workers 50 --requests 2500 --out benchmark_node1.json
```