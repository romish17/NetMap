import { db, stmts } from "../db.js";
import { verifyAgentToken } from "../auth.js";
import { broadcast } from "../ws.js";

export default async function agentRoutes(app) {
  app.post("/api/agent/report", { preHandler: verifyAgentToken }, async (req, reply) => {
    if (req.agent.scope !== "agent") {
      return reply.code(403).send({ error: "agent scope required" });
    }

    const report = req.body;
    if (!report?.agent_id) return reply.code(400).send({ error: "missing agent_id" });

    const now = Date.now();

    stmts.upsertAgent.run({
      id:        report.agent_id,
      hostname:  report.hostname ?? report.agent_id,
      last_seen: now,
      data:      JSON.stringify(report),
    });

    // Docker container edges
    if (report.docker?.available && report.docker.containers?.length) {
      for (const c of report.docker.containers) {
        stmts.upsertEdge.run({
          id:        `${report.agent_id}::docker::${c.id}`,
          source:    report.agent_id,
          target:    `docker::${report.agent_id}::${c.id}`,
          edge_type: "vm_container",
          last_seen: now,
        });
      }
    }

    // Update scanned_hosts if this agent's IP was previously scanned
    const primaryIP = report.interfaces?.[0]?.ip;
    if (primaryIP) {
      db.prepare("UPDATE scanned_hosts SET has_agent = 1 WHERE ip = ?").run(primaryIP);
    }

    broadcast("agent_updated", { agent_id: report.agent_id });
    return { ok: true };
  });
}
