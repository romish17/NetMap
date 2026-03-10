export default function ScannerPanel({ progress }) {
  if (!progress) return null;

  const { done = 0, total = 254, network = "..." } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const eta = total > 0 && done > 0
    ? Math.round(((total - done) / done) * (Date.now() / 1000))
    : null;

  return (
    <div style={{
      height: 32,
      background: "#04041280",
      borderBottom: "1px solid #10b98120",
      display: "flex",
      alignItems: "center",
      padding: "0 20px",
      gap: 16,
      flexShrink: 0,
    }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", boxShadow: "0 0 8px #10b981" }} className="blink" />
      <span style={{ fontSize: 8, color: "#10b981", letterSpacing: 3, fontFamily: "'Azeret Mono', monospace" }}>
        SCANNING {network}
      </span>

      <div style={{ flex: 1, height: 3, background: "#10b98115", borderRadius: 2 }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: "linear-gradient(90deg, #10b981, #00f7ff)",
          borderRadius: 2,
          transition: "width 0.5s ease",
          boxShadow: "0 0 8px #10b98150",
        }} />
      </div>

      <span style={{ fontSize: 8, color: "#10b981", fontFamily: "'Azeret Mono', monospace", opacity: 0.7 }}>
        {done}/{total}
      </span>

      {eta && (
        <span style={{ fontSize: 7, color: "#1e3050", fontFamily: "'Azeret Mono', monospace" }}>
          ETA ~{eta}s
        </span>
      )}
    </div>
  );
}
