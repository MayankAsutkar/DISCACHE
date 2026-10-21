/**
 * DisCache — Interactive Distributed Systems Lab (app.js)
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
  // 3. IN-MEMORY O(1) LRU CACHE + PER-NODE WAL SIMULATION ENGINE
  // ==========================================================================
  class SimulatedDataNode {
    constructor(nodeId, port, walFile, demoCapacity = 5) {
      this.nodeId = nodeId;
      this.port = port;
      this.walFile = walFile;
      this.capacity = demoCapacity;
      this.defaultSystemCapacity = 100000;
      this.entries = []; // Ordered from HEAD (MRU, index 0) to TAIL (LRU, last index)
      this.walRecords = [];
      this.nextWalSeq = 1;
      this.hits = 0;
      this.misses = 0;
      this.evictions = 0;
      this.totalReqs = 0;
    }

    get(key) {
      this.totalReqs++;
      const idx = this.entries.findIndex((e) => e.key === key);
      if (idx === -1) {
        this.misses++;
        return { hit: false, value: null };
      }
      this.hits++;
      const [entry] = this.entries.splice(idx, 1);
      this.entries.unshift(entry); // Move to MRU HEAD
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
      }

      const idx = this.entries.findIndex((e) => e.key === key);
      if (idx !== -1) {
        const [entry] = this.entries.splice(idx, 1);
        entry.value = value;
        this.entries.unshift(entry);
        return { updated: true, evicted: false, evictedKey: null, walRecord: walRec };
      }

      let evictedKey = null;
      let evictedVal = null;
      if (this.entries.length >= this.capacity) {
        const lru = this.entries.pop();
        if (lru) {
          evictedKey = lru.key;
          evictedVal = lru.value;
          this.evictions++;
        }
      }

      this.entries.unshift({
        key,
        value,
        addr: '0x' + (0x7f0010 + ((murmurhash3_x86_32(key) & 0xfff) << 4)).toString(16).toUpperCase(),
      });

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
      }

      const idx = this.entries.findIndex((e) => e.key === key);
      if (idx === -1) {
        return { removed: false, walRecord: walRec };
      }
      this.entries.splice(idx, 1);
      return { removed: true, walRecord: walRec };
    }

    setCapacity(newCap) {
      this.capacity = Math.max(1, Number(newCap) || 5);
      while (this.entries.length > this.capacity) {
        this.entries.pop();
        this.evictions++;
      }
    }

    clearMemoryOnly() {
      this.entries = [];
    }

    clearAll() {
      this.entries = [];
      this.walRecords = [];
      this.nextWalSeq = 1;
      this.hits = 0;
      this.misses = 0;
      this.evictions = 0;
    }

    replayWalUpTo(count) {
      this.entries = [];
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
    reducedMotion: false,
    ws: null,

    nodes: {
      1: new SimulatedDataNode(1, 8001, 'node_1.log', 5),
      2: new SimulatedDataNode(2, 8002, 'node_2.log', 5),
      3: new SimulatedDataNode(3, 8003, 'node_3.log', 5),
    },

    // Section 5: Architecture Tracer State
    arch: {
      op: 'PUT',
      key: 'session:4092',
      val: 'uid=8810;role=admin',
      currentStage: 0,
      maxStage: 6,
      timer: null,
      running: false,
      activePlan: null,
      logs: [],
      stepSeq: 1,
    },

    // Section 6: Ring State
    ringKey: 'session:4092',
    sampleDistCounts: null,

    // Section 7: Cache Engine State
    cacheSelectedNode: 1,
    cacheOp: 'PUT',
    lastCacheBanner: 'O(1) Pointer Splice on GET / PUT / DELETE',

    // Section 9: WAL & Recovery State
    walSelectedNode: 1,
    recoveryStep: 1, // 1..6
    recoveryReplayedCount: 0,
    recoveryTimer: null,

    // Section 10: Performance Lab State
    perfViewMode: 'coordinator', // 'coordinator' | 'single_node'
    perfReports: {
      coordinator: null,
      single_node: null,
    },
  };

  // Seed initial deterministic keys across the cluster so all views start populated
  function seedInitialClusterState() {
    const initialSeeds = [
      ['user:101', 'Alice_BTech_CSE'],
      ['session:4092', 'uid=8810;role=admin'],
      ['invoice:9004', 'status=paid;amt=1200'],
      ['acct:301', 'bal=4500'],
      ['config:timeout', '3000ms'],
      ['job:worker:7', 'active_shard_2'],
      ['cache:block:7', '0xFFA0192B'],
      ['metric:cpu:0', 'load=0.42'],
      ['course:cs401', 'Distributed_Systems'],
    ];
    for (const [k, v] of initialSeeds) {
      const r = hashRing.route(k);
      state.nodes[r.physical.nodeId].put(k, v, false);
    }
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
        ws.send(JSON.stringify({ type: 'inspect_cluster' }));
      };

      ws.onclose = () => {
        state.bridgeConnected = false;
        if (state.liveMode) {
          state.liveMode = false;
          updateModeIndicator();
        }
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
      target.entries = (liveNode.entries || []).map((e) => ({
        key: e.key,
        value: e.value,
        addr: '0x' + (0x7f0010 + ((murmurhash3_x86_32(e.key) & 0xfff) << 4)).toString(16).toUpperCase(),
      }));
      target.walRecords = (liveNode.walRecords || []).map((w) => ({
        seq: w.seq,
        timestampMs: w.timestampMs,
        op: w.op,
        key: w.key,
        value: w.value,
      }));
      target.nextWalSeq = (liveNode.walSeq || target.walRecords.length) + 1;
    }

    renderClusterNodeCards();
    renderCacheEngineView();
    renderWalRecoveryView();
  }

  function handleBridgeMessage(msg) {
    if (msg.type === 'cluster_snapshot') {
      const snap = msg.snapshot;
      const isClusterLive =
        snap &&
        snap.coordinatorOnline &&
        snap.nodesOnline &&
        snap.nodesOnline[1] &&
        snap.nodesOnline[2] &&
        snap.nodesOnline[3];

      if (isClusterLive && state.liveMode) {
        syncSnapshotFromLiveCluster(snap);
      }
      updateModeIndicator(isClusterLive);
    } else if (msg.type === 'op_result') {
      if (state.liveMode && msg.snapshot) {
        syncSnapshotFromLiveCluster(msg.snapshot);
      }
    } else if (msg.type === 'recover_result' || msg.type === 'config_result') {
      if (state.liveMode && msg.snapshot) {
        syncSnapshotFromLiveCluster(msg.snapshot);
      }
    } else if (msg.type === 'benchmark_result') {
      const btn = document.getElementById('runLiveBenchBtn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Run Benchmark';
      }
      if (msg.report) {
        applyBenchmarkReport(msg.report, 'MEASURED EXECUTION DATA (PYTHON LOAD TESTER)');
      }
      if (state.liveMode && msg.snapshot) {
        syncSnapshotFromLiveCluster(msg.snapshot);
      }
    } else if (msg.type === 'error') {
      const btn = document.getElementById('runLiveBenchBtn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Run Benchmark';
      }
    }
  }

  function updateModeIndicator(liveClusterAvailable = false) {
    const badgeBtn = document.getElementById('modeToggleBtn');
    const badgeText = document.getElementById('modeBadgeText');
    const walNotice = document.getElementById('walSimNoticeBadge');

    if (state.liveMode) {
      badgeBtn.classList.add('live-active');
      badgeText.textContent = 'LIVE C++20 CLUSTER (:8000–:8003)';
      if (walNotice) walNotice.textContent = 'CONNECTED TO LIVE C++ DATA NODE WAL';
    } else {
      badgeBtn.classList.remove('live-active');
      badgeText.textContent = liveClusterAvailable
        ? 'DEMO MODE: SIMULATED DATA (CLICK FOR LIVE C++)'
        : 'DEMO MODE: SIMULATED DATA';
      if (walNotice) walNotice.textContent = 'VISUAL SIMULATION (LOCAL NODE SCOPE)';
    }
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

      countLbl.textContent = `${node.entries.length} / ${node.capacity} entries`;
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
        'Python Load Tester',
        `Constructed 10-byte binary header [Magic=0xDC, Op=${plan.opHex}, KeyLen=${plan.keyBytes}, ValLen=${plan.valBytes}] and opened raw TCP stream to Coordinator 127.0.0.1:8000.`
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
      // Execute the actual operation on the node if not yet executed
      if (!plan.executedMutation) {
        plan.executedMutation = true;

        if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(
            JSON.stringify({
              type: 'execute_op',
              op: plan.op,
              key: plan.key,
              value: plan.val,
            })
          );
        }

        if (plan.op === 'PUT') {
          const res = nodeObj.put(plan.key, plan.val, false);
          plan.statusHex = '0x00 (STATUS_OK)';
          plan.executionOutcomeText = res.evicted
            ? `Stored "${plan.key}"="${plan.val}" at MRU Head (Evicted LRU Tail "${res.evictedKey}")`
            : res.updated
            ? `Updated "${plan.key}"="${plan.val}" and promoted to MRU Head`
            : `Inserted "${plan.key}"="${plan.val}" at MRU Head`;

          stageStatus.textContent = `STAGE 5: WAL APPEND (${plan.walFile}) → O(1) LRU CACHE UPDATE`;
          document.getElementById('pipeWALInfo').textContent = `Appended SEQ #${nodeObj.walRecords.length} + Flushed`;
          document.getElementById('pipeLRUInfo').textContent = `MRU Head: ${plan.key}`;
          renderClusterNodeCards(plan.targetNodeId, true, true);
          appendArchLog(
            'STEP 5/6',
            'WAL Flush + LRU PUT',
            `Node ${plan.targetNodeId} WAL & LRUCache`,
            `1) Appended PUT "${plan.key}" to ${plan.walFile} (SEQ #${nodeObj.walRecords.length}) and flushed durable record. 2) Acquired std::unique_lock<std::shared_mutex> and ${plan.executionOutcomeText}.`
          );
        } else if (plan.op === 'DELETE') {
          const res = nodeObj.del(plan.key, false);
          plan.statusHex = res.removed ? '0x00 (STATUS_OK)' : '0x01 (NOT_FOUND)';
          plan.executionOutcomeText = res.removed
            ? `Removed "${plan.key}" from std::unordered_map and unlinked Doubly Linked List node`
            : `Key "${plan.key}" not present in cache`;

          stageStatus.textContent = `STAGE 5: WAL APPEND (${plan.walFile}) → O(1) LRU DELETE`;
          document.getElementById('pipeWALInfo').textContent = `Appended SEQ #${nodeObj.walRecords.length} + Flushed`;
          document.getElementById('pipeLRUInfo').textContent = `Size: ${nodeObj.entries.length}/${nodeObj.capacity}`;
          renderClusterNodeCards(plan.targetNodeId, true, true);
          appendArchLog(
            'STEP 5/6',
            'WAL Flush + LRU DELETE',
            `Node ${plan.targetNodeId} WAL & LRUCache`,
            `1) Appended DELETE "${plan.key}" to ${plan.walFile} (SEQ #${nodeObj.walRecords.length}) and flushed to disk. 2) ${plan.executionOutcomeText}.`
          );
        } else {
          // GET
          const res = nodeObj.get(plan.key);
          plan.statusHex = res.hit ? '0x00 (STATUS_OK / HIT)' : '0x01 (NOT_FOUND / MISS)';
          plan.executionOutcomeText = res.hit
            ? `CACHE HIT: Value="${res.value}" (Promoted "${plan.key}" to MRU Head)`
            : `CACHE MISS: Key "${plan.key}" not found in Node ${plan.targetNodeId}`;

          stageStatus.textContent = `STAGE 5: O(1) LRU CACHE LOOKUP (NO WAL WRITE ON GET)`;
          document.getElementById('pipeWALInfo').textContent = `Bypassed (Read-Only GET)`;
          document.getElementById('pipeLRUInfo').textContent = res.hit ? `HIT → MRU: ${plan.key}` : `MISS (${plan.key})`;
          renderClusterNodeCards(plan.targetNodeId, true, false);
          appendArchLog(
            'STEP 5/6',
            'O(1) LRU Lookup',
            `Node ${plan.targetNodeId} LRUCache`,
            `${plan.executionOutcomeText}. Read operation does not mutate ${plan.walFile}.`
          );
        }

        // Sync other visualizers
        renderCacheEngineView();
        renderWalRecoveryView();
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

      appendArchLog(
        'STEP 6/6',
        'Return Binary Response',
        `Node ${plan.targetNodeId} → Coordinator → Client`,
        `Returned 16-byte response header [Magic=0xDC, Status=${plan.statusHex}, Node=${plan.targetNodeId}] to Python client.`
      );
      stopArchAutoRun();
    }
  }

  function stepArchForward() {
    if (state.arch.currentStage === 0 || state.arch.currentStage >= state.arch.maxStage) {
      const plan = buildArchitectureExecutionPlan();
      if (!plan) return;
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
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#000000" />
        </marker>
      </defs>
    `);

    // Clockwise indicator arc at top
    const cwArcStart = polarToXY(cx, cy, R + 32, -Math.PI * 0.63);
    const cwArcEnd = polarToXY(cx, cy, R + 32, -Math.PI * 0.37);
    parts.push(`
      <path d="M ${cwArcStart.x.toFixed(1)} ${cwArcStart.y.toFixed(1)} A ${R + 32} ${R + 32} 0 0 1 ${cwArcEnd.x.toFixed(1)} ${cwArcEnd.y.toFixed(1)}"
            fill="none" stroke="#000000" stroke-width="1.2" marker-end="url(#ringArrow)" />
      <text x="${cx}" y="${cy - R - 38}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">
        0x00000000 · CLOCKWISE SUCCESSOR LOOKUP
      </text>
    `);

    // Main Hash Space Circle
    parts.push(`
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#000000" stroke-width="1.5" />
      <circle cx="${cx}" cy="${cy}" r="${R - 22}" fill="none" stroke="#000000" stroke-width="0.5" stroke-dasharray="2,3" />
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
        `<line x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}" stroke="#000000" stroke-width="1" />`
      );
    }

    // Highlighted Clockwise Successor Search Arc from KeyHash to Successor VNode
    const arcPath = describeClockwiseArc(cx, cy, R + 16, routeRes.keyHash, routeRes.successor.hashPos);
    parts.push(`
      <path d="${arcPath}" fill="none" stroke="#000000" stroke-width="2.5" stroke-dasharray="4,2" marker-end="url(#ringArrow)" />
    `);

    // Key Hash Marker (Distinct Black-Outline Square + Radial Line)
    const keyAng = hashToAngleRad(routeRes.keyHash);
    const keyPt = polarToXY(cx, cy, R, keyAng);
    const keyLabelPt = polarToXY(cx, cy, R + 24, keyAng);
    parts.push(`
      <line x1="${cx}" y1="${cy}" x2="${keyPt.x.toFixed(2)}" y2="${keyPt.y.toFixed(2)}" stroke="#000000" stroke-width="1" stroke-dasharray="3,3" />
      <rect x="${(keyPt.x - 6).toFixed(2)}" y="${(keyPt.y - 6).toFixed(2)}" width="12" height="12" fill="#FFFFFF" stroke="#000000" stroke-width="2.5" />
      <circle cx="${keyPt.x.toFixed(2)}" cy="${keyPt.y.toFixed(2)}" r="2.5" fill="#000000" />
    `);

    // Highlighted Successor Virtual Node Marker (Solid Black Circle + Outer Ring)
    const succAng = hashToAngleRad(routeRes.successor.hashPos);
    const succPt = polarToXY(cx, cy, R, succAng);
    parts.push(`
      <line x1="${cx}" y1="${cy}" x2="${succPt.x.toFixed(2)}" y2="${succPt.y.toFixed(2)}" stroke="#000000" stroke-width="2" />
      <circle cx="${succPt.x.toFixed(2)}" cy="${succPt.y.toFixed(2)}" r="8" fill="#FFFFFF" stroke="#000000" stroke-width="2.5" />
      <circle cx="${succPt.x.toFixed(2)}" cy="${succPt.y.toFixed(2)}" r="4" fill="#000000" />
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
                stroke="#000000" stroke-width="2" marker-end="url(#ringArrow)" />
        `);
      }

      parts.push(`
        <rect x="${pb.x}" y="${pb.y}" width="${pb.w}" height="${pb.h}"
              fill="${isTarget ? '#000000' : '#FFFFFF'}"
              stroke="#000000" stroke-width="${isTarget ? '2.5' : '1'}" />
        <text x="${pb.x + 10}" y="${pb.y + 20}" font-family="Proxima Nova, sans-serif" font-size="12" font-weight="700"
              fill="${isTarget ? '#FFFFFF' : '#000000'}">${pb.label}</text>
        <text x="${pb.x + 10}" y="${pb.y + 36}" font-family="JetBrains Mono, monospace" font-size="10"
              fill="${isTarget ? '#FFFFFF' : '#000000'}">${pb.port}</text>
      `);
    }

    // Center Readout Badge inside the Ring
    parts.push(`
      <rect x="${cx - 102}" y="${cy - 44}" width="204" height="88" fill="#FFFFFF" stroke="#000000" stroke-width="1.5" />
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
      <rect x="${(calloutX - 48).toFixed(1)}" y="${(calloutY - 10).toFixed(1)}" width="96" height="18" fill="#FFFFFF" stroke="#000000" stroke-width="1" />
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

    const mruKey = node.entries.length > 0 ? node.entries[0].key : '—';
    const lruKey = node.entries.length > 0 ? node.entries[node.entries.length - 1].key : '—';

    document.getElementById('lruMetricSize').textContent = String(node.entries.length);
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
            <div class="dll-node-box ${isHead ? 'mru-node' : ''} ${isTail ? 'lru-node' : ''}">
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

    if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(
        JSON.stringify({
          type: 'execute_op',
          directNodeId: node.nodeId,
          op,
          key,
          value: val,
        })
      );
    }

    if (op === 'PUT') {
      const outcome = node.put(key, val, false);
      if (outcome.evicted) {
        state.lastCacheBanner = `PUT("${key}", "${val}"): Capacity (${node.capacity}) reached → Evicted LRU TAIL "${outcome.evictedKey}" in O(1) and inserted "${key}" at HEAD`;
      } else if (outcome.updated) {
        state.lastCacheBanner = `PUT("${key}", "${val}"): Updated value in O(1) and promoted node to MRU HEAD`;
      } else {
        state.lastCacheBanner = `PUT("${key}", "${val}"): Inserted new Node* at MRU HEAD and indexed in std::unordered_map in O(1)`;
      }
    } else if (op === 'GET') {
      const outcome = node.get(key);
      if (outcome.hit) {
        state.lastCacheBanner = `GET("${key}") → HIT ("${outcome.value}"): Detached Node* and moved to MRU HEAD in O(1)`;
      } else {
        state.lastCacheBanner = `GET("${key}") → CACHE MISS: Key not found in std::unordered_map (O(1))`;
      }
    } else if (op === 'DELETE') {
      const outcome = node.del(key, false);
      state.lastCacheBanner = outcome.removed
        ? `DELETE("${key}") → O(1) Detach from Doubly Linked List + std::unordered_map::erase`
        : `DELETE("${key}") → Key not found`;
    }

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

    if (state.recoveryStep === 1) {
      stage6Text.textContent = 'ONLINE';
      memBanner.textContent = 'STATE: ONLINE (SYNCHRONIZED WITH LOCAL WAL)';
    } else if (state.recoveryStep === 2) {
      stage6Text.textContent = 'RESTARTING...';
      memBanner.textContent = `STATE: SIMULATING NODE ${nodeId} PROCESS RESTART`;
    } else if (state.recoveryStep === 3) {
      stage6Text.textContent = 'RAM CLEARED';
      memBanner.textContent = 'STATE: VOLATILE IN-MEMORY CACHE CLEARED (0 ENTRIES)';
    } else if (state.recoveryStep === 4) {
      stage6Text.textContent = `REPLAYING (${state.recoveryReplayedCount}/${node.walRecords.length})`;
      memBanner.textContent = `STATE: REPLAYING ${node.walFile} SEQUENTIALLY (${state.recoveryReplayedCount} / ${node.walRecords.length} RECORDS)`;
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
          let replayStatus = 'DURABLE ON DISK';
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
    if (node.walRecords.length === 0) {
      node.put('acct:301', 'bal=4500', false);
      node.put('acct:302', 'bal=9200', false);
      node.put('acct:301', 'bal=5100', false);
    }

    if (state.recoveryStep === 1 || state.recoveryStep >= 6) {
      state.recoveryStep = 2; // Step 2: Simulate Node Restart
    } else if (state.recoveryStep === 2) {
      state.recoveryStep = 3; // Step 3: Clear In-Memory State
      node.clearMemoryOnly();
      state.recoveryReplayedCount = 0;
      if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'node_recover', nodeId: node.nodeId, stage: 'CLEAR_MEMORY' }));
      }
    } else if (state.recoveryStep === 3) {
      state.recoveryStep = 4; // Step 4: Replay WAL Operations in Order
      state.recoveryReplayedCount = 1;
      node.replayWalUpTo(state.recoveryReplayedCount);
    } else if (state.recoveryStep === 4) {
      if (state.recoveryReplayedCount < node.walRecords.length) {
        state.recoveryReplayedCount += 1;
        node.replayWalUpTo(state.recoveryReplayedCount);
      } else {
        state.recoveryStep = 5; // Step 5: Show Reconstructed Cache
        if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'node_recover', nodeId: node.nodeId, stage: 'REPLAY_WAL' }));
        }
      }
    } else if (state.recoveryStep === 5) {
      state.recoveryStep = 6; // Step 6: Mark Recovery Complete
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
    if (node.walRecords.length === 0) {
      node.put('acct:301', 'bal=4500', false);
      node.put('acct:302', 'bal=9200', false);
      node.put('acct:301', 'bal=5100', false);
    }

    state.recoveryStep = 1;
    renderWalRecoveryView();

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
        successful_ops: totalReqs,
        failed_ops: 0,
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

    renderPerformanceLab();
  }

  function renderPerformanceLineChart(report) {
    const svg = document.getElementById('perfLineChartSvg');
    if (!svg || !report || !report.series || report.series.length === 0) return;

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
              stroke="#000000" stroke-width="${g === 4 ? '1.5' : '0.4'}" ${g < 4 ? 'stroke-dasharray="2,3"' : ''} />
        <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9">${opsVal}</text>
        <text x="${W - padR + 6}" y="${(y + 3).toFixed(1)}" text-anchor="start" font-family="JetBrains Mono, monospace" font-size="9">${latVal}ms</text>
      `);
    }

    // Axes & Legend
    out.push(`
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#000000" stroke-width="1.2" />
      <line x1="${W - padR}" y1="${padT}" x2="${W - padR}" y2="${padT + plotH}" stroke="#000000" stroke-width="1.2" />
      <text x="${padL}" y="15" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">── THROUGHPUT (ops/s)</text>
      <text x="${padL + 165}" y="15" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">- - P99 LATENCY (ms)</text>
      <text x="${padL + 320}" y="15" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">··· P50 LATENCY (ms)</text>
    `);

    const opsPoints = series.map((s, i) => `${xAt(i).toFixed(1)},${yOps(s.ops_per_sec).toFixed(1)}`).join(' ');
    const p99Points = series.map((s, i) => `${xAt(i).toFixed(1)},${yLat(s.p99_ms).toFixed(1)}`).join(' ');
    const p50Points = series.map((s, i) => `${xAt(i).toFixed(1)},${yLat(s.p50_ms).toFixed(1)}`).join(' ');

    out.push(`
      <polyline points="${opsPoints}" fill="none" stroke="#000000" stroke-width="2" />
      <polyline points="${p99Points}" fill="none" stroke="#000000" stroke-width="1.5" stroke-dasharray="5,3" />
      <polyline points="${p50Points}" fill="none" stroke="#000000" stroke-width="1.5" stroke-dasharray="2,2" />
    `);

    series.forEach((s, i) => {
      const cx = xAt(i);
      const cyOps = yOps(s.ops_per_sec);
      const cyP99 = yLat(s.p99_ms);
      out.push(`
        <circle cx="${cx.toFixed(1)}" cy="${cyOps.toFixed(1)}" r="3" fill="#000000" />
        <rect x="${(cx - 2.5).toFixed(1)}" y="${(cyP99 - 2.5).toFixed(1)}" width="5" height="5" fill="#FFFFFF" stroke="#000000" stroke-width="1.5" />
        <text x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9">W${s.bucket}</text>
      `);
    });

    svg.innerHTML = out.join('');
  }

  function renderPerformanceBarChart(report) {
    const svg = document.getElementById('perfBarChartSvg');
    if (!svg || !report) return;

    const W = 560;
    const H = 250;
    const nd = report.node_distribution || { node_1: 0, node_2: 0, node_3: 0 };
    const m = report.metrics;

    const totalNodeReqs = Math.max(1, (nd.node_1 || 0) + (nd.node_2 || 0) + (nd.node_3 || 0));
    const n1Pct = (((nd.node_1 || 0) / totalNodeReqs) * 100).toFixed(1);
    const n2Pct = (((nd.node_2 || 0) / totalNodeReqs) * 100).toFixed(1);
    const n3Pct = (((nd.node_3 || 0) / totalNodeReqs) * 100).toFixed(1);

    const maxNodeCount = Math.max(nd.node_1 || 0, nd.node_2 || 0, nd.node_3 || 0, 10) * 1.2;

    const p50 = m.p50_latency_ms || 0.4;
    const p90 = m.p90_latency_ms || Number((p50 * 1.7).toFixed(3));
    const p95 = m.p95_latency_ms || Number((p50 * 2.1).toFixed(3));
    const p99 = m.p99_latency_ms || 1.2;
    const maxPctLat = Math.max(p99, 0.5) * 1.25;

    let out = [];

    // Left Half: Per-Node Request Distribution Bars
    out.push(`
      <text x="20" y="18" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">A. PER-NODE REQUEST DISTRIBUTION</text>
      <line x1="20" y1="210" x2="255" y2="210" stroke="#000000" stroke-width="1.5" />
    `);

    const nodeBars = [
      { label: 'Node 1 (:8001)', count: nd.node_1 || 0, pct: n1Pct, fill: '#000000', textFill: '#000000' },
      { label: 'Node 2 (:8002)', count: nd.node_2 || 0, pct: n2Pct, fill: '#FFFFFF', textFill: '#000000' },
      { label: 'Node 3 (:8003)', count: nd.node_3 || 0, pct: n3Pct, fill: '#000000', textFill: '#000000' },
    ];

    nodeBars.forEach((b, idx) => {
      const bx = 34 + idx * 74;
      const bh = Math.max(4, (b.count / maxNodeCount) * 155);
      const by = 210 - bh;
      out.push(`
        <rect x="${bx}" y="${by.toFixed(1)}" width="46" height="${bh.toFixed(1)}" fill="${b.fill}" stroke="#000000" stroke-width="1.5" />
        <text x="${bx + 23}" y="${(by - 14).toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">${b.count}</text>
        <text x="${bx + 23}" y="${(by - 4).toFixed(1)}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="8">(${b.pct}%)</text>
        <text x="${bx + 23}" y="226" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="9">${b.label.split(' ')[0]} ${b.label.split(' ')[1]}</text>
      `);
    });

    // Divider between subcharts
    out.push(`<line x1="275" y1="10" x2="275" y2="235" stroke="#000000" stroke-width="0.7" stroke-dasharray="3,3" />`);

    // Right Half: Latency Percentile Bars (P50, P90, P95, P99)
    out.push(`
      <text x="295" y="18" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">B. LATENCY PERCENTILES (ms)</text>
      <line x1="295" y1="210" x2="545" y2="210" stroke="#000000" stroke-width="1.5" />
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
              fill="${isTail ? '#000000' : '#FFFFFF'}" stroke="#000000" stroke-width="1.5" />
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
    document.getElementById('perfMetricSuccess').textContent = Number(m.successful_ops).toLocaleString();
    document.getElementById('perfMetricFailed').textContent = Number(m.failed_ops).toLocaleString();
    document.getElementById('perfMetricThroughput').textContent = `${Number(m.throughput_ops_sec).toLocaleString()} ops/s`;
    document.getElementById('perfMetricWorkersSub').textContent = `${cfg.workers} concurrent workers`;
    document.getElementById('perfMetricP50').textContent = `${m.p50_latency_ms} ms`;
    document.getElementById('perfMetricP99').textContent = `${m.p99_latency_ms} ms`;

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
            <td class="mono">${Number(rep.metrics.successful_ops).toLocaleString()} / ${rep.metrics.failed_ops}</td>
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
    if (workers < 1 || workers > 500) {
      banner.hidden = false;
      banner.textContent = 'WORKERS VALIDATION: Enter between 1 and 200 concurrent worker threads (50+ recommended for concurrency demonstration).';
      return null;
    }
    banner.hidden = true;

    const targetMode =
      state.perfViewMode === 'coordinator'
        ? 'coordinator'
        : document.getElementById('perfSingleNodeSelect').value;

    return { targetMode, getPct, putPct, delPct, workers, totalReqs };
  }

  // ==========================================================================
  // 11. EVENT LISTENERS & INITIALIZATION
  // ==========================================================================
  function bindEvents() {
    // Topbar Navigation Active State
    const navLinks = document.querySelectorAll('.main-nav .nav-link');
    navLinks.forEach((link) => {
      link.addEventListener('click', () => {
        navLinks.forEach((l) => l.classList.remove('active'));
        link.classList.add('active');
      });
    });

    // Mode Toggle (Demo Mode vs Live C++ Cluster Mode)
    document.getElementById('modeToggleBtn').addEventListener('click', () => {
      if (!state.bridgeConnected) {
        updateModeIndicator(false);
        return;
      }
      state.liveMode = !state.liveMode;
      updateModeIndicator(true);
      if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'inspect_cluster' }));
      }
    });

    // Motion Toggle (Standard vs Reduced Motion)
    document.getElementById('motionToggleBtn').addEventListener('click', () => {
      state.reducedMotion = !state.reducedMotion;
      document.getElementById('motionBtnText').textContent = state.reducedMotion
        ? 'MOTION: REDUCED'
        : 'MOTION: STANDARD';
    });

    // Architecture Controls
    const archOpBtns = document.querySelectorAll('#archOpGroup .seg-btn');
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
      resetArchFlow();
      document.getElementById('architecture').scrollIntoView({ behavior: 'smooth' });
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
      node.setCapacity(newCap);
      state.lastCacheBanner = `Updated Node ${node.nodeId} Demo Capacity to ${node.capacity} entries (System Default: 100,000)`;
      if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            type: 'node_config',
            nodeId: node.nodeId,
            configKey: 'CAPACITY',
            configValue: String(newCap),
          })
        );
      }
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
      node.clearAll();
      state.lastCacheBanner = `Cleared Node ${node.nodeId} in-memory cache and WAL.`;
      if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            type: 'node_config',
            nodeId: node.nodeId,
            configKey: 'RESET',
            configValue: '',
          })
        );
      }
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
      if (op === 'PUT') {
        node.put(key, val, false);
      } else {
        node.del(key, false);
      }
      if (state.liveMode && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            type: 'execute_op',
            directNodeId: node.nodeId,
            op,
            key,
            value: val,
          })
        );
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
        btn.disabled = true;
        btn.textContent = 'Running 50+ Workers...';
        state.ws.send(
          JSON.stringify({
            type: 'run_benchmark',
            params: {
              targetMode: params.targetMode,
              totalRequests: params.totalReqs,
              workers: params.workers,
              getPct: params.getPct,
              putPct: params.putPct,
              deletePct: params.delPct,
            },
          })
        );
      } else {
        const simReport = generateDeterministicIllustrativeReport(
          params.targetMode,
          params.workers,
          params.totalReqs,
          params.getPct,
          params.putPct,
          params.delPct
        );
        applyBenchmarkReport(simReport, 'ILLUSTRATIVE DATA (SIMULATED)');
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
    seedInitialClusterState();

    // Generate initial illustrative benchmark reports for both Coordinator & Single Data Node views
    state.perfReports.coordinator = generateDeterministicIllustrativeReport(
      'coordinator',
      50,
      2500,
      70,
      20,
      10
    );
    state.perfReports.single_node = generateDeterministicIllustrativeReport(
      'node_1',
      50,
      2500,
      70,
      20,
      10
    );

    bindEvents();
    applyArchStageVisuals(0);
    renderHashRingVisualizer();
    renderCacheEngineView();
    renderWalRecoveryView();
    renderPerformanceLab();
    initWebSocketBridge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();