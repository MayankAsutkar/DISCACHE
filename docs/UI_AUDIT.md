# DisCache UI and Implementation Audit

## Scope and repository findings

This checkout is a vanilla HTML/CSS/JavaScript application served by `bridge.js`; it does not use React, a router package, a CSS framework, or a component library. The browser simulator lives in `public/app.js`. The live adapter is a Node HTTP/WebSocket bridge that forwards to the C++ TCP services and starts `load_tester.py`. The C++ implementation is in `src/` and `include/`; the Python client is `load_tester.py`.

No SRS, `docs/` folder, test suite, or protocol test fixture was present in the original checkout. The referenced SRS opcode table was therefore not available for direct comparison. The checked-in binaries and WAL files are generated artifacts, not specifications.

## Verified binary protocol

The protocol is defined in `include/BinaryProtocol.h` and is used by the coordinator, data nodes, Node bridge and Python load tester.

### Requests

| Offset | Field | Size | Encoding |
| --- | --- | ---: | --- |
| 0 | Magic `0xDC` | 1 byte | unsigned byte |
| 1 | Opcode | 1 byte | unsigned byte |
| 2 | Key length | 4 bytes | unsigned, network byte order |
| 6 | Value length | 4 bytes | unsigned, network byte order |
| 10 | Key bytes, then value bytes | variable | UTF-8 at the Python/browser clients |

Opcodes are `0x01 GET`, `0x02 PUT`, `0x03 DELETE`, `0x04 INSPECT`, `0x05 RECOVER`, `0x06 CONFIG`, and `0x07 PING`. The C++ decoder rejects a bad magic byte and request key/value lengths above 10 MiB by closing the request path; it does not encode a structured malformed-request response.

### Responses

| Offset | Field | Size | Encoding |
| --- | --- | ---: | --- |
| 0 | Magic `0xDC` | 1 byte | unsigned byte |
| 1 | Status | 1 byte | unsigned byte |
| 2 | Node ID | 2 bytes | unsigned, network byte order |
| 4 | Key hash | 4 bytes | unsigned, network byte order |
| 8 | Successor vnode hash | 4 bytes | unsigned, network byte order |
| 12 | Payload length | 4 bytes | unsigned, network byte order |
| 16 | Payload | variable | byte string |

Statuses are `0x00 OK`, `0x01 NOT_FOUND`, and `0x02 ERROR`. The C++ response reader rejects payloads above 20 MiB. For normal coordinator-routed operations, the coordinator sets node ID and key/vnode hash metadata from its own route result after receiving the node response. GET returns the value as payload on a hit and an empty payload on a miss. PUT returns an outcome such as `INSERTED`, `UPDATED`, or `EVICTED:<key>`. DELETE returns `DELETED` or `NOT_FOUND`.

The old SRS claim `GET=0x00`, `PUT=0x01`, `DELETE=0x02` conflicts with the implementation inspected here, but that SRS was not present in this repository. The UI follows the implementation; the SRS must be updated in its source repository if that legacy table is still authoritative there. The working protocol was not changed.

## Verified implementation behavior

- **Hashing:** `MurmurHash3.cpp` implements x86-32. C++ hashes the bytes in the `std::string` with seed 0. The browser uses `TextEncoder` and the matching x86-32 algorithm. Vnode labels are `Node-{id}#VN-{index}`, with 100 labels per physical node. `std::map::lower_bound` selects the first position greater than or equal to the key hash; reaching `end()` wraps to `begin()`.
- **Distribution:** 300 virtual ring positions improve statistical ownership distribution; they do not guarantee equal key counts. The system has no replication or automatic failover.
- **Coordinator:** owns the ring and forwards requests. It does not store key-value data.
- **LRU:** C++ uses `std::unordered_map` plus a doubly linked list. Map lookup/erase is average-case O(1), not guaranteed worst-case O(1); list pointer updates are O(1). `GET` takes an exclusive lock when moving a hit to MRU. Read-only snapshots use shared locks. The browser demo now also uses a `Map` and linked nodes rather than array scans/splices.
- **Capacity:** C++ default capacity is 100,000 entries. Browser cache controls use a small demo capacity and label it separately.
- **WAL:** PUT/DELETE append a local node record and call `std::ofstream::flush()` before cache mutation. There is no `fsync()`/`fdatasync()` call; do not describe this as power-loss durable. Startup replay clears the node's cache and reapplies that same node's log in order. The guided UI recovery is a simulation; it does not terminate a process.
- **Live inspection:** The bridge returns up to 100 visible entries per node along with the actual cache size and true MRU/LRU keys. The UI now keeps those totals separate from the preview list.
- **Concurrency:** each server uses `select()` for socket readiness, then dispatches to a bounded thread pool. Cache synchronization matches the lock behavior above.
- **Benchmark:** `load_tester.py` measures per-attempt latency and computes overall throughput from completed attempts divided by wall time. The chart time series now includes failed attempts too. Illustrative values are a model, not measured performance; success/failure counts are not reported as fabricated values. Live benchmark execution requires the bridge plus coordinator and all three nodes. The bridge now avoids the WindowsApps Python alias and supports `DISCACHE_PYTHON` as an explicit interpreter override.

## UI route and behavior changes

The product experience uses five History API routes, with known-path fallback in the existing Node server:

- `/` Home
- `/playground` PUT / GET / DELETE request demo
- `/how-it-works` Architecture, hash ring, LRU cache and WAL
- `/performance` Performance
- `/guide` User guide, optional request tour and troubleshooting

The earlier `/hash-ring`, `/cache`, `/recovery`, and `/architecture` URLs resolve to `/how-it-works`. The playground starts with an empty simulated cache and the `session:4092` / `user=8810` sample, so PUT → GET → DELETE → GET has predictable outcomes. A dismissible guide is remembered in local storage. The optional four-step tour uses the same Playground controls and advances only from a matching real result. The How it works route includes controllable request, LRU and WAL explanations sourced from the current simulation or live snapshot; simulated cache loss and log replay are disabled in live mode. The technical packet details are optional. The performance page starts empty and distinguishes live runs, saved historical measurements, imported data and generated illustrative samples. The shared header retains System/Dark/Light theme choice, with explicit choices persisted in local storage. The interface uses a graphite/white/violet palette, reduced-motion support and responsive layouts.

Live operations are correlated by request ID. A live request updates views from the returned bridge snapshot and response; it no longer mutates demo state in parallel. Live mode and the live benchmark require all four C++ processes to be reachable. If unavailable, simulation remains available and the live action is marked unavailable. The Python benchmark spawn reports errors rather than silently generating synthetic values.

## Confirmed corrections

1. Preserved the implemented opcode table and framed protocol; added Python byte-level request/response and malformed-frame tests plus a POSIX C++ framing test for Linux/WSL.
2. Corrected guaranteed-O(1) cache wording and clarified that successful GET changes recency under an exclusive lock.
3. Corrected WAL durability language from “durable” to C++ stream flush, explicitly noting the absence of `fsync` and that the guided crash is simulated.
4. Replaced the browser array-based LRU model with a map-indexed doubly linked list.
5. Required a full cluster snapshot for live mode; live operations now await and use real responses.
6. Removed the live-benchmark fallback that presented simulated metrics after a failed/unavailable live call. Added report validation and “not measured” success/failure display for illustrative reports.
7. Added failed benchmark attempts to chart time-series accounting and closed worker sockets after failed initial connections.
8. Replaced the `python` spawn alias on Windows with interpreter discovery plus the `DISCACHE_PYTHON` override.
9. Preserved live cache totals/MRU/LRU values independently from the inspection preview and restored the empty demo state whenever live mode exits.

## Verification and limitations

- `node --check public/app.js` and `node --check bridge.js` passed during implementation.
- `python.exe -W error::ResourceWarning -m unittest discover -s tests -v` passed all 6 Python tests.
- The POSIX C++ protocol test was added but could not be compiled in this Windows environment: WSL has no Ubuntu distribution. The WSL component was installed during an attempted test command, but no Ubuntu distribution was installed. No C++ build result is claimed.
- No package lint/test/build scripts exist beyond `npm start` and the benchmark script. The full C++ cluster is not available without a suitable POSIX/WSL environment; live features remain disabled unless the bridge can inspect all four processes.
