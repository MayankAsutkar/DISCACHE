#!/usr/bin/env python3
"""
DisCache — Multi-Threaded Python Load Tester
============================================
Benchmarks either the full Coordinator-routed cluster (:8000) or an individual
Data Node (:8001, :8002, :8003) over the custom raw TCP binary protocol.

Supports:
- Configurable GET / PUT / DELETE workload percentages
- 50+ concurrent worker threads
- Throughput (ops/sec), P50 latency, P99 latency, and per-node distribution
- JSON export for loading into the DisCache Performance Lab
"""

import argparse
import concurrent.futures
import json
import math
import random
import socket
import struct
import sys
import time
from typing import Dict, List, Tuple

PROTOCOL_MAGIC = 0xDC
OP_GET = 0x01
OP_PUT = 0x02
OP_DELETE = 0x03


def encode_request(opcode: int, key: str, value: str = "") -> bytes:
    key_bytes = key.encode("utf-8")
    val_bytes = value.encode("utf-8")
    header = struct.pack("!BBII", PROTOCOL_MAGIC, opcode, len(key_bytes), len(val_bytes))
    return header + key_bytes + val_bytes


def recv_exact(sock: socket.socket, n: int) -> bytes:
    chunks = []
    received = 0
    while received < n:
        chunk = sock.recv(n - received)
        if not chunk:
            raise ConnectionError("Socket closed before full frame read")
        chunks.append(chunk)
        received += len(chunk)
    return b"".join(chunks)


def send_and_recv(sock: socket.socket, opcode: int, key: str, value: str = "") -> Tuple[int, int, int, int, bytes]:
    pkt = encode_request(opcode, key, value)
    sock.sendall(pkt)
    header = recv_exact(sock, 16)
    magic, status, node_id, key_hash, vnode_hash, payload_len = struct.unpack("!BBHIII", header)
    if magic != PROTOCOL_MAGIC:
        raise ValueError(f"Invalid protocol magic: {magic:#x}")
    payload = recv_exact(sock, payload_len) if payload_len > 0 else b""
    return status, node_id, key_hash, vnode_hash, payload


def worker_task(
    worker_id: int,
    host: str,
    port: int,
    ops_count: int,
    get_pct: float,
    put_pct: float,
    delete_pct: float,
    keyspace_size: int,
) -> Dict:
    rng = random.Random(1000 + worker_id)
    latencies_us: List[float] = []
    node_counts = {1: 0, 2: 0, 3: 0}
    op_counts = {"GET": 0, "PUT": 0, "DELETE": 0}
    success_count = 0
    fail_count = 0
    timeline_samples: List[Tuple[float, float]] = []

    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.settimeout(5.0)
        sock.connect((host, port))
    except Exception:
        if sock is not None:
            sock.close()
        sock = None

    for i in range(ops_count):
        r = rng.uniform(0.0, 100.0)
        key = f"key:{rng.randint(1, keyspace_size)}"
        if r < get_pct:
            opcode = OP_GET
            op_name = "GET"
            val = ""
        elif r < (get_pct + put_pct):
            opcode = OP_PUT
            op_name = "PUT"
            val = f"val_{worker_id}_{i}"
        else:
            opcode = OP_DELETE
            op_name = "DELETE"
            val = ""

        op_counts[op_name] += 1
        t0 = time.perf_counter()
        try:
            if sock is None:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                sock.settimeout(5.0)
                sock.connect((host, port))

            status, node_id, _, _, _ = send_and_recv(sock, opcode, key, val)
            elapsed_us = (time.perf_counter() - t0) * 1_000_000.0
            latencies_us.append(elapsed_us)
            timeline_samples.append((time.perf_counter(), elapsed_us))

            if status in (0, 1):  # OK or NOT_FOUND are valid protocol completions
                success_count += 1
            else:
                fail_count += 1

            if node_id in node_counts:
                node_counts[node_id] += 1
        except Exception:
            elapsed_us = (time.perf_counter() - t0) * 1_000_000.0
            latencies_us.append(elapsed_us)
            timeline_samples.append((time.perf_counter(), elapsed_us))
            fail_count += 1
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
                sock = None

    if sock is not None:
        try:
            sock.close()
        except Exception:
            pass

    return {
        "latencies_us": latencies_us,
        "node_counts": node_counts,
        "op_counts": op_counts,
        "success": success_count,
        "failed": fail_count,
        "timeline": timeline_samples,
    }


def percentile(sorted_vals: List[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = (len(sorted_vals) - 1) * (pct / 100.0)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)


def run_benchmark(
    host: str = "127.0.0.1",
    port: int = 8000,
    target_mode: str = "coordinator",
    total_requests: int = 2500,
    workers: int = 50,
    get_pct: float = 70.0,
    put_pct: float = 20.0,
    delete_pct: float = 10.0,
    keyspace_size: int = 500,
) -> Dict:
    workers = max(1, int(workers))
    total_requests = max(workers, int(total_requests))
    base_ops = total_requests // workers
    rem = total_requests % workers

    start_wall = time.perf_counter()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = []
        for w in range(workers):
            w_ops = base_ops + (1 if w < rem else 0)
            futures.append(
                executor.submit(
                    worker_task,
                    w,
                    host,
                    port,
                    w_ops,
                    get_pct,
                    put_pct,
                    delete_pct,
                    keyspace_size,
                )
            )
        for f in concurrent.futures.as_completed(futures):
            results.append(f.result())

    elapsed_sec = max(0.0001, time.perf_counter() - start_wall)

    all_latencies_us: List[float] = []
    node_dist = {1: 0, 2: 0, 3: 0}
    op_dist = {"GET": 0, "PUT": 0, "DELETE": 0}
    total_success = 0
    total_failed = 0
    all_timeline: List[Tuple[float, float]] = []

    for r in results:
        all_latencies_us.extend(r["latencies_us"])
        for nid in (1, 2, 3):
            node_dist[nid] += r["node_counts"][nid]
        for opk in ("GET", "PUT", "DELETE"):
            op_dist[opk] += r["op_counts"][opk]
        total_success += r["success"]
        total_failed += r["failed"]
        all_timeline.extend(r["timeline"])

    all_latencies_us.sort()
    p50_us = percentile(all_latencies_us, 50.0)
    p90_us = percentile(all_latencies_us, 90.0)
    p95_us = percentile(all_latencies_us, 95.0)
    p99_us = percentile(all_latencies_us, 99.0)
    avg_us = sum(all_latencies_us) / len(all_latencies_us) if all_latencies_us else 0.0

    # Build 10 time-series buckets for charting
    all_timeline.sort(key=lambda x: x[0])
    series = []
    if all_timeline:
        t_min = all_timeline[0][0]
        t_max = max(t_min + 0.0001, all_timeline[-1][0])
        bucket_count = 10
        bucket_width = (t_max - t_min) / bucket_count
        buckets: List[List[float]] = [[] for _ in range(bucket_count)]
        for ts, lat in all_timeline:
            b = min(bucket_count - 1, int((ts - t_min) / bucket_width))
            buckets[b].append(lat)
        for idx, b_lats in enumerate(buckets):
            b_lats.sort()
            b_ops_sec = len(b_lats) / bucket_width if bucket_width > 0 else 0.0
            series.append({
                "bucket": idx + 1,
                "ops_per_sec": round(b_ops_sec, 1),
                "p50_ms": round(percentile(b_lats, 50.0) / 1000.0, 3),
                "p99_ms": round(percentile(b_lats, 99.0) / 1000.0, 3),
            })

    completed = total_success + total_failed
    throughput = completed / elapsed_sec

    return {
        "source": "measured_python_load_tester",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "target_mode": target_mode,
        "endpoint": f"{host}:{port}",
        "config": {
            "total_requests": completed,
            "workers": workers,
            "get_pct": get_pct,
            "put_pct": put_pct,
            "delete_pct": delete_pct,
            "keyspace_size": keyspace_size,
        },
        "metrics": {
            "total_requests": completed,
            "successful_ops": total_success,
            "failed_ops": total_failed,
            "elapsed_sec": round(elapsed_sec, 4),
            "throughput_ops_sec": round(throughput, 1),
            "avg_latency_ms": round(avg_us / 1000.0, 3),
            "p50_latency_ms": round(p50_us / 1000.0, 3),
            "p90_latency_ms": round(p90_us / 1000.0, 3),
            "p95_latency_ms": round(p95_us / 1000.0, 3),
            "p99_latency_ms": round(p99_us / 1000.0, 3),
        },
        "operation_counts": op_dist,
        "node_distribution": {
            "node_1": node_dist[1],
            "node_2": node_dist[2],
            "node_3": node_dist[3],
        },
        "series": series,
    }


def main():
    parser = argparse.ArgumentParser(description="DisCache Multi-Threaded Python Load Tester")
    parser.add_argument("--host", default="127.0.0.1", help="Target host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Target port (8000=Coordinator, 8001-8003=Data Nodes)")
    parser.add_argument("--target", default="coordinator", help="Target mode label (coordinator | node_1 | node_2 | node_3)")
    parser.add_argument("--requests", type=int, default=2500, help="Total requests to execute")
    parser.add_argument("--workers", type=int, default=50, help="Concurrent worker threads (default: 50)")
    parser.add_argument("--get-pct", type=float, default=70.0, help="GET workload percentage")
    parser.add_argument("--put-pct", type=float, default=20.0, help="PUT workload percentage")
    parser.add_argument("--delete-pct", type=float, default=10.0, help="DELETE workload percentage")
    parser.add_argument("--keyspace", type=int, default=500, help="Distinct keys in workload")
    parser.add_argument("--out", default="benchmark_results.json", help="Output JSON file path")
    parser.add_argument("--json", action="store_true", help="Print raw JSON to stdout")
    args = parser.parse_args()

    report = run_benchmark(
        host=args.host,
        port=args.port,
        target_mode=args.target,
        total_requests=args.requests,
        workers=args.workers,
        get_pct=args.get_pct,
        put_pct=args.put_pct,
        delete_pct=args.delete_pct,
        keyspace_size=args.keyspace,
    )

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)

    if args.json:
        print(json.dumps(report))
    else:
        m = report["metrics"]
        nd = report["node_distribution"]
        print("=" * 64)
        print(f"DisCache Load Tester Report — Target: {report['endpoint']} ({report['target_mode']})")
        print("=" * 64)
        print(f"Workers            : {report['config']['workers']}")
        print(f"Workload Mix       : GET {args.get_pct:.0f}% | PUT {args.put_pct:.0f}% | DELETE {args.delete_pct:.0f}%")
        print(f"Total Requests     : {m['total_requests']}")
        print(f"Successful / Failed: {m['successful_ops']} / {m['failed_ops']}")
        print(f"Elapsed Time       : {m['elapsed_sec']} s")
        print(f"Throughput         : {m['throughput_ops_sec']} ops/sec")
        print(f"P50 Latency        : {m['p50_latency_ms']} ms")
        print(f"P99 Latency        : {m['p99_latency_ms']} ms")
        print(f"Node Distribution  : Node 1={nd['node_1']}, Node 2={nd['node_2']}, Node 3={nd['node_3']}")
        print(f"Saved JSON         : {args.out}")


if __name__ == "__main__":
    main()
