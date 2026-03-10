import { useState, useCallback, useEffect } from "react";
import { api, setAccessToken, getAccessToken } from "../lib/api.js";

export function useAuth() {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount: try to restore session via refresh token (httpOnly cookie)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          setAccessToken(data.accessToken);
          const me = await api.get("/api/auth/me");
          setUser(me);
        }
      } catch {
        // No valid session
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (username, password) => {
    await api.login(username, password);
    const me = await api.get("/api/auth/me");
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return { user, loading, login, logout };
}
