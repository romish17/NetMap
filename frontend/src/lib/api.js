// API wrapper with automatic JWT refresh

const BASE = import.meta.env.VITE_API_URL ?? "";

let _accessToken = null;

export function setAccessToken(token) {
  _accessToken = token;
}

export function getAccessToken() {
  return _accessToken;
}

async function refreshAccessToken() {
  const res = await fetch(`${BASE}/api/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    _accessToken = null;
    throw new Error("refresh_failed");
  }
  const data = await res.json();
  _accessToken = data.accessToken;
  return data.accessToken;
}

async function request(method, path, body, retry = true) {
  const headers = { "Content-Type": "application/json" };
  if (_accessToken) headers["Authorization"] = `Bearer ${_accessToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry) {
    try {
      await refreshAccessToken();
      return request(method, path, body, false);
    } catch {
      throw new Error("unauthenticated");
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? "request failed"), { status: res.status });
  }

  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get:    (path)        => request("GET",    path),
  post:   (path, body)  => request("POST",   path, body),
  delete: (path)        => request("DELETE", path),

  login: async (username, password) => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? "login failed");
    }
    const data = await res.json();
    _accessToken = data.accessToken;
    return data;
  },

  logout: async () => {
    await fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    _accessToken = null;
  },
};
