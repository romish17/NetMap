import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcrypt";

const DB_PATH = process.env.DB_PATH ?? "./netmap.db";

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'viewer',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_login  INTEGER
  );

  CREATE TABLE IF NOT EXISTS agent_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    token_hash  TEXT    NOT NULL UNIQUE,
    scope       TEXT    NOT NULL DEFAULT 'agent',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen   INTEGER,
    revoked     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL UNIQUE,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    hostname    TEXT,
    last_seen   INTEGER,
    data        TEXT
  );

  CREATE TABLE IF NOT EXISTS proxmox_nodes (
    id          TEXT PRIMARY KEY,
    node        TEXT,
    last_seen   INTEGER,
    data        TEXT
  );

  CREATE TABLE IF NOT EXISTS proxmox_vms (
    id          TEXT PRIMARY KEY,
    node        TEXT,
    vmid        INTEGER,
    type        TEXT,
    last_seen   INTEGER,
    data        TEXT
  );

  CREATE TABLE IF NOT EXISTS topology_edges (
    id          TEXT PRIMARY KEY,
    source      TEXT,
    target      TEXT,
    edge_type   TEXT,
    last_seen   INTEGER
  );

  CREATE TABLE IF NOT EXISTS scanned_hosts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ip           TEXT    NOT NULL UNIQUE,
    mac          TEXT,
    vendor       TEXT,
    hostname     TEXT,
    os           TEXT,
    device_type  TEXT,
    open_ports   TEXT,
    has_agent    INTEGER NOT NULL DEFAULT 0,
    last_seen    INTEGER NOT NULL,
    first_seen   INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ─── Prepared statements ──────────────────────────────────────────────────────

export const stmts = {
  upsertAgent: db.prepare(`
    INSERT INTO agents (id, hostname, last_seen, data)
    VALUES (@id, @hostname, @last_seen, @data)
    ON CONFLICT(id) DO UPDATE SET
      hostname  = excluded.hostname,
      last_seen = excluded.last_seen,
      data      = excluded.data
  `),

  upsertProxmoxNode: db.prepare(`
    INSERT INTO proxmox_nodes (id, node, last_seen, data)
    VALUES (@id, @node, @last_seen, @data)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = excluded.last_seen, data = excluded.data
  `),

  upsertProxmoxVM: db.prepare(`
    INSERT INTO proxmox_vms (id, node, vmid, type, last_seen, data)
    VALUES (@id, @node, @vmid, @type, @last_seen, @data)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = excluded.last_seen, data = excluded.data
  `),

  upsertEdge: db.prepare(`
    INSERT INTO topology_edges (id, source, target, edge_type, last_seen)
    VALUES (@id, @source, @target, @edge_type, @last_seen)
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen
  `),

  upsertScannedHost: db.prepare(`
    INSERT INTO scanned_hosts (ip, mac, vendor, hostname, os, device_type, open_ports, has_agent, last_seen)
    VALUES (@ip, @mac, @vendor, @hostname, @os, @device_type, @open_ports, @has_agent, @last_seen)
    ON CONFLICT(ip) DO UPDATE SET
      mac         = excluded.mac,
      vendor      = excluded.vendor,
      hostname    = excluded.hostname,
      os          = excluded.os,
      device_type = excluded.device_type,
      open_ports  = excluded.open_ports,
      has_agent   = excluded.has_agent,
      last_seen   = excluded.last_seen
  `),
};

// ─── Init admin user ──────────────────────────────────────────────────────────

export async function initAdminUser() {
  const count = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
  if (count > 0) return;

  let password = process.env.NETMAP_ADMIN_PASS;
  const generated = !password;
  if (!password) {
    password = randomBytes(12).toString("hex");
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)").run("admin", hash, "admin");

  if (generated) {
    console.warn("[netmap] Initial admin password:", password);
    console.warn("[netmap] Change this immediately via the admin panel.");
  }
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
