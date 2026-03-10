import { useState, useCallback, useEffect, useRef } from "react";
import { useTopology }  from "../hooks/useTopology.js";
import { useWebSocket } from "../hooks/useWebSocket.js";
import TopologyGraph   from "../components/TopologyGraph.jsx";
import DetailPanel     from "../components/DetailPanel.jsx";
import ScannerPanel    from "../components/ScannerPanel.jsx";
import { api }         from "../lib/api.js";
import { NC }          from "../lib/nodeConfig.js";

const ALL_TYPES = ["proxmox", "vm", "lxc", "agent", "container", "scanned", "nas", "iot", "router", "switch", "linux_generic", "windows", "monitoring", "firewall", "rpi", "network", "workstation"];

// Formate "il y a X" à partir d'un timestamp ms
function timeAgo(ms) {
  if (!ms) return null;
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

export default function Dashboard({ user, onLogout }) {
  const { topology, stats, loading, useMock, refresh } = useTopology();
  const [selected,      setSelected]      = useState(null);
  const [scanProgress,  setScanProgress]  = useState(null);
  // { in_progress, last_scan_at, last_hosts, last_network, total_in_db }
  const [scannerStatus, setScannerStatus] = useState(null);
  const [visibleTypes,  setVisibleTypes]  = useState(new Set(ALL_TYPES));
  // Forcer le recalcul du "time ago" chaque minute
  const [, tick] = useState(0);

  // Charger le statut du scanner au montage
  useEffect(() => {
    api.get("/api/scanner/status")
      .then(s => setScannerStatus(s))
      .catch(() => {}); // scanner non configuré = silencieux
  }, []);

  // Ticker pour rafraîchir "X ago" sans refetch
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Timeout : si scan_started mais aucun scan_progress en 2 min → reset
  const scanTimeoutRef = useRef(null);

  const handleWsMessage = useCallback((msg) => {
    if (msg.event === "agent_updated" || msg.event === "proxmox_updated") {
      refresh();
    }
    if (msg.event === "scan_started") {
      clearTimeout(scanTimeoutRef.current);
      setScanProgress({ done: 0, total: 0, network: msg.data.network, startTime: Date.now() });
      setScannerStatus(s => s ? { ...s, in_progress: true } : { in_progress: true });
      // Timeout de sécurité : si aucune mise à jour en 3 minutes, on abandonne
      scanTimeoutRef.current = setTimeout(() => {
        setScanProgress(null);
        setScannerStatus(s => s ? { ...s, in_progress: false } : null);
      }, 3 * 60 * 1000);
    }
    if (msg.event === "scan_progress") {
      clearTimeout(scanTimeoutRef.current);
      setScanProgress(p => p ? {
        ...p,
        done:      msg.data.done,
        total:     msg.data.total,
        network:   msg.data.network,
        currentIp: msg.data.current_ip,
      } : null);
      // Renouveler le timeout après chaque update
      scanTimeoutRef.current = setTimeout(() => {
        setScanProgress(null);
        setScannerStatus(s => s ? { ...s, in_progress: false } : null);
      }, 3 * 60 * 1000);
    }
    if (msg.event === "scanner_updated") {
      clearTimeout(scanTimeoutRef.current);
      setScanProgress(null);
      setScannerStatus({
        in_progress:  false,
        last_scan_at: msg.data.scanned_at ?? Date.now(),
        last_hosts:   msg.data.hosts_found ?? 0,
        last_network: msg.data.network ?? null,
      });
      refresh();
    }
  }, [refresh]);

  const wsStatus = useWebSocket(handleWsMessage, !useMock);

  async function triggerScan() {
    try {
      await api.get("/api/scanner/trigger");
    } catch (err) {
      console.warn("Scan trigger failed:", err.message);
    }
  }

  // Filtrage de la topologie selon les types visibles
  const filteredTopology = topology ? {
    ...topology,
    nodes: topology.nodes.filter(n => visibleTypes.has(n.type)),
    edges: topology.edges,
  } : null;

  const nodeTypesPresent = topology
    ? [...new Set(topology.nodes.map(n => n.type))]
    : [];

  // Indicateur scanner : en cours / dernier scan / jamais
  const scannerIndicator = (() => {
    if (!scannerStatus) return null;
    if (scannerStatus.in_progress || scanProgress) {
      return { color: "#10b981", label: "SCANNING" };
    }
    if (scannerStatus.last_scan_at) {
      const ago = timeAgo(scannerStatus.last_scan_at);
      return {
        color: "#4ade80",
        label: `SCAN ${ago} · ${scannerStatus.last_hosts ?? 0} HOSTS`,
      };
    }
    return { color: "#334a6a", label: "NO SCAN YET" };
  })();

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#03030e", display: "flex", flexDirection: "column", overflow: "hidden", color: "#e2e8f0", fontFamily: "'Azeret Mono', monospace" }}>

      {/* ═══ HEADER ═══════════════════════════════════════════════════════════ */}
      <div style={{ height: 56, flexShrink: 0, borderBottom: "1px solid #00f7ff12", display: "flex", alignItems: "center", padding: "0 20px", gap: 20, background: "linear-gradient(180deg,#0a0a22 0%,#03030e 100%)" }}>

        <div>
          <div style={{ fontFamily: "'Orbitron',monospace", fontWeight: 900, fontSize: 16, color: "#00f7ff", letterSpacing: 7, lineHeight: 1, textShadow: "0 0 24px #00f7ff55" }}>
            NET<span style={{ color: "#f97316", textShadow: "0 0 24px #f9731655" }}>MAP</span>
          </div>
          <div style={{ fontSize: 6.5, color: "#0d1a2d", letterSpacing: 4, marginTop: 2 }}>INFRA TOPOLOGY EXPLORER</div>
        </div>

        <div style={{ width: 1, height: 28, background: "#00f7ff12" }} />

        {/* Stats */}
        {[
          ["AGENTS",     stats.agents     ?? "—"],
          ["VMs/LXCs",   stats.vms        ?? "—"],
          ["CONTAINERS", stats.containers ?? "—"],
          ["SCANNED",    stats.scanned    ?? "—"],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 6.5, color: "#1e3050", letterSpacing: 3 }}>{k}</div>
            <div className="stat-val" style={{ color: "#00f7ff" }}>{v}</div>
          </div>
        ))}

        <div style={{ flex: 1 }} />

        {/* Mock data badge */}
        {useMock && (
          <div style={{ fontSize: 7.5, color: "#f97316", letterSpacing: 2, padding: "4px 10px", border: "1px solid #f9731640", background: "#f9731608" }}>
            MOCK DATA
          </div>
        )}

        {/* Statut scanner */}
        {!useMock && scannerIndicator && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", border: `1px solid ${scannerIndicator.color}25`, background: `${scannerIndicator.color}08`, borderRadius: 2 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: scannerIndicator.color,
              boxShadow: `0 0 6px ${scannerIndicator.color}`,
            }} className={scannerStatus?.in_progress || scanProgress ? "blink" : ""} />
            <span style={{ fontSize: 7, color: scannerIndicator.color, letterSpacing: 1.5, whiteSpace: "nowrap" }}>
              {scannerIndicator.label}
            </span>
          </div>
        )}

        {/* Statut WebSocket */}
        {!useMock && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: wsStatus === "connected" ? "#4ade80" : "#334a6a",
              boxShadow: wsStatus === "connected" ? "0 0 8px #4ade80" : "none",
            }} className={wsStatus !== "connected" ? "blink" : ""} />
            <span style={{ fontSize: 7.5, color: "#1e3050", letterSpacing: 2 }}>{wsStatus.toUpperCase()}</span>
          </div>
        )}

        {/* Bouton scan (admin) */}
        {user.role === "admin" && !useMock && (
          <button
            className="scan-btn"
            style={{ color: "#10b981", borderColor: "#10b981", opacity: (scannerStatus?.in_progress || scanProgress) ? 0.4 : 1 }}
            onClick={triggerScan}
            disabled={!!(scannerStatus?.in_progress || scanProgress)}
          >
            {(scannerStatus?.in_progress || scanProgress) ? "◉ SCANNING…" : "◉ SCAN NOW"}
          </button>
        )}

        <button className="scan-btn" style={{ color: "#00f7ff", borderColor: "#00f7ff" }} onClick={refresh} disabled={loading}>
          {loading ? "◈  LOADING..." : "↺  REFRESH"}
        </button>

        {/* User + Logout */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 10, borderLeft: "1px solid #00f7ff12" }}>
          <span style={{ fontSize: 8, color: "#1e3050", letterSpacing: 2 }}>{user.username.toUpperCase()}</span>
          {user.role === "admin" && <span className="tag" style={{ color: "#f97316" }}>ADMIN</span>}
          <button className="scan-btn" style={{ color: "#ff2d78", borderColor: "#ff2d78", padding: "4px 12px" }} onClick={onLogout}>
            ⏻
          </button>
        </div>
      </div>

      {/* Barre de progression du scan (uniquement pendant un scan actif) */}
      {scanProgress && <ScannerPanel progress={scanProgress} />}

      {/* ═══ BODY ═════════════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Canvas ─────────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <div className="scanline" />
          <div className="crt" />

          <TopologyGraph
            topology={filteredTopology}
            selected={selected}
            onSelect={(node) => { setSelected(node); }}
          />

          {/* Légende + filtres par type */}
          <div style={{ position: "absolute", bottom: 16, left: 16, background: "#06061acc", border: "1px solid #00f7ff10", padding: "12px 14px", backdropFilter: "blur(10px)", zIndex: 10, maxHeight: "60vh", overflowY: "auto" }}>
            <div className="section-title" style={{ marginBottom: 10 }}>NODE TYPES</div>
            {nodeTypesPresent.map(type => {
              const c = NC[type] ?? { color: "#94a3b8" };
              const visible = visibleTypes.has(type);
              return (
                <div key={type} className="legend-row" style={{ cursor: "pointer", opacity: visible ? 1 : 0.3 }}
                  onClick={() => {
                    setVisibleTypes(prev => {
                      const next = new Set(prev);
                      if (next.has(type)) next.delete(type);
                      else next.add(type);
                      return next;
                    });
                  }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: visible ? c.color : "#334a6a", boxShadow: visible ? `0 0 6px ${c.color}` : "none", flexShrink: 0 }} />
                  <span style={{ fontSize: 8.5, color: visible ? "#2d3f55" : "#1a2a3a" }}>
                    {type.toUpperCase()} ({topology?.nodes.filter(n => n.type === type).length ?? 0})
                  </span>
                </div>
              );
            })}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #00f7ff0a" }}>
              <div className="legend-row" style={{ marginBottom: 5 }}>
                <div style={{ width: 16, height: 0, borderTop: "1.5px solid #f97316", opacity: 0.5 }} />
                <span style={{ fontSize: 7, color: "#1e3050" }}>HYPERVISOR → VM</span>
              </div>
              <div className="legend-row" style={{ marginBottom: 5 }}>
                <div style={{ width: 16, height: 0, borderTop: "1.5px dashed #a78bfa", opacity: 0.5 }} />
                <span style={{ fontSize: 7, color: "#1e3050" }}>VM → AGENT</span>
              </div>
              <div className="legend-row">
                <div style={{ width: 16, height: 0, borderTop: "1px solid #38bdf8", opacity: 0.4 }} />
                <span style={{ fontSize: 7, color: "#1e3050" }}>AGENT → CONTAINER</span>
              </div>
            </div>
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #00f7ff08", fontSize: 7, color: "#1e3050", lineHeight: 2 }}>
              SCROLL ↕ ZOOM · DRAG ✥ MOVE<br />CLICK ◎ INSPECT · CLICK TYPE TO FILTER
            </div>
          </div>
        </div>

        {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
        <div style={{ width: 300, borderLeft: "1px solid #00f7ff10", display: "flex", flexDirection: "column", background: "#04041280", backdropFilter: "blur(8px)", flexShrink: 0 }}>
          <div style={{ flex: 1, overflowY: "auto" }}>
            <DetailPanel selected={selected} onClose={() => setSelected(null)} user={user} />
          </div>
        </div>
      </div>
    </div>
  );
}
