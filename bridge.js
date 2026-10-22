/**
 * DisCache — Separate Integration Adapter (bridge.js)
 * ====================================================
 * Keeps the core C++ Coordinator (:8000) and Data Nodes (:8001, :8002, :8003)
 * pure raw-TCP binary-protocol processes while allowing the browser laboratory
 * to inspect live cluster state, execute binary requests, trigger WAL crash
 * recovery, and run the multi-threaded Python load tester.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');

const HTTP_PORT = Number(process.env.BRIDGE_PORT || 8080);
const COORD_HOST = process.env.COORD_HOST || '127.0.0.1';
const COORD_PORT = Number(process.env.COORD_PORT || 8000);
const NODE_PORTS = {
  1: Number(process.env.NODE1_PORT || 8001),
  2: Number(process.env.NODE2_PORT || 8002),
  3: Number(process.env.NODE3_PORT || 8003),
};

const PROTOCOL_MAGIC = 0xDC;
const OP = {
  GET: 0x01,
  PUT: 0x02,
  DELETE: 0x03,
  INSPECT: 0x04,
  RECOVER: 0x05,
  CONFIG: 0x06,
  PING: 0x07,
};

const publicDir = path.join(__dirname, 'public');
const appRoutes = new Set([
  '/',
  '/playground',
  '/how-it-works',
  '/hash-ring',
  '/cache',
  '/recovery',
  '/performance',
  '/guide',
  '/architecture',
]);

function encodeBinaryRequest(opcode, key = '', value = '') {
  const keyBuf = Buffer.from(String(key), 'utf8');
  const valBuf = Buffer.from(String(value), 'utf8');
  const header = Buffer.alloc(10);
  header.writeUInt8(PROTOCOL_MAGIC, 0);
  header.writeUInt8(opcode, 1);
  header.writeUInt32BE(keyBuf.length, 2);
  header.writeUInt32BE(valBuf.length, 6);
  return Buffer.concat([header, keyBuf, valBuf]);
}

function sendBinaryRequest(host, port, opcode, key = '', value = '', timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const reqBuf = encodeBinaryRequest(opcode, key, value);
    const startNs = process.hrtime.bigint();
    const socket = net.createConnection({ host, port });
    let recvBuf = Buffer.alloc(0);
    let settled = false;

    const finishError = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => finishError(new Error(`TCP timeout (${host}:${port})`)));
    socket.on('error', finishError);

    socket.on('connect', () => {
      socket.setNoDelay(true);
      socket.write(reqBuf);
    });

    socket.on('data', (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      if (recvBuf.length < 16) return;

      const magic = recvBuf.readUInt8(0);
      if (magic !== PROTOCOL_MAGIC) {
        return finishError(new Error(`Invalid binary magic byte: 0x${magic.toString(16)}`));
      }
      const status = recvBuf.readUInt8(1);
      const nodeId = recvBuf.readUInt16BE(2);
      const keyHash = recvBuf.readUInt32BE(4);
      const vnodeHash = recvBuf.readUInt32BE(8);
      const payloadLen = recvBuf.readUInt32BE(12);

      if (recvBuf.length < 16 + payloadLen) return;

      const responseFrame = recvBuf.subarray(0, 16 + payloadLen);
      const payload = responseFrame.subarray(16).toString('utf8');
      const elapsedUs = Number(process.hrtime.bigint() - startNs) / 1000;

      settled = true;
      socket.end();
      resolve({
        status,
        statusText: status === 0 ? 'OK' : status === 1 ? 'NOT_FOUND' : 'ERROR',
        nodeId,
        keyHash,
        vnodeHash,
        payloadLen,
        payload,
        elapsedUs,
        wireRequestHex: reqBuf.toString('hex'),
        wireResponseHex: responseFrame.subarray(0, Math.min(responseFrame.length, 64)).toString('hex'),
      });
    });

    socket.on('close', () => {
      if (!settled) {
        finishError(new Error(`Connection closed before complete binary response (${host}:${port})`));
      }
    });
  });
}

function unescapeField(s = '') {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function parseNodeInspectPayload(raw) {
  const state = {
    nodeId: 0,
    port: 0,
    walFile: '',
    size: 0,
    capacity: 100000,
    mruKey: '',
    lruKey: '',
    hits: 0,
    misses: 0,
    evictions: 0,
    totalReqs: 0,
    walSeq: 0,
    entries: [],
    walRecords: [],
  };

  const lines = String(raw).split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const tag = parts[0];
    if (tag === 'NODE_ID') state.nodeId = Number(parts[1]);
    else if (tag === 'PORT') state.port = Number(parts[1]);
    else if (tag === 'WAL_FILE') state.walFile = parts[1] || '';
    else if (tag === 'SIZE') state.size = Number(parts[1]);
    else if (tag === 'CAPACITY') state.capacity = Number(parts[1]);
    else if (tag === 'MRU_KEY') state.mruKey = unescapeField(parts[1] || '');
    else if (tag === 'LRU_KEY') state.lruKey = unescapeField(parts[1] || '');
    else if (tag === 'HITS') state.hits = Number(parts[1]);
    else if (tag === 'MISSES') state.misses = Number(parts[1]);
    else if (tag === 'EVICTIONS') state.evictions = Number(parts[1]);
    else if (tag === 'TOTAL_REQS') state.totalReqs = Number(parts[1]);
    else if (tag === 'WAL_SEQ') state.walSeq = Number(parts[1]);
    else if (tag === 'ENTRY') {
      state.entries.push({
        key: unescapeField(parts[1] || ''),
        value: unescapeField(parts[2] || ''),
      });
    } else if (tag === 'WAL') {
      state.walRecords.push({
        seq: Number(parts[1]),
        timestampMs: Number(parts[2]),
        op: parts[3] || 'PUT',
        key: unescapeField(parts[4] || ''),
        value: unescapeField(parts[5] || ''),
      });
    }
  }
  return state;
}

function parseRingInspectPayload(raw) {
  const ring = {
    coordinatorPort: COORD_PORT,
    totalVnodes: 0,
    vnodesPerNode: 100,
    totalRouted: 0,
    nodeRouted: { 1: 0, 2: 0, 3: 0 },
    vnodes: [],
  };

  const lines = String(raw).split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const tag = parts[0];
    if (tag === 'COORDINATOR_PORT') ring.coordinatorPort = Number(parts[1]);
    else if (tag === 'TOTAL_VNODES') ring.totalVnodes = Number(parts[1]);
    else if (tag === 'VNODES_PER_NODE') ring.vnodesPerNode = Number(parts[1]);
    else if (tag === 'TOTAL_ROUTED') ring.totalRouted = Number(parts[1]);
    else if (tag === 'NODE_1_ROUTED') ring.nodeRouted[1] = Number(parts[1]);
    else if (tag === 'NODE_2_ROUTED') ring.nodeRouted[2] = Number(parts[1]);
    else if (tag === 'NODE_3_ROUTED') ring.nodeRouted[3] = Number(parts[1]);
    else if (tag === 'VNODE') {
      ring.vnodes.push({
        hashPos: Number(parts[1]),
        nodeId: Number(parts[2]),
        vnodeIndex: Number(parts[3]),
        port: Number(parts[4]),
        label: parts[5] || '',
      });
    }
  }
  return ring;
}

function resolvePythonExecutable() {
  if (process.env.DISCACHE_PYTHON) return process.env.DISCACHE_PYTHON;
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['python'], { encoding: 'utf8', windowsHide: true });
    const candidates = String(result.stdout || '').split(/\r?\n/).map((value) => value.trim());
    const executable = candidates.find((candidate) =>
      candidate && !/\\WindowsApps\\/i.test(candidate) && fs.existsSync(candidate)
    );
    if (executable) return executable;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function fetchClusterSnapshot() {
  const status = {
    coordinatorOnline: false,
    nodesOnline: { 1: false, 2: false, 3: false },
    coordinator: null,
    nodes: {},
  };

  try {
    const coordRes = await sendBinaryRequest(COORD_HOST, COORD_PORT, OP.INSPECT, 'RING', '', 1200);
    status.coordinatorOnline = true;
    status.coordinator = parseRingInspectPayload(coordRes.payload);
  } catch (_) {
    status.coordinatorOnline = false;
  }

  for (const nodeId of [1, 2, 3]) {
    try {
      const nodeRes = await sendBinaryRequest(COORD_HOST, NODE_PORTS[nodeId], OP.INSPECT, '', '', 1200);
      status.nodesOnline[nodeId] = true;
      status.nodes[nodeId] = parseNodeInspectPayload(nodeRes.payload);
    } catch (_) {
      status.nodesOnline[nodeId] = false;
    }
  }

  return status;
}

function runPythonLoadTester(params) {
  return new Promise((resolve, reject) => {
    const targetMode = params.targetMode || 'coordinator';
    const port = targetMode === 'node_1' ? NODE_PORTS[1]
               : targetMode === 'node_2' ? NODE_PORTS[2]
               : targetMode === 'node_3' ? NODE_PORTS[3]
               : COORD_PORT;

    const requests = Math.min(20000, Math.max(100, Number(params.totalRequests || 2000)));
    const workers = Math.min(200, Math.max(1, Number(params.workers || 50)));
    const getPct = Number(params.getPct ?? 70);
    const putPct = Number(params.putPct ?? 20);
    const deletePct = Number(params.deletePct ?? 10);
    const keyspace = Math.max(10, Number(params.keyspace || 300));

    const scriptPath = path.join(__dirname, 'load_tester.py');
    const outFile = path.join(__dirname, 'benchmark_results.json');

    const args = [
      scriptPath,
      '--host', COORD_HOST,
      '--port', String(port),
      '--target', targetMode,
      '--requests', String(requests),
      '--workers', String(workers),
      '--get-pct', String(getPct),
      '--put-pct', String(putPct),
      '--delete-pct', String(deletePct),
      '--keyspace', String(keyspace),
      '--out', outFile,
      '--json',
    ];

    const proc = spawn(resolvePythonExecutable(), args, { cwd: __dirname, windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `load_tester.py exited with code ${code}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Failed to parse load_tester output: ${e.message}`));
      }
    });
  });
}

// Optional auto-launcher for local C++ cluster processes if binaries exist
let clusterAttempted = false;
async function ensureLocalClusterRunning() {
  if (clusterAttempted) return;
  clusterAttempted = true;
  const snap = await fetchClusterSnapshot();
  if (snap.coordinatorOnline && snap.nodesOnline[1] && snap.nodesOnline[2] && snap.nodesOnline[3]) {
    console.log('[Bridge] Connected to live C++20 DisCache cluster (:8000, :8001, :8002, :8003)');
    return;
  }

  const onlineNodeCount = Object.values(snap.nodesOnline).filter(Boolean).length;
  if (snap.coordinatorOnline || onlineNodeCount > 0) {
    console.warn('[Bridge] A partial DisCache cluster is already running; refusing to start duplicate processes.');
    return;
  }

  const coordBin = path.join(__dirname, 'discache_coordinator');
  const nodeBin = path.join(__dirname, 'discache_node');
  if (fs.existsSync(coordBin) && fs.existsSync(nodeBin) && process.platform === 'win32') {
    const wslProbe = spawnSync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', 'true'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (wslProbe.error || wslProbe.status !== 0) {
      console.error('[Bridge] Cannot auto-start the C++ cluster: the WSL distribution "Ubuntu" is unavailable. Install/configure Ubuntu in WSL or start the four C++ services manually.');
      return;
    }

    const wslDir = __dirname.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, '/');
    console.log('[Bridge] Starting 4 C++20 DisCache processes in WSL (:8000, :8001, :8002, :8003)...');
    const cmd = `cd "${wslDir}" && ./discache_node 1 8001 node_1.log >/dev/null 2>&1 & ./discache_node 2 8002 node_2.log >/dev/null 2>&1 & ./discache_node 3 8003 node_3.log >/dev/null 2>&1 & sleep 0.4 && ./discache_coordinator 8000 >/dev/null 2>&1 & wait`;
    const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', cmd], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', (error) => {
      console.error(`[Bridge] Failed to launch the WSL cluster: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        console.error(`[Bridge] WSL cluster launcher exited with code ${code}${signal ? ` (signal ${signal})` : ''}.`);
      }
    });
    process.on('exit', () => {
      try { child.kill(); } catch (_) {}
    });
  } else if (process.platform === 'win32') {
    console.warn('[Bridge] C++ cluster binaries are missing; live mode is unavailable until the services are built and started.');
  }
}

const server = http.createServer(async (req, res) => {
  const urlParts = req.url.split('?');
  const pathname = urlParts[0];

  if (pathname === '/api/benchmark_results.json') {
    const benchFile = path.join(__dirname, 'benchmark_results.json');
    if (fs.existsSync(benchFile)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(fs.readFileSync(benchFile));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No exported benchmark_results.json found yet.' }));
  }

  const requested = appRoutes.has(pathname) ? '/index.html' : pathname;
  const file = path.normalize(path.join(publicDir, requested));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const type = file.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : file.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : file.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  const send = (payload) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  // Send initial cluster snapshot
  try {
    const snapshot = await fetchClusterSnapshot();
    send({ type: 'cluster_snapshot', snapshot });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  ws.on('message', async (rawMessage) => {
    let requestId = null;
    try {
      const msg = JSON.parse(rawMessage.toString());
      requestId = msg.requestId || null;

      if (msg.type === 'inspect_cluster') {
        const snapshot = await fetchClusterSnapshot();
        send({ type: 'cluster_snapshot', snapshot });
      } else if (msg.type === 'execute_op') {
        const opName = String(msg.op || 'GET').toUpperCase();
        const opcode = opName === 'PUT' ? OP.PUT : opName === 'DELETE' ? OP.DELETE : OP.GET;
        const key = String(msg.key || '');
        const value = String(msg.value || '');
        const targetPort = msg.directNodeId ? NODE_PORTS[msg.directNodeId] : COORD_PORT;

        const result = await sendBinaryRequest(COORD_HOST, targetPort, opcode, key, value);
        const snapshot = await fetchClusterSnapshot();
        send({
          type: 'op_result',
          requestId: msg.requestId || null,
          op: opName,
          key,
          value,
          targetPort,
          result,
          snapshot,
        });
      } else if (msg.type === 'node_recover') {
        const nodeId = Number(msg.nodeId || 1);
        const port = NODE_PORTS[nodeId] || NODE_PORTS[1];
        const stage = msg.stage || 'FULL';

        if (stage === 'CLEAR_MEMORY') {
          const res = await sendBinaryRequest(COORD_HOST, port, OP.RECOVER, 'CLEAR_MEMORY', '');
          const snapshot = await fetchClusterSnapshot();
          send({ type: 'recover_result', requestId, nodeId, stage, result: res, snapshot });
        } else {
          const res = await sendBinaryRequest(COORD_HOST, port, OP.RECOVER, 'REPLAY_WAL', '');
          const snapshot = await fetchClusterSnapshot();
          send({ type: 'recover_result', requestId, nodeId, stage: 'REPLAY_WAL', result: res, snapshot });
        }
      } else if (msg.type === 'node_config') {
        const nodeId = Number(msg.nodeId || 1);
        const port = NODE_PORTS[nodeId] || NODE_PORTS[1];
        const configKey = String(msg.configKey || 'CAPACITY');
        const configVal = String(msg.configValue || '100000');

        const res = await sendBinaryRequest(COORD_HOST, port, OP.CONFIG, configKey, configVal);
        const snapshot = await fetchClusterSnapshot();
        send({ type: 'config_result', requestId, nodeId, configKey, configVal, result: res, snapshot });
      } else if (msg.type === 'reset_cluster') {
        for (const nid of [1, 2, 3]) {
          try {
            await sendBinaryRequest(COORD_HOST, NODE_PORTS[nid], OP.CONFIG, 'RESET', '');
          } catch (_) {}
        }
        const snapshot = await fetchClusterSnapshot();
        send({ type: 'cluster_snapshot', snapshot });
      } else if (msg.type === 'run_benchmark') {
        send({ type: 'benchmark_started', requestId, params: msg.params });
        const report = await runPythonLoadTester(msg.params || {});
        const snapshot = await fetchClusterSnapshot();
        send({ type: 'benchmark_result', requestId, report, snapshot });
      }
    } catch (error) {
      send({ type: 'error', requestId, message: error.message });
    }
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`DisCache Lab Bridge listening at http://localhost:${HTTP_PORT}`);
  ensureLocalClusterRunning().catch((error) => {
    console.error(`[Bridge] Cluster startup check failed: ${error.message}`);
  });
});