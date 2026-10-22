/**
 * DisCache — Distributed Cache Demo (app.js)
 * =======================================================
 * Implements:
 * 1. Deterministic 32-bit MurmurHash3_x86_32 (byte-identical to C++20 backend)
 * 2. 300-Position Consistent Hash Ring (3 Physical Nodes × 100 Virtual Nodes)
 * 3. O(1) LRU Cache Engine (Hash Map + Custom Doubly Linked List)
 * 4. Per-Node Write-Ahead Log (node_1.log, node_2.log, node_3.log) & 6-Step Crash Recovery
 * 5. Step-by-Step Architecture Request Tracer & Binary Protocol Packet Inspector
 * 6. Performance Lab with Live Python Load Tester integration + JSON Import + Monochrome SVG Charts
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. DETERMINISTIC MURMURHASH3 (x86_32) — IDENTICAL TO C++20 IMPLEMENTATION
  // ==========================================================================
  function rotl32(x, r) {
    return ((x << r) | (x >>> (32 - r))) >>> 0;
  }

  function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function murmurhash3_x86_32(keyStr, seed = 0) {
    const encoder = new TextEncoder();
    const data = encoder.encode(String(keyStr));
    const len = data.length;
    const nblocks = Math.floor(len / 4);

    let h1 = seed >>> 0;
    const c1 = 0xcc9e2d51;
    const c2 = 0x1b873593;

    for (let i = 0; i < nblocks; i++) {
      const idx = i * 4;
      let k1 =
        (data[idx] |
          (data[idx + 1] << 8) |
          (data[idx + 2] << 16) |
          (data[idx + 3] << 24)) >>>
        0;

      k1 = Math.imul(k1, c1) >>> 0;
      k1 = rotl32(k1, 15);
      k1 = Math.imul(k1, c2) >>> 0;

      h1 = (h1 ^ k1) >>> 0;
      h1 = rotl32(h1, 13);
      h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
    }

    const tailIdx = nblocks * 4;
    let k1 = 0;
    const rem = len & 3;
    if (rem === 3) {
      k1 ^= (data[tailIdx + 2] << 16) >>> 0;
    }
    if (rem >= 2) {
      k1 ^= (data[tailIdx + 1] << 8) >>> 0;
    }
    if (rem >= 1) {
      k1 ^= data[tailIdx] >>> 0;
      k1 = Math.imul(k1, c1) >>> 0;
      k1 = rotl32(k1, 15);
      k1 = Math.imul(k1, c2) >>> 0;
      h1 = (h1 ^ k1) >>> 0;
    }

    h1 = (h1 ^ len) >>> 0;
    h1 = fmix32(h1);
    return h1 >>> 0;
  }

  function toHex32(num) {
    return '0x' + (num >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }

  function escapeHtml(val) {
    return String(val ?? '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[ch]));
  }

  // ==========================================================================
  // 2. CONSISTENT HASH RING (3 PHYSICAL NODES × 100 VIRTUAL NODES = 300)
  // ==========================================================================
  const PHYSICAL_NODES = {
    1: { nodeId: 1, name: 'Data Node 1', port: 8001, walFile: 'node_1.log' },
    2: { nodeId: 2, name: 'Data Node 2', port: 8002, walFile: 'node_2.log' },
    3: { nodeId: 3, name: 'Data Node 3', port: 8003, walFile: 'node_3.log' },
  };

  class DeterministicHashRing {
    constructor(vnodesPerNode = 100) {
      this.vnodesPerNode = vnodesPerNode;
      this.vnodes = [];
      this.buildRing();
    }

    buildRing() {
      const list = [];
      for (const nodeId of [1, 2, 3]) {
        const pnode = PHYSICAL_NODES[nodeId];
        for (let v = 0; v < this.vnodesPerNode; v++) {
          const label = `Node-${nodeId}#VN-${v}`;
          const hashPos = murmurhash3_x86_32(label, 0);
          list.push({
            hashPos,
            nodeId,
            vnodeIndex: v,
            port: pnode.port,
            label,
          });
        }
      }
      // Sort ascending by uint32 hashPos (identical to std::map<uint32_t, VirtualNode>)
      list.sort((a, b) => a.hashPos - b.hashPos);
      this.vnodes = list;
    }

    route(key) {
      const keyHash = murmurhash3_x86_32(key, 0);
      // Binary search for std::map::lower_bound(keyHash)
      let lo = 0;
      let hi = this.vnodes.length - 1;
      let foundIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (this.vnodes[mid].hashPos >= keyHash) {
          foundIdx = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      let wrapped = false;
      if (foundIdx === -1) {
        foundIdx = 0;
        wrapped = true;
      }
      const successor = this.vnodes[foundIdx];
      const physical = PHYSICAL_NODES[successor.nodeId];
      return {
        key,
        keyHash,
        successor,
        successorIndex: foundIdx,
        physical,
        wrapped,
      };
    }

    computeArcShares() {
      const FULL_RING = 4294967296; // 2^32
      const arcSums = { 1: 0, 2: 0, 3: 0 };
      const n = this.vnodes.length;
      for (let i = 0; i < n; i++) {
        const curr = this.vnodes[i];
        const prev = this.vnodes[(i - 1 + n) % n];
        const arc =
          i === 0
            ? FULL_RING - prev.hashPos + curr.hashPos
            : curr.hashPos - prev.hashPos;
        arcSums[curr.nodeId] += arc;
      }
      return {
        1: ((arcSums[1] / FULL_RING) * 100).toFixed(2),
        2: ((arcSums[2] / FULL_RING) * 100).toFixed(2),
        3: ((arcSums[3] / FULL_RING) * 100).toFixed(2),
      };
    }
  }

  const hashRing = new DeterministicHashRing(100);

  // ==========================================================================
  // 3. IN-MEMORY MAP + DOUBLY LINKED LRU CACHE AND PER-NODE WAL SIMULATION
  // ==========================================================================
  class SimulatedDataNode {
    constructor(nodeId, port, walFile, demoCapacity = 5) {
      this.nodeId = nodeId;
      this.port = port;
      this.walFile = walFile;
      this.capacity = demoCapacity;
      this.defaultSystemCapacity = 100000;
      this.entryMap = new Map();
      this.head = null;
      this.tail = null;
      this.reportedSize = null;
      this.reportedMruKey = null;
      this.reportedLruKey = null;
      this.walRecords = [];
      this.walRecordCount = 0;
      this.nextWalSeq = 1;
      this.hits = 0;
      this.misses = 0;
      this.evictions = 0;
      this.totalReqs = 0;
    }

    get entries() {
      const entries = [];
      for (let entry = this.head; entry; entry = entry.next) entries.push(entry);
      return entries;
    }

    attachFront(entry) {
      entry.prev = null;
      entry.next = this.head;
      if (this.head) this.head.prev = entry;
      this.head = entry;
      if (!this.tail) this.tail = entry;
    }

    detach(entry) {
      if (entry.prev) entry.prev.next = entry.next;
      else this.head = entry.next;
      if (entry.next) entry.next.prev = entry.prev;
      else this.tail = entry.prev;
      entry.prev = null;
      entry.next = null;
    }

    moveToHead(entry) {
      if (entry !== this.head) {
        this.detach(entry);
        this.attachFront(entry);
      }
    }

    get(key) {
      this.totalReqs++;
      const entry = this.entryMap.get(key);
      if (!entry) {
        this.misses++;
        return { hit: false, value: null };
      }
      this.hits++;
      this.moveToHead(entry);
      return { hit: true, value: entry.value };
    }

    put(key, value, skipWal = false) {
      this.totalReqs++;
      let walRec = null;
      if (!skipWal) {
        walRec = {
          seq: this.nextWalSeq++,
          timestampMs: Date.now(),
          op: 'PUT',
          key,
          value,
        };
        this.walRecords.push(walRec);
        this.walRecordCount = walRec.seq;
      }

      const existing = this.entryMap.get(key);
      if (existing) {
        const entry = existing;
        entry.value = value;
        this.moveToHead(entry);
        return { updated: true, evicted: false, evictedKey: null, walRecord: walRec };
      }

      let evictedKey = null;
      let evictedVal = null;
      if (this.entryMap.size >= this.capacity) {
        const lru = this.tail;
        if (lru) {
          this.detach(lru);
          this.entryMap.delete(lru.key);
          evictedKey = lru.key;
          evictedVal = lru.value;
          this.evictions++;
        }
      }

      const entry = {
        key,
        value,
        addr: '0x' + (0x7f0010 + ((murmurhash3_x86_32(key) & 0xfff) << 4)).toString(16).toUpperCase(),
        prev: null,
        next: null,
      };
      this.attachFront(entry);
      this.entryMap.set(key, entry);

      return {
        updated: false,
        evicted: evictedKey !== null,
        evictedKey,
        evictedVal,
        walRecord: walRec,
      };
    }

    del(key, skipWal = false) {
      this.totalReqs++;
      let walRec = null;
      if (!skipWal) {
        walRec = {
          seq: this.nextWalSeq++,
          timestampMs: Date.now(),
          op: 'DELETE',
          key,
          value: '',
        };
        this.walRecords.push(walRec);
        this.walRecordCount = walRec.seq;
      }

      const entry = this.entryMap.get(key);
      if (!entry) {
        return { removed: false, walRecord: walRec };
      }
      this.detach(entry);
      this.entryMap.delete(key);
      return { removed: true, walRecord: walRec };
    }

    setCapacity(newCap) {
      this.capacity = Math.max(1, Number(newCap) || 5);
      while (this.entryMap.size > this.capacity) {
        const lru = this.tail;
        if (!lru) break;
        this.detach(lru);
        this.entryMap.delete(lru.key);
        this.evictions++;
      }
    }

    clearMemoryOnly() {
      this.entryMap.clear();
      this.head = null;
      this.tail = null;
    }

    clearAll() {
      this.clearMemoryOnly();
      this.walRecords = [];
      this.walRecordCount = 0;
      this.nextWalSeq = 1;
      this.hits = 0;
      this.misses = 0;
      this.evictions = 0;
    }

    replayWalUpTo(count) {
      this.clearMemoryOnly();
      const limit = Math.min(count, this.walRecords.length);
      for (let i = 0; i < limit; i++) {
        const rec = this.walRecords[i];
        if (rec.op === 'PUT') {
          this.put(rec.key, rec.value, true);
        } else if (rec.op === 'DELETE') {
          this.del(rec.key, true);
        }
      }
    }
  }

  // Global Application State
  const state = {
    liveMode: false,
    bridgeConnected: false,
    clusterAvailable: false,
    benchmarkRunning: false,
    reducedMotion: false,
    ws: null,
    clusterPollTimer: null,
    operationSeq: 0,
    pendingOperations: new Map(),
    benchmarkRequestId: null,
    latestClusterSnapshot: null,

    nodes: {
      1: new SimulatedDataNode(1, 8001, 'node_1.log', 5),
      2: new SimulatedDataNode(2, 8002, 'node_2.log', 5),
      3: new SimulatedDataNode(3, 8003, 'node_3.log', 5),
    },

    // Section 5: Architecture Tracer State
    arch: {
      op: 'PUT',
      key: 'session:4092',
      val: 'user=8810',
      currentStage: 0,
      maxStage: 6,
      timer: null,
      running: false,
      activePlan: null,
      logs: [],
      stepSeq: 1,
      productHistory: [],
      productSequenceIndex: 0,
      productLastResult: null,
    },

    // Section 6: Ring State
    ringKey: 'session:4092',
    sampleDistCounts: null,

    // Section 7: Cache Engine State
    cacheSelectedNode: 1,
    cacheOp: 'PUT',
    lastCacheBanner: 'Map lookup is average-case O(1); list pointer updates are O(1).',
    cacheAnimation: null,

    // Section 9: WAL & Recovery State
    walSelectedNode: 1,
    recoveryStep: 1, // 1..6
    recoveryReplayedCount: 0,
    recoveryTimer: null,
    recoveryPending: false,
    recoveryAutoRun: false,

    // Section 10: Performance Lab State
    perfViewMode: 'coordinator', // 'coordinator' | 'single_node'
    perfReports: {
      coordinator: null,
      single_node: null,
    },
    productReport: null,
  };

  const routeContent = {
    '/': null,
    '/playground': {
      what: 'A request asks to store, read or remove one key-value pair. The coordinator chooses one data node and that node runs the operation.',
      try: 'Choose PUT, GET or DELETE. Use a sample key, then Run or Step Forward to see each stage and the result.',
      outcome: 'Start with the sample PUT to watch a request reach its node.',
      how: 'The browser simulation mirrors the coordinator route and LRU/WAL flow. In live mode, the result is shown only after the C++ node responds.',
    },
    '/hash-ring': {
      what: 'The hash ring is a map that assigns each key to one of three data nodes. It uses many virtual positions to spread ownership around the ring.',
      try: 'Enter a key or choose a sample. Recalculate to see its hash, clockwise successor and destination node.',
      outcome: 'A sample key is ready. Recalculate its route to inspect the result.',
      how: 'Both key bytes and vnode labels are hashed with MurmurHash3 x86-32 using seed 0. The first vnode at or after the key hash wins; if none exists, lookup wraps to the first vnode.',
    },
    '/cache': {
      what: 'Each data node keeps recently used values in memory. A GET or PUT moves a key to the front; when capacity is full, a new PUT evicts the least recently used key.',
      try: 'Use the sample controls to PUT, GET and DELETE keys. Set a small demo capacity, then fill it and insert another key to see eviction.',
      outcome: 'The selected data node starts with sample cache entries.',
      how: 'The simulation and C++ implementation pair a key index with a doubly linked list. Map lookup is average-case O(1); list promotion and unlink are O(1). A successful GET takes an exclusive cache lock because it changes recency.',
    },
    '/recovery': {
      what: 'A write-ahead log records mutations so a data node can rebuild its in-memory cache by replaying that node’s own log.',
      try: 'Append a PUT or DELETE, then step through a simulated restart and local-log replay.',
      outcome: 'The current node’s demo log is ready. Append a mutation to begin.',
      how: 'The C++ implementation appends and calls C++ stream flush before changing memory. It does not call fsync/fdatasync, so this is not a power-loss durability guarantee. The UI crash is a simulation, not a process termination.',
    },
    '/performance': {
      what: 'Compare a direct data-node benchmark with requests routed through the coordinator.',
      try: 'Set workload mix, workers and request count. Generate illustrative data for a demo, or run a live benchmark only when all C++ nodes are online.',
      outcome: 'Initial charts are explicitly illustrative. Their provenance is shown beside every report.',
      how: 'Live measurements come from load_tester.py and include failed attempts in elapsed-time throughput. Imported reports are validated before display.',
    },
    '/architecture': {
      what: 'The coordinator routes requests but does not store values. Three independent data nodes each own a cache and a local WAL.',
      try: 'Review the process map, request protocol, concurrency pipeline and implementation notes. Use the playground to trace a key end to end.',
      outcome: 'The system topology and implementation limits are summarized below.',
      how: 'The C++ services use raw TCP with a 10-byte request header and 16-byte response header. There is no replication, consensus or automatic failover.',
    },
  };

  const routeSections = {
    '/': ['productHome'],
    '/playground': ['productPlayground'],
    '/how-it-works': ['productHow'],
    '/performance': ['productPerformance'],
    '/guide': ['productGuide'],
    '/hash-ring': ['productHow'],
    '/cache': ['productHow'],
    '/recovery': ['productHow'],
    '/architecture': ['productHow'],
  };

  let currentRoute = '/';
  const learning = {
    mode: 'route',
    step: -1,
    timer: null,
    crashedNodeId: null,
    recoveryMessage: 'No simulated crash.',
  };
  const tour = {
    active: false,
    step: 0,
    completed: 0,
    key: 'session:4092',
    results: [],
    attempt: null,
  };
  const tourSteps = [
    {
      op: 'PUT',
      status: 0,
      title: 'Store a sample value',
      instruction: 'Run PUT with the sample key and value. The coordinator routes the key, then the node logs and stores it.',
      expected: '“Value stored”; the selected node cache and local log change.',
    },
    {
      op: 'GET',
      status: 0,
      title: 'Retrieve the value',
      instruction: 'Run GET with the same key. A successful lookup returns the value and promotes it to most recently used.',
      expected: '“Value found: user=8810”; the cache order may change, but the log does not.',
    },
    {
      op: 'DELETE',
      status: 0,
      title: 'Delete the key',
      instruction: 'Run DELETE with the same key. The node records the mutation before removing the in-memory entry.',
      expected: '“Key deleted”; the entry leaves cache memory and a DELETE record is added.',
    },
    {
      op: 'GET',
      status: 1,
      title: 'Observe a cache miss',
      instruction: 'Run GET again. The key is now absent, so the node returns a not-found result.',
      expected: '“Key not found”; memory and the log stay unchanged by this GET.',
    },
  ];

  function setRouteOutcome(text) {
    const outcome = document.getElementById('routeOutcome');
    if (outcome) outcome.textContent = text;
  }

  function arrangeArchitectureContent() {
    const details = document.getElementById('architectureDetails');
    const topology = document.querySelector('#overview .overview-preview-panel');
    const concurrency = document.querySelector('#cache-engine .concurrency-panel');
    const reference = document.getElementById('reference-summary');
    if (details && topology && !document.getElementById('architectureTopology')) {
      const topologyCopy = topology.cloneNode(true);
      topologyCopy.id = 'architectureTopology';
      const title = topologyCopy.querySelector('.panel-title');
      if (title) title.textContent = 'Process topology and network boundaries';
      details.append(topologyCopy);
    }
    if (details && concurrency && concurrency.parentElement !== details) details.append(concurrency);
    if (details && reference && reference.parentElement !== details) details.append(reference);
  }

  function navigateToRoute(pathname, options = {}) {
    const requestedPath = routeSections[pathname] ? pathname : '/';
    const path = ['/hash-ring', '/cache', '/recovery', '/architecture'].includes(requestedPath)
      ? '/how-it-works'
      : requestedPath;
    const sectionIds = routeSections[path];
    currentRoute = path;
    if (path !== '/how-it-works') pauseLearningAnimation();
    if (options.push !== false && location.pathname !== path) history.pushState({}, '', path);
    if (options.push === false && location.pathname !== path) history.replaceState({}, '', path);

    document.querySelectorAll('.lab-section, #architectureReference').forEach((section) => {
      section.hidden = !sectionIds.includes(section.id);
    });
    document.querySelectorAll('.dc-page').forEach((section) => {
      section.hidden = !sectionIds.includes(section.id);
    });
    const intro = document.getElementById('routeIntro');
    const copy = routeContent[path];
    const pageTitle = {
      '/': 'Home',
      '/playground': 'Playground',
      '/how-it-works': 'How it works',
      '/performance': 'Performance',
      '/guide': 'User guide',
    }[path];
    document.title = `${pageTitle} · DisCache`;
    intro.hidden = !copy;
    if (copy) {
      document.getElementById('routeWhat').textContent = copy.what;
      document.getElementById('routeTry').textContent = copy.try;
      document.getElementById('routeOutcome').textContent = copy.outcome;
      document.getElementById('routeHow').textContent = copy.how;
    }

    document.querySelectorAll('[data-route-link]').forEach((link) => {
      const active = link.getAttribute('href') === path;
      link.classList.toggle('active', active && link.classList.contains('dc-nav-link'));
      if (link.classList.contains('dc-nav-link')) {
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    });
    if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(refreshScrollReveals);
  }

  function refreshScrollReveals() {
    const targets = document.querySelectorAll('.lab-section:not([hidden]) .panel, .lab-section:not([hidden]) .fact-card, .lab-section:not([hidden]) .metric-tile, .dc-page:not([hidden]) .dc-card, .dc-page:not([hidden]) .dc-concept');
    if (state.reducedMotion || !('IntersectionObserver' in window)) {
      targets.forEach((target) => target.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });

    targets.forEach((target) => {
      target.classList.add('scroll-reveal');
      if (!target.classList.contains('is-visible')) observer.observe(target);
    });
  }

  function applyTheme(choice, persist = false) {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeChoice = choice;
    const selector = document.getElementById('themeSelect');
    if (selector) selector.value = choice;
    if (persist) {
      try {
        localStorage.setItem('discache-theme', choice);
      } catch (_) {}
    }
  }

  function initializeTheme() {
    let choice = 'dark';
    try {
      const saved = localStorage.getItem('discache-theme');
      if (saved === 'dark' || saved === 'light' || saved === 'system') choice = saved;
    } catch (_) {}
    applyTheme(choice);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (document.documentElement.dataset.themeChoice === 'system') applyTheme('system');
    });
  }

  // Start with an empty demo cache so the first PUT has a clear, repeatable effect.
  function seedInitialClusterState() {
    state.recoveryReplayedCount = state.nodes[state.walSelectedNode].walRecords.length;
  }

  // ==========================================================================
  // 4. WEBSOCKET BRIDGE ADAPTER (OPTIONAL LIVE C++20 CLUSTER CONNECTION)
  // ==========================================================================
  function initWebSocketBridge() {
    if (!location.host) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}`);
      state.ws = ws;

      ws.onopen = () => {
        state.bridgeConnected = true;
        updateModeIndicator();
        ws.send(JSON.stringify({ type: 'inspect_cluster' }));
        state.clusterPollTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'inspect_cluster' }));
          }
        }, 2500);
      };

      ws.onclose = () => {
        const wasLive = state.liveMode;
        state.bridgeConnected = false;
        state.clusterAvailable = false;
        state.latestClusterSnapshot = null;
        state.benchmarkRunning = false;
        state.benchmarkRequestId = null;
        const benchmarkButton = document.getElementById('runLiveBenchBtn');
        if (benchmarkButton) benchmarkButton.textContent = 'Run Benchmark';
        failPendingLiveOperations('The browser bridge disconnected.');
        if (state.clusterPollTimer) clearInterval(state.clusterPollTimer);
        state.clusterPollTimer = null;
        state.liveMode = false;
        if (wasLive) restoreDemoCluster();
        updateModeIndicator();
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          handleBridgeMessage(msg);
        } catch (_) {}
      };
    } catch (_) {
      state.bridgeConnected = false;
    }
  }

  function syncSnapshotFromLiveCluster(snapshot) {
    if (!snapshot || !snapshot.coordinatorOnline) return;
    const allNodesUp =
      snapshot.nodesOnline &&
      snapshot.nodesOnline[1] &&
      snapshot.nodesOnline[2] &&
      snapshot.nodesOnline[3];

    if (!allNodesUp) return;

    for (const nid of [1, 2, 3]) {
      const liveNode = snapshot.nodes[nid];
      if (!liveNode) continue;
      const target = state.nodes[nid];
      target.capacity = liveNode.capacity;
      target.hits = liveNode.hits;
      target.misses = liveNode.misses;
      target.evictions = liveNode.evictions;
      target.totalReqs = liveNode.totalReqs;
      target.reportedSize = Number(liveNode.size || 0);
      target.reportedMruKey = liveNode.mruKey || '';
      target.reportedLruKey = liveNode.lruKey || '';
      target.clearMemoryOnly();
      for (const entry of [...(liveNode.entries || [])].reverse()) {
        target.put(entry.key, entry.value, true);
      }
      target.walRecords = (liveNode.walRecords || []).map((w) => ({
        seq: w.seq,
        timestampMs: w.timestampMs,
        op: w.op,
        key: w.key,
        value: w.value,
      }));
      target.walRecordCount = Number(liveNode.walSeq || 0);
      target.nextWalSeq = target.walRecordCount + 1;
      target.totalReqs = Number(liveNode.totalReqs || 0);
    }

    renderClusterNodeCards();
    renderCacheEngineView();
    renderWalRecoveryView();
    renderProductExperience();
  }

  function restoreDemoCluster() {
    stopArchAutoRun();
    state.arch.currentStage = 0;
    state.arch.activePlan = null;
    state.arch.logs = [];
    state.arch.stepSeq = 1;
    state.arch.productHistory = [];
    state.arch.productSequenceIndex = 0;
    state.arch.productLastResult = null;
    for (const node of Object.values(state.nodes)) {
      node.clearAll();
      node.setCapacity(5);
      node.reportedSize = null;
      node.reportedMruKey = null;
      node.reportedLruKey = null;
    }
    seedInitialClusterState();
    state.recoveryStep = 1;
    state.recoveryReplayedCount = state.nodes[state.walSelectedNode].walRecords.length;
    renderClusterNodeCards();
    renderCacheEngineView();
    renderWalRecoveryView();
    renderArchEventLog();
    renderProductExperience();
  }

  function handleBridgeMessage(msg) {
    if (msg.type === 'cluster_snapshot') {
      const snap = msg.snapshot;
      state.latestClusterSnapshot = snap || null;
      state.clusterAvailable = Boolean(
        snap &&
        snap.coordinatorOnline &&
        snap.nodesOnline &&
        snap.nodesOnline[1] &&
        snap.nodesOnline[2] &&
        snap.nodesOnline[3]
      );

      if (state.clusterAvailable && state.liveMode) {
        syncSnapshotFromLiveCluster(snap);
      }
      if (!state.clusterAvailable && state.liveMode) {
        state.liveMode = false;
        restoreDemoCluster();
      }
      if (!state.clusterAvailable) {
        if (state.benchmarkRunning) {
          state.benchmarkRunning = false;
          state.benchmarkRequestId = null;
          showPerformanceError('LIVE BENCHMARK INTERRUPTED: the C++ cluster became unavailable. No replacement simulation was generated.');
        }
        failPendingLiveOperations('The C++ cluster is no longer available.');
      }
      updateModeIndicator();
    } else if (msg.type === 'op_result') {
      if (msg.snapshot) state.latestClusterSnapshot = msg.snapshot;
      if (state.liveMode && msg.snapshot) {
        syncSnapshotFromLiveCluster(msg.snapshot);
      }
      completeLiveOperation(msg);
      updateModeIndicator();
    } else if (msg.type === 'recover_result' || msg.type === 'config_result') {
      if (msg.snapshot) state.latestClusterSnapshot = msg.snapshot;
      if (state.liveMode && msg.snapshot) {
        syncSnapshotFromLiveCluster(msg.snapshot);
      }
      completeLiveOperation(msg);
    } else if (msg.type === 'benchmark_result') {
      if (msg.requestId !== state.benchmarkRequestId) return;
      state.benchmarkRunning = false;
      state.benchmarkRequestId = null;
      state.benchmarkRequestId = null;
      const btn = document.getElementById('runLiveBenchBtn');
      if (btn) {
        btn.disabled = !state.bridgeConnected || !state.clusterAvailable;
        btn.textContent = 'Run Benchmark';
      }
      if (msg.report) {
        try {
          validateBenchmarkReport(msg.report);
          applyBenchmarkReport(msg.report, 'MEASURED EXECUTION DATA (PYTHON LOAD TESTER)');
        } catch (err) {
          showPerformanceError(`LIVE BENCHMARK REPORT INVALID: ${err.message}`);
        }
      }
      if (state.liveMode && msg.snapshot) {
        state.latestClusterSnapshot = msg.snapshot;
        syncSnapshotFromLiveCluster(msg.snapshot);
      }
      completeLiveOperation(msg);
    } else if (msg.type === 'benchmark_started') {
      if (msg.requestId === state.benchmarkRequestId) {
        state.benchmarkRunning = true;
        updateModeIndicator();
      }
    } else if (msg.type === 'error') {
      const handledOperation = completeLiveOperation(msg, msg.message || 'Unknown bridge error');
      const benchmarkFailed = msg.requestId && msg.requestId === state.benchmarkRequestId;
      if (benchmarkFailed) {
        state.benchmarkRunning = false;
        state.benchmarkRequestId = null;
      }
      if (benchmarkFailed) {
        const btn = document.getElementById('runLiveBenchBtn');
        if (btn) {
          btn.disabled = !state.bridgeConnected || !state.clusterAvailable;
          btn.textContent = 'Run Benchmark';
        }
      }
      if (!handledOperation) {
        showPerformanceError(`LIVE REQUEST FAILED: ${msg.message || 'Unknown bridge error'}. Use Generate Illustrative Sample for simulated data.`);
      }
      updateModeIndicator();
    }
  }

  function sendLiveOperation(message, callback) {
    if (!state.clusterAvailable || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      callback(null, 'The C++ coordinator and all three data nodes are not connected.');
      return null;
    }

    const requestId = `ui-${++state.operationSeq}`;
    state.pendingOperations.set(requestId, callback);
    updateModeIndicator();
    try {
      state.ws.send(JSON.stringify({ ...message, requestId }));
    } catch (error) {
      state.pendingOperations.delete(requestId);
      callback(null, error.message);
      return null;
    }
    return requestId;
  }

  function completeLiveOperation(message, error = null) {
    const callback = message.requestId && state.pendingOperations.get(message.requestId);
    if (!callback) return false;
    state.pendingOperations.delete(message.requestId);
    callback(message.result || null, error, message);
    updateModeIndicator();
    return true;
  }

  function failPendingLiveOperations(message) {
    for (const [requestId, callback] of state.pendingOperations) {
      state.pendingOperations.delete(requestId);
      callback(null, message);
    }
    updateModeIndicator();
  }

  function updateModeIndicator() {
    const badgeBtn = document.getElementById('modeToggleBtn');
    const badgeText = document.getElementById('modeBadgeText');
    const walNotice = document.getElementById('walSimNoticeBadge');
    const liveClusterAvailable = state.bridgeConnected && state.clusterAvailable;

    badgeBtn.disabled = !liveClusterAvailable && !state.liveMode;
    badgeBtn.disabled = badgeBtn.disabled || state.pendingOperations.size > 0 || state.benchmarkRunning;
    badgeBtn.title = liveClusterAvailable
      ? 'Toggle between the deterministic demo and the connected C++20 cluster'
      : state.bridgeConnected
      ? 'Live mode unavailable: the coordinator and all three data nodes must be online'
      : 'Live mode unavailable: the browser bridge is not connected';
    const liveBenchBtn = document.getElementById('runLiveBenchBtn');
    if (liveBenchBtn) {
      liveBenchBtn.disabled = !liveClusterAvailable || state.benchmarkRunning;
    }
    const productLiveBenchBtn = document.getElementById('productRunLiveBtn');
    if (productLiveBenchBtn) {
      productLiveBenchBtn.disabled = !liveClusterAvailable || state.benchmarkRunning;
      productLiveBenchBtn.textContent = state.benchmarkRunning
        ? 'Running live benchmark…'
        : liveClusterAvailable
        ? 'Run live benchmark'
        : 'Run live benchmark · unavailable';
      productLiveBenchBtn.title = liveClusterAvailable
        ? 'Run load_tester.py against the connected C++ cluster'
        : 'Connect the coordinator and all three C++ data nodes to enable live benchmarks';
    }
    ['cacheSeedEvictBtn', 'walResetDemoBtn'].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = state.liveMode;
    });

    if (state.liveMode) {
      badgeBtn.classList.add('live-active');
      badgeText.textContent = 'Live · C++ cluster';
      if (walNotice) walNotice.textContent = 'CONNECTED TO LIVE C++ DATA NODE WAL';
    } else {
      badgeBtn.classList.remove('live-active');
      badgeText.textContent = 'Demo · simulated';
      if (walNotice) walNotice.textContent = 'VISUAL SIMULATION (LOCAL NODE SCOPE)';
    }
    const modeLabel = document.getElementById('demoModeLabel');
    const modePill = document.getElementById('demoModePill');
    if (modeLabel) modeLabel.textContent = state.liveMode ? 'LIVE C++ CLUSTER' : 'SIMULATED';
    if (modePill) modePill.textContent = state.liveMode ? 'LIVE C++' : 'SIMULATED';
    renderProductExperience();
  }

  function showPerformanceError(message) {
    const banner = document.getElementById('perfValidationMsg');
    if (!banner) return;
    banner.hidden = false;
    banner.textContent = message;
    const productBanner = document.getElementById('productBenchmarkError');
    if (productBanner) {
      productBanner.hidden = false;
      productBanner.textContent = message;
    }
  }

  function finishLiveArchitectureRequest(plan, result, error, responseMessage) {
    if (state.arch.activePlan !== plan) {
      if (error && plan.pending) {
        plan.pending = false;
        plan.statusHex = '0x02 (ERROR)';
        plan.executionOutcomeText = `LIVE REQUEST FAILED: ${error}`;
        plan.routeMatches = null;
        recordProductOperation(plan);
      }
      return;
    }
    plan.pending = false;
    const node = state.nodes[plan.targetNodeId];
    const stageStatus = document.getElementById('archStageStatusText');
    const routeMatches = result && result.nodeId === plan.targetNodeId &&
      result.keyHash === plan.routeInfo.keyHash &&
      result.vnodeHash === plan.routeInfo.successor.hashPos;
    plan.routeMatches = result ? Boolean(routeMatches) : null;

    if (error || !result) {
      plan.statusHex = '0x02 (ERROR)';
      plan.executionOutcomeText = `LIVE REQUEST FAILED: ${error || 'No response received'}`;
    } else {
      const statusName = result.status === 0 ? 'OK' : result.status === 1 ? 'NOT_FOUND' : 'ERROR';
      plan.statusHex = `0x${result.status.toString(16).padStart(2, '0').toUpperCase()} (${statusName})`;
      plan.executionOutcomeText = `LIVE ${statusName}: ${result.payload || '(empty payload)'}`;
      if (!routeMatches) {
        plan.executionOutcomeText += ` · ROUTE MISMATCH: backend node/hash ${result.nodeId}/${toHex32(result.keyHash)}/${toHex32(result.vnodeHash)}`;
      }
      if (responseMessage) plan.response = result;
    }

    if (plan.op === 'GET') {
      document.getElementById('pipeWALInfo').textContent = 'No WAL write (GET)';
      document.getElementById('pipeLRUInfo').textContent = result && result.status === 0
        ? `LIVE HIT → MRU: ${plan.key}`
        : `LIVE MISS / ERROR: ${plan.key}`;
      stageStatus.textContent = `STAGE 5: LIVE GET RESPONSE FROM DATA NODE ${plan.targetNodeId}`;
    } else {
      document.getElementById('pipeWALInfo').textContent = `WAL sequence #${node.walRecordCount} · stream flushed`;
      document.getElementById('pipeLRUInfo').textContent = `LIVE ${result?.status === 0 ? 'UPDATED' : 'UNCHANGED'} · ${node.entries.length}/${node.capacity}`;
      stageStatus.textContent = `STAGE 5: LIVE ${plan.op} RESPONSE FROM DATA NODE ${plan.targetNodeId}`;
    }

    setRouteOutcome(`LIVE ${plan.op} "${plan.key}" → ${plan.statusHex} · Data Node ${plan.targetNodeId} · ${plan.executionOutcomeText}`);
    renderClusterNodeCards(plan.targetNodeId, true, plan.op !== 'GET');
    renderCacheEngineView();
    renderWalRecoveryView();
    appendArchLog(
      'STEP 5/6',
      `Live ${plan.op} Result`,
      `Data Node ${plan.targetNodeId}`,
      `${plan.executionOutcomeText}${error ? '' : ` · Backend route ${routeMatches ? 'matches' : 'does not match'} the browser calculation.`}`
    );
    const runButton = document.getElementById('archRunBtn');
    runButton.disabled = false;
    runButton.textContent = 'Run';
    if (plan.resumeAfterLive) {
      state.arch.currentStage = 6;
      applyArchStageVisuals(6);
    }
    recordProductOperation(plan);
    renderProductExperience();
  }

  // ==========================================================================
  // 5. MAIN INTERACTIVE ARCHITECTURE VISUALIZATION
  // ==========================================================================
  function renderClusterNodeCards(activeNodeId = null, highlightLru = false, highlightWal = false) {
    for (const nid of [1, 2, 3]) {
      const node = state.nodes[nid];
      const card = document.getElementById(`clusterNodeCard${nid}`);
      const statusTag = document.getElementById(`clusterNodeStatus${nid}`);
      const countLbl = document.getElementById(`node${nid}CountLabel`);
      const lruPrev = document.getElementById(`node${nid}LruPreview`);
      const walSeqLbl = document.getElementById(`node${nid}WalSeqLabel`);
      const walPrev = document.getElementById(`node${nid}WalPreview`);
      const lruBox = document.getElementById(`node${nid}LruBox`);
      const walBox = document.getElementById(`node${nid}WalBox`);

      if (!card) continue;

      if (activeNodeId === nid) {
        card.classList.add('selected-route-node');
        statusTag.textContent = 'SELECTED ROUTE TARGET';
      } else {
        card.classList.remove('selected-route-node');
        statusTag.textContent = 'IDLE STANDBY';
      }

      lruBox.classList.toggle('active-internal', activeNodeId === nid && highlightLru);
      walBox.classList.toggle('active-internal', activeNodeId === nid && highlightWal);

      countLbl.textContent = `${node.reportedSize ?? node.entries.length} / ${node.capacity} entries`;
      if (node.entries.length === 0) {
        lruPrev.textContent = 'Empty (MRU Head: —)';
      } else {
        const keysChain = node.entries
          .slice(0, 4)
          .map((e, i) => (i === 0 ? `[MRU] ${e.key}=${e.value}` : `${e.key}=${e.value}`))
          .join(' → ');
        lruPrev.textContent = keysChain;
      }

      walSeqLbl.textContent = `SEQ: ${node.walRecords.length}`;
      if (node.walRecords.length === 0) {
        walPrev.textContent = 'No WAL records';
      } else {
        const lastRec = node.walRecords[node.walRecords.length - 1];
        walPrev.textContent =
          lastRec.op === 'PUT'
            ? `#${lastRec.seq} PUT ${lastRec.key}=${lastRec.value}`
            : `#${lastRec.seq} DELETE ${lastRec.key}`;
      }
    }
  }

  function updateRoutingBranchSvg(selectedNodeId = null, showPacket = false, packetProgress = 1.0) {
    for (const nid of [1, 2, 3]) {
      const line = document.getElementById(`branchLine${nid}`);
      if (!line) continue;
      if (selectedNodeId === nid) {
        line.setAttribute('stroke-width', '2.5');
        line.setAttribute('marker-end', 'url(#arrowThick)');
      } else {
        line.setAttribute('stroke-width', '1');
        line.setAttribute('marker-end', 'url(#arrowThin)');
      }
    }

    const pkt = document.getElementById('branchPacketRect');
    if (!pkt) return;
    if (!showPacket || !selectedNodeId) {
      pkt.setAttribute('visibility', 'hidden');
      return;
    }

    pkt.setAttribute('visibility', 'visible');
    const targetY = selectedNodeId === 1 ? 45 : selectedNodeId === 2 ? 135 : 225;
    const xPos = packetProgress < 0.5 ? 60 : 195;
    const yPos = packetProgress < 0.5 ? 135 : targetY;
    pkt.setAttribute('x', String(xPos - 6));
    pkt.setAttribute('y', String(yPos - 6));
  }

  function buildArchitectureExecutionPlan() {
    const op = state.arch.op;
    const key = document.getElementById('archKeyInput').value.trim();
    const val = document.getElementById('archValInput').value;
    const validationBanner = document.getElementById('archValidationMsg');

    if (!key) {
      validationBanner.hidden = false;
      validationBanner.textContent = 'INVALID INPUT: Key cannot be empty. Enter a key string to route.';
      return null;
    }
    validationBanner.hidden = true;

    state.arch.key = key;
    state.arch.val = val;

    const routeInfo = hashRing.route(key);
    const targetNodeId = routeInfo.physical.nodeId;
    const targetPort = routeInfo.physical.port;
    const walFile = routeInfo.physical.walFile;
    const opHex = op === 'GET' ? '0x01 (GET)' : op === 'PUT' ? '0x02 (PUT)' : '0x03 (DELETE)';
    const keyBytes = new TextEncoder().encode(key).length;
    const valBytes = op === 'PUT' ? new TextEncoder().encode(val).length : 0;

    return {
      op,
      key,
      val: op === 'PUT' ? val : '',
      routeInfo,
      targetNodeId,
      targetPort,
      walFile,
      opHex,
      keyBytes,
      valBytes,
      executedMutation: false,
      executionOutcomeText: '',
      statusHex: '0x00 (STATUS_OK)',
    };
  }

  function appendArchLog(stepLabel, action, component, explanation) {
    state.arch.logs.unshift({
      seq: state.arch.stepSeq++,
      stepLabel,
      action,
      component,
      explanation,
    });
    if (state.arch.logs.length > 30) {
      state.arch.logs.pop();
    }
    renderArchEventLog();
  }

  function renderArchEventLog() {
    const tbody = document.getElementById('archEventLogBody');
    if (!tbody) return;
    if (state.arch.logs.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="empty-cell">Select an operation (PUT, GET, or DELETE) and click <strong>Run</strong> or <strong>Step Forward</strong> to trace the packet lifecycle.</td></tr>';
      return;
    }
    tbody.innerHTML = state.arch.logs
      .map(
        (item, idx) => `
      <tr class="${idx === 0 ? 'active-row' : ''}">
        <td class="mono">${escapeHtml(item.stepLabel)}</td>
        <td><strong>${escapeHtml(item.action)}</strong></td>
        <td class="mono">${escapeHtml(item.component)}</td>
        <td>${escapeHtml(item.explanation)}</td>
      </tr>
    `
      )
      .join('');
  }

  function applyArchStageVisuals(stageIndex) {
    const plan = state.arch.activePlan;
    const stageCounter = document.getElementById('archStageCounter');
    const stageStatus = document.getElementById('archStageStatusText');

    for (let i = 1; i <= 6; i++) {
      const box = document.getElementById(`pipeStage${i}`);
      if (!box) continue;
      box.classList.toggle('active-stage', i === stageIndex);
      box.classList.toggle('completed-stage', i < stageIndex);
    }

    for (let c = 1; c <= 5; c++) {
      const conn = document.getElementById(`pipeConn${c}`);
      if (!conn) continue;
      conn.classList.toggle('active-conn', c === stageIndex - 1 || (stageIndex === 6 && c === 5));
    }

    if (!plan || stageIndex === 0) {
      stageCounter.textContent = '0 / 6';
      stageStatus.textContent = 'IDLE — READY FOR REQUEST';
      document.getElementById('pipeClientInfo').textContent = `Op: ${state.arch.op} ${state.arch.key}`;
      document.getElementById('pipeCoordInfo').textContent = 'Hash: --';
      document.getElementById('pipeRingInfo').textContent = 'VNode: --';
      document.getElementById('pipeSelectedNodeTitle').textContent = 'Selected Data Node';
      document.getElementById('pipeSelectedNodePort').textContent = 'Port :8001 / :8002 / :8003';
      document.getElementById('pipeNodeInfo').textContent = 'Awaiting routing';
      document.getElementById('pipeLRUInfo').textContent = 'MRU Head: --';
      document.getElementById('pipeWALInfo').textContent = 'Write-Ahead Log';
      updateRoutingBranchSvg(null, false);
      renderClusterNodeCards(null, false, false);
      renderProductExperience();
      return;
    }

    stageCounter.textContent = `${stageIndex} / 6`;

    const reqFields = document.getElementById('archReqPacketFields');
    const resFields = document.getElementById('archResPacketFields');

    reqFields.innerHTML = `
      <span><strong>MAGIC:</strong> 0xDC</span>
      <span><strong>OP:</strong> ${escapeHtml(plan.opHex)}</span>
      <span><strong>KEY_LEN:</strong> ${plan.keyBytes}B</span>
      <span><strong>VAL_LEN:</strong> ${plan.valBytes}B</span>
      <span><strong>PAYLOAD:</strong> "${escapeHtml(plan.key)}"${plan.op === 'PUT' ? ` | "${escapeHtml(plan.val)}"` : ''}</span>
    `;

    const nodeObj = state.nodes[plan.targetNodeId];

    if (stageIndex === 1) {
      stageStatus.textContent = 'STAGE 1: CLIENT SERIALIZES BINARY REQUEST FRAME';
      document.getElementById('pipeClientInfo').textContent = `${plan.op} "${plan.key}" (${10 + plan.keyBytes + plan.valBytes}B frame)`;
      updateRoutingBranchSvg(null, false);
      renderClusterNodeCards(null, false, false);
      appendArchLog(
        'STEP 1/6',
        `Serialize ${plan.op} Frame`,
        'Browser Playground',
        `Constructed the 10-byte request preview [Magic=0xDC, Op=${plan.opHex}, KeyLen=${plan.keyBytes}, ValLen=${plan.valBytes}]. ${state.liveMode ? 'The bridge will send it to the live coordinator.' : 'The browser will continue through the deterministic simulation.'}`
      );
    } else if (stageIndex === 2) {
      stageStatus.textContent = 'STAGE 2: COORDINATOR HASHES KEY VIA MURMURHASH3';
      document.getElementById('pipeCoordInfo').textContent = `Hash: ${toHex32(plan.routeInfo.keyHash)}`;
      updateRoutingBranchSvg(null, false);
      renderClusterNodeCards(null, false, false);
      appendArchLog(
        'STEP 2/6',
        'MurmurHash3_x86_32',
        'Coordinator :8000',
        `select() woke worker thread; hashed key "${plan.key}" → ${toHex32(plan.routeInfo.keyHash)} (${plan.routeInfo.keyHash}).`
      );
    } else if (stageIndex === 3) {
      stageStatus.textContent = 'STAGE 3: CONSISTENT HASH RING SUCCESSOR LOOKUP';
      document.getElementById('pipeRingInfo').textContent = `${plan.routeInfo.successor.label} (${toHex32(plan.routeInfo.successor.hashPos)})`;
      document.getElementById('pipeRoutePortLabel').textContent = `Forward TCP :${plan.targetPort}`;
      document.getElementById('pipeRouteNodeSub').textContent = `Data Node ${plan.targetNodeId}`;
      updateRoutingBranchSvg(plan.targetNodeId, true, 0.35);
      renderClusterNodeCards(plan.targetNodeId, false, false);
      appendArchLog(
        'STEP 3/6',
        'Ring Successor Lookup',
        'Consistent Hash Ring',
        `std::map::lower_bound(${toHex32(plan.routeInfo.keyHash)}) selected clockwise virtual node ${plan.routeInfo.successor.label} at ${toHex32(plan.routeInfo.successor.hashPos)} → mapped to Data Node ${plan.targetNodeId} (127.0.0.1:${plan.targetPort}).`
      );
    } else if (stageIndex === 4) {
      stageStatus.textContent = `STAGE 4: COORDINATOR FORWARDS PACKET TO DATA NODE ${plan.targetNodeId} (:${plan.targetPort})`;
      document.getElementById('pipeSelectedNodeTitle').textContent = `Data Node ${plan.targetNodeId}`;
      document.getElementById('pipeSelectedNodePort').textContent = `127.0.0.1:${plan.targetPort}`;
      document.getElementById('pipeNodeInfo').textContent = `select() → Bounded Pool`;
      document.getElementById('pipeWalFileSub').textContent = `${plan.walFile}`;
      updateRoutingBranchSvg(plan.targetNodeId, true, 0.95);
      renderClusterNodeCards(plan.targetNodeId, false, false);
      appendArchLog(
        'STEP 4/6',
        'Forward Binary Frame',
        `Data Node ${plan.targetNodeId} :${plan.targetPort}`,
        `Coordinator forwarded binary request over TCP to 127.0.0.1:${plan.targetPort}. Data Node select() multiplexer dispatched socket task to its Bounded Thread Pool.`
      );
    } else if (stageIndex === 5) {
      if (!plan.executedMutation) {
        plan.executedMutation = true;
        if (state.liveMode) {
          plan.pending = true;
          plan.liveExecution = true;
          plan.resumeAfterLive = state.arch.running;
          stageStatus.textContent = `STAGE 5: WAITING FOR LIVE DATA NODE ${plan.targetNodeId}`;
          document.getElementById('pipeWALInfo').textContent = plan.op === 'GET'
            ? 'Awaiting response · GET does not append WAL'
            : 'Awaiting node WAL and cache result';
          document.getElementById('pipeLRUInfo').textContent = 'Awaiting live response';
          appendArchLog(
            'STEP 5/6',
            `Send Live ${plan.op}`,
            `Data Node ${plan.targetNodeId}`,
            `Request sent through the bridge. Waiting for the C++ response before updating this view.`
          );
          if (plan.resumeAfterLive) stopArchAutoRun();
          document.getElementById('archRunBtn').disabled = true;
          sendLiveOperation({
            type: 'execute_op',
            op: plan.op,
            key: plan.key,
            value: plan.val,
          }, (result, error, responseMessage) => {
            finishLiveArchitectureRequest(plan, result, error, responseMessage);
          });
        } else if (plan.op === 'PUT') {
          const res = nodeObj.put(plan.key, plan.val, false);
          plan.statusHex = '0x00 (STATUS_OK)';
          plan.executionOutcomeText = res.evicted
            ? `Stored "${plan.key}"="${plan.val}" at MRU Head (Evicted LRU Tail "${res.evictedKey}")`
            : res.updated
            ? `Updated "${plan.key}"="${plan.val}" and promoted to MRU Head`
            : `Inserted "${plan.key}"="${plan.val}" at MRU Head`;

          stageStatus.textContent = `STAGE 5: WAL APPEND (${plan.walFile}) → LRU CACHE UPDATE`;
          document.getElementById('pipeWALInfo').textContent = `Appended SEQ #${nodeObj.walRecordCount} + Stream Flushed`;
          document.getElementById('pipeLRUInfo').textContent = `MRU Head: ${plan.key}`;
          renderClusterNodeCards(plan.targetNodeId, true, true);
          appendArchLog(
            'STEP 5/6',
            'WAL Flush + LRU PUT',
            `Node ${plan.targetNodeId} WAL & LRUCache`,
            `1) Appended PUT "${plan.key}" to ${plan.walFile} (SEQ #${nodeObj.walRecordCount}) and flushed the C++ stream. 2) Acquired std::unique_lock<std::shared_mutex> and ${plan.executionOutcomeText}.`
          );
          renderCacheEngineView();
          renderWalRecoveryView();
        } else if (plan.op === 'DELETE') {
          const res = nodeObj.del(plan.key, false);
          plan.statusHex = res.removed ? '0x00 (STATUS_OK)' : '0x01 (NOT_FOUND)';
          plan.executionOutcomeText = res.removed
            ? `Removed "${plan.key}" from std::unordered_map and unlinked Doubly Linked List node`
            : `Key "${plan.key}" not present in cache`;

          stageStatus.textContent = `STAGE 5: WAL APPEND (${plan.walFile}) → LRU DELETE`;
          document.getElementById('pipeWALInfo').textContent = `Appended SEQ #${nodeObj.walRecordCount} + Stream Flushed`;
          document.getElementById('pipeLRUInfo').textContent = `Size: ${nodeObj.entries.length}/${nodeObj.capacity}`;
          renderClusterNodeCards(plan.targetNodeId, true, true);
          appendArchLog(
            'STEP 5/6',
            'WAL Flush + LRU DELETE',
            `Node ${plan.targetNodeId} WAL & LRUCache`,
            `1) Appended DELETE "${plan.key}" to ${plan.walFile} (SEQ #${nodeObj.walRecordCount}) and flushed the C++ stream. 2) ${plan.executionOutcomeText}.`
          );
          renderCacheEngineView();
          renderWalRecoveryView();
        } else {
          const res = nodeObj.get(plan.key);
          plan.statusHex = res.hit ? '0x00 (STATUS_OK / HIT)' : '0x01 (NOT_FOUND / MISS)';
          plan.executionOutcomeText = res.hit
            ? `CACHE HIT: Value="${res.value}" (Promoted "${plan.key}" to MRU Head)`
            : `CACHE MISS: Key "${plan.key}" not found in Node ${plan.targetNodeId}`;

          stageStatus.textContent = 'STAGE 5: LRU CACHE LOOKUP (NO WAL WRITE ON GET)';
          document.getElementById('pipeWALInfo').textContent = 'Bypassed (Read-Only GET)';
          document.getElementById('pipeLRUInfo').textContent = res.hit ? `HIT → MRU: ${plan.key}` : `MISS (${plan.key})`;
          renderClusterNodeCards(plan.targetNodeId, true, false);
          appendArchLog(
            'STEP 5/6',
            'LRU Lookup',
            `Node ${plan.targetNodeId} LRUCache`,
            `${plan.executionOutcomeText}. GET updates recency under an exclusive cache lock and does not mutate ${plan.walFile}.`
          );
          renderCacheEngineView();
          renderWalRecoveryView();
        }
      }
    } else if (stageIndex === 6) {
      stageStatus.textContent = `STAGE 6: COMPLETE — 16-BYTE BINARY RESPONSE RETURNED TO CLIENT`;
      updateRoutingBranchSvg(plan.targetNodeId, false);
      renderClusterNodeCards(plan.targetNodeId, false, false);

      resFields.innerHTML = `
        <span><strong>MAGIC:</strong> 0xDC</span>
        <span><strong>STATUS:</strong> ${escapeHtml(plan.statusHex)}</span>
        <span><strong>NODE_ID:</strong> ${plan.targetNodeId} (:${plan.targetPort})</span>
        <span><strong>KEY_HASH:</strong> ${toHex32(plan.routeInfo.keyHash)}</span>
        <span><strong>VNODE_HASH:</strong> ${toHex32(plan.routeInfo.successor.hashPos)}</span>
        <span><strong>RESULT:</strong> ${escapeHtml(plan.executionOutcomeText)}</span>
      `;
      setRouteOutcome(`${plan.op} "${plan.key}" → ${plan.statusHex}. Data Node ${plan.targetNodeId} (:${plan.targetPort}); ${plan.executionOutcomeText}.`);

      appendArchLog(
        'STEP 6/6',
        'Return Binary Response',
        `Node ${plan.targetNodeId} → Coordinator → Client`,
        `Returned 16-byte response header [Magic=0xDC, Status=${plan.statusHex}, Node=${plan.targetNodeId}] to Python client.`
      );
      stopArchAutoRun();
      recordProductOperation(plan);
    }
    renderProductExperience();
  }

  function stepArchForward() {
    if (state.arch.activePlan?.pending) return;
    if (state.arch.currentStage === 0 || state.arch.currentStage >= state.arch.maxStage) {
      const plan = buildArchitectureExecutionPlan();
      if (!plan) return;
      state.arch.productLastResult = null;
      state.arch.activePlan = plan;
      state.arch.currentStage = 1;
    } else {
      state.arch.currentStage += 1;
    }
    applyArchStageVisuals(state.arch.currentStage);
  }

  function stopArchAutoRun() {
    if (state.arch.timer) {
      clearInterval(state.arch.timer);
      state.arch.timer = null;
    }
    state.arch.running = false;
    const runBtn = document.getElementById('archRunBtn');
    if (runBtn) runBtn.textContent = 'Run';
  }

  function toggleArchRun() {
    if (state.arch.running) {
      stopArchAutoRun();
      return;
    }

    if (state.arch.currentStage === 0 || state.arch.currentStage >= state.arch.maxStage) {
      const plan = buildArchitectureExecutionPlan();
      if (!plan) return;
      state.arch.activePlan = plan;
      state.arch.currentStage = 0;
    }

    // If Reduced Motion is active, step immediately through all stages
    if (state.reducedMotion) {
      while (state.arch.currentStage < state.arch.maxStage) {
        state.arch.currentStage += 1;
        applyArchStageVisuals(state.arch.currentStage);
      }
      return;
    }

    state.arch.running = true;
    const runBtn = document.getElementById('archRunBtn');
    if (runBtn) runBtn.textContent = 'Pause';

    stepArchForward();
    state.arch.timer = setInterval(() => {
      if (state.arch.currentStage < state.arch.maxStage) {
        stepArchForward();
      } else {
        stopArchAutoRun();
      }
    }, 650);
  }

  function resetArchFlow() {
    stopArchAutoRun();
    document.getElementById('archRunBtn').disabled = false;
    state.arch.currentStage = 0;
    state.arch.activePlan = null;
    applyArchStageVisuals(0);
  }

  // ==========================================================================
  // 6. CONSISTENT HASHING VISUALIZER
  // ==========================================================================
  function hashToAngleRad(hashUint32) {
    const ratio = (hashUint32 >>> 0) / 4294967296;
    return ratio * Math.PI * 2 - Math.PI / 2; // 0 at 12 o'clock, clockwise
  }

  function polarToXY(cx, cy, radius, angleRad) {
    return {
      x: cx + radius * Math.cos(angleRad),
      y: cy + radius * Math.sin(angleRad),
    };
  }

  function describeClockwiseArc(cx, cy, radius, startHash, endHash) {
    const startAngle = hashToAngleRad(startHash);
    let endAngle = hashToAngleRad(endHash);
    if (endAngle <= startAngle) {
      endAngle += Math.PI * 2;
    }
    const delta = endAngle - startAngle;
    const largeArc = delta > Math.PI ? 1 : 0;
    const startPt = polarToXY(cx, cy, radius, startAngle);
    const endPt = polarToXY(cx, cy, radius, endAngle);
    return `M ${startPt.x.toFixed(2)} ${startPt.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${endPt.x.toFixed(2)} ${endPt.y.toFixed(2)}`;
  }

  function renderHashRingVisualizer() {
    const inputEl = document.getElementById('ringKeyInput');
    const key = (inputEl ? inputEl.value.trim() : state.ringKey) || 'session:4092';
    state.ringKey = key;

    const routeRes = hashRing.route(key);
    setRouteOutcome(`"${key}" hashes to ${toHex32(routeRes.keyHash)} and routes clockwise to ${routeRes.physical.name} (:${routeRes.physical.port}) via ${routeRes.successor.label}${routeRes.wrapped ? ' after wrapping to the ring start' : ''}.`);
    const keyDeg = ((routeRes.keyHash / 4294967296) * 360).toFixed(2);
    const vnodeDeg = ((routeRes.successor.hashPos / 4294967296) * 360).toFixed(2);

    // Update 5-Step Algorithm text
    document.getElementById('hashStep1Out').textContent =
      `MurmurHash3_x86_32("${key}", seed=0) = ${toHex32(routeRes.keyHash)} (${routeRes.keyHash})`;
    document.getElementById('hashStep2Out').textContent =
      `Position = ${routeRes.keyHash} / 2^32 (${keyDeg}° clockwise from 0x00000000)`;
    document.getElementById('hashStep3Out').textContent =
      `std::map::lower_bound(${toHex32(routeRes.keyHash)}) → ${routeRes.successor.label} @ ${toHex32(routeRes.successor.hashPos)} (${vnodeDeg}°)${routeRes.wrapped ? ' [WRAPPED PAST 2^32-1]' : ''}`;
    document.getElementById('hashStep4Out').textContent =
      `${routeRes.successor.label} → ${routeRes.physical.name} (Node ID: ${routeRes.physical.nodeId})`;
    document.getElementById('hashStep5Out').textContent =
      `Coordinator :8000 forwards binary packet to 127.0.0.1:${routeRes.physical.port}`;

    // Render SVG Ring
    const svg = document.getElementById('hashRingSvg');
    if (!svg) return;

    const cx = 310;
    const cy = 265;
    const R = 168;

    let parts = [];

    // Definitions for arrowheads
    parts.push(`
      <defs>
        <marker id="ringArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--purple)" />
        </marker>
      </defs>
    `);

    // Clockwise indicator arc at top
    const cwArcStart = polarToXY(cx, cy, R + 32, -Math.PI * 0.63);
    const cwArcEnd = polarToXY(cx, cy, R + 32, -Math.PI * 0.37);
    parts.push(`
      <path d="M ${cwArcStart.x.toFixed(1)} ${cwArcStart.y.toFixed(1)} A ${R + 32} ${R + 32} 0 0 1 ${cwArcEnd.x.toFixed(1)} ${cwArcEnd.y.toFixed(1)}"
            fill="none" stroke="var(--purple)" stroke-width="1.2" marker-end="url(#ringArrow)" />
      <text x="${cx}" y="${cy - R - 38}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">
        0x00000000 · CLOCKWISE SUCCESSOR LOOKUP
      </text>
    `);

    // Main Hash Space Circle
    parts.push(`
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--line)" stroke-width="1.5" />
      <circle cx="${cx}" cy="${cy}" r="${R - 22}" fill="none" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2,3" />
    `);

    // Plot all 300 Virtual Node positions around the ring
    for (const vn of hashRing.vnodes) {
      const ang = hashToAngleRad(vn.hashPos);
      let r1 = R;
      let r2 = R;
      if (vn.nodeId === 1) {
        r1 = R;
        r2 = R + 9;
      } else if (vn.nodeId === 2) {
        r1 = R - 4;
        r2 = R + 4;
      } else {
        r1 = R - 9;
        r2 = R;
      }
      const p1 = polarToXY(cx, cy, r1, ang);
      const p2 = polarToXY(cx, cy, r2, ang);
      parts.push(
        `<line class="vnode-position vnode-node-${vn.nodeId}" x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}" stroke="var(--node-${vn.nodeId})" stroke-width="1" />`
      );
    }

    // Highlighted Clockwise Successor Search Arc from KeyHash to Successor VNode
    const arcPath = describeClockwiseArc(cx, cy, R + 16, routeRes.keyHash, routeRes.successor.hashPos);
    parts.push(`
      <path class="successor-route-arc" d="${arcPath}" fill="none" stroke="var(--purple)" stroke-width="2.5" stroke-dasharray="4,2" marker-end="url(#ringArrow)" />
    `);

    // Key Hash Marker (Distinct Black-Outline Square + Radial Line)
    const keyAng = hashToAngleRad(routeRes.keyHash);
    const keyPt = polarToXY(cx, cy, R, keyAng);
    const keyLabelPt = polarToXY(cx, cy, R + 24, keyAng);
    parts.push(`
      <line x1="${cx}" y1="${cy}" x2="${keyPt.x.toFixed(2)}" y2="${keyPt.y.toFixed(2)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3,3" />
      <rect x="${(keyPt.x - 6).toFixed(2)}" y="${(keyPt.y - 6).toFixed(2)}" width="12" height="12" fill="var(--surface)" stroke="var(--purple)" stroke-width="2.5" />
      <circle cx="${keyPt.x.toFixed(2)}" cy="${keyPt.y.toFixed(2)}" r="2.5" fill="var(--purple)" />
    `);

    // Highlighted Successor Virtual Node Marker (Solid Black Circle + Outer Ring)
    const succAng = hashToAngleRad(routeRes.successor.hashPos);
    const succPt = polarToXY(cx, cy, R, succAng);
    parts.push(`
      <line x1="${cx}" y1="${cy}" x2="${succPt.x.toFixed(2)}" y2="${succPt.y.toFixed(2)}" stroke="var(--purple)" stroke-width="2" />
      <circle cx="${succPt.x.toFixed(2)}" cy="${succPt.y.toFixed(2)}" r="8" fill="var(--surface)" stroke="var(--purple)" stroke-width="2.5" />
      <circle cx="${succPt.x.toFixed(2)}" cy="${succPt.y.toFixed(2)}" r="4" fill="var(--purple)" />
    `);

    // Three Physical Data Node Boxes arranged cleanly around the ring
    const physicalBoxes = [
      { id: 1, x: 18, y: 55, w: 128, h: 48, label: 'Data Node 1', port: ':8001 (100 VNs)' },
      { id: 2, x: 474, y: 55, w: 128, h: 48, label: 'Data Node 2', port: ':8002 (100 VNs)' },
      { id: 3, x: 246, y: 458, w: 128, h: 48, label: 'Data Node 3', port: ':8003 (100 VNs)' },
    ];

    for (const pb of physicalBoxes) {
      const isTarget = pb.id === routeRes.physical.nodeId;
      const boxCx = pb.x + pb.w / 2;
      const boxCy = pb.y + pb.h / 2;

      if (isTarget) {
        parts.push(`
          <line x1="${succPt.x.toFixed(1)}" y1="${succPt.y.toFixed(1)}" x2="${boxCx.toFixed(1)}" y2="${boxCy.toFixed(1)}"
                stroke="var(--purple)" stroke-width="2" marker-end="url(#ringArrow)" />
        `);
      }

      parts.push(`
        <rect class="${isTarget ? 'ring-target-node' : ''}" x="${pb.x}" y="${pb.y}" width="${pb.w}" height="${pb.h}"
                fill="${isTarget ? 'var(--purple-strong)' : 'var(--surface)'}"
                stroke="var(--line)" stroke-width="${isTarget ? '2.5' : '1'}" />
        <text x="${pb.x + 10}" y="${pb.y + 20}" font-family="Proxima Nova, sans-serif" font-size="12" font-weight="700"
                fill="${isTarget ? '#FFFFFF' : 'var(--ink)'}">${pb.label}</text>
        <text x="${pb.x + 10}" y="${pb.y + 36}" font-family="JetBrains Mono, monospace" font-size="10"
                fill="${isTarget ? '#FFFFFF' : 'var(--muted)'}">${pb.port}</text>
      `);
    }

    // Center Readout Badge inside the Ring
    parts.push(`
      <rect x="${cx - 102}" y="${cy - 44}" width="204" height="88" fill="var(--surface)" stroke="var(--line)" stroke-width="1.5" />
      <text x="${cx}" y="${cy - 24}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">
        KEY: "${escapeHtml(key.length > 18 ? key.slice(0, 18) + '…' : key)}"
      </text>
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10">
        HASH: ${toHex32(routeRes.keyHash)}
      </text>
      <text x="${cx}" y="${cy + 10}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">
        → ${routeRes.successor.label}
      </text>
      <text x="${cx}" y="${cy + 28}" text-anchor="middle" font-family="Proxima Nova, sans-serif" font-size="11" font-weight="700">
        TARGET: DATA NODE ${routeRes.physical.nodeId} (:${routeRes.physical.port})
      </text>
    `);

    // Key Hash Callout Tag
    const calloutX = Math.max(60, Math.min(560, keyLabelPt.x));
    const calloutY = Math.max(25, Math.min(445, keyLabelPt.y));
    parts.push(`
      <rect x="${(calloutX - 48).toFixed(1)}" y="${(calloutY - 10).toFixed(1)}" width="96" height="18" fill="var(--surface)" stroke="var(--line)" stroke-width="1" />
      <text x="${calloutX.toFixed(1)}" y="${(calloutY + 2).toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">
        KEY @ ${keyDeg}°
      </text>
    `);

    svg.innerHTML = parts.join('');
    renderRingDistributionTable();
  }

  function renderRingDistributionTable() {
    const tbody = document.getElementById('ringDistTableBody');
    if (!tbody) return;
    const arcShares = hashRing.computeArcShares();

    if (!state.sampleDistCounts) {
      const counts = { 1: 0, 2: 0, 3: 0 };
      for (let i = 1; i <= 300; i++) {
        const r = hashRing.route(`sample_key:${i}`);
        counts[r.physical.nodeId]++;
      }
      state.sampleDistCounts = counts;
    }

    tbody.innerHTML = [1, 2, 3]
      .map((nid) => {
        const p = PHYSICAL_NODES[nid];
        const sampleCount = state.sampleDistCounts[nid];
        const samplePct = ((sampleCount / 300) * 100).toFixed(1);
        return `
        <tr>
          <td><strong>${p.name} (:${p.port})</strong></td>
          <td class="mono">100 VNodes</td>
          <td class="mono">${arcShares[nid]}% of 2^32</td>
          <td class="mono">${sampleCount} keys (${samplePct}%)</td>
        </tr>
      `;
      })
      .join('');
  }

  // ==========================================================================
  // 7. CACHE ENGINE VISUALIZER & 8. CONCURRENCY PIPELINE
  // ==========================================================================
  function renderCacheEngineView() {
    const node = state.nodes[state.cacheSelectedNode];
    if (!node) return;

    const mruKey = node.reportedMruKey ?? (node.entries.length > 0 ? node.entries[0].key : '—');
    const lruKey = node.reportedLruKey ?? (node.entries.length > 0 ? node.entries[node.entries.length - 1].key : '—');

    document.getElementById('lruMetricSize').textContent = String(node.reportedSize ?? node.entries.length);
    document.getElementById('lruMetricCap').innerHTML = `${node.capacity} <small>(Demo)</small>`;
    document.getElementById('lruMetricMRU').textContent = mruKey;
    document.getElementById('lruMetricLRU').textContent = lruKey;
    document.getElementById('lruMetricCounters').textContent = `${node.hits} / ${node.misses} / ${node.evictions}`;
    document.getElementById('lruLastOpBanner').textContent = state.lastCacheBanner;

    // 1. Render Custom Doubly Linked List (MRU Head <-> ... <-> LRU Tail)
    const dllContainer = document.getElementById('dllVisualizerContainer');
    if (node.entries.length === 0) {
      dllContainer.innerHTML = `
        <div class="dll-pointer-badge">HEAD (MRU) → nullptr</div>
        <span class="dll-arrow">↔</span>
        <div class="dll-pointer-badge">TAIL (LRU) → nullptr</div>
      `;
    } else {
      const nodesHtml = node.entries
        .map((entry, idx) => {
          const isHead = idx === 0;
          const isTail = idx === node.entries.length - 1;
          const prevLabel = isHead ? 'nullptr' : node.entries[idx - 1].key;
          const nextLabel = isTail ? 'nullptr' : node.entries[idx + 1].key;
          const roleText =
            isHead && isTail
              ? 'HEAD (MRU) & TAIL (LRU)'
              : isHead
              ? 'HEAD (MRU)'
              : isTail
              ? 'TAIL (LRU — EVICT NEXT)'
              : `NODE #${idx + 1}`;

          return `
            <div class="dll-node-box ${isHead ? 'mru-node' : ''} ${isTail ? 'lru-node' : ''} ${isHead ? (state.cacheAnimation || '') : ''}">
              <div class="dll-node-role">
                <span>${roleText}</span>
                <span>${entry.addr}</span>
              </div>
              <div class="dll-node-body">
                <div class="dll-node-kv"><strong>key:</strong> ${escapeHtml(entry.key)}</div>
                <div class="dll-node-kv"><strong>val:</strong> ${escapeHtml(entry.value)}</div>
                <div class="dll-node-ptrs">
                  <span>prev: ${escapeHtml(prevLabel)}</span>
                  <span>next: ${escapeHtml(nextLabel)}</span>
                </div>
              </div>
            </div>
          `;
        })
        .join('<span class="dll-arrow" aria-hidden="true">⇄</span>');

      dllContainer.innerHTML = `
        <div class="dll-pointer-badge">head_</div>
        <span class="dll-arrow">→</span>
        ${nodesHtml}
        <span class="dll-arrow">←</span>
        <div class="dll-pointer-badge">tail_</div>
      `;
    }

    if (state.cacheAnimation) {
      const animation = state.cacheAnimation;
      requestAnimationFrame(() => {
        if (state.cacheAnimation === animation) state.cacheAnimation = null;
      });
    }

    // 2. Render std::unordered_map<std::string, Node*> Table
    const tbody = document.getElementById('lruTableBody');
    if (node.entries.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty-cell">Cache is empty on this Data Node. Execute a PUT operation or click <strong>Fill to Capacity</strong>.</td></tr>';
    } else {
      tbody.innerHTML = node.entries
        .map((entry, idx) => {
          const bucket = murmurhash3_x86_32(entry.key, 0) % 1024;
          const posLabel =
            idx === 0
              ? '0 — HEAD (MRU)'
              : idx === node.entries.length - 1
              ? `${idx} — TAIL (LRU)`
              : `${idx}`;
          return `
            <tr class="${idx === 0 ? 'active-row' : ''}">
              <td class="mono"><strong>${escapeHtml(entry.key)}</strong></td>
              <td class="mono">${escapeHtml(entry.value)}</td>
              <td class="mono">bucket[${bucket}]</td>
              <td class="mono">Node* (${entry.addr})</td>
              <td class="mono">${posLabel}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  function executeCacheEngineOperation() {
    const node = state.nodes[state.cacheSelectedNode];
    const op = state.cacheOp;
    const key = document.getElementById('cacheKeyInput').value.trim();
    const val = document.getElementById('cacheValInput').value;

    if (!key) return;

    if (state.liveMode) {
      state.lastCacheBanner = `LIVE ${op} ${key}: waiting for Data Node ${node.nodeId} response...`;
      renderCacheEngineView();
      const button = document.getElementById('cacheExecBtn');
      button.disabled = true;
      sendLiveOperation({
        type: 'execute_op',
        directNodeId: node.nodeId,
        op,
        key,
        value: val,
      }, (result, error) => {
        button.disabled = false;
        state.cacheAnimation = !error && result?.status === 0 && (op === 'PUT' || op === 'GET')
          ? (op === 'GET' ? 'cache-promoted' : 'cache-inserted')
          : null;
        const status = result ? (result.status === 0 ? 'OK' : result.status === 1 ? 'NOT_FOUND' : 'ERROR') : 'ERROR';
        state.lastCacheBanner = error
          ? `LIVE ${op} failed: ${error}`
          : `LIVE ${op} ${key} → ${status}: ${result.payload || '(empty payload)'}`;
        renderCacheEngineView();
      });
      return;
    }

    if (op === 'PUT') {
      const outcome = node.put(key, val, false);
      state.cacheAnimation = outcome.evicted ? 'cache-inserted cache-eviction' : 'cache-inserted';
      if (outcome.evicted) {
        state.lastCacheBanner = `PUT("${key}", "${val}"): evicted LRU TAIL "${outcome.evictedKey}" (O(1) list unlink; average-case O(1) map erase) and inserted at HEAD.`;
      } else if (outcome.updated) {
        state.lastCacheBanner = `PUT("${key}", "${val}"): updated value and promoted to MRU HEAD (average-case O(1) map lookup; O(1) list move).`;
      } else {
        state.lastCacheBanner = `PUT("${key}", "${val}"): inserted at MRU HEAD; map lookup/insertion is average-case O(1).`;
      }
    } else if (op === 'GET') {
      const outcome = node.get(key);
      state.cacheAnimation = outcome.hit ? 'cache-promoted' : null;
      if (outcome.hit) {
        state.lastCacheBanner = `GET("${key}") → HIT ("${outcome.value}"): moved to MRU HEAD with O(1) list work under an exclusive lock.`;
      } else {
        state.lastCacheBanner = `GET("${key}") → CACHE MISS: key not found (average-case O(1) map lookup).`;
      }
    } else if (op === 'DELETE') {
      const outcome = node.del(key, false);
      state.cacheAnimation = null;
      state.lastCacheBanner = outcome.removed
        ? `DELETE("${key}") → O(1) list unlink + average-case O(1) map erase`
        : `DELETE("${key}") → Key not found`;
    }

    setRouteOutcome(state.lastCacheBanner);
    renderCacheEngineView();
    renderClusterNodeCards();
    renderWalRecoveryView();
  }

  function traceConcurrencyPipeline(isMutation) {
    const stages = [1, 2, 3, 4, 5].map((i) => document.getElementById(`concStage${i}`));
    const readCard = document.getElementById('syncReadCard');
    const writeCard = document.getElementById('syncWriteCard');

    stages.forEach((s) => s && s.classList.remove('active-conc'));
    readCard.classList.toggle('active-sync', !isMutation);
    writeCard.classList.toggle('active-sync', isMutation);

    if (state.reducedMotion) {
      stages.forEach((s) => s && s.classList.add('active-conc'));
      return;
    }

    stages.forEach((s, idx) => {
      setTimeout(() => {
        stages.forEach((el, j) => el && el.classList.toggle('active-conc', j === idx));
      }, idx * 280);
    });
  }

  // ==========================================================================
  // 9. WAL AND CRASH-RECOVERY VISUALIZER
  // ==========================================================================
  function renderWalRecoveryView() {
    const nodeId = state.walSelectedNode;
    const node = state.nodes[nodeId];

    document.getElementById('walSelectedNodeLabel').textContent = `NODE ${nodeId} (:${node.port})`;
    document.getElementById('walFileHeaderName').textContent = node.walFile;
    document.getElementById('walFooterFile').textContent = node.walFile;

    // Update 6-Stage Recovery Strip
    const boxes = document.querySelectorAll('#recoveryStepsStrip .rec-stage-box');
    boxes.forEach((box) => {
      const stepNum = Number(box.getAttribute('data-rec-step'));
      box.classList.toggle('active', stepNum === state.recoveryStep);
      box.classList.toggle('completed', stepNum < state.recoveryStep);
    });

    const stage6Text = document.getElementById('recStage6Text');
    const memBanner = document.getElementById('walRecoveryBannerText');
    const recordTotal = state.liveMode ? node.walRecordCount : node.walRecords.length;
    document.getElementById('walStepRecoveryBtn').disabled = state.recoveryPending;
    document.getElementById('walRunRecoveryBtn').disabled = state.recoveryPending;

    if (state.recoveryStep === 1) {
      stage6Text.textContent = 'ONLINE';
      memBanner.textContent = 'STATE: ONLINE (SYNCHRONIZED WITH LOCAL WAL)';
    } else if (state.recoveryStep === 2) {
      stage6Text.textContent = state.recoveryPending ? 'CLEARING MEMORY...' : 'RESTART SIMULATED';
      memBanner.textContent = `STATE: SIMULATING NODE ${nodeId} RESTART; NO PROCESS IS TERMINATED`;
    } else if (state.recoveryStep === 3) {
      stage6Text.textContent = 'RAM CLEARED';
      memBanner.textContent = 'STATE: VOLATILE IN-MEMORY CACHE CLEARED (0 ENTRIES)';
    } else if (state.recoveryStep === 4) {
      stage6Text.textContent = state.recoveryPending ? 'REPLAYING LOCAL LOG...' : `REPLAYED ${state.recoveryReplayedCount}/${recordTotal}`;
      memBanner.textContent = `STATE: ${state.recoveryPending ? 'REPLAYING' : 'REPLAYED'} ${node.walFile} (${state.recoveryReplayedCount} / ${recordTotal} RECORDS)`;
    } else if (state.recoveryStep === 5) {
      stage6Text.textContent = 'CACHE REBUILT';
      memBanner.textContent = `STATE: IN-MEMORY LRU RECONSTRUCTED (${node.entries.length} ENTRIES)`;
    } else if (state.recoveryStep === 6) {
      stage6Text.textContent = 'RECOVERY COMPLETE';
      memBanner.textContent = 'STATUS: RECOVERY COMPLETE — RECONSTRUCTED FROM LOCAL WAL';
    }

    // Render WAL Log Table
    const walTbody = document.getElementById('walLogTableBody');
    if (node.walRecords.length === 0) {
      walTbody.innerHTML =
        '<tr><td colspan="5" class="empty-cell">No WAL records in this node\'s log file yet. Execute a PUT/DELETE mutation or click <strong>Seed Sample WAL</strong>.</td></tr>';
    } else {
      walTbody.innerHTML = node.walRecords
        .map((rec, idx) => {
          let replayStatus = state.liveMode ? 'LIVE LOG · STREAM FLUSHED' : 'SIMULATED LOG ENTRY';
          let isCurrentReplay = false;
          if (state.recoveryStep === 3) {
            replayStatus = 'PENDING REPLAY';
          } else if (state.recoveryStep === 4) {
            if (idx < state.recoveryReplayedCount) {
              replayStatus = 'REPLAYED ✓';
              isCurrentReplay = idx === state.recoveryReplayedCount - 1;
            } else {
              replayStatus = 'QUEUED';
            }
          } else if (state.recoveryStep >= 5) {
            replayStatus = 'REPLAYED IN ORDER';
          }

          return `
            <tr class="${isCurrentReplay ? 'active-row' : ''}">
              <td class="mono"><strong>#${rec.seq}</strong></td>
              <td class="mono"><strong>${escapeHtml(rec.op)}</strong></td>
              <td class="mono">${escapeHtml(rec.key)}</td>
              <td class="mono">${rec.op === 'PUT' ? escapeHtml(rec.value) : '—'}</td>
              <td class="mono">${replayStatus}</td>
            </tr>
          `;
        })
        .join('');
    }

    // Render In-Memory Cache State Table
    const memTbody = document.getElementById('walMemoryTableBody');
    if (node.entries.length === 0) {
      const emptyMsg =
        state.recoveryStep === 2 || state.recoveryStep === 3
          ? 'IN-MEMORY STATE CLEARED (0 ENTRIES IN VOLATILE RAM) — READY FOR SEQUENTIAL WAL REPLAY'
          : 'In-memory LRU Cache is currently empty.';
      memTbody.innerHTML = `<tr><td colspan="4" class="empty-cell">${emptyMsg}</td></tr>`;
    } else {
      const sourceText =
        state.recoveryStep >= 4 ? `Reconstructed from ${node.walFile}` : 'Live Mutation';
      memTbody.innerHTML = node.entries
        .map((entry, idx) => {
          const orderTag =
            idx === 0
              ? 'HEAD (MRU)'
              : idx === node.entries.length - 1
              ? 'TAIL (LRU)'
              : `#${idx + 1}`;
          return `
            <tr>
              <td class="mono"><strong>${orderTag}</strong></td>
              <td class="mono">${escapeHtml(entry.key)}</td>
              <td class="mono">${escapeHtml(entry.value)}</td>
              <td class="mono">${escapeHtml(sourceText)}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  function animateMutationWorkflow() {
    const steps = [1, 2, 3, 4, 5].map((i) => document.getElementById(`mutStep${i}`));
    if (state.reducedMotion) {
      steps.forEach((s) => s && s.classList.add('active-mut'));
      return;
    }
    steps.forEach((s, idx) => {
      setTimeout(() => {
        steps.forEach((el, j) => el && el.classList.toggle('active-mut', j === idx));
      }, idx * 160);
    });
  }

  function stepWalRecovery() {
    const node = state.nodes[state.walSelectedNode];
    if (state.recoveryPending) return;
    if (!state.liveMode && node.walRecords.length === 0) {
      node.put('acct:301', 'bal=4500', false);
      node.put('acct:302', 'bal=9200', false);
      node.put('acct:301', 'bal=5100', false);
    }

    if (state.recoveryStep === 1 || state.recoveryStep >= 6) {
      state.recoveryStep = 2; // Step 2: Simulate Node Restart
    } else if (state.recoveryStep === 2) {
      if (state.liveMode) {
        state.recoveryPending = true;
        sendLiveOperation({ type: 'node_recover', nodeId: node.nodeId, stage: 'CLEAR_MEMORY' }, (result, error) => {
          state.recoveryPending = false;
          if (error || result?.status !== 0) {
            state.recoveryAutoRun = false;
            setRouteOutcome(`Live memory clear failed: ${error || result?.payload || 'node returned an error'}.`);
          } else {
            state.recoveryStep = 3;
            state.recoveryReplayedCount = 0;
            if (state.recoveryAutoRun) stepWalRecovery();
          }
          renderWalRecoveryView();
          renderCacheEngineView();
          renderClusterNodeCards();
        });
      } else {
        state.recoveryStep = 3;
        node.clearMemoryOnly();
        state.recoveryReplayedCount = 0;
      }
    } else if (state.recoveryStep === 3) {
      state.recoveryStep = 4; // Step 4: Replay WAL Operations in Order
      if (state.liveMode) {
        state.recoveryPending = true;
        sendLiveOperation({ type: 'node_recover', nodeId: node.nodeId, stage: 'REPLAY_WAL' }, (result, error) => {
          state.recoveryPending = false;
          if (error || result?.status !== 0) {
            state.recoveryAutoRun = false;
            setRouteOutcome(`Live WAL replay failed: ${error || result?.payload || 'node returned an error'}.`);
          } else {
            state.recoveryReplayedCount = node.walRecordCount;
            state.recoveryStep = 5;
            setRouteOutcome(`Data Node ${node.nodeId} rebuilt its in-memory cache by replaying ${node.walFile} (${node.walRecordCount} records).`);
            if (state.recoveryAutoRun) stepWalRecovery();
          }
          renderWalRecoveryView();
          renderCacheEngineView();
          renderClusterNodeCards();
        });
      } else {
        state.recoveryReplayedCount = 1;
        node.replayWalUpTo(state.recoveryReplayedCount);
      }
    } else if (state.recoveryStep === 4) {
      if (!state.liveMode && state.recoveryReplayedCount < node.walRecords.length) {
        state.recoveryReplayedCount += 1;
        node.replayWalUpTo(state.recoveryReplayedCount);
      } else if (!state.liveMode) {
        state.recoveryStep = 5; // Step 5: Show Reconstructed Cache
      }
    } else if (state.recoveryStep === 5) {
      state.recoveryStep = 6; // Step 6: Mark Recovery Complete
      state.recoveryAutoRun = false;
    }

    renderWalRecoveryView();
    renderCacheEngineView();
    renderClusterNodeCards();
  }

  function runFullWalRecoverySequence() {
    if (state.recoveryTimer) {
      clearInterval(state.recoveryTimer);
      state.recoveryTimer = null;
    }

    const node = state.nodes[state.walSelectedNode];
    if (!state.liveMode && node.walRecords.length === 0) {
      node.put('acct:301', 'bal=4500', false);
      node.put('acct:302', 'bal=9200', false);
      node.put('acct:301', 'bal=5100', false);
    }

    state.recoveryStep = 1;
    renderWalRecoveryView();

    if (state.liveMode) {
      state.recoveryAutoRun = true;
      stepWalRecovery();
      stepWalRecovery();
      return;
    }

    if (state.reducedMotion) {
      node.replayWalUpTo(node.walRecords.length);
      state.recoveryReplayedCount = node.walRecords.length;
      state.recoveryStep = 6;
      renderWalRecoveryView();
      renderCacheEngineView();
      renderClusterNodeCards();
      return;
    }

    state.recoveryTimer = setInterval(() => {
      if (state.recoveryStep < 6) {
        stepWalRecovery();
      } else {
        clearInterval(state.recoveryTimer);
        state.recoveryTimer = null;
      }
    }, 550);
  }

  // ==========================================================================
  // 10. PERFORMANCE LAB (PYTHON LOAD TESTER + MONOCHROME SVG CHARTS)
  // ==========================================================================
  function generateDeterministicIllustrativeReport(targetMode, workers, totalReqs, getPct, putPct, delPct) {
    // Uses actual MurmurHash3 key routing across the 300-vnode ring for authentic per-node distribution
    const nodeDist = { node_1: 0, node_2: 0, node_3: 0 };
    const singleNodeNum =
      targetMode === 'node_1' ? 1 : targetMode === 'node_2' ? 2 : targetMode === 'node_3' ? 3 : 0;

    for (let i = 0; i < totalReqs; i++) {
      if (singleNodeNum > 0) {
        nodeDist[`node_${singleNodeNum}`]++;
      } else {
        const r = hashRing.route(`bench_key:${i % 500}`);
        nodeDist[`node_${r.physical.nodeId}`]++;
      }
    }

    const isCoordinator = targetMode === 'coordinator';
    const mutationRatio = (putPct + delPct) / 100.0;

    // Illustrative model reflecting extra TCP hop for Coordinator vs direct Data Node
    const baseP50 = isCoordinator
      ? 0.42 + mutationRatio * 0.35 + (workers / 50) * 0.18
      : 0.24 + mutationRatio * 0.28 + (workers / 50) * 0.12;
    const baseP99 = isCoordinator
      ? baseP50 * 2.85 + mutationRatio * 0.65
      : baseP50 * 2.45 + mutationRatio * 0.45;
    const baseThroughput = isCoordinator
      ? Math.round(14500 / (1 + mutationRatio * 0.55))
      : Math.round(19200 / (1 + mutationRatio * 0.5));

    const series = [];
    for (let b = 1; b <= 10; b++) {
      const wave = Math.sin(b * 0.8) * 0.06;
      series.push({
        bucket: b,
        ops_per_sec: Math.round(baseThroughput * (1 + wave)),
        p50_ms: Number((baseP50 * (1 - wave * 0.5)).toFixed(3)),
        p99_ms: Number((baseP99 * (1 + Math.abs(wave))).toFixed(3)),
      });
    }

    return {
      source: 'illustrative_simulation',
      provenanceLabel: 'ILLUSTRATIVE DATA (SIMULATED)',
      target_mode: targetMode,
      endpoint: isCoordinator ? '127.0.0.1:8000' : `127.0.0.1:800${singleNodeNum}`,
      config: {
        total_requests: totalReqs,
        workers,
        get_pct: getPct,
        put_pct: putPct,
        delete_pct: delPct,
      },
      metrics: {
        total_requests: totalReqs,
        successful_ops: null,
        failed_ops: null,
        throughput_ops_sec: baseThroughput,
        p50_latency_ms: Number(baseP50.toFixed(3)),
        p90_latency_ms: Number((baseP50 * 1.75).toFixed(3)),
        p95_latency_ms: Number((baseP50 * 2.15).toFixed(3)),
        p99_latency_ms: Number(baseP99.toFixed(3)),
      },
      node_distribution: nodeDist,
      series,
    };
  }

  function applyBenchmarkReport(report, provenanceText) {
    validateBenchmarkReport(report);
    const label =
      provenanceText ||
      (report.source === 'measured_python_load_tester'
        ? 'MEASURED EXECUTION DATA (PYTHON LOAD TESTER)'
        : 'ILLUSTRATIVE DATA (SIMULATED)');

    report.provenanceLabel = label;

    if (report.target_mode === 'coordinator') {
      state.perfReports.coordinator = report;
    } else {
      state.perfReports.single_node = report;
    }

    state.productReport = report;
    renderPerformanceLab();
    renderProductPerformance();
  }

  function validateBenchmarkReport(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error('Expected a benchmark report object.');
    }
    if (!['coordinator', 'node_1', 'node_2', 'node_3'].includes(report.target_mode)) {
      throw new Error('Unknown benchmark target.');
    }
    if (typeof report.endpoint !== 'string' || !report.endpoint.trim()) {
      throw new Error('Missing benchmark endpoint.');
    }
    const config = report.config;
    const metrics = report.metrics;
    if (!config || !metrics || typeof config !== 'object' || typeof metrics !== 'object') {
      throw new Error('Missing config or metrics object.');
    }
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const workers = Number(config.workers);
    if (!Number.isInteger(workers) || workers < 1 || workers > 200) {
      throw new Error('Worker count must be an integer from 1 to 200.');
    }
    const mix = [config.get_pct, config.put_pct, config.delete_pct].map(Number);
    if (!mix.every((value) => Number.isFinite(value) && value >= 0 && value <= 100) || Math.abs(mix.reduce((sum, value) => sum + value, 0) - 100) > 0.01) {
      throw new Error('Workload percentages must be valid and sum to 100.');
    }
    for (const key of ['total_requests', 'throughput_ops_sec', 'p50_latency_ms', 'p90_latency_ms', 'p95_latency_ms', 'p99_latency_ms']) {
      if (!finite(Number(metrics[key]))) throw new Error(`Invalid metric: ${key}.`);
    }
    if (metrics.successful_ops != null && !finite(Number(metrics.successful_ops))) {
      throw new Error('Invalid metric: successful_ops.');
    }
    if (metrics.failed_ops != null && !finite(Number(metrics.failed_ops))) {
      throw new Error('Invalid metric: failed_ops.');
    }
    if (report.source !== 'illustrative_simulation') {
      if (metrics.successful_ops == null || metrics.failed_ops == null) {
        throw new Error('Measured/imported reports must include successful_ops and failed_ops.');
      }
      if (Number(metrics.successful_ops) + Number(metrics.failed_ops) !== Number(metrics.total_requests)) {
        throw new Error('Successful plus failed operations must equal total_requests.');
      }
    }
    const distribution = report.node_distribution;
    if (!distribution || !['node_1', 'node_2', 'node_3'].every((key) => finite(Number(distribution[key])))) {
      throw new Error('Invalid per-node distribution.');
    }
    if (!Array.isArray(report.series) || report.series.length === 0 || report.series.some((point) =>
      !point || !Number.isInteger(Number(point.bucket)) || !['ops_per_sec', 'p50_ms', 'p99_ms'].every((key) => finite(Number(point[key])))
    )) {
      throw new Error('Benchmark series is missing or invalid.');
    }
    return report;
  }

  function renderPerformanceLineChart(report) {
    const svg = document.getElementById('perfLineChartSvg');
    if (!svg || !report || !report.series || report.series.length === 0) return;
    svg.setAttribute('aria-label', `${report.provenanceLabel}: throughput in operations per second and P50/P99 latency in milliseconds across benchmark windows.`);

    const series = report.series;
    const W = 560;
    const H = 250;
    const padL = 54;
    const padR = 52;
    const padT = 28;
    const padB = 38;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxOps = Math.max(...series.map((s) => s.ops_per_sec), 100) * 1.15;
    const maxLat = Math.max(...series.map((s) => s.p99_ms), 0.5) * 1.2;

    const xAt = (idx) => padL + (idx / Math.max(1, series.length - 1)) * plotW;
    const yOps = (val) => padT + plotH - (val / maxOps) * plotH;
    const yLat = (val) => padT + plotH - (val / maxLat) * plotH;

    let out = [];

    // Grid lines (thin monochrome)
    for (let g = 0; g <= 4; g++) {
      const y = padT + (g / 4) * plotH;
      const opsVal = Math.round(maxOps * (1 - g / 4));
      const latVal = (maxLat * (1 - g / 4)).toFixed(2);
      out.push(`
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
              stroke="var(--line)" stroke-width="${g === 4 ? '1.5' : '0.4'}" ${g < 4 ? 'stroke-dasharray="2,3"' : ''} />
        <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9">${opsVal}</text>
        <text x="${W - padR + 6}" y="${(y + 3).toFixed(1)}" text-anchor="start" font-family="JetBrains Mono, monospace" font-size="9">${latVal}ms</text>
      `);
    }

    // Axes & Legend
    out.push(`
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--line)" stroke-width="1.2" />
      <line x1="${W - padR}" y1="${padT}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--line)" stroke-width="1.2" />
      <text x="${padL}" y="15" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">── THROUGHPUT (ops/s)</text>
      <text x="${padL + 165}" y="15" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">- - P99 LATENCY (ms)</text>
      <text x="${padL + 320}" y="15" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">··· P50 LATENCY (ms)</text>
    `);

    const opsPoints = series.map((s, i) => `${xAt(i).toFixed(1)},${yOps(s.ops_per_sec).toFixed(1)}`).join(' ');
    const p99Points = series.map((s, i) => `${xAt(i).toFixed(1)},${yLat(s.p99_ms).toFixed(1)}`).join(' ');
    const p50Points = series.map((s, i) => `${xAt(i).toFixed(1)},${yLat(s.p50_ms).toFixed(1)}`).join(' ');

    out.push(`
      <polyline points="${opsPoints}" fill="none" stroke="var(--purple)" stroke-width="2" />
      <polyline points="${p99Points}" fill="none" stroke="var(--node-3)" stroke-width="1.5" stroke-dasharray="5,3" />
      <polyline points="${p50Points}" fill="none" stroke="var(--node-2)" stroke-width="1.5" stroke-dasharray="2,2" />
    `);

    series.forEach((s, i) => {
      const cx = xAt(i);
      const cyOps = yOps(s.ops_per_sec);
      const cyP99 = yLat(s.p99_ms);
      out.push(`
        <circle cx="${cx.toFixed(1)}" cy="${cyOps.toFixed(1)}" r="3" fill="var(--purple)" />
        <rect x="${(cx - 2.5).toFixed(1)}" y="${(cyP99 - 2.5).toFixed(1)}" width="5" height="5" fill="var(--surface)" stroke="var(--node-3)" stroke-width="1.5" />
        <text x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9">W${s.bucket}</text>
      `);
    });

    svg.innerHTML = out.join('');
  }

  function renderPerformanceBarChart(report) {
    const svg = document.getElementById('perfBarChartSvg');
    if (!svg || !report) return;
    svg.setAttribute('aria-label', `${report.provenanceLabel}: request distribution by node and latency percentiles in milliseconds.`);

    const W = 560;
    const H = 250;
    const nd = report.node_distribution || { node_1: 0, node_2: 0, node_3: 0 };
    const m = report.metrics;

    const totalNodeReqs = Math.max(1, (nd.node_1 || 0) + (nd.node_2 || 0) + (nd.node_3 || 0));
    const n1Pct = (((nd.node_1 || 0) / totalNodeReqs) * 100).toFixed(1);
    const n2Pct = (((nd.node_2 || 0) / totalNodeReqs) * 100).toFixed(1);
    const n3Pct = (((nd.node_3 || 0) / totalNodeReqs) * 100).toFixed(1);

    const maxNodeCount = Math.max(nd.node_1 || 0, nd.node_2 || 0, nd.node_3 || 0, 10) * 1.2;

    const p50 = m.p50_latency_ms ?? 0;
    const p90 = m.p90_latency_ms;
    const p95 = m.p95_latency_ms;
    const p99 = m.p99_latency_ms;
    const maxPctLat = Math.max(p99, 0.5) * 1.25;

    let out = [];

    // Left Half: Per-Node Request Distribution Bars
    out.push(`
      <text x="20" y="18" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">A. PER-NODE REQUEST DISTRIBUTION</text>
      <line x1="20" y1="210" x2="255" y2="210" stroke="var(--line)" stroke-width="1.5" />
    `);

    const nodeBars = [
      { label: 'Node 1 (:8001)', count: nd.node_1 || 0, pct: n1Pct, fill: 'var(--node-1)' },
      { label: 'Node 2 (:8002)', count: nd.node_2 || 0, pct: n2Pct, fill: 'var(--node-2)' },
      { label: 'Node 3 (:8003)', count: nd.node_3 || 0, pct: n3Pct, fill: 'var(--node-3)' },
    ];

    nodeBars.forEach((b, idx) => {
      const bx = 34 + idx * 74;
      const bh = Math.max(4, (b.count / maxNodeCount) * 155);
      const by = 210 - bh;
      out.push(`
        <rect x="${bx}" y="${by.toFixed(1)}" width="46" height="${bh.toFixed(1)}" fill="${b.fill}" stroke="var(--line)" stroke-width="1.5" />
        <text x="${bx + 23}" y="${(by - 14).toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">${b.count}</text>
        <text x="${bx + 23}" y="${(by - 4).toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="8">(${b.pct}%)</text>
        <text x="${bx + 23}" y="226" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9">${b.label.split(' ')[0]} ${b.label.split(' ')[1]}</text>
      `);
    });

    // Divider between subcharts
    out.push(`<line x1="275" y1="10" x2="275" y2="235" stroke="var(--line)" stroke-width="0.7" stroke-dasharray="3,3" />`);

    // Right Half: Latency Percentile Bars (P50, P90, P95, P99)
    out.push(`
      <text x="295" y="18" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">B. LATENCY PERCENTILES (ms)</text>
      <line x1="295" y1="210" x2="545" y2="210" stroke="var(--line)" stroke-width="1.5" />
    `);

    const latBars = [
      { label: 'P50', val: p50 },
      { label: 'P90', val: p90 },
      { label: 'P95', val: p95 },
      { label: 'P99', val: p99 },
    ];

    latBars.forEach((lb, idx) => {
      const bx = 308 + idx * 58;
      const bh = Math.max(4, (lb.val / maxPctLat) * 155);
      const by = 210 - bh;
      const isTail = lb.label === 'P50' || lb.label === 'P99';
      out.push(`
        <rect x="${bx}" y="${by.toFixed(1)}" width="38" height="${bh.toFixed(1)}"
              fill="${isTail ? 'var(--purple)' : 'var(--surface-soft)'}" stroke="var(--line)" stroke-width="1.5" />
        <text x="${bx + 19}" y="${(by - 6).toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">${lb.val}ms</text>
        <text x="${bx + 19}" y="226" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="${isTail ? '700' : '400'}">${lb.label}</text>
      `);
    });

    svg.innerHTML = out.join('');
  }

  function renderPerformanceLab() {
    const activeReport =
      state.perfViewMode === 'coordinator'
        ? state.perfReports.coordinator
        : state.perfReports.single_node;

    if (!activeReport) return;

    const m = activeReport.metrics;
    const cfg = activeReport.config;

    document.getElementById('perfProvenanceBanner').innerHTML =
      `DATA SOURCE: <strong>${escapeHtml(activeReport.provenanceLabel)}</strong> · TARGET: <code>${escapeHtml(activeReport.endpoint)}</code>`;
    document.getElementById('chart51SourceTag').textContent = activeReport.provenanceLabel;
    document.getElementById('chart52SourceTag').textContent = activeReport.provenanceLabel;

    document.getElementById('perfMetricTotal').textContent = Number(m.total_requests).toLocaleString();
    document.getElementById('perfMetricMixSub').textContent =
      `GET ${cfg.get_pct}% · PUT ${cfg.put_pct}% · DEL ${cfg.delete_pct}%`;
    document.getElementById('perfMetricSuccess').textContent = m.successful_ops == null ? 'Not measured' : Number(m.successful_ops).toLocaleString();
    document.getElementById('perfMetricFailed').textContent = m.failed_ops == null ? 'Not measured' : Number(m.failed_ops).toLocaleString();
    document.getElementById('perfMetricThroughput').textContent = `${Number(m.throughput_ops_sec).toLocaleString()} ops/s`;
    document.getElementById('perfMetricWorkersSub').textContent = `${cfg.workers} concurrent workers`;
    document.getElementById('perfMetricP50').textContent = `${m.p50_latency_ms} ms`;
    document.getElementById('perfMetricP99').textContent = `${m.p99_latency_ms} ms`;
    setRouteOutcome(`${activeReport.provenanceLabel} · ${activeReport.endpoint} · ${m.total_requests} requests · ${m.throughput_ops_sec} ops/s · P50 ${m.p50_latency_ms} ms · P99 ${m.p99_latency_ms} ms.`);

    renderPerformanceLineChart(activeReport);
    renderPerformanceBarChart(activeReport);

    // Populate Comparison Table (Individual Data Node vs Full Coordinator-Routed System)
    const compBody = document.getElementById('perfComparisonTableBody');
    const rows = [state.perfReports.coordinator, state.perfReports.single_node].filter(Boolean);
    compBody.innerHTML = rows
      .map((rep) => {
        const isCurrent =
          (state.perfViewMode === 'coordinator' && rep.target_mode === 'coordinator') ||
          (state.perfViewMode === 'single_node' && rep.target_mode !== 'coordinator');
        const nd = rep.node_distribution || { node_1: 0, node_2: 0, node_3: 0 };
        const targetLabel =
          rep.target_mode === 'coordinator'
            ? `Full Coordinator-Routed System (${rep.endpoint})`
            : `Individual Data Node (${rep.endpoint})`;
        return `
          <tr class="${isCurrent ? 'active-row' : ''}">
            <td><strong>${escapeHtml(targetLabel)}</strong></td>
            <td class="mono">${escapeHtml(rep.provenanceLabel)}</td>
            <td class="mono">${rep.config.workers} threads</td>
            <td class="mono">${rep.config.get_pct}% / ${rep.config.put_pct}% / ${rep.config.delete_pct}%</td>
            <td class="mono">${Number(rep.metrics.total_requests).toLocaleString()}</td>
            <td class="mono">${rep.metrics.successful_ops == null ? 'Not measured' : Number(rep.metrics.successful_ops).toLocaleString()} / ${rep.metrics.failed_ops == null ? 'Not measured' : Number(rep.metrics.failed_ops).toLocaleString()}</td>
            <td class="mono"><strong>${Number(rep.metrics.throughput_ops_sec).toLocaleString()} ops/s</strong></td>
            <td class="mono">${rep.metrics.p50_latency_ms} ms</td>
            <td class="mono">${rep.metrics.p99_latency_ms} ms</td>
            <td class="mono">${nd.node_1} / ${nd.node_2} / ${nd.node_3}</td>
          </tr>
        `;
      })
      .join('');
  }

  function readAndValidatePerfControls() {
    const getPct = Number(document.getElementById('perfGetPct').value);
    const putPct = Number(document.getElementById('perfPutPct').value);
    const delPct = Number(document.getElementById('perfDelPct').value);
    const workers = Number(document.getElementById('perfWorkersInput').value);
    const totalReqs = Number(document.getElementById('perfTotalReqsInput').value);
    const banner = document.getElementById('perfValidationMsg');

    const sum = Math.round((getPct + putPct + delPct) * 100) / 100;
    if (sum !== 100) {
      banner.hidden = false;
      banner.textContent = `WORKLOAD VALIDATION: GET (${getPct}%) + PUT (${putPct}%) + DELETE (${delPct}%) = ${sum}%. Percentages must sum to 100%.`;
      return null;
    }
    if (!Number.isInteger(workers) || workers < 1 || workers > 200) {
      banner.hidden = false;
      banner.textContent = 'WORKERS VALIDATION: Enter an integer from 1 to 200 concurrent worker threads.';
      return null;
    }
    if (!Number.isInteger(totalReqs) || totalReqs < 100 || totalReqs > 20000) {
      banner.hidden = false;
      banner.textContent = 'REQUEST VALIDATION: Enter an integer from 100 to 20,000 requests.';
      return null;
    }
    if (![getPct, putPct, delPct].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
      banner.hidden = false;
      banner.textContent = 'WORKLOAD VALIDATION: Each percentage must be between 0 and 100.';
      return null;
    }
    banner.hidden = true;

    const targetMode =
      state.perfViewMode === 'coordinator'
        ? 'coordinator'
        : document.getElementById('perfSingleNodeSelect').value;

    return { targetMode, getPct, putPct, delPct, workers, totalReqs };
  }

  function productStatus(plan) {
    const code = plan.statusHex.match(/0x([0-9A-F]{2})/i);
    return code ? Number.parseInt(code[1], 16) : null;
  }

  function pauseLearningAnimation() {
    if (learning.timer) {
      clearInterval(learning.timer);
      learning.timer = null;
    }
    const pauseButton = document.getElementById('learningPauseBtn');
    if (pauseButton) pauseButton.disabled = true;
  }

  function tourResultSummary(result) {
    if (result.status === 2 || result.status == null) return `Request failed: ${result.outcome}`;
    if (result.op === 'PUT' && result.status === 0) return `Value stored on Data Node ${result.nodeId}.`;
    if (result.op === 'GET' && result.status === 0) {
      const value = result.response?.payload ?? result.outcome.match(/CACHE HIT: Value="([^"]*)"/)?.[1];
      return value == null ? `Value found on Data Node ${result.nodeId}.` : `Value found: ${value}`;
    }
    if (result.op === 'GET') return `Key not found on Data Node ${result.nodeId}; this is a cache miss.`;
    if (result.op === 'DELETE' && result.status === 0) return `Key deleted from Data Node ${result.nodeId}.`;
    if (result.op === 'DELETE') return `Key not found on Data Node ${result.nodeId}; the DELETE was recorded.`;
    return result.outcome;
  }

  function renderTour() {
    const panel = document.getElementById('interactiveTour');
    if (!panel) return;
    panel.hidden = !tour.active;
    if (!tour.active) return;

    const stepIndex = Math.min(tour.step, tourSteps.length - 1);
    const step = tourSteps[stepIndex];
    const isComplete = tour.completed === tourSteps.length && stepIndex === tourSteps.length - 1;
    const result = tour.results[stepIndex] || (stepIndex === tour.completed ? tour.attempt : null);
    document.getElementById('tourProgress').textContent =
      isComplete ? 'GUIDED TOUR · COMPLETE' : `GUIDED TOUR · STEP ${stepIndex + 1} OF ${tourSteps.length}`;
    document.getElementById('tourTitle').textContent = isComplete ? 'You have completed the tour' : step.title;
    document.getElementById('tourInstruction').textContent = isComplete
      ? 'You stored, retrieved, deleted, and then missed the same key. Try another key or explore How it works.'
      : step.instruction;
    document.getElementById('tourExpected').textContent = step.expected;
    document.getElementById('tourObserved').textContent = result
      ? `${result.executionMode === 'live C++ response' ? 'Live result' : 'Simulated result'}: ${tourResultSummary(result)}${result.status === step.status ? '' : ` (status ${result.statusHex || 'ERROR'}; this step is not complete)`}`
      : tour.completed > stepIndex
      ? 'This step is complete.'
      : 'No request has run for this step yet.';
    const busy = Boolean(state.arch.running || state.arch.activePlan?.pending);
    document.getElementById('tourPreviousBtn').disabled = busy || stepIndex === 0;
    document.getElementById('tourNextBtn').disabled = busy || tour.completed <= stepIndex || stepIndex >= tourSteps.length - 1;
    document.getElementById('tourRunStepBtn').hidden = tour.completed > stepIndex;
    document.getElementById('tourRunStepBtn').textContent = `Run ${step.op}`;
    document.getElementById('tourRunStepBtn').disabled = busy || tour.completed > stepIndex;
    document.getElementById('tourSkipBtn').disabled = busy;
    document.getElementById('tourFinishBtn').hidden = !isComplete;
    document.getElementById('tourFinishBtn').disabled = busy;
  }

  function renderLearningAnimation() {
    const scene = document.getElementById('learningScene');
    if (!scene) return;
    const key = document.getElementById('demoKey')?.value.trim() || state.arch.key;
    const route = hashRing.route(key);
    const routeNode = route.physical.nodeId;
    const nodeId = learning.crashedNodeId || routeNode;
    const node = state.nodes[nodeId];
    const cacheSize = state.liveMode ? Number(node.reportedSize || 0) : node.entries.length;
    const roles = [...scene.querySelectorAll('[data-learning-role]')];
    const links = [...scene.querySelectorAll('[data-learning-link]')];
    const caption = document.getElementById('learningCaption');
    const visualState = document.getElementById('learningState');
    const source = state.liveMode ? 'LIVE C++ SNAPSHOT' : 'BROWSER SIMULATION';
    document.getElementById('learningSource').textContent = source;
    document.getElementById('learningRecoveryControls').hidden = learning.mode !== 'wal';
    document.getElementById('learningRecoveryStatus').textContent = learning.recoveryMessage;
    document.getElementById('simulateCrashBtn').disabled = state.liveMode || learning.crashedNodeId !== null;
    document.getElementById('simulateRecoveryBtn').disabled = state.liveMode || learning.crashedNodeId === null;
    document.getElementById('learningNodeLabel').textContent = `Data Node ${nodeId}`;
    document.getElementById('learningNodeDetail').textContent = state.liveMode
      ? `${cacheSize} cache entries`
      : `${cacheSize}/${node.capacity} cache entries`;

    roles.forEach((element) => {
      element.classList.remove('is-active', 'is-complete');
    });
    links.forEach((element) => {
      element.classList.remove('is-active', 'is-complete');
      element.textContent = learning.mode === 'route' && learning.step === 4 ? '←' : '→';
    });
    visualState.replaceChildren();

    if (learning.mode === 'route') {
      const responseReturning = learning.step === 4;
      const labels = [
        ['Your app', responseReturning ? 'Receives response' : 'Sends request'],
        ['Coordinator', responseReturning ? 'Returns response' : 'Hashes the key'],
        ['Hash ring', `${route.successor.label}${route.wrapped ? ' · wraps' : ''}`],
        [`Data Node ${routeNode}`, responseReturning ? 'Sends result' : 'Handles the request'],
      ];
      roles.forEach((element, index) => {
        element.querySelector('strong').textContent = labels[index][0];
        element.querySelector('span').textContent = labels[index][1];
        if (responseReturning) {
          element.classList.add(index < 2 ? 'is-active' : 'is-complete');
        } else if (learning.step >= index) {
          element.classList.add(learning.step === index ? 'is-active' : 'is-complete');
        }
      });
      links.forEach((element, index) => {
        if (responseReturning) element.classList.add('is-active');
        else if (learning.step > index) element.classList.add('is-complete');
        else if (learning.step === index) element.classList.add('is-active');
      });
      const stage = learning.step < 0
        ? 'Ready to trace the request.'
        : [
          'The client sends the selected operation and key.',
          `The coordinator hashes “${key}” with the system hash algorithm.`,
          `The key hash ${toHex32(route.keyHash)} selects the next clockwise virtual node, ${route.successor.label}.`,
          `Data Node ${routeNode} handles the request.`,
          `The response travels back through the coordinator to your app.`,
        ][learning.step];
      caption.textContent = `${stage} Route is computed from the current key and the real demo ring.`;
      visualState.textContent = `${key} · ${toHex32(route.keyHash)} → ${route.successor.label} → Data Node ${routeNode}`;
    } else if (learning.mode === 'lru') {
      roles.forEach((element, index) => {
        const labels = [
          ['Recent request', 'Uses the selected key'],
          ['Coordinator', 'Selects one node'],
          ['LRU order', 'MRU → LRU'],
          [`Data Node ${nodeId}`, `${cacheSize}/${node.capacity} entries`],
        ];
        element.querySelector('strong').textContent = labels[index][0];
        element.querySelector('span').textContent = labels[index][1];
        if (index === 3) element.classList.add('is-active');
        else if (learning.step >= index) element.classList.add(learning.step === index ? 'is-active' : 'is-complete');
      });
      const event = state.arch.productHistory.find((item) => item.nodeId === nodeId);
      let messages = [
        'No cache operation has run yet. Use Playground to create an actual cache event.',
        `The selected node currently has ${cacheSize} of ${node.capacity} entries.`,
        'A successful GET promotes the found key; a full-cache PUT can evict the LRU entry.',
        'The list below is the selected node’s actual cache order, most recent first.',
      ];
      if (event?.op === 'GET' && event.status === 0) {
        messages = [
          `GET for “${event.key}” reaches Data Node ${nodeId}.`,
          `The actual lookup found “${event.key}”.`,
          `The successful GET promoted “${event.key}” to MRU.`,
          'The list below is the node’s actual current order.',
        ];
      } else if (event?.op === 'PUT' && event.status === 0) {
        const evicted = event.outcome.match(/Evicted LRU Tail "([^"]+)"/);
        messages = evicted
          ? [
            `PUT for “${event.key}” reached a full cache on Data Node ${nodeId}.`,
            'The new entry was inserted at the MRU end.',
            `The actual LRU entry “${evicted[1]}” was evicted.`,
            'The list below is the resulting actual cache order.',
          ]
          : [
            `PUT for “${event.key}” reached Data Node ${nodeId}.`,
            'No capacity eviction was reported for this insertion.',
            `The actual cache contains “${event.key}”.`,
            'The list below is the resulting actual cache order.',
          ];
      } else if (event?.op === 'GET') {
        messages = [
          `GET for “${event.key}” reached Data Node ${nodeId}.`,
          'The actual lookup returned not found.',
          'A cache miss does not promote an entry or change the LRU order.',
          'The list below is the node’s actual current order.',
        ];
      } else if (event?.op === 'DELETE') {
        messages = event.status === 0
          ? [
            `DELETE for “${event.key}” reached Data Node ${nodeId}.`,
            'The node recorded the mutation before changing memory.',
            `“${event.key}” was removed from the cache.`,
            'The list below is the remaining actual cache order.',
          ]
          : [
            `DELETE for “${event.key}” reached Data Node ${nodeId}.`,
            'The node recorded the DELETE; the key was already absent.',
            'The cache order is unchanged.',
            'The list below is the node’s actual current order.',
          ];
      }
      caption.textContent = `${messages[Math.max(0, learning.step)]} Step controls explain the observed state; they do not mutate the cache.`;
      const lruEntries = node.entries.slice(0, 6);
      visualState.innerHTML = lruEntries.length
        ? `MRU → LRU${state.liveMode && cacheSize > lruEntries.length ? ` · first ${lruEntries.length} shown` : ''}<br>${lruEntries.map((entry, index) => `<span class="dc-learning-entry${index === 0 && learning.step >= 2 && event?.op === 'GET' && event.status === 0 ? ' is-promoted' : ''}">${index + 1}. ${escapeHtml(entry.key)}</span>`).join('')}${cacheSize > lruEntries.length ? `<span class="dc-learning-entry">… ${cacheSize - lruEntries.length} more</span>` : ''}`
        : cacheSize > 0
        ? `${cacheSize} entries are reported, but their keys are not in the available snapshot.`
        : 'The selected node’s cache is empty.';
    } else {
      const relevantEvent = state.arch.productHistory.find((item) =>
        item.nodeId === nodeId && (item.op === 'PUT' || item.op === 'DELETE'),
      );
      const record = relevantEvent && [...node.walRecords].reverse().find((item) =>
        item.op === relevantEvent.op && item.key === relevantEvent.key,
      );
      const steps = record ? [
        `The node receives ${record.op} for “${record.key}”.`,
        `It appends WAL record #${record.seq} and flushes the C++ output stream.`,
        record.op === 'PUT'
          ? 'After the log append succeeds, the node updates its in-memory LRU cache.'
          : relevantEvent.status === 0
          ? 'After the log append succeeds, the node removes the key from memory.'
          : 'The DELETE record is logged; the key was absent, so memory stays unchanged.',
        relevantEvent.status === 0 ? 'The node returns success to the coordinator.' : 'The node returns NOT_FOUND to the coordinator.',
      ] : [
        'A PUT or DELETE reaches its data node.',
        'The node appends a record and flushes its C++ stream (not fsync).',
        'The node applies the mutation to its in-memory cache.',
        'The node acknowledges the actual operation result.',
      ];
      const labels = [
        ['Mutation', 'PUT or DELETE'],
        ['Local WAL', record ? `Record #${record.seq}` : 'Append + stream flush'],
        ['Cache memory', 'In-memory LRU'],
        ['Response', 'Result returned'],
      ];
      roles.forEach((element, index) => {
        element.querySelector('strong').textContent = labels[index][0];
        element.querySelector('span').textContent = labels[index][1];
        if (learning.step >= index) element.classList.add(learning.step === index ? 'is-active' : 'is-complete');
      });
      caption.textContent = record
        ? `${steps[Math.max(0, learning.step)]} Stream flush is not an fsync power-loss guarantee.`
        : `The list below shows actual local log records. ${steps[Math.max(0, learning.step)]}`;
      const walSize = state.liveMode ? Number(node.walRecordCount || 0) : node.walRecords.length;
      visualState.innerHTML = node.walRecords.length
        ? `LOCAL LOG · ${walSize} record${walSize === 1 ? '' : 's'}<br>${node.walRecords.slice(-4).reverse().map((item) => `<span class="dc-learning-entry">#${item.seq} ${escapeHtml(item.op)} ${escapeHtml(item.key)}</span>`).join('')}`
        : walSize > 0
        ? `LOCAL LOG · ${walSize} records · record details are not available in this snapshot.`
        : 'This selected node has no log records.';
    }

    const maxStep = learning.mode === 'route' ? 4 : 3;
    document.getElementById('learningProgress').textContent =
      learning.step < 0 ? 'Ready' : `Step ${learning.step + 1} of ${maxStep + 1}`;
    document.getElementById('learningRunBtn').disabled = learning.timer !== null;
    document.getElementById('learningStepBtn').disabled = learning.timer !== null || learning.step >= maxStep;
    document.getElementById('learningPauseBtn').disabled = learning.timer === null;
  }

  function advanceLearningAnimation() {
    const maxStep = learning.mode === 'route' ? 4 : 3;
    learning.step = Math.min(maxStep, learning.step + 1);
    renderLearningAnimation();
    if (learning.step >= maxStep) pauseLearningAnimation();
  }

  function startInteractiveTour() {
    if (state.arch.activePlan?.pending) return;
    navigateToRoute('/playground');
    if (!state.liveMode) document.getElementById('demoResetBtn').click();
    const keyInput = document.getElementById('demoKey');
    const valueInput = document.getElementById('demoValue');
    keyInput.value = 'session:4092';
    valueInput.value = 'user=8810';
    state.arch.key = keyInput.value;
    state.arch.val = valueInput.value;
    document.getElementById('archKeyInput').value = keyInput.value;
    document.getElementById('archValInput').value = valueInput.value;
    tour.active = true;
    tour.step = 0;
    tour.completed = 0;
    tour.key = keyInput.value;
    tour.results = [];
    tour.attempt = null;
    state.arch.op = tourSteps[0].op;
    resetArchFlow();
    state.arch.productLastResult = null;
    renderProductExperience();
    document.getElementById('tourRunStepBtn').focus();
  }

  function finishInteractiveTour(skipped) {
    tour.active = false;
    try {
      localStorage.setItem('discache-tour-state', skipped ? 'skipped' : 'finished');
    } catch (_) {}
    renderProductExperience();
  }

  function recordProductOperation(plan) {
    if (!plan || plan.productRecorded || plan.pending || !plan.executionOutcomeText) return;
    plan.productRecorded = true;
    const status = productStatus(plan);
    const result = {
      op: plan.op,
      key: plan.key,
      value: plan.val,
      nodeId: plan.response?.nodeId || plan.targetNodeId,
      expectedNodeId: plan.targetNodeId,
      status,
      statusHex: plan.statusHex,
      outcome: plan.executionOutcomeText,
      response: plan.response || null,
      routeMatches: plan.routeMatches,
      executionMode: plan.liveExecution ? 'live C++ response' : 'deterministic browser simulation',
    };
    state.arch.productLastResult = result;
    state.arch.productHistory.unshift(result);
    state.arch.productHistory = state.arch.productHistory.slice(0, 6);

    const expected = ['PUT', 'GET', 'DELETE', 'GET'][state.arch.productSequenceIndex];
    const expectedStatus = [0, 0, 0, 1][state.arch.productSequenceIndex];
    const sampleKey = document.getElementById('demoKey').value.trim();
    if (state.arch.productSequenceIndex < 4 && result.routeMatches !== false && plan.key === sampleKey && plan.op === expected && status === expectedStatus) {
      state.arch.productSequenceIndex++;
    }
    if (tour.active && tour.completed < tourSteps.length) {
      const tourStep = tourSteps[tour.completed];
      if (plan.key === tour.key && plan.op === tourStep.op) tour.attempt = result;
      if (result.routeMatches !== false && plan.key === tour.key && plan.op === tourStep.op && status === tourStep.status) {
        tour.results[tour.completed] = result;
        tour.attempt = null;
        tour.completed++;
        tour.step = Math.min(tour.completed, tourSteps.length - 1);
      }
    }
    renderProductExperience();
  }

  function renderProductHashRing(route) {
    const svg = document.getElementById('productHashRing');
    if (!svg || !route) return;
    const cx = 120;
    const cy = 80;
    const radius = 48;
    const point = (hash, r) => polarToXY(cx, cy, r, hashToAngleRad(hash));
    const marks = hashRing.vnodes.map((vnode) => {
      const inner = point(vnode.hashPos, radius - 2);
      const outer = point(vnode.hashPos, radius + 2);
      const color = vnode.nodeId === 1 ? 'var(--dc-node-1)' : vnode.nodeId === 2 ? 'var(--dc-node-2)' : 'var(--dc-node-3)';
      return `<line x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" stroke="${color}" stroke-width="1"/>`;
    });
    const keyPoint = point(route.keyHash, radius);
    const vnodePoint = point(route.successor.hashPos, radius);
    const keyPath = describeClockwiseArc(cx, cy, radius + 8, route.keyHash, route.successor.hashPos);
    svg.innerHTML = `
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--dc-border-strong)" stroke-width="1"/>
      ${marks.join('')}
      <path d="${keyPath}" fill="none" stroke="var(--dc-purple)" stroke-width="1.5" stroke-dasharray="3 2"/>
      <circle cx="${keyPoint.x.toFixed(1)}" cy="${keyPoint.y.toFixed(1)}" r="3.5" fill="var(--dc-purple)"/>
      <circle cx="${vnodePoint.x.toFixed(1)}" cy="${vnodePoint.y.toFixed(1)}" r="4" fill="var(--dc-surface)" stroke="var(--dc-purple)" stroke-width="2"/>
      <text x="${cx}" y="${cy - 5}" text-anchor="middle" fill="var(--dc-text)" font-size="8" font-family="var(--dc-mono)">KEY</text>
      <text x="${cx}" y="${cy + 8}" text-anchor="middle" fill="var(--dc-muted)" font-size="7" font-family="var(--dc-mono)">${toHex32(route.keyHash)}</text>
      <text x="${cx}" y="154" text-anchor="middle" fill="var(--dc-muted)" font-size="8">clockwise → successor</text>
    `;
  }

  function renderProductExperience() {
    const keyInput = document.getElementById('demoKey');
    if (!keyInput) return;
    if (tour.active && !state.arch.activePlan?.pending) {
      state.arch.op = tourSteps[Math.min(tour.step, tourSteps.length - 1)].op;
      document.querySelectorAll('[data-demo-op]').forEach((button) => {
        const active = button.dataset.demoOp === state.arch.op;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    const key = keyInput.value.trim();
    const valueInput = document.getElementById('demoValue');
    const selectedRoute = key ? hashRing.route(key) : null;
    const activePlan = state.arch.activePlan;
    const plan = activePlan && state.arch.currentStage > 0 ? activePlan : null;
    const result = state.arch.productLastResult;
    const running = Boolean(plan && (plan.pending || (state.arch.currentStage < state.arch.maxStage && !result)));

    document.getElementById('demoModeLabel').textContent = state.liveMode ? 'LIVE C++ CLUSTER' : 'SIMULATED';
    document.getElementById('demoModePill').textContent = state.liveMode ? 'LIVE C++' : 'SIMULATED';
    document.getElementById('demoDataSource').textContent = state.liveMode ? 'Live C++ cluster snapshot' : 'Browser simulation';
    document.getElementById('demoSequenceProgress').textContent = `${state.arch.productSequenceIndex} / 4 complete`;
    document.getElementById('demoRunBtn').textContent = state.arch.running
      ? 'Pause'
      : plan && state.arch.currentStage < state.arch.maxStage
      ? 'Continue'
      : `Run ${state.arch.op}`;
    document.getElementById('demoRunBtn').disabled = Boolean(plan && plan.pending);
    document.getElementById('demoStepBtn').disabled = Boolean(plan && plan.pending);
    document.getElementById('demoResetBtn').disabled = Boolean(plan && plan.pending);
    document.getElementById('demoStageLabel').textContent = plan
      ? ['Preparing', 'Hashing key', 'Finding node', 'Routing request', 'Updating cache', 'Response returned'][Math.max(0, state.arch.currentStage - 1)]
      : 'Ready';
    const stage = plan ? state.arch.currentStage : 0;
    const visibleStage = stage === 0 ? 'Ready' : `${stage >= 6 ? 4 : stage < 3 ? stage : stage < 5 ? 2 : 3} / 4`;
    document.getElementById('demoStageCount').textContent = visibleStage;
    document.getElementById('demoKey').disabled = Boolean(plan && plan.pending);
    document.getElementById('demoValue').disabled = state.arch.op !== 'PUT' || Boolean(plan && plan.pending) || tour.active;
    document.querySelectorAll('[data-demo-op]').forEach((button) => {
      button.disabled = Boolean(plan && plan.pending) || tour.active;
    });
    document.getElementById('demoKey').disabled = Boolean(plan && plan.pending) || tour.active;
    document.getElementById('operationHelp').textContent = {
      PUT: 'PUT stores or replaces this value on the key’s assigned node. Requires a key and value.',
      GET: 'GET looks up a required key on its assigned node. A hit returns the value and makes it most recently used; a miss leaves the cache unchanged.',
      DELETE: 'DELETE removes a required key from its assigned node. The node logs the mutation before changing memory; a missing key returns not found.',
    }[state.arch.op];
    const activeSegments = stage === 0 ? 0 : stage >= 6 ? 4 : stage < 3 ? 1 : stage < 5 ? 2 : 3;
    document.querySelectorAll('#demoStageTrack i').forEach((segment, index) => {
      segment.classList.toggle('is-complete', index < activeSegments);
    });

    const activeNodeId = plan && stage >= 3 ? plan.targetNodeId : null;
    document.querySelectorAll('[data-node-id]').forEach((node) => {
      node.classList.toggle('is-active-path', activeNodeId !== null && Number(node.dataset.nodeId) === activeNodeId);
    });

    for (const nodeId of [1, 2, 3]) {
      const node = state.nodes[nodeId];
      const entries = node.entries.slice(0, 3);
      const preview = entries.length
        ? entries.map((entry) => `${escapeHtml(entry.key)} = ${escapeHtml(entry.value)}`).join(' · ')
        : 'Empty cache';
      document.getElementById(`demoNodeMeta${nodeId}`).textContent =
        `${state.liveMode ? Number(node.reportedSize || 0) : node.entries.length} entries`;
      document.getElementById(`demoNodeCache${nodeId}`).innerHTML = preview;
    }

    const currentOp = plan ? plan.op : state.arch.op;
    const currentKey = plan ? plan.key : key;
    document.getElementById('demoResultOperation').textContent = result && !running ? result.op : plan ? plan.op : '—';
    document.getElementById('demoResultKey').textContent = result && !running ? result.key : currentKey || '—';
    document.getElementById('demoResultNode').textContent = result && !running
      ? `Data Node ${result.nodeId}`
      : plan && stage >= 3
      ? `Data Node ${plan.targetNodeId}`
      : '—';

    let title = 'Ready when you are';
    let message = `Run PUT to store ${key ? `"${key}"` : 'a key'} on its assigned node.`;
    let change = 'No changes yet';
    let statusState = 'ready';
    let statusLabel = 'READY';
    let statusCode = null;
    let resultNode = selectedRoute && key ? `Data Node ${selectedRoute.physical.nodeId}` : '—';

    if (running && plan) {
      title = `Running ${plan.op}`;
      message = `Routing "${plan.key}" to Data Node ${plan.targetNodeId}…`;
      change = 'Request in progress';
      resultNode = `Data Node ${plan.targetNodeId}`;
      statusLabel = 'IN PROGRESS';
    } else if (result) {
      statusCode = result.status;
      resultNode = `Data Node ${result.nodeId}`;
      if (result.op === 'RECOVERY') {
        title = result.statusLabel;
        message = result.outcome;
        change = 'Local cache replayed';
        statusState = 'success';
        statusLabel = state.liveMode ? 'LIVE ACTION' : 'SIMULATED';
      } else if (result.status === 2 || result.status == null) {
        title = 'Request failed';
        message = result.outcome;
        change = 'No confirmed cache change';
        statusState = 'error';
        statusLabel = 'ERROR';
      } else if (result.op === 'PUT') {
        title = 'Value stored';
        message = `Stored "${result.key}" on Data Node ${result.nodeId}.`;
        const evicted = result.outcome.match(/Evicted LRU Tail "([^"]+)"/);
        change = evicted
          ? `WAL recorded · evicted ${evicted[1]}`
          : `WAL recorded · ${state.liveMode ? 'cache updated' : 'added to MRU'}`;
        statusState = 'success';
        statusLabel = 'STORED';
      } else if (result.op === 'GET' && result.status === 0) {
        title = 'Value found';
        const cached = state.nodes[result.nodeId].entryMap.get(result.key);
        const foundValue = result.response ? result.response.payload : cached?.value;
        message = foundValue == null ? `Value found for "${result.key}".` : `Value found: ${foundValue}`;
        change = 'Promoted to most recently used · no log write';
        statusState = 'success';
        statusLabel = 'FOUND';
      } else if (result.op === 'GET') {
        title = 'Key not found';
        message = `"${result.key}" is not in Data Node ${result.nodeId}'s cache.`;
        change = 'Cache unchanged · no log write';
        statusState = 'ready';
        statusLabel = 'CACHE MISS';
      } else if (result.op === 'DELETE' && result.status === 0) {
        title = 'Key deleted';
        message = `Removed "${result.key}" from Data Node ${result.nodeId}.`;
        change = `WAL recorded · removed from cache`;
        statusState = 'success';
        statusLabel = 'DELETED';
      } else if (result.op === 'DELETE') {
        title = 'Key not found';
        message = `"${result.key}" was not in Data Node ${result.nodeId}'s cache.`;
        change = 'Delete recorded · cache was unchanged';
        statusState = 'ready';
        statusLabel = 'NOT FOUND';
      }
      if (result.routeMatches === false) {
        message += ` Live response came from Data Node ${result.nodeId}; expected Data Node ${result.expectedNodeId}.`;
        statusState = 'error';
        statusLabel = 'ROUTE MISMATCH';
      }
    }

    document.getElementById('demoResultTitle').textContent = title;
    document.getElementById('demoResultMessage').textContent = message;
    document.getElementById('demoResultChange').textContent = change;
    document.getElementById('demoResultNode').textContent = resultNode;
    const indicator = document.getElementById('demoResultIndicator');
    indicator.textContent = statusLabel;
    indicator.dataset.state = statusState;
    document.getElementById('demoStageTrack').setAttribute('aria-label', `Request path: ${document.getElementById('demoStageLabel').textContent}`);

    const codeName = statusCode === 0 ? 'OK' : statusCode === 1 ? 'NOT_FOUND' : statusCode === 2 ? 'ERROR' : 'not sent';
    const requestOp = plan || result;
    const requestKey = requestOp ? requestOp.key : key;
    const requestValue = requestOp ? (requestOp.val ?? requestOp.value ?? valueInput.value) : valueInput.value;
    const op = requestOp ? requestOp.op : currentOp;
    const opCode = op === 'PUT' ? '0x02' : op === 'DELETE' ? '0x03' : '0x01';
    const keyLength = new TextEncoder().encode(requestKey || '').length;
    const valueLength = op === 'PUT' ? new TextEncoder().encode(requestValue || '').length : 0;
    document.getElementById('demoPacketInspector').textContent = result?.op === 'RECOVERY'
      ? `Execution: simulated recovery\nAction: replayed ${state.nodes[result.nodeId].walRecords.length} local WAL records into volatile cache memory.\nNo network request or durability claim.`
      : plan || result
      ? `Execution: ${result?.executionMode || (state.liveMode ? 'live C++ response' : 'deterministic browser simulation')}\nRequest: magic 0xDC · opcode ${opCode} (${op})\nKey length: ${keyLength} UTF-8 bytes · value length: ${valueLength} UTF-8 bytes\nRoute: ${selectedRoute ? toHex32(selectedRoute.keyHash) : '—'} → ${selectedRoute ? selectedRoute.successor.label : '—'}\nExpected destination: ${plan ? `Data Node ${plan.targetNodeId}` : result ? `Data Node ${result.expectedNodeId || result.nodeId}` : '—'}\nActual response node: ${result && result.response ? result.response.nodeId : result?.status === 2 ? 'no response' : result ? result.nodeId : 'pending'}\nResponse status: ${statusCode == null ? 'pending' : `0x${statusCode.toString(16).padStart(2, '0').toUpperCase()} (${codeName})`}${result && result.response ? `\nResponse key hash: ${toHex32(result.response.keyHash)} · vnode hash: ${toHex32(result.response.vnodeHash)}\nResponse payload: ${result.response.payload || '(empty)'}` : ''}`
      : 'No request has been sent.';

    const events = state.arch.productHistory;
    document.getElementById('demoEventList').innerHTML = events.length
      ? events.map((event) => {
        const label = event.routeMatches === false
          ? 'Route mismatch'
          : event.op === 'RECOVERY'
          ? 'Local log replayed'
          : event.status === 0
          ? event.op === 'PUT' ? 'Value stored' : event.op === 'DELETE' ? 'Key deleted' : 'Value found'
          : event.status === 1 ? 'Key not found' : 'Request failed';
        return `<li><strong>${escapeHtml(event.op)} · ${escapeHtml(event.key)}</strong><span>${escapeHtml(label)} · Node ${event.nodeId}</span></li>`;
      }).join('')
      : '<li class="dc-event-empty">Your request results will appear here.</li>';

    if (selectedRoute) {
      document.getElementById('howRouteSummary').textContent =
        `${toHex32(selectedRoute.keyHash)} → next clockwise virtual node ${selectedRoute.successor.label} → Data Node ${selectedRoute.physical.nodeId}.`;
      document.getElementById('howHashValues').textContent =
        `key ${toHex32(selectedRoute.keyHash)} · successor ${toHex32(selectedRoute.successor.hashPos)}${selectedRoute.wrapped ? ' · wraps to ring start' : ''}`;
      renderProductHashRing(selectedRoute);
      const node = state.nodes[selectedRoute.physical.nodeId];
      const lru = node.entries.slice(0, 6);
      document.getElementById('howLruList').innerHTML = lru.length
        ? lru.map((entry, index) => `<li><span>${index === 0 ? 'Most recent' : index === lru.length - 1 ? 'Least recent' : `Position ${index + 1}`}</span><strong>${escapeHtml(entry.key)}</strong></li>`).join('')
        : state.liveMode && Number(node.reportedSize || 0) > 0
        ? '<li>Entries exist, but are not in the available inspection preview.</li>'
        : '<li>Cache entries appear after a PUT.</li>';
      const currentValue = node.entryMap.get(key)?.value;
      document.getElementById('howWalMemory').textContent = currentValue == null
        ? state.liveMode && Number(node.reportedSize || 0) > node.entries.length
          ? 'Outside the available cache preview'
          : 'Key absent'
        : currentValue;
      document.getElementById('howWalLog').textContent = state.liveMode
        ? `Live log · ${node.walRecordCount} records`
        : `Simulated · ${node.walRecords.length} records`;
      const walRecords = node.walRecords.slice(-4).reverse();
      document.getElementById('howWalList').innerHTML = walRecords.length
        ? walRecords.map((record) => `<li><span>#${record.seq} · ${escapeHtml(record.op)}</span><strong>${escapeHtml(record.key)}</strong></li>`).join('')
        : '<li>Mutations appear here after a PUT or DELETE.</li>';
      const recoveryButton = document.getElementById('simulateRecoveryBtn');
      recoveryButton.disabled = state.liveMode || learning.crashedNodeId === null;
      recoveryButton.title = state.liveMode ? 'Recovery simulation is demo-only' : 'Replay the selected simulated node log into cache memory';
      document.getElementById('simulateCrashBtn').disabled = state.liveMode || learning.crashedNodeId !== null;
    } else {
      document.getElementById('howRouteSummary').textContent = 'Enter a key in the playground to see its destination node.';
      document.getElementById('howHashValues').textContent = 'No key selected.';
      document.getElementById('howLruList').innerHTML = '<li>Cache entries appear after a PUT.</li>';
      document.getElementById('howWalMemory').textContent = 'No key selected';
      document.getElementById('howWalLog').textContent = 'No node selected';
      document.getElementById('howWalList').innerHTML = '<li>Mutations appear here after a PUT or DELETE.</li>';
    }
    renderTour();
    renderLearningAnimation();
  }

  function renderProductPerformance() {
    const report = state.productReport;
    const results = document.getElementById('productBenchmarkResults');
    if (!results) return;
    const notice = document.getElementById('productBenchmarkNotice');
    const error = document.getElementById('productBenchmarkError');
    if (!report) {
      results.hidden = true;
      document.getElementById('performanceModePill').textContent = 'NO RUN YET';
      return;
    }
    results.hidden = false;
    error.hidden = true;
    const metrics = report.metrics;
    const simulated = report.source === 'illustrative_simulation';
    const measured = report.source === 'measured_python_load_tester';
    const provenance = report.provenanceLabel || (simulated ? 'SIMULATED SAMPLE' : measured ? 'MEASURED' : 'IMPORTED');
    document.getElementById('performanceModePill').textContent = provenance;
    document.getElementById('productBenchmarkSource').textContent = provenance;
    document.getElementById('productBenchmarkTitle').textContent =
      `${report.target_mode === 'coordinator' ? 'Coordinator' : 'Data node'} · ${report.endpoint}`;
    document.getElementById('productThroughput').textContent = `${Number(metrics.throughput_ops_sec).toLocaleString()} ops/s`;
    document.getElementById('productP50').textContent = `${Number(metrics.p50_latency_ms).toLocaleString()} ms`;
    document.getElementById('productP99').textContent = `${Number(metrics.p99_latency_ms).toLocaleString()} ms`;
    document.getElementById('productFailures').textContent = metrics.failed_ops == null ? 'Not measured' : Number(metrics.failed_ops).toLocaleString();
    document.getElementById('productFailureNote').textContent = metrics.successful_ops == null
      ? `${Number(metrics.total_requests).toLocaleString()} requests · simulated`
      : `${Number(metrics.successful_ops).toLocaleString()} completed`;
    if (simulated) {
      notice.textContent = 'Simulated sample data — these values are illustrative and are not measurements of a running cluster.';
    } else if (report.timestamp && provenance.includes('SAVED')) {
      notice.textContent = `Historical measurement from ${new Date(report.timestamp).toLocaleString()} · ${report.config.workers} workers · ${Number(metrics.total_requests).toLocaleString()} requests. Not a live reading.`;
    } else {
      notice.textContent = `${provenance} · ${report.config.workers} workers · ${Number(metrics.total_requests).toLocaleString()} requests · workload GET ${report.config.get_pct}% / PUT ${report.config.put_pct}% / DELETE ${report.config.delete_pct}%.`;
    }
    const chart = document.getElementById('productBenchmarkChart');
    const series = report.series;
    if (!series || series.length === 0) {
      chart.innerHTML = '';
      return;
    }
    const width = 640;
    const height = 220;
    const pad = { top: 12, right: 16, bottom: 30, left: 48 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const max = Math.max(1, ...series.map((point) => Number(point.ops_per_sec))) * 1.12;
    const points = series.map((point, index) => {
      const x = pad.left + index / Math.max(1, series.length - 1) * plotWidth;
      const y = pad.top + plotHeight - Number(point.ops_per_sec) / max * plotHeight;
      return { x, y, bucket: point.bucket, value: Number(point.ops_per_sec) };
    });
    const grid = [0, 1, 2, 3].map((line) => {
      const y = pad.top + plotHeight * line / 3;
      const value = Math.round(max * (1 - line / 3));
      return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="var(--dc-border)" stroke-dasharray="3 4"/><text x="${pad.left - 8}" y="${y + 3}" fill="var(--dc-muted)" font-size="9" text-anchor="end">${value.toLocaleString()}</text>`;
    }).join('');
    const path = points.map((point) => `${point.x},${point.y}`).join(' ');
    chart.setAttribute('aria-label', `${provenance} throughput chart in operations per second.`);
    chart.innerHTML = `${grid}<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotHeight}" stroke="var(--dc-border-strong)"/><line x1="${pad.left}" y1="${pad.top + plotHeight}" x2="${width - pad.right}" y2="${pad.top + plotHeight}" stroke="var(--dc-border-strong)"/><polyline points="${path}" fill="none" stroke="var(--dc-purple)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3" fill="var(--dc-purple)"><title>Interval ${point.bucket}: ${point.value.toLocaleString()} ops/s</title></circle><text x="${point.x}" y="${height - 9}" fill="var(--dc-muted)" font-size="8" text-anchor="middle">${point.bucket}</text>`).join('')}`;
  }

  function initializeProductExperience() {
    const demoKey = document.getElementById('demoKey');
    const demoValue = document.getElementById('demoValue');
    demoKey.value = state.arch.key;
    demoValue.value = state.arch.val;
    document.getElementById('archKeyInput').value = state.arch.key;
    document.getElementById('archValInput').value = state.arch.val;

    const guide = document.getElementById('firstRunGuide');
    try {
      guide.hidden = localStorage.getItem('discache-guide-dismissed') === 'true';
    } catch (_) {
      guide.hidden = false;
    }
    document.getElementById('dismissGuideBtn').addEventListener('click', () => {
      guide.hidden = true;
      try {
        localStorage.setItem('discache-guide-dismissed', 'true');
      } catch (_) {}
    });
    document.getElementById('startTourBtn').addEventListener('click', startInteractiveTour);
    document.getElementById('printGuideBtn').addEventListener('click', () => window.print());
    document.getElementById('tourRunStepBtn').addEventListener('click', () => {
      if (!tour.active || tour.completed > tour.step || state.arch.activePlan?.pending) return;
      state.arch.op = tourSteps[tour.step].op;
      resetArchFlow();
      state.arch.productLastResult = null;
      renderProductExperience();
      document.getElementById('demoRunBtn').click();
    });
    document.getElementById('tourPreviousBtn').addEventListener('click', () => {
      if (!tour.active || tour.step === 0) return;
      tour.step--;
      renderProductExperience();
    });
    document.getElementById('tourNextBtn').addEventListener('click', () => {
      if (!tour.active || tour.completed <= tour.step) return;
      tour.step = Math.min(tour.completed, tourSteps.length - 1);
      renderProductExperience();
    });
    document.getElementById('tourSkipBtn').addEventListener('click', () => finishInteractiveTour(true));
    document.getElementById('tourFinishBtn').addEventListener('click', () => {
      if (tour.completed === tourSteps.length) finishInteractiveTour(false);
    });

    document.querySelectorAll('[data-learning-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        pauseLearningAnimation();
        learning.mode = button.dataset.learningMode;
        learning.step = -1;
        document.querySelectorAll('[data-learning-mode]').forEach((tab) => {
          tab.setAttribute('aria-pressed', String(tab === button));
        });
        renderLearningAnimation();
      });
    });
    document.getElementById('learningRunBtn').addEventListener('click', () => {
      pauseLearningAnimation();
      const maxStep = learning.mode === 'route' ? 4 : 3;
      if (state.reducedMotion) {
        learning.step = maxStep;
        renderLearningAnimation();
        return;
      }
      if (learning.step >= maxStep) learning.step = -1;
      advanceLearningAnimation();
      if (learning.step < maxStep) {
        learning.timer = window.setInterval(advanceLearningAnimation, 850);
        renderLearningAnimation();
      }
    });
    document.getElementById('learningStepBtn').addEventListener('click', () => {
      pauseLearningAnimation();
      advanceLearningAnimation();
    });
    document.getElementById('learningPauseBtn').addEventListener('click', pauseLearningAnimation);
    document.getElementById('learningResetBtn').addEventListener('click', () => {
      pauseLearningAnimation();
      learning.step = -1;
      renderLearningAnimation();
    });

    document.querySelectorAll('[data-demo-op]').forEach((button) => {
      button.addEventListener('click', () => {
        if (state.arch.activePlan?.pending) return;
        state.arch.op = button.dataset.demoOp;
        document.querySelectorAll('[data-demo-op]').forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-pressed', String(active));
        });
        resetArchFlow();
        state.arch.productLastResult = null;
        renderProductExperience();
      });
    });

    const syncInputs = () => {
      state.arch.key = demoKey.value;
      state.arch.val = demoValue.value;
      document.getElementById('archKeyInput').value = demoKey.value;
      document.getElementById('archValInput').value = demoValue.value;
      if (!state.arch.activePlan?.pending) {
        resetArchFlow();
        state.arch.productLastResult = null;
      }
      renderProductExperience();
    };
    demoKey.addEventListener('input', syncInputs);
    demoValue.addEventListener('input', syncInputs);

    document.getElementById('demoRunBtn').addEventListener('click', () => {
      if (!demoKey.value.trim()) {
        document.getElementById('demoResultTitle').textContent = 'Key required';
        document.getElementById('demoResultMessage').textContent = 'Enter a key before running this request.';
        document.getElementById('demoResultIndicator').textContent = 'INVALID INPUT';
        document.getElementById('demoResultIndicator').dataset.state = 'error';
        demoKey.focus();
        return;
      }
      toggleArchRun();
      renderProductExperience();
    });
    document.getElementById('demoStepBtn').addEventListener('click', () => {
      if (!demoKey.value.trim()) {
        document.getElementById('demoResultTitle').textContent = 'Key required';
        document.getElementById('demoResultMessage').textContent = 'Enter a key before stepping through this request.';
        document.getElementById('demoResultIndicator').textContent = 'INVALID INPUT';
        document.getElementById('demoResultIndicator').dataset.state = 'error';
        demoKey.focus();
        return;
      }
      stopArchAutoRun();
      stepArchForward();
      renderProductExperience();
    });
    document.getElementById('demoResetBtn').addEventListener('click', () => {
      stopArchAutoRun();
      state.arch.op = 'PUT';
      demoKey.value = 'session:4092';
      demoValue.value = 'user=8810';
      state.arch.key = demoKey.value;
      state.arch.val = demoValue.value;
      document.getElementById('archKeyInput').value = demoKey.value;
      document.getElementById('archValInput').value = demoValue.value;
      document.querySelectorAll('[data-demo-op]').forEach((button) => {
        const active = button.dataset.demoOp === 'PUT';
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      state.arch.logs = [];
      state.arch.stepSeq = 1;
      state.arch.productHistory = [];
      state.arch.productSequenceIndex = 0;
      state.arch.productLastResult = null;
      if (tour.active) {
        tour.step = 0;
        tour.completed = 0;
        tour.results = [];
        tour.attempt = null;
      }
      learning.crashedNodeId = null;
      learning.recoveryMessage = 'No simulated crash.';
      renderArchEventLog();
      resetArchFlow();
      if (!state.liveMode) restoreDemoCluster();
      renderProductExperience();
    });

    document.getElementById('simulateCrashBtn').addEventListener('click', () => {
      if (state.liveMode) return;
      const key = demoKey.value.trim();
      if (!key) return;
      const nodeId = hashRing.route(key).physical.nodeId;
      const node = state.nodes[nodeId];
      const recordCount = node.walRecords.length;
      node.clearMemoryOnly();
      learning.crashedNodeId = nodeId;
      learning.recoveryMessage = `Simulated cache-memory loss on Data Node ${nodeId}; ${recordCount} local log records remain.`;
      renderProductExperience();
    });
    document.getElementById('simulateRecoveryBtn').addEventListener('click', () => {
      if (state.liveMode || learning.crashedNodeId === null) return;
      const node = state.nodes[learning.crashedNodeId];
      const recordCount = node.walRecords.length;
      node.replayWalUpTo(recordCount);
      learning.recoveryMessage = `Replayed ${recordCount} local log record${recordCount === 1 ? '' : 's'} into Data Node ${node.nodeId}'s simulated cache.`;
      learning.crashedNodeId = null;
      renderProductExperience();
    });

    const syncBenchmarkControls = () => {
      const target = document.getElementById('productBenchmarkTarget').value;
      state.perfViewMode = target === 'coordinator' ? 'coordinator' : 'single_node';
      document.getElementById('perfSingleNodeSelect').value = target === 'coordinator' ? 'node_1' : target;
      document.getElementById('perfGetPct').value = document.getElementById('productGetPct').value;
      document.getElementById('perfPutPct').value = document.getElementById('productPutPct').value;
      document.getElementById('perfDelPct').value = document.getElementById('productDelPct').value;
      document.getElementById('perfWorkersInput').value = document.getElementById('productWorkers').value;
      document.getElementById('perfTotalReqsInput').value = document.getElementById('productRequests').value;
    };
    document.getElementById('productRunLiveBtn').addEventListener('click', () => {
      if (!state.clusterAvailable || state.benchmarkRunning) return;
      syncBenchmarkControls();
      const params = readAndValidatePerfControls();
      if (!params) {
        const validation = document.getElementById('perfValidationMsg');
        document.getElementById('productBenchmarkError').textContent = validation.textContent;
        document.getElementById('productBenchmarkError').hidden = false;
        return;
      }
      document.getElementById('productBenchmarkError').hidden = true;
      document.getElementById('runLiveBenchBtn').click();
    });
    document.getElementById('productSampleBtn').addEventListener('click', () => {
      syncBenchmarkControls();
      const params = readAndValidatePerfControls();
      if (!params) {
        const banner = document.getElementById('productBenchmarkError');
        banner.textContent = document.getElementById('perfValidationMsg').textContent;
        banner.hidden = false;
        return;
      }
      document.getElementById('productBenchmarkError').hidden = true;
      document.getElementById('loadIllustrativeBtn').click();
    });
    document.getElementById('productLoadSavedBtn').addEventListener('click', async () => {
      const button = document.getElementById('productLoadSavedBtn');
      button.disabled = true;
      document.getElementById('productBenchmarkError').hidden = true;
      try {
        const response = await fetch('/api/benchmark_results.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Saved benchmark is unavailable (HTTP ${response.status}).`);
        const report = await response.json();
        validateBenchmarkReport(report);
        const savedAt = report.timestamp ? new Date(report.timestamp).toLocaleDateString() : 'date unavailable';
        applyBenchmarkReport(report, `SAVED MEASUREMENT · ${savedAt}`);
      } catch (error) {
        const banner = document.getElementById('productBenchmarkError');
        banner.textContent = error.message;
        banner.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    document.getElementById('productImportReport').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const report = JSON.parse(String(reader.result));
          applyBenchmarkReport(report, 'IMPORTED BENCHMARK · JSON');
          document.getElementById('productBenchmarkError').hidden = true;
        } catch (error) {
          const banner = document.getElementById('productBenchmarkError');
          banner.textContent = `Could not load benchmark report: ${error.message}`;
          banner.hidden = false;
        }
      };
      reader.onerror = () => {
        const banner = document.getElementById('productBenchmarkError');
        banner.textContent = 'Could not read the selected benchmark file.';
        banner.hidden = false;
      };
      reader.readAsText(file);
    });

    renderProductExperience();
    renderProductPerformance();
  }

  // ==========================================================================
  // 11. EVENT LISTENERS & INITIALIZATION
  // ==========================================================================
  function bindEvents() {
    document.querySelectorAll('[data-route-link]').forEach((link) => {
      link.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        const target = new URL(link.href, location.href);
        if (target.origin !== location.origin) return;
        event.preventDefault();
        navigateToRoute(target.pathname);
      });
    });
    window.addEventListener('popstate', () => navigateToRoute(location.pathname, { push: false }));

    document.getElementById('themeSelect').addEventListener('change', (event) => {
      applyTheme(event.target.value, true);
    });

    // Mode Toggle (Demo Mode vs Live C++ Cluster Mode)
    document.getElementById('modeToggleBtn').addEventListener('click', () => {
      if (!state.bridgeConnected || (!state.liveMode && !state.clusterAvailable)) {
        updateModeIndicator();
        return;
      }
      const wasLive = state.liveMode;
      state.liveMode = !state.liveMode;
      learning.crashedNodeId = null;
      learning.recoveryMessage = state.liveMode ? 'Recovery controls are disabled for live data.' : 'No simulated crash.';
      if (wasLive && !state.liveMode) restoreDemoCluster();
      updateModeIndicator();
      if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'inspect_cluster' }));
        if (state.latestClusterSnapshot) {
          syncSnapshotFromLiveCluster(state.latestClusterSnapshot);
        }
      }
      renderProductExperience();
    });

    // Motion Toggle (Standard vs Reduced Motion)
    document.getElementById('motionToggleBtn').addEventListener('click', () => {
      state.reducedMotion = !state.reducedMotion;
      document.documentElement.dataset.reducedMotion = String(state.reducedMotion);
      const motionButton = document.getElementById('motionToggleBtn');
      motionButton.setAttribute('aria-pressed', String(state.reducedMotion));
      document.getElementById('motionBtnText').textContent = state.reducedMotion
        ? 'MOTION: REDUCED'
        : 'MOTION: STANDARD';
      if (state.reducedMotion) {
        refreshScrollReveals();
        pauseLearningAnimation();
      }
      renderLearningAnimation();
      if (state.reducedMotion) pauseLearningAnimation();
    });

    // Architecture Controls
    const archOpBtns = document.querySelectorAll('#archOpGroup .seg-btn');
    document.getElementById('archValInput').disabled = state.arch.op !== 'PUT';
    archOpBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        archOpBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.arch.op = btn.getAttribute('data-op');
        const valInput = document.getElementById('archValInput');
        valInput.disabled = state.arch.op !== 'PUT';
        resetArchFlow();
      });
    });

    document.querySelectorAll('.sample-key-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('archKeyInput').value = btn.getAttribute('data-key');
        document.getElementById('archValInput').value = btn.getAttribute('data-val');
        resetArchFlow();
      });
    });

    document.getElementById('archRunBtn').addEventListener('click', toggleArchRun);
    document.getElementById('archStepBtn').addEventListener('click', () => {
      stopArchAutoRun();
      stepArchForward();
    });
    document.getElementById('archResetBtn').addEventListener('click', resetArchFlow);
    document.getElementById('clearArchLogBtn').addEventListener('click', () => {
      state.arch.logs = [];
      renderArchEventLog();
    });

    // Consistent Hashing Controls
    document.getElementById('ringCalcBtn').addEventListener('click', renderHashRingVisualizer);
    document.getElementById('ringKeyInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') renderHashRingVisualizer();
    });
    document.querySelectorAll('.ring-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('ringKeyInput').value = btn.getAttribute('data-key');
        renderHashRingVisualizer();
      });
    });
    document.getElementById('ringExecuteInArchBtn').addEventListener('click', () => {
      const k = document.getElementById('ringKeyInput').value.trim() || 'session:4092';
      document.getElementById('archKeyInput').value = k;
      navigateToRoute('/playground');
      resetArchFlow();
      stepArchForward();
    });
    document.getElementById('runKeySampleDistBtn').addEventListener('click', () => {
      const counts = { 1: 0, 2: 0, 3: 0 };
      const randPrefix = 'batch_' + Math.floor(Math.random() * 900 + 100);
      for (let i = 1; i <= 300; i++) {
        const r = hashRing.route(`${randPrefix}:key:${i}`);
        counts[r.physical.nodeId]++;
      }
      state.sampleDistCounts = counts;
      renderRingDistributionTable();
    });

    // Cache Engine Controls
    const cacheNodeBtns = document.querySelectorAll('#cacheNodeSelectGroup .seg-btn');
    cacheNodeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        cacheNodeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.cacheSelectedNode = Number(btn.getAttribute('data-node'));
        document.getElementById('cacheDemoCapInput').value = String(
          state.nodes[state.cacheSelectedNode].capacity
        );
        renderCacheEngineView();
      });
    });

    const cacheOpBtns = document.querySelectorAll('#cacheOpGroup .seg-btn');
    cacheOpBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        cacheOpBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.cacheOp = btn.getAttribute('data-op');
        document.getElementById('cacheValInput').disabled = state.cacheOp !== 'PUT';
      });
    });

    document.getElementById('applyCacheCapBtn').addEventListener('click', () => {
      const newCap = Math.max(2, Number(document.getElementById('cacheDemoCapInput').value) || 5);
      const node = state.nodes[state.cacheSelectedNode];
      if (state.liveMode) {
        const button = document.getElementById('applyCacheCapBtn');
        button.disabled = true;
        sendLiveOperation({
          type: 'node_config',
          nodeId: node.nodeId,
          configKey: 'CAPACITY',
          configValue: String(newCap),
        }, (result, error) => {
          button.disabled = false;
          state.lastCacheBanner = error
            ? `LIVE capacity update failed: ${error}`
            : `LIVE capacity update → ${result?.payload || 'no response'}`;
          renderCacheEngineView();
        });
        return;
      }
      node.setCapacity(newCap);
      state.lastCacheBanner = `Updated Node ${node.nodeId} Demo Capacity to ${node.capacity} entries (System Default: 100,000)`;
      renderCacheEngineView();
      renderClusterNodeCards();
    });

    document.getElementById('cacheExecBtn').addEventListener('click', executeCacheEngineOperation);
    document.getElementById('cacheSeedEvictBtn').addEventListener('click', () => {
      const node = state.nodes[state.cacheSelectedNode];
      const cap = Math.min(12, node.capacity);
      for (let i = 1; i <= cap; i++) {
        node.put(`item_${node.nodeId}_${i}`, `val_${i * 10}`, false);
      }
      state.lastCacheBanner = `Filled Node ${node.nodeId} to capacity (${node.entries.length}/${node.capacity}). Next new PUT will evict TAIL ("${node.entries[node.entries.length - 1]?.key}").`;
      renderCacheEngineView();
      renderClusterNodeCards();
      renderWalRecoveryView();
    });

    document.getElementById('cacheClearNodeBtn').addEventListener('click', () => {
      const node = state.nodes[state.cacheSelectedNode];
      if (state.liveMode) {
        const button = document.getElementById('cacheClearNodeBtn');
        button.disabled = true;
        sendLiveOperation({
          type: 'node_config',
          nodeId: node.nodeId,
          configKey: 'RESET',
          configValue: '',
        }, (result, error) => {
          button.disabled = false;
          state.lastCacheBanner = error
            ? `LIVE reset failed: ${error}`
            : `LIVE reset → ${result?.payload || 'no response'}`;
          renderCacheEngineView();
        });
        return;
      }
      node.clearAll();
      state.lastCacheBanner = `Cleared Node ${node.nodeId} in-memory cache and WAL.`;
      renderCacheEngineView();
      renderClusterNodeCards();
      renderWalRecoveryView();
    });

    document.getElementById('traceConcurrencyReadBtn').addEventListener('click', () =>
      traceConcurrencyPipeline(false)
    );
    document.getElementById('traceConcurrencyWriteBtn').addEventListener('click', () =>
      traceConcurrencyPipeline(true)
    );

    // WAL & Crash-Recovery Controls
    const walNodeTabs = document.querySelectorAll('.wal-node-tab');
    walNodeTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        walNodeTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.walSelectedNode = Number(tab.getAttribute('data-node'));
        state.recoveryStep = 1;
        state.recoveryReplayedCount = state.nodes[state.walSelectedNode].walRecords.length;
        renderWalRecoveryView();
      });
    });

    document.getElementById('walOpSelect').addEventListener('change', (e) => {
      document.getElementById('walValInput').disabled = e.target.value !== 'PUT';
    });

    document.getElementById('walAppendBtn').addEventListener('click', () => {
      const node = state.nodes[state.walSelectedNode];
      const op = document.getElementById('walOpSelect').value;
      const key = document.getElementById('walKeyInput').value.trim();
      const val = document.getElementById('walValInput').value;
      if (!key) return;

      animateMutationWorkflow();
      if (state.liveMode) {
        const button = document.getElementById('walAppendBtn');
        button.disabled = true;
        sendLiveOperation({
          type: 'execute_op',
          directNodeId: node.nodeId,
          op,
          key,
          value: val,
        }, (result, error) => {
          button.disabled = false;
          if (error) {
            setRouteOutcome(`Live WAL mutation failed: ${error}`);
          } else {
            state.recoveryStep = 1;
            state.recoveryReplayedCount = node.walRecords.length;
            state.lastCacheBanner = `LIVE ${op} → ${result?.payload || 'no response'} · WAL sequence #${node.walRecordCount}`;
            setRouteOutcome(`${op} ${key} → ${result?.payload || 'no response'} · Data Node ${node.nodeId} · WAL sequence #${node.walRecordCount}.`);
          }
          renderWalRecoveryView();
          renderCacheEngineView();
          renderClusterNodeCards();
        });
        return;
      }
      if (op === 'PUT') {
        node.put(key, val, false);
      } else {
        node.del(key, false);
      }
      state.recoveryStep = 1;
      state.recoveryReplayedCount = node.walRecords.length;
      renderWalRecoveryView();
      renderCacheEngineView();
      renderClusterNodeCards();
    });

    document.getElementById('walRunRecoveryBtn').addEventListener('click', runFullWalRecoverySequence);
    document.getElementById('walStepRecoveryBtn').addEventListener('click', () => {
      if (state.recoveryTimer) {
        clearInterval(state.recoveryTimer);
        state.recoveryTimer = null;
      }
      stepWalRecovery();
    });
    document.getElementById('walResetDemoBtn').addEventListener('click', () => {
      const node = state.nodes[state.walSelectedNode];
      node.clearAll();
      node.put(`node${node.nodeId}:k1`, 'v100', false);
      node.put(`node${node.nodeId}:k2`, 'v200', false);
      node.put(`node${node.nodeId}:k3`, 'v300', false);
      node.del(`node${node.nodeId}:k2`, false);
      node.put(`node${node.nodeId}:k1`, 'v100_updated', false);
      state.recoveryStep = 1;
      state.recoveryReplayedCount = node.walRecords.length;
      renderWalRecoveryView();
      renderCacheEngineView();
      renderClusterNodeCards();
    });

    // Performance Lab Controls
    const perfViewBtns = document.querySelectorAll('#perfViewModeGroup .seg-btn');
    perfViewBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        perfViewBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.perfViewMode = btn.getAttribute('data-view');
        document.getElementById('perfNodeTargetWrap').hidden =
          state.perfViewMode !== 'single_node';
        renderPerformanceLab();
      });
    });

    document.getElementById('runLiveBenchBtn').addEventListener('click', () => {
      const params = readAndValidatePerfControls();
      if (!params) return;

      if (state.bridgeConnected && state.ws && state.ws.readyState === WebSocket.OPEN) {
        const btn = document.getElementById('runLiveBenchBtn');
        state.benchmarkRunning = true;
        updateModeIndicator();
        state.benchmarkRequestId = `ui-${++state.operationSeq}`;
        btn.disabled = true;
        btn.textContent = `Running ${params.workers} workers...`;
        try {
          state.ws.send(JSON.stringify({
            type: 'run_benchmark',
            requestId: state.benchmarkRequestId,
            params: {
              targetMode: params.targetMode,
              totalRequests: params.totalReqs,
              workers: params.workers,
              getPct: params.getPct,
              putPct: params.putPct,
              deletePct: params.delPct,
            },
          }));
        } catch (error) {
          state.benchmarkRunning = false;
          state.benchmarkRequestId = null;
          btn.disabled = !state.clusterAvailable;
          btn.textContent = 'Run Benchmark';
          showPerformanceError(`LIVE BENCHMARK FAILED: ${error.message}. Use Generate Illustrative Sample for simulated data.`);
        }
      } else {
        showPerformanceError('LIVE BENCHMARK UNAVAILABLE: the bridge and all C++ nodes must be connected. Use Generate Illustrative Sample for simulated data.');
      }
    });

    document.getElementById('loadIllustrativeBtn').addEventListener('click', () => {
      const params = readAndValidatePerfControls();
      if (!params) return;
      const simReport = generateDeterministicIllustrativeReport(
        params.targetMode,
        params.workers,
        params.totalReqs,
        params.getPct,
        params.putPct,
        params.delPct
      );
      applyBenchmarkReport(simReport, 'ILLUSTRATIVE DATA (SIMULATED)');
    });

    document.getElementById('importBenchJsonInput').addEventListener('change', (evt) => {
      const file = evt.target.files && evt.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!parsed.metrics) throw new Error('Missing metrics object in JSON');
          applyBenchmarkReport(parsed, 'IMPORTED BENCHMARK OUTPUT (JSON)');
        } catch (err) {
          const banner = document.getElementById('perfValidationMsg');
          banner.hidden = false;
          banner.textContent = `JSON IMPORT ERROR: ${err.message}`;
        }
      };
      reader.readAsText(file);
    });
  }

  function init() {
    arrangeArchitectureContent();
    initializeTheme();
    state.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.reducedMotion = String(state.reducedMotion);
    document.getElementById('motionToggleBtn').setAttribute('aria-pressed', String(state.reducedMotion));
    document.getElementById('motionBtnText').textContent = state.reducedMotion
      ? 'MOTION: REDUCED'
      : 'MOTION: STANDARD';
    seedInitialClusterState();

    bindEvents();
    initializeProductExperience();
    applyArchStageVisuals(0);
    renderHashRingVisualizer();
    renderCacheEngineView();
    renderWalRecoveryView();
    renderPerformanceLab();
    navigateToRoute(location.pathname, { push: false, scroll: false });
    initWebSocketBridge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();