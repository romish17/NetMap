import { useEffect, useRef, useState } from "react";

export default function ScannerPanel({ progress }) {
  // Tick chaque seconde pour recalculer l'ETA en temps réel
  const [, tick] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!progress) { clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timerRef.current);
  }, [progress]);

  if (!progress) return null;

  const { done = 0, total = 0, network = "...", currentIp = "", startTime } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // ETA exact : (elapsed / done) * remaining
  let etaLabel = null;
  if (startTime && done > 0 && total > done) {
    const elapsedMs = Date.now() - startTime;
    const msPerHost = elapsedMs / done;
    const etaSecs   = Math.round((total - done) * msPerHost / 1000);
    etaLabel = etaSecs >= 60
      ? `~${Math.floor(etaSecs / 60)}m${String(etaSecs % 60).padStart(2, "0")}s`
      : `~${etaSecs}s`;
  }

  return (
    <div style={{
      height: 36,
      background: "#04041280",
      borderBottom: "1px solid #10b98120",
      display: "flex",
      alignItems: "center",
      padding: "0 20px",
      gap: 14,
      flexShrink: 0,
    }}>

      {/* Point clignotant */}
      <div style={{
        width: 7, height: 7, borderRadius: "50%",
        background: "#10b981", boxShadow: "0 0 10px #10b981",
      }} className="blink" />

      {/* Réseau */}
      <span style={{ fontSize: 8, color: "#10b981", letterSpacing: 3, fontFamily: "'Azeret Mono', monospace", whiteSpace: "nowrap" }}>
        SCANNING {network}
      </span>

      {/* Barre de progression */}
      <div style={{ flex: 1, height: 3, background: "#10b98115", borderRadius: 2, minWidth: 60 }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: "linear-gradient(90deg, #10b981, #00f7ff)",
          borderRadius: 2,
          transition: "width 0.4s ease",
          boxShadow: "0 0 8px #10b98150",
        }} />
      </div>

      {/* Compteur + pourcentage */}
      <span style={{ fontSize: 8, color: "#4ade80", fontFamily: "'Azeret Mono', monospace", whiteSpace: "nowrap" }}>
        {done}/{total || "?"}&nbsp;&nbsp;{pct}%
      </span>

      {/* IP courante */}
      {currentIp && (
        <span style={{ fontSize: 7.5, color: "#00f7ffaa", fontFamily: "'Azeret Mono', monospace", letterSpacing: 1, whiteSpace: "nowrap" }}>
          → {currentIp}
        </span>
      )}

      {/* ETA */}
      {etaLabel && (
        <span style={{ fontSize: 7.5, color: "#4ade80aa", fontFamily: "'Azeret Mono', monospace", whiteSpace: "nowrap" }}>
          ETA {etaLabel}
        </span>
      )}
    </div>
  );
}
