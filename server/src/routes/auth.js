import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { db, hashToken } from "../db.js";
import { signAccess, signRefresh, verifyRefreshJWT, verifyJWT } from "../auth.js";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
  maxAge: 7 * 24 * 3600,
};

export default async function authRoutes(app) {
  // Rate limit login
  app.post("/api/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: "username and password required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const accessToken  = signAccess({ id: user.id, username: user.username, role: user.role });
    const refreshRaw   = randomBytes(32).toString("hex");
    const refreshHash  = hashToken(refreshRaw);
    const expiresAt    = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

    db.prepare(`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES (?, ?, ?)
    `).run(user.id, refreshHash, expiresAt);

    db.prepare("UPDATE users SET last_login = unixepoch() WHERE id = ?").run(user.id);

    reply.setCookie("refreshToken", refreshRaw, COOKIE_OPTS);
    return { accessToken };
  });

  // Refresh access token
  app.post("/api/auth/refresh", async (req, reply) => {
    const refreshRaw = req.cookies?.refreshToken;
    if (!refreshRaw) return reply.code(401).send({ error: "no refresh token" });

    const hash = hashToken(refreshRaw);
    const stored = db.prepare(`
      SELECT rt.*, u.username, u.role FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ? AND rt.revoked = 0
    `).get(hash);

    if (!stored || stored.expires_at < Math.floor(Date.now() / 1000)) {
      reply.clearCookie("refreshToken", { path: "/" });
      return reply.code(401).send({ error: "invalid or expired refresh token" });
    }

    const accessToken = signAccess({ id: stored.user_id, username: stored.username, role: stored.role });
    return { accessToken };
  });

  // Logout
  app.post("/api/auth/logout", async (req, reply) => {
    const refreshRaw = req.cookies?.refreshToken;
    if (refreshRaw) {
      const hash = hashToken(refreshRaw);
      db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?").run(hash);
    }
    reply.clearCookie("refreshToken", { path: "/" });
    return reply.code(204).send();
  });

  // Current user
  app.get("/api/auth/me", { preHandler: verifyJWT }, async (req) => {
    return { id: req.user.id, username: req.user.username, role: req.user.role };
  });
}
