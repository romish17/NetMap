/**
 * NetMap – Central Server
 * Fastify + SQLite + WebSocket
 *
 * install: npm i fastify @fastify/websocket @fastify/cors better-sqlite3 node-fetch
 */

import Fastify            from "fastify";
import websocketPlugin    from "@fastify/websocket";
import corsPlugin         from "@fastify/cors";
import Database           from "better-sqlite3";
import { readFileSync }   from "fs";
import { createHash }     from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT         ?? "3000");
const HOST         = process.env.HOST                  ?? "0.0.0.0";
const AGENT_TOKEN  = process.env.NETMAP_TOKEN          ?? "changeme";
const DB_PATH      = process.env.DB_PATH               ?? "./netmap.db";

const PROXMOX_HOST = process.env.PROXMOX_HOST;          // e.g. "192.168.1.200:8006"
const PROXMOX_USER = process.env.PROXMOX_USER           ?? "root@pam";
const PROXMOX_PASS = process.env.PROXMOX_PASS;
const PROXMOX_POLL = parseInt(process.env.PROXMOX_POLL  ?? "60") * 1000;

// ─── Database ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    hostname    TEXT,
    last_seen   INTEGER,
    data        TEXT   -- JSON blob of full report
  );

  CREATE TABLE IF NOT EXISTS proxmox_nodes (
    id          TEXT PRIMARY KEY,   -- "proxmox/{node}"
    node        TEXT,
    last_seen   INTEGER,
    data        TEXT                -- JSON blob
  );

  CREATE TABLE IF NOT EXISTS proxmox_vms (
    id          TEXT PRIMARY KEY,   -- "proxmox/{node}/{vmid}"
    node        TEXT,
    vmid        INTEGER,
    type        TEXT,               -- "qemu" | "lxc"
    last_seen   INTEGER,
    data        TEXT
  );

  CREATE TABLE IF NOT EXISTS topology_edges (
    id          TEXT PRIMARY KEY,
    source      TEXT,
    target      TEXT,
    edge_type   TEXT,              -- "hypervisor_vm" | "vm_container" | "agent_link"
    last_seen   INTEGER
  );
`);

// ─── Prepared statements ─────────────────────────────────────────────────────

const upsertAgent = db.prepare(`
  INSERT INTO agents (id, hostname, last_seen, data)
  VALUES (@id, @hostname, @last_seen, @data)
  ON CONFLICT(id) DO UPDATE SET
    hostname  = excluded.hostname,
    last_seen = excluded.last_seen,
    data      = excluded.data
`);

const upsertProxmoxNode = db.prepare(`
  INSERT INTO proxmox_nodes (id, node, last_seen, data)
  VALUES (@id, @node, @last_seen, @data)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = excluded.last_seen, data = excluded.data
`);

const upsertProxmoxVM = db.prepare(`
  INSERT INTO proxmox_vms (id, node, vmid, type, last_seen, data)
  VALUES (@id, @node, @vmid, @type, @last_seen, @data)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = excluded.last_seen, data = excluded.data
`);

const upsertEdge = db.prepare(`
  INSERT INTO topology_edges (id, source, target, edge_type, last_seen)
  VALUES (@id, @source, @target, @edge_type, @last_seen)
  ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen
`);

// ─── Fastify ─────────────────────────────────────────────────────────────────

const app = Fastify({ logger: { level: "info" } });

await app.register(corsPlugin, { origin: true });
await app.register(websocketPlugin);

// WebSocket clients for live push
const wsClients = new Set();

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of wsClients) {
    try { client.send(msg); } catch { wsClients.delete(client); }
  }
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

function checkAgentToken(req, reply) {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${AGENT_TOKEN}`) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** POST /api/agent/report  – Agent push */
app.post("/api/agent/report", async (req, reply) => {
  if (!checkAgentToken(req, reply)) return;

  const report = req.body;
  if (!report?.agent_id) return reply.code(400).send({ error: "missing agent_id" });

  const now = Date.now();

  upsertAgent.run({
    id:        report.agent_id,
    hostname:  report.hostname ?? report.agent_id,
    last_seen: now,
    data:      JSON.stringify(report),
  });

  // Derive VM→Container edges from docker data
  if (report.docker?.available && report.docker.containers?.length) {
    for (const c of report.docker.containers) {
      const edgeId = `${report.agent_id}::docker::${c.id}`;
      upsertEdge.run({
        id:        edgeId,
        source:    report.agent_id,
        target:    `docker::${report.agent_id}::${c.id}`,
        edge_type: "vm_container",
        last_seen: now,
      });
    }
  }

  broadcast("agent_updated", { agent_id: report.agent_id });
  return { ok: true };
});

/** GET /api/topology  – Full topology for the frontend */
app.get("/api/topology", async () => {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 min

  const nodes = [];
  const edges = [];
  const groups = {};   // groupId → { label, type, children[] }

  // ── Agents ──
  for (const row of db.prepare("SELECT * FROM agents ORDER BY last_seen DESC").all()) {
    const data   = JSON.parse(row.data);
    const stale  = (now - row.last_seen) > staleThreshold;
    const nodeId = row.id;

    // Best IP from interfaces
    const primaryIP = data.interfaces?.[0]?.ip ?? "?";

    nodes.push({
      id:       nodeId,
      label:    data.hostname ?? row.id,
      type:     "agent",
      ip:       primaryIP,
      os:       data.system?.os ?? "",
      last_seen: row.last_seen,
      stale,
      // Detail payload
      detail: {
        system:     data.system,
        interfaces: data.interfaces,
        open_ports: data.open_ports,
        shares:     data.shares,
        docker:     data.docker,
      },
    });

    // Docker containers as child nodes
    if (data.docker?.available) {
      for (const c of data.docker.containers ?? []) {
        const cId = `docker::${nodeId}::${c.id}`;
        nodes.push({
          id:       cId,
          label:    c.name,
          type:     "container",
          image:    c.image,
          state:    c.state,
          parent:   nodeId,
          stale,
          detail: { container: c },
        });
        edges.push({ source: nodeId, target: cId, type: "vm_container" });
      }
    }
  }

  // ── Proxmox nodes ──
  for (const row of db.prepare("SELECT * FROM proxmox_nodes").all()) {
    const data  = JSON.parse(row.data);
    const stale = (now - row.last_seen) > staleThreshold;
    nodes.push({
      id:       row.id,
      label:    row.node,
      type:     "proxmox",
      ip:       data.ip ?? "",
      last_seen: row.last_seen,
      stale,
      detail:   { proxmox: data },
    });
  }

  // ── Proxmox VMs/LXCs ──
  for (const row of db.prepare("SELECT * FROM proxmox_vms").all()) {
    const data  = JSON.parse(row.data);
    const stale = (now - row.last_seen) > staleThreshold;
    const nodeId = row.id;
    const parentId = `proxmox/${data.node}`;

    nodes.push({
      id:       nodeId,
      label:    data.name ?? `VM ${row.vmid}`,
      type:     row.type === "lxc" ? "lxc" : "vm",
      vmid:     row.vmid,
      parent:   parentId,
      ip:       data.ip ?? "",
      status:   data.status ?? "unknown",
      stale,
      detail:   { vm: data },
    });
    edges.push({ source: parentId, target: nodeId, type: "hypervisor_vm" });

    // If there's an agent with a matching hostname or IP, link them
    const matchAgent = db.prepare(
      "SELECT id FROM agents WHERE json_extract(data,'$.hostname') = ? LIMIT 1"
    ).get(data.name ?? "");
    if (matchAgent) {
      edges.push({ source: nodeId, target: matchAgent.id, type: "vm_agent" });
    }
  }

  // ── Topology edges from DB ──
  for (const row of db.prepare("SELECT * FROM topology_edges").all()) {
    if (!edges.find(e => e.source === row.source && e.target === row.target)) {
      edges.push({ source: row.source, target: row.target, type: row.edge_type });
    }
  }

  return { nodes, edges, generated_at: now };
});

/** GET /api/stats  – Quick dashboard counts */
app.get("/api/stats", async () => {
  const agents    = db.prepare("SELECT COUNT(*) as n FROM agents").get().n;
  const vms       = db.prepare("SELECT COUNT(*) as n FROM proxmox_vms").get().n;
  const pxNodes   = db.prepare("SELECT COUNT(*) as n FROM proxmox_nodes").get().n;
  const containers = db
    .prepare("SELECT data FROM agents")
    .all()
    .reduce((acc, r) => {
      const d = JSON.parse(r.data);
      return acc + (d.docker?.containers?.length ?? 0);
    }, 0);
  return { agents, vms, proxmox_nodes: pxNodes, containers };
});

/** WebSocket /ws  – Live topology updates */
app.get("/ws", { websocket: true }, (socket) => {
  wsClients.add(socket);
  socket.on("close", () => wsClients.delete(socket));
});

// ─── Proxmox poller ──────────────────────────────────────────────────────────

let proxmoxTicket = null;
let proxmoxCSRF   = null;
let proxmoxExpiry = 0;

async function proxmoxAuth() {
  if (!PROXMOX_HOST || !PROXMOX_PASS) return false;
  if (Date.now() < proxmoxExpiry) return true;

  const { default: fetch } = await import("node-fetch");
  const res = await fetch(
    `https://${PROXMOX_HOST}/api2/json/access/ticket`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: PROXMOX_USER, password: PROXMOX_PASS }),
      // In production add proper TLS verification
      // For homelab self-signed: set NODE_TLS_REJECT_UNAUTHORIZED=0
    }
  );
  if (!res.ok) { app.log.warn("Proxmox auth failed"); return false; }
  const json = await res.json();
  proxmoxTicket = json.data.ticket;
  proxmoxCSRF   = json.data.CSRFPreventionToken;
  proxmoxExpiry = Date.now() + 1.5 * 3600 * 1000; // tickets last 2h
  return true;
}

async function proxmoxFetch(path) {
  const { default: fetch } = await import("node-fetch");
  return fetch(
    `https://${PROXMOX_HOST}/api2/json${path}`,
    {
      headers: {
        "Cookie": `PVEAuthCookie=${proxmoxTicket}`,
        "CSRFPreventionToken": proxmoxCSRF,
      },
    }
  );
}

async function pollProxmox() {
  if (!PROXMOX_HOST || !PROXMOX_PASS) return;

  try {
    if (!await proxmoxAuth()) return;

    const now = Date.now();

    // Nodes
    const nodesRes = await proxmoxFetch("/nodes");
    const nodesJson = await nodesRes.json();
    for (const node of nodesJson.data ?? []) {
      const id = `proxmox/${node.node}`;
      upsertProxmoxNode.run({ id, node: node.node, last_seen: now, data: JSON.stringify(node) });

      // VMs
      const vmsRes = await proxmoxFetch(`/nodes/${node.node}/qemu`);
      const vmsJson = await vmsRes.json();
      for (const vm of vmsJson.data ?? []) {
        // Try to get IP from agent network (best-effort)
        let ip = "";
        try {
          const agentRes = await proxmoxFetch(`/nodes/${node.node}/qemu/${vm.vmid}/agent/network-get-interfaces`);
          const agentJson = await agentRes.json();
          const ifaces = agentJson.data?.result ?? [];
          for (const iface of ifaces) {
            if (iface.name === "lo") continue;
            const addr = iface["ip-addresses"]?.find(a => a["ip-address-type"] === "ipv4");
            if (addr) { ip = addr["ip-address"]; break; }
          }
        } catch { /* QEMU guest agent not available */ }

        upsertProxmoxVM.run({
          id:       `proxmox/${node.node}/${vm.vmid}`,
          node:     node.node,
          vmid:     vm.vmid,
          type:     "qemu",
          last_seen: now,
          data:     JSON.stringify({ ...vm, node: node.node, ip }),
        });
      }

      // LXCs
      const lxcsRes = await proxmoxFetch(`/nodes/${node.node}/lxc`);
      const lxcsJson = await lxcsRes.json();
      for (const lxc of lxcsJson.data ?? []) {
        upsertProxmoxVM.run({
          id:       `proxmox/${node.node}/${lxc.vmid}`,
          node:     node.node,
          vmid:     lxc.vmid,
          type:     "lxc",
          last_seen: now,
          data:     JSON.stringify({ ...lxc, node: node.node }),
        });
      }
    }

    broadcast("proxmox_updated", { ts: now });
    app.log.info("Proxmox sync complete");
  } catch (err) {
    app.log.warn({ err }, "Proxmox poll error");
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: HOST });
app.log.info(`NetMap server listening on ${HOST}:${PORT}`);

// Proxmox initial poll + schedule
if (PROXMOX_HOST) {
  pollProxmox();
  setInterval(pollProxmox, PROXMOX_POLL);
}
