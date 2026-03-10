import { useState, useCallback } from "react";
import { useTopology }  from "../hooks/useTopology.js";
import { useWebSocket } from "../hooks/useWebSocket.js";
import TopologyGraph   from "../components/TopologyGraph.jsx";
import DetailPanel     from "../components/DetailPanel.jsx";
import ScannerPanel    from "../components/ScannerPanel.jsx";
import { api }         from "../lib/api.js";
import { NC }          from "../lib/nodeConfig.js";

const ALL_TYPES = ["proxmox", "vm", "lxc", "agent", "container", "scanned", "nas", "iot", "router", "switch", "linux_generic", "windows", "monitoring", "firewall", "rpi", "network", "workstation"];

export default function Dashboard({ user, onLogout }) {
  const { topology, stats, loading, useMock, refresh } = useTopology();
  const [selected,      setSelected]      = useState(null);
  const [scanProgress,  setScanProgress]  = useState(null); // { done, total, network }
  const [visibleTypes,  setVisibleTypes]  = useState(new Set(ALL_TYPES));

  const handleWsMessage = useCallback((msg) => {
    if (msg.event === "agent_updated" || msg.event === "proxmox_updated" || msg.event === "scanner_updated") {
      refresh();
    }
    if (msg.event === "scan_started") {
      setScanProgress({ done: 0, total: 254, network: msg.data.network });
    }
    if (msg.event === "scan_progress") {
      setScanProgress(p => p ? { ...p, done: msg.data.done, total: msg.data.total, network: msg.data.network } : null);
    }
    if (msg.event === "scanner_updated") {
      setScanProgress(null);
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

  // Filter topology
  const filteredTopology = topology ? {
    ...topology,
    nodes: topology.nodes.filter(n => visibleTypes.has(n.type) || visibleTypes.has("container") && n.type === "container"),
    edges: topology.edges,
  } : null;

  const nodeTypesPresent = topology
    ? [...new Set(topology.nodes.map(n => n.type))]
    : [];

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

        {useMock && (
          <div style={{ fontSize: 7.5, color: "#f97316", letterSpacing: 2, padding: "4px 10px", border: "1px solid #f9731640", background: "#f9731608" }}>
            MOCK DATA
          </div>
        )}

        {!useMock && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: wsStatus === "connected" ? "#4ade80" : "#334a6a", boxShadow: wsStatus === "connected" ? "0 0 8px #4ade80" : "none" }} className={wsStatus !== "connected" ? "blink" : ""} />
            <span style={{ fontSize: 7.5, color: "#1e3050", letterSpacing: 2 }}>{wsStatus.toUpperCase()}</span>
          </div>
        )}

        {user.role === "admin" && (
          <button className="scan-btn" style={{ color: "#10b981", borderColor: "#10b981" }} onClick={triggerScan}>
            ◉ SCAN NOW
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

      {/* Scanner progress bar */}
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

          {/* Legend + type filters */}
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
