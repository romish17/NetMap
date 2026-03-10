import { db, stmts } from "../db.js";
import { verifyScannerToken, verifyJWT, verifyAdmin } from "../auth.js";
import { broadcast } from "../ws.js";

// ── État du scanner (en mémoire, reset au redémarrage du serveur) ──────────
let scanInProgress = false;
let lastScanAt     = null;   // timestamp ms
let lastScanHosts  = 0;
let lastScanNetwork = null;
const SCANNER_URL  = process.env.SCANNER_URL ?? "http://scanner:8080";

export default async function scannerRoutes(app) {

  // ── POST /api/scanner/report — le scanner envoie ses résultats ──────────
  app.post("/api/scanner/report", { preHandler: verifyScannerToken }, async (req, reply) => {
    const report = req.body;
    if (!report?.hosts) return reply.code(400).send({ error: "missing hosts" });

    const now = Math.floor(Date.now() / 1000);

    for (const host of report.hosts) {
      // Vérifier si un agent existe pour cette IP
      const agentWithIP = db.prepare(`
        SELECT id FROM agents
        WHERE json_extract(data, '$.interfaces[0].ip') = ?
        LIMIT 1
      `).get(host.ip);

      const hasAgent = !!agentWithIP;

      stmts.upsertScannedHost.run({
        ip:          host.ip,
        mac:         host.mac         ?? null,
        vendor:      host.vendor      ?? null,
        hostname:    host.hostname    ?? null,
        os:          host.os          ?? null,
        device_type: host.device_type ?? null,
        open_ports:  JSON.stringify(host.open_ports ?? []),
        has_agent:   hasAgent ? 1 : 0,
        last_seen:   now,
      });

      // Enrichir l'agent avec les données nmap si disponibles
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

    // Mettre à jour l'état persistant
    scanInProgress  = false;
    lastScanAt      = Date.now();
    lastScanHosts   = report.hosts.length;
    lastScanNetwork = report.network ?? null;

    broadcast("scanner_updated", {
      hosts_found: report.hosts.length,
      network:     report.network,
      scanned_at:  lastScanAt,
    });

    return { ok: true, processed: report.hosts.length };
  });

  // ── GET /api/scanner/status — état du scanner (auth JWT requis) ─────────
  app.get("/api/scanner/status", { preHandler: verifyJWT }, async () => {
    // Compter les hôtes en DB
    const dbCount = db.prepare("SELECT COUNT(*) AS n FROM scanned_hosts").get()?.n ?? 0;
    return {
      in_progress:   scanInProgress,
      last_scan_at:  lastScanAt,        // ms, ou null
      last_hosts:    lastScanHosts,
      last_network:  lastScanNetwork,
      total_in_db:   dbCount,
    };
  });

  // ── GET /api/scanner/trigger — déclencher un scan manuel (admin) ────────
  app.get("/api/scanner/trigger", { preHandler: verifyAdmin }, async (req, reply) => {
    if (scanInProgress) {
      return reply.code(409).send({ error: "scan already in progress" });
    }

    const network = req.query.network;
    scanInProgress = true;

    broadcast("scan_started", {
      network:            network ?? lastScanNetwork ?? "all configured networks",
      estimated_duration: 60,
    });

    // Signaler le scanner via HTTP (best-effort)
    try {
      const fetchFn = (await import("node-fetch")).default;
      await fetchFn(`${SCANNER_URL}/trigger`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ network }),
        signal:  AbortSignal.timeout(3000),
      });
    } catch {
      // Le scanner scanera à son prochain intervalle si pas d'endpoint HTTP
    }

    reply.code(202).send({ ok: true, message: "scan triggered" });
  });

  // ── POST /api/scanner/progress — mises à jour de progression ───────────
  app.post("/api/scanner/progress", { preHandler: verifyScannerToken }, async (req) => {
    const { done, total, current_ip, network } = req.body ?? {};
    if (!scanInProgress) scanInProgress = true;
    broadcast("scan_progress", { done, total, current_ip, network });
    return { ok: true };
  });
}
