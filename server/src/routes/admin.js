import { randomBytes } from "crypto";
import { db, hashToken } from "../db.js";
import { verifyAdmin } from "../auth.js";

export default async function adminRoutes(app) {
  // List all agent tokens
  app.get("/api/admin/tokens", { preHandler: verifyAdmin }, async () => {
    const tokens = db.prepare(`
      SELECT id, name, scope, created_at, last_seen, revoked
      FROM agent_tokens
      ORDER BY created_at DESC
    `).all();
    return { tokens };
  });

  // Create a new token
  app.post("/api/admin/tokens", { preHandler: verifyAdmin }, async (req, reply) => {
    const { name, scope } = req.body ?? {};
    if (!name) return reply.code(400).send({ error: "name required" });
    if (scope && !["agent", "scanner"].includes(scope)) {
      return reply.code(400).send({ error: "scope must be 'agent' or 'scanner'" });
    }

    const rawToken = randomBytes(32).toString("hex");
    const hash     = hashToken(rawToken);

    db.prepare(`
      INSERT INTO agent_tokens (name, token_hash, scope)
      VALUES (?, ?, ?)
    `).run(name, hash, scope ?? "agent");

    // Return raw token ONCE — never stored in plaintext
    return reply.code(201).send({ token: rawToken, name, scope: scope ?? "agent" });
  });

  // Revoke a token
  app.delete("/api/admin/tokens/:id", { preHandler: verifyAdmin }, async (req, reply) => {
    const { id } = req.params;
    const result = db.prepare("UPDATE agent_tokens SET revoked = 1 WHERE id = ?").run(id);
    if (result.changes === 0) return reply.code(404).send({ error: "token not found" });
    return { ok: true };
  });

  // List users
  app.get("/api/admin/users", { preHandler: verifyAdmin }, async () => {
    const users = db.prepare(`
      SELECT id, username, role, created_at, last_login
      FROM users ORDER BY created_at ASC
    `).all();
    return { users };
  });

  // Serve agent install script
  app.get("/install.sh", async (req, reply) => {
    const { readFileSync } = await import("fs");
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");

    const __dirname = dirname(fileURLToPath(import.meta.url));
    try {
      const script = readFileSync(join(__dirname, "../../install.sh"), "utf8");
      reply.type("text/plain").send(script);
    } catch {
      reply.code(404).send("install script not found");
    }
  });

  // Serve pre-built agent binaries
  app.get("/downloads/:filename", async (req, reply) => {
    const { createReadStream, existsSync } = await import("fs");
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const file = join(__dirname, "../../downloads", req.params.filename);
    if (!existsSync(file)) return reply.code(404).send("not found");
    reply.type("application/octet-stream");
    reply.send(createReadStream(file));
  });
}
