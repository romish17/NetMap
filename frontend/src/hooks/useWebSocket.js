import { useEffect, useRef, useState } from "react";

// If VITE_WS_URL is not set, derive from current page origin (works behind any proxy)
function getWsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

export function useWebSocket(onMessage, enabled = true) {
  const wsRef = useRef(null);
  const [status, setStatus] = useState("disconnected");

  useEffect(() => {
    if (!enabled) return;

    let reconnectTimer = null;

    function connect() {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen  = () => setStatus("connected");
      ws.onclose = () => {
        setStatus("disconnected");
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          onMessage(msg);
        } catch { /* ignore */ }
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [enabled, onMessage]);

  return status;
}
