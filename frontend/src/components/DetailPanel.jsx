import { useState } from "react";
import { getNodeConfig } from "../lib/nodeConfig.js";

function fmtBytes(bytes) {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function fmtUptime(secs) {
  if (!secs) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function copyInstallCmd(node) {
  const cmd = `curl -fsSL $SERVER_URL/install.sh | NETMAP_SERVER=$SERVER_URL NETMAP_TOKEN=$TOKEN bash`;
  navigator.clipboard?.writeText(cmd);
}

export default function DetailPanel({ selected, onClose, user }) {
  const [tab, setTab] = useState("info");

  if (!selected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 14 }}>
        <div style={{ width: 36, height: 36, border: "1px solid #0d1a2d", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#0d1a2d", fontSize: 16 }}>◎</span>
        </div>
        <div style={{ fontSize: 8, color: "#0d1a2d", letterSpacing: 4, textAlign: "center", lineHeight: 2.2 }}>
          SELECT A NODE<br />TO INSPECT
        </div>
      </div>
    );
  }

  const nc        = getNodeConfig(selected.type);
  const det       = selected.detail ?? {};
  const sys       = det.system ?? det.vm ?? det.proxmox ?? {};
  const ports     = det.open_ports ?? [];
  const shares    = det.shares ?? {};
  const docker    = det.docker ?? {};
  const container = det.container ?? {};
  const scanned   = det.scanned ?? {};

  const tabs = [
    { id: "info",   label: "INFO" },
    ports.length > 0 || container.ports?.length > 0 ? { id: "ports", label: `PORTS ${ports.length || container.ports?.length || 0}` } : null,
    (shares.smb?.length > 0 || shares.nfs?.length > 0) ? { id: "shares", label: "SHARES" } : null,
    docker.available ? { id: "docker", label: `DOCKER ${docker.containers?.length ?? 0}` } : null,
  ].filter(Boolean);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "12px 14px", borderBottom: "1px solid #00f7ff10", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
          <div>
            <div style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 13, color: nc.color, marginBottom: 5, textShadow: `0 0 12px ${nc.color}50` }}>
              {selected.label}
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              <span className="tag" style={{ color: nc.color }}>{selected.type.toUpperCase()}</span>
              {selected.stale && <span className="tag" style={{ color: "#ff2d78" }}>STALE</span>}
              {selected.hasAgent === false && <span className="tag" style={{ color: "#ff2d78" }}>NO AGENT</span>}
              {selected.status && <span className="tag" style={{ color: selected.status === "running" ? "#4ade80" : "#ff2d78" }}>{selected.status.toUpperCase()}</span>}
              {selected.state  && <span className="tag" style={{ color: selected.state  === "running" ? "#4ade80" : "#ff2d78" }}>{selected.state.toUpperCase()}</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#1e3050", cursor: "pointer", fontSize: 16, padding: 2 }}>✕</button>
        </div>
        {selected.ip && <div style={{ fontSize: 9, color: nc.color, opacity: 0.6, fontFamily: "'Azeret Mono',monospace" }}>{selected.ip}</div>}
        {selected.last_seen && <div style={{ fontSize: 8, color: "#1e3050", marginTop: 3 }}>last seen {timeAgo(selected.last_seen)}</div>}
      </div>

      {/* Tabs */}
      {tabs.length > 1 && (
        <div style={{ display: "flex", borderBottom: "1px solid #00f7ff0a", flexShrink: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ flex: 1, background: "none", border: "none", borderBottom: tab === t.id ? `1px solid ${nc.color}` : "1px solid transparent", color: tab === t.id ? nc.color : "#1e3050", fontSize: 7, letterSpacing: 2, padding: "8px 4px", cursor: "pointer", marginBottom: -1 }}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>

        {tab === "info" && (
          <div>
            {sys.os && (
              <>
                <div className="section-title">SYSTEM</div>
                {[
                  ["OS",        sys.os ?? sys.name],
                  ["KERNEL",    sys.kernel],
                  ["ARCH",      sys.arch],
                  ["UPTIME",    sys.uptime_secs ? fmtUptime(sys.uptime_secs) : fmtUptime(sys.uptime)],
                  ["CPU CORES", sys.cpu_cores ?? sys.cpus],
                  ["RAM",       sys.ram_total_mb ? `${sys.ram_used_mb} / ${sys.ram_total_mb} MB` : sys.maxmem ? `${fmtBytes(sys.mem)} / ${fmtBytes(sys.maxmem)}` : null],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <div className="info-label">{k}</div>
                    <div className="info-value">{v}</div>
                  </div>
                ))}
              </>
            )}

            {det.interfaces?.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: 14 }}>INTERFACES</div>
                {det.interfaces.map(i => (
                  <div key={i.name} style={{ marginBottom: 8 }}>
                    <div className="info-label">{i.name}</div>
                    <div className="info-value">{i.ip}{i.cidr} — {i.mac}</div>
                  </div>
                ))}
              </>
            )}

            {container.image && (
              <>
                <div className="section-title">CONTAINER</div>
                {[
                  ["IMAGE",    container.image],
                  ["ID",       container.id],
                  ["NETWORKS", container.networks?.join(", ")],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <div className="info-label">{k}</div>
                    <div className="info-value">{v}</div>
                  </div>
                ))}
              </>
            )}

            {/* Scanned host info */}
            {scanned.mac && (
              <>
                <div className="section-title">SCANNED INFO</div>
                {[
                  ["MAC",      scanned.mac],
                  ["VENDOR",   scanned.vendor],
                  ["OS",       scanned.os],
                  ["TYPE",     scanned.deviceType],
                  ["HOSTNAME", scanned.hostname],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <div className="info-label">{k}</div>
                    <div className="info-value">{v}</div>
                  </div>
                ))}

                {selected.hasAgent === false && (
                  <div style={{ marginTop: 16 }}>
                    <div className="info-label" style={{ marginBottom: 8 }}>INSTALL AGENT</div>
                    <button
                      className="scan-btn"
                      style={{ color: "#10b981", borderColor: "#10b981", width: "100%", fontSize: 8 }}
                      onClick={() => copyInstallCmd(selected)}
                    >
                      ⎘ COPY INSTALL COMMAND
                    </button>
                    <div style={{ fontSize: 7, color: "#1e3050", marginTop: 6, lineHeight: 1.8 }}>
                      Set NETMAP_SERVER and NETMAP_TOKEN before running.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === "ports" && (
          <div>
            <div className="section-title">LISTENING PORTS</div>
            {(ports.length > 0 ? ports : container.ports ?? []).map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #00f7ff08" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 12, color: nc.color }}>{p.port ?? p.host_port}</span>
                  <span style={{ fontSize: 8, color: "#334a6a" }}>{p.proto?.toUpperCase()}</span>
                </div>
                <span style={{ fontSize: 9, color: "#4a5f80" }}>{p.process || p.service || "—"}</span>
              </div>
            ))}
          </div>
        )}

        {tab === "shares" && (
          <div>
            {shares.smb?.length > 0 && (
              <>
                <div className="section-title">SMB SHARES</div>
                {shares.smb.map((s, i) => (
                  <div key={i} style={{ marginBottom: 10, paddingLeft: 8, borderLeft: `2px solid ${nc.color}30` }}>
                    <div style={{ fontSize: 10, color: nc.color, marginBottom: 2 }}>{s.name}</div>
                    <div style={{ fontSize: 9, color: "#4a5f80" }}>{s.path}</div>
                    {s.comment && <div style={{ fontSize: 8, color: "#1e3050" }}>{s.comment}</div>}
                  </div>
                ))}
              </>
            )}
            {shares.nfs?.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: 14 }}>NFS EXPORTS</div>
                {shares.nfs.map((n, i) => (
                  <div key={i} style={{ marginBottom: 10, paddingLeft: 8, borderLeft: "2px solid #4ade8030" }}>
                    <div style={{ fontSize: 10, color: "#4ade80", marginBottom: 2 }}>{n.path}</div>
                    <div style={{ fontSize: 9, color: "#4a5f80" }}>clients: {n.clients}</div>
                    {n.options && <div style={{ fontSize: 8, color: "#1e3050" }}>{n.options}</div>}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {tab === "docker" && docker.available && (
          <div>
            <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="section-title" style={{ marginBottom: 0 }}>CONTAINERS</div>
              <span style={{ fontSize: 8, color: "#334a6a" }}>Docker {docker.version}</span>
            </div>
            {(docker.containers ?? []).map((c, i) => (
              <div key={i} className="container-row">
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <div className="state-dot" style={{ background: c.state === "running" ? "#4ade80" : "#ff2d78", boxShadow: c.state === "running" ? "0 0 6px #4ade80" : "none" }} />
                  <span style={{ fontSize: 10, color: "#c8d8e8", flex: 1 }}>{c.name}</span>
                </div>
                <div style={{ fontSize: 8, color: "#334a6a", marginBottom: 5 }}>{c.image}</div>
                {c.ports?.filter(p => p.host_port).map((p, j) => (
                  <span key={j} className="port-badge">{p.host_port}:{p.container_port}/{p.proto}</span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
