import jwt from "jsonwebtoken";
import { db, hashToken } from "./db.js";

const JWT_SECRET         = process.env.JWT_SECRET         ?? "dev-secret-change-me";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret";

export function signAccess(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "15m" });
}

export function signRefresh(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: "7d" });
}

export function verifyAccess(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function verifyRefreshJWT(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}

// ─── Fastify hooks ────────────────────────────────────────────────────────────

export async function verifyJWT(req, reply) {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "missing token" });
  }
  try {
    req.user = verifyAccess(auth.slice(7));
  } catch {
    return reply.code(401).send({ error: "invalid or expired token" });
  }
}

export async function verifyAdmin(req, reply) {
  await verifyJWT(req, reply);
  if (reply.sent) return;
  if (req.user?.role !== "admin") {
    return reply.code(403).send({ error: "admin required" });
  }
}

export async function verifyAgentToken(req, reply) {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "missing token" });
  }
  const raw = auth.slice(7);
  const hash = hashToken(raw);

  const token = db.prepare(
    "SELECT * FROM agent_tokens WHERE token_hash = ? AND revoked = 0"
  ).get(hash);

  if (!token) {
    return reply.code(401).send({ error: "invalid or revoked token" });
  }

  db.prepare("UPDATE agent_tokens SET last_seen = ? WHERE id = ?")
    .run(Date.now(), token.id);

  req.agent = { id: token.id, name: token.name, scope: token.scope };
}

export async function verifyScannerToken(req, reply) {
  await verifyAgentToken(req, reply);
  if (reply.sent) return;
  if (req.agent?.scope !== "scanner") {
    return reply.code(403).send({ error: "scanner scope required" });
  }
}
