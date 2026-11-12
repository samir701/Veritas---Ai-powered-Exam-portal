const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/+$/, "");

export async function apiFetch(path, { method = "GET", body, csrfToken, candidateToken, keepalive = false } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (method !== "GET" && csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  if (candidateToken) {
    headers["X-Candidate-Token"] = candidateToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    keepalive,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export function getApiBase() {
  return API_BASE;
}

export async function postCandidateLiveFrame(candidateToken, blob) {
  await fetch(`${API_BASE}/api/candidate/live-webcam/frame`, {
    method: "POST",
    headers: {
      "Content-Type": "image/jpeg",
      "X-Candidate-Token": candidateToken,
    },
    body: blob,
  });
}

export function getWebSocketUrl(wsPath) {
  if (typeof window === "undefined") return "";
  if (API_BASE) {
    const parsed = new URL(API_BASE, window.location.origin);
    const proto = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${parsed.host}${wsPath}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host =
    window.location.port === "3000"
      ? `${window.location.hostname}:4000`
      : window.location.host;
  return `${proto}//${host}${wsPath}`;
}

export function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

