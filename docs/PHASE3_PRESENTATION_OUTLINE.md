# Phase 3 Presentation Outline

## Suggested 5-minute walkthrough

### 1. What DisCache does (30 seconds)

- A small distributed in-memory key/value cache written in C++20.
- One coordinator routes requests to three independent data nodes.
- Open the browser app and point out the clearly labeled simulated mode.

### 2. Architecture (45 seconds)

- Show the coordinator and three nodes on Home or How it works.
- Explain that the coordinator routes a key; the selected data node owns the value.
- Mention consistent hashing and 100 virtual positions per node without presenting it as replication or failover.

### 3. The core demo (90 seconds)

On Playground, use the prefilled `session:4092` key and `user=8810` value:

1. Run PUT and read the stored result and selected node.
2. Run GET and observe the returned value.
3. Run DELETE and observe removal.
4. Run GET again and observe a not-found/cache-miss result.

State that this interaction is simulated unless the mode badge confirms all four live services are connected.

### 4. What changes inside a node (60 seconds)

- Explain that a successful GET promotes its key to most recently used.
- Show eviction only after inserting into a full cache.
- Explain the WAL order: append and stream flush, then in-memory mutation, then response.
- Clarify that stream flush is not an `fsync`/`fdatasync` power-loss guarantee. The browser crash/replay interaction is simulated.

### 5. Performance evidence (45 seconds)

- Distinguish live benchmark results from saved historical reports and illustrative sample data.
- If no live cluster is available, show the historical report timestamp and explain that it is not a current measurement.
- Discuss throughput, P50/P99 latency, and failures only when their source is visible.

### 6. Engineering and limitations (45 seconds)

- Point to the binary protocol and the Node client.
- Summarize the available Node and Python tests; run the C++ framing test/build only in a POSIX-compatible environment.
- Be explicit about the absence of a verified live-cluster run or build when those gates have not been completed.

## Demo checklist

- Start the web bridge and verify the Home page returns successfully.
- Confirm the mode badge says simulated or live; do not imply live connectivity from the page loading.
- Reset Playground before presenting, then run PUT → GET → DELETE → GET.
- Check that each result, node route, cache display, and event log correspond to the performed action.
- For performance, verify the report's provenance and timestamp before describing its values.
- Avoid claims of replication, automatic failover, power-loss durability, or unverified benchmark results.
