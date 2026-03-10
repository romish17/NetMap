import { useState } from "react";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [scanning, setScanning] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    setScanning(true);

    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err.message ?? "Authentication failed");
      setScanning(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: "#03030e",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Azeret Mono', monospace",
      position: "relative", overflow: "hidden",
    }}>
      {/* Grid background */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.04 }}>
        <defs>
          <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M48 0L0 0L0 48" fill="none" stroke="#00f7ff" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Scanline */}
      <div className="scanline" />

      <div style={{
        width: 360,
        border: "1px solid #00f7ff20",
        background: "linear-gradient(135deg, #04041280, #06061a90)",
        backdropFilter: "blur(20px)",
        padding: "40px 36px",
        position: "relative",
        clipPath: "polygon(16px 0%, 100% 0%, calc(100% - 16px) 100%, 0% 100%)",
      }}>
        {/* Scanning animation overlay */}
        {scanning && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 10,
            background: "linear-gradient(180deg, transparent 0%, #00f7ff05 50%, transparent 100%)",
            animation: "scanmove 0.8s linear 2",
          }} />
        )}

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ fontFamily: "'Orbitron', monospace", fontWeight: 900, fontSize: 28, letterSpacing: 8, lineHeight: 1, textShadow: "0 0 30px #00f7ff55" }}>
            <span style={{ color: "#00f7ff" }}>NET</span>
            <span style={{ color: "#f97316", textShadow: "0 0 30px #f9731655" }}>MAP</span>
          </div>
          <div style={{ fontSize: 7, color: "#0d1a2d", letterSpacing: 5, marginTop: 6 }}>
            INFRA TOPOLOGY EXPLORER
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 18 }}>
            <div className="info-label" style={{ marginBottom: 6 }}>USERNAME</div>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                background: "#00f7ff08",
                border: "1px solid #00f7ff20",
                color: "#c8d8e8",
                fontFamily: "'Azeret Mono', monospace",
                fontSize: 12,
                padding: "10px 12px",
                outline: "none",
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.target.style.borderColor = "#00f7ff50"}
              onBlur={e => e.target.style.borderColor = "#00f7ff20"}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <div className="info-label" style={{ marginBottom: 6 }}>PASSWORD</div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{
                width: "100%",
                background: "#00f7ff08",
                border: "1px solid #00f7ff20",
                color: "#c8d8e8",
                fontFamily: "'Azeret Mono', monospace",
                fontSize: 12,
                padding: "10px 12px",
                outline: "none",
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.target.style.borderColor = "#00f7ff50"}
              onBlur={e => e.target.style.borderColor = "#00f7ff20"}
            />
          </div>

          {error && (
            <div style={{
              fontSize: 9, color: "#ff2d78", letterSpacing: 2,
              padding: "8px 12px",
              border: "1px solid #ff2d7840",
              background: "#ff2d7810",
              marginBottom: 16,
            }}>
              ✕ {error.toUpperCase()}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="scan-btn"
            style={{ width: "100%", color: "#00f7ff", borderColor: "#00f7ff40", clipPath: "none" }}
          >
            {loading ? "◈  AUTHENTICATING..." : "→  ACCESS SYSTEM"}
          </button>
        </form>

        <div style={{ marginTop: 20, fontSize: 7.5, color: "#0d1a2d", textAlign: "center", letterSpacing: 2 }}>
          AUTHORIZED ACCESS ONLY
        </div>
      </div>
    </div>
  );
}
