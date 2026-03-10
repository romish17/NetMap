import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import corsPlugin      from "@fastify/cors";
import cookiePlugin    from "@fastify/cookie";
import rateLimitPlugin from "@fastify/rate-limit";

import { initAdminUser } from "./db.js";
import { registerWsRoute } from "./ws.js";
import authRoutes    from "./routes/auth.js";
import agentRoutes   from "./routes/agent.js";
import topologyRoutes from "./routes/topology.js";
import scannerRoutes from "./routes/scanner.js";
import adminRoutes   from "./routes/admin.js";

const PORT = parseInt(process.env.PORT ?? "3000");
const HOST = process.env.HOST ?? "0.0.0.0";

// ─── Fastify ─────────────────────────────────────────────────────────────────

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
});

await app.register(corsPlugin, { origin: true, credentials: true });
await app.register(cookiePlugin);
await app.register(websocketPlugin);
await app.register(rateLimitPlugin, { global: false });

// ─── Routes ──────────────────────────────────────────────────────────────────

await app.register(authRoutes);
await app.register(agentRoutes);
await app.register(topologyRoutes);
await app.register(scannerRoutes);
await app.register(adminRoutes);

registerWsRoute(app);

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/api/health", () => ({ ok: true, ts: Date.now() }));

// ─── Proxmox poller ──────────────────────────────────────────────────────────

const PROXMOX_HOST = process.env.PROXMOX_HOST;
const PROXMOX_USER = process.env.PROXMOX_USER ?? "root@pam";
const PROXMOX_PASS = process.env.PROXMOX_PASS;
const PROXMOX_POLL = parseInt(process.env.PROXMOX_POLL ?? "60") * 1000;

import { db, stmts } from "./db.js";
import { broadcast } from "./ws.js";

let proxmoxTicket = null;
let proxmoxCSRF   = null;
let proxmoxExpiry = 0;

async function proxmoxAuth() {
  if (!PROXMOX_HOST || !PROXMOX_PASS) return false;
  if (Date.now() < proxmoxExpiry) return true;

  const { default: fetch } = await import("node-fetch");
  const res = await fetch(`https://${PROXMOX_HOST}/api2/json/access/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PROXMOX_USER, password: PROXMOX_PASS }),
  });
  if (!res.ok) { app.log.warn("Proxmox auth failed"); return false; }
  const json = await res.json();
  proxmoxTicket = json.data.ticket;
  proxmoxCSRF   = json.data.CSRFPreventionToken;
  proxmoxExpiry = Date.now() + 1.5 * 3600 * 1000;
  return true;
}

async function proxmoxFetch(path) {
  const { default: fetch } = await import("node-fetch");
  return fetch(`https://${PROXMOX_HOST}/api2/json${path}`, {
    headers: {
      Cookie:                `PVEAuthCookie=${proxmoxTicket}`,
      CSRFPreventionToken:   proxmoxCSRF,
    },
  });
}

async function pollProxmox() {
  if (!PROXMOX_HOST || !PROXMOX_PASS) return;
  try {
    if (!await proxmoxAuth()) return;
    const now = Date.now();

    const nodesRes  = await proxmoxFetch("/nodes");
    const nodesJson = await nodesRes.json();
    for (const node of nodesJson.data ?? []) {
      const id = `proxmox/${node.node}`;
      stmts.upsertProxmoxNode.run({ id, node: node.node, last_seen: now, data: JSON.stringify(node) });

      const vmsRes  = await proxmoxFetch(`/nodes/${node.node}/qemu`);
      const vmsJson = await vmsRes.json();
      for (const vm of vmsJson.data ?? []) {
        let ip = "";
        try {
          const agentRes  = await proxmoxFetch(`/nodes/${node.node}/qemu/${vm.vmid}/agent/network-get-interfaces`);
          const agentJson = await agentRes.json();
          for (const iface of agentJson.data?.result ?? []) {
            if (iface.name === "lo") continue;
            const addr = iface["ip-addresses"]?.find(a => a["ip-address-type"] === "ipv4");
            if (addr) { ip = addr["ip-address"]; break; }
          }
        } catch { /* guest agent unavailable */ }

        stmts.upsertProxmoxVM.run({
          id:       `proxmox/${node.node}/${vm.vmid}`,
          node:     node.node,
          vmid:     vm.vmid,
          type:     "qemu",
          last_seen: now,
          data:     JSON.stringify({ ...vm, node: node.node, ip }),
        });
      }

      const lxcsRes  = await proxmoxFetch(`/nodes/${node.node}/lxc`);
      const lxcsJson = await lxcsRes.json();
      for (const lxc of lxcsJson.data ?? []) {
        stmts.upsertProxmoxVM.run({
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

await initAdminUser();
await app.listen({ port: PORT, host: HOST });
app.log.info(`NetMap server listening on ${HOST}:${PORT}`);

if (PROXMOX_HOST) {
  pollProxmox();
  setInterval(pollProxmox, PROXMOX_POLL);
}
