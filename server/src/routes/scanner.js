import { db, stmts } from "../db.js";
import { verifyScannerToken, verifyAdmin } from "../auth.js";
import { broadcast } from "../ws.js";

// Track if a scan is in progress
let scanInProgress = false;
const SCANNER_URL = process.env.SCANNER_URL ?? "http://scanner:8080";

export default async function scannerRoutes(app) {
  // Scanner push results
  app.post("/api/scanner/report", { preHandler: verifyScannerToken }, async (req, reply) => {
    const report = req.body;
    if (!report?.hosts) return reply.code(400).send({ error: "missing hosts" });

    const now = Math.floor(Date.now() / 1000);

    for (const host of report.hosts) {
      // Check if agent exists for this IP
      const agentWithIP = db.prepare(`
        SELECT id FROM agents
        WHERE json_extract(data, '$.interfaces[0].ip') = ?
        LIMIT 1
      `).get(host.ip);

      const hasAgent = !!agentWithIP;

      stmts.upsertScannedHost.run({
        ip:          host.ip,
        mac:         host.mac ?? null,
        vendor:      host.vendor ?? null,
        hostname:    host.hostname ?? null,
        os:          host.os ?? null,
        device_type: host.device_type ?? null,
        open_ports:  JSON.stringify(host.open_ports ?? []),
        has_agent:   hasAgent ? 1 : 0,
        last_seen:   now,
      });

      // Enrich agent with nmap data if it exists
      if (hasAgent && host.os) {
        const agent = db.prepare("SELECT data FROM agents WHERE id = ?").get(agentWithIP.id);
        if (agent) {
          const data = JSON.parse(agent.data);
          data.nmap_os     = host.os;
          data.mac         = host.mac;
          data.vendor      = host.vendor;
          data.device_type = host.device_type;
          db.prepare("UPDATE agents SET data = ? WHERE id = ?")
            .run(JSON.stringify(data), agentWithIP.id);
        }
      }
    }

    scanInProgress = false;
    broadcast("scanner_updated", {
      hosts_found: report.hosts.length,
      network:     report.network,
    });

    return { ok: true, processed: report.hosts.length };
  });

  // Trigger manual scan (admin only)
  app.get("/api/scanner/trigger", { preHandler: verifyAdmin }, async (req, reply) => {
    if (scanInProgress) {
      return reply.code(409).send({ error: "scan already in progress" });
    }

    const network = req.query.network;
    scanInProgress = true;

    broadcast("scan_started", {
      network:            network ?? "all configured networks",
      estimated_duration: 60,
    });

    // Signal scanner via HTTP (best-effort, scanner polls anyway)
    try {
      const fetchFn = (await import("node-fetch")).default;
      await fetchFn(`${SCANNER_URL}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Scanner may not have HTTP endpoint — it will scan on next interval
    }

    reply.code(202).send({ ok: true, message: "scan triggered" });
  });

  // Scanner progress updates (called by scanner)
  app.post("/api/scanner/progress", { preHandler: verifyScannerToken }, async (req) => {
    const { done, total, current_ip, network } = req.body ?? {};
    broadcast("scan_progress", { done, total, current_ip, network });
    return { ok: true };
  });
}
