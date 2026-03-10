import { useState } from "react";
import { useAuth } from "./hooks/useAuth.js";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";

export default function App() {
  const { user, loading, login, logout } = useAuth();

  if (loading) {
    return (
      <div style={{ width: "100vw", height: "100vh", background: "#03030e", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontFamily: "'Orbitron', monospace", color: "#00f7ff", fontSize: 13, letterSpacing: 6 }}>
          INITIALIZING...
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={login} />;
  }

  return <Dashboard user={user} onLogout={logout} />;
}
