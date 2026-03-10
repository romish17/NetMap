import { db } from "../db.js";
import { verifyJWT } from "../auth.js";

export default async function topologyRoutes(app) {
  app.get("/api/topology", { preHandler: verifyJWT }, async () => {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    const nodes = [];
    const edges = [];

    // ── Agents ──
    for (const row of db.prepare("SELECT * FROM agents ORDER BY last_seen DESC").all()) {
      const data  = JSON.parse(row.data);
      const stale = (now - row.last_seen) > staleThreshold;

      nodes.push({
        id:        row.id,
        label:     data.hostname ?? row.id,
        type:      "agent",
        ip:        data.interfaces?.[0]?.ip ?? "",
        os:        data.system?.os ?? "",
        last_seen: row.last_seen,
        stale,
        detail: {
          system:     data.system,
          interfaces: data.interfaces,
          open_ports: data.open_ports,
          shares:     data.shares,
          docker:     data.docker,
        },
      });

      if (data.docker?.available) {
        for (const c of data.docker.containers ?? []) {
          const cId = `docker::${row.id}::${c.id}`;
          nodes.push({
            id:     cId,
            label:  c.name,
            type:   "container",
            image:  c.image,
            state:  c.state,
            parent: row.id,
            stale,
            detail: { container: c },
          });
          edges.push({ source: row.id, target: cId, type: "vm_container" });
        }
      }
    }

    // ── Proxmox nodes ──
    for (const row of db.prepare("SELECT * FROM proxmox_nodes").all()) {
      const data  = JSON.parse(row.data);
      const stale = (now - row.last_seen) > staleThreshold;
      nodes.push({
        id:        row.id,
        label:     row.node,
        type:      "proxmox",
        ip:        data.ip ?? "",
        last_seen: row.last_seen,
        stale,
        detail:    { proxmox: data },
      });
    }

    // ── Proxmox VMs/LXCs ──
    for (const row of db.prepare("SELECT * FROM proxmox_vms").all()) {
      const data     = JSON.parse(row.data);
      const stale    = (now - row.last_seen) > staleThreshold;
      const parentId = `proxmox/${data.node}`;

      nodes.push({
        id:     row.id,
        label:  data.name ?? `VM ${row.vmid}`,
        type:   row.type === "lxc" ? "lxc" : "vm",
        vmid:   row.vmid,
        parent: parentId,
        ip:     data.ip ?? "",
        status: data.status ?? "unknown",
        stale,
        detail: { vm: data },
      });
      edges.push({ source: parentId, target: row.id, type: "hypervisor_vm" });

      // Link to agent by hostname
      const matchAgent = db.prepare(
        "SELECT id FROM agents WHERE json_extract(data,'$.hostname') = ? LIMIT 1"
      ).get(data.name ?? "");
      if (matchAgent) {
        edges.push({ source: row.id, target: matchAgent.id, type: "vm_agent" });
      }
    }

    // ── Scanned hosts (without agent) ──
    for (const row of db.prepare("SELECT * FROM scanned_hosts WHERE has_agent = 0").all()) {
      nodes.push({
        id:         `scanned::${row.ip}`,
        label:      row.hostname || row.ip,
        type:       row.device_type || "scanned",
        ip:         row.ip,
        mac:        row.mac,
        vendor:     row.vendor,
        last_seen:  row.last_seen * 1000,
        stale:      (now - row.last_seen * 1000) > staleThreshold,
        hasAgent:   false,
        detail: {
          open_ports: JSON.parse(row.open_ports ?? "[]"),
          scanned: {
            mac:        row.mac,
            vendor:     row.vendor,
            hostname:   row.hostname,
            os:         row.os,
            deviceType: row.device_type,
          },
        },
      });
    }

    // ── Topology edges from DB ──
    for (const row of db.prepare("SELECT * FROM topology_edges").all()) {
      if (!edges.find(e => e.source === row.source && e.target === row.target)) {
        edges.push({ source: row.source, target: row.target, type: row.edge_type });
      }
    }

    return { nodes, edges, generated_at: now };
  });

  app.get("/api/stats", { preHandler: verifyJWT }, async () => {
    const agents    = db.prepare("SELECT COUNT(*) as n FROM agents").get().n;
    const vms       = db.prepare("SELECT COUNT(*) as n FROM proxmox_vms").get().n;
    const pxNodes   = db.prepare("SELECT COUNT(*) as n FROM proxmox_nodes").get().n;
    const scanned   = db.prepare("SELECT COUNT(*) as n FROM scanned_hosts WHERE has_agent = 0").get().n;
    const containers = db
      .prepare("SELECT data FROM agents")
      .all()
      .reduce((acc, r) => {
        const d = JSON.parse(r.data);
        return acc + (d.docker?.containers?.length ?? 0);
      }, 0);
    return { agents, vms, proxmox_nodes: pxNodes, containers, scanned };
  });
}
