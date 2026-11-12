// backend/src/websocket.js
// Lightweight in-memory WebSocket + snapshot relay for live webcam preview.
//
// No video or image data is ever persisted to disk. Only the single most recent
// live frame is retained in RAM while a session is active, and it is cleared as
// soon as the stream stops or the attempt finishes.

import { WebSocketServer } from "ws";

// Map<token, { candidate: WebSocket|null, admins: Set<WebSocket>, latestFrame: Buffer|null, updatedAt: number }>
const sessions = new Map();

function getOrCreateSession(token) {
  let sess = sessions.get(token);
  if (!sess) {
    sess = { candidate: null, admins: new Set(), latestFrame: null, updatedAt: 0 };
    sessions.set(token, sess);
  }
  return sess;
}

/**
 * Verify that `token` belongs to an active in-progress attempt with live webcam enabled.
 * @param {string} token
 * @param {import("./db.js").Database} db
 * @returns {boolean}
 */
async function tokenExists(token, db) {
  if (!token) return false;
  try {
    const row = await db.get(
      "SELECT id FROM attempts WHERE live_webcam_token = ? AND status = 'in_progress' AND is_anonymized = 0",
      token
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Push an in-memory JPEG frame (used by both WS and HTTP fallback) and broadcast to connected admins.
 * @param {string} token
 * @param {Buffer} frameBuf
 */
export function broadcastLiveFrame(token, frameBuf) {
  if (!token || !frameBuf || frameBuf.length === 0) return;
  const sess = getOrCreateSession(token);
  sess.latestFrame = frameBuf;
  sess.updatedAt = Date.now();
  for (const adminWs of sess.admins) {
    if (adminWs.readyState === 1 /* OPEN */) {
      try {
        adminWs.send(frameBuf, { binary: true });
      } catch {
        // ignore transient socket error
      }
    }
  }
}

/**
 * Return the latest in-memory frame (if any) for HTTP fallback preview.
 * @param {string} token
 * @returns {{ frame: Buffer, updatedAt: number } | null}
 */
export function getLatestLiveFrame(token) {
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess || !sess.latestFrame) return null;
  return { frame: sess.latestFrame, updatedAt: sess.updatedAt };
}

/**
 * Close any open sockets and clear in-memory frames for a token.
 * @param {string|null|undefined} token
 */
export function closeLiveWebcamSession(token) {
  if (!token) return;
  const sess = sessions.get(token);
  if (!sess) return;
  sess.latestFrame = null;
  try {
    sess.candidate?.close();
  } catch {}
  for (const adminWs of sess.admins) {
    try {
      adminWs.close();
    } catch {}
  }
  sessions.delete(token);
}

/**
 * Attach a WebSocket server to the existing HTTP server.
 * @param {import("http").Server} httpServer
 * @param {import("./db.js").Database} db
 */
export function setupWebSocket(httpServer, db) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (request, socket, head) => {
    const parsed = new URL(request.url || "/", "http://localhost");
    if (parsed.pathname !== "/live-webcam") {
      socket.destroy();
      return;
    }

    const token = (parsed.searchParams.get("token") || "").trim();
    const role = parsed.searchParams.get("role") === "admin" ? "admin" : "candidate";

    if (!(await tokenExists(token, db))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws._token = token;
      ws._role = role;
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    const { _token: token, _role: role } = ws;
    const sess = getOrCreateSession(token);

    if (role === "admin") {
      sess.admins.add(ws);
    } else {
      if (sess.candidate && sess.candidate !== ws) {
        try {
          sess.candidate.close();
        } catch {}
      }
      sess.candidate = ws;
    }

    try {
      ws.send(JSON.stringify({ type: "connected", role }));
    } catch {}

    // Immediately deliver the latest frame if an admin just joined/reconnected
    if (role === "admin" && sess.latestFrame) {
      try {
        ws.send(sess.latestFrame, { binary: true });
      } catch {}
    }

    if (role === "candidate") {
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        // Guard against oversized payloads (max 512 KB per JPEG frame)
        if (buf.length > 512 * 1024) return;
        broadcastLiveFrame(token, buf);
      });
    }

    ws.on("close", () => {
      const s = sessions.get(token);
      if (!s) return;
      if (role === "admin") {
        s.admins.delete(ws);
      } else if (s.candidate === ws) {
        s.candidate = null;
        s.latestFrame = null;
      }
      if (!s.candidate && s.admins.size === 0 && !s.latestFrame) {
        sessions.delete(token);
      }
    });

    ws.on("error", (err) => {
      console.error(`[live-webcam] ws error (${role}/${token.slice(0, 8)}…): ${err.message}`);
    });
  });

  httpServer.on("close", () => {
    for (const token of [...sessions.keys()]) {
      closeLiveWebcamSession(token);
    }
    wss.close();
  });

  console.log("[live-webcam] WebSocket relay attached at /live-webcam");
}
