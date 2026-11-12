import http from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { setupWebSocket } from "./websocket.js";

const config = loadConfig();
const { app, db } = createApp(config);

await db.init();

const server = http.createServer(app);

// Attach live-webcam WebSocket relay (no data persisted to disk).
setupWebSocket(server, db);

server.listen(config.port, config.host, () => {
  console.log(`Veritas Exam Portal API listening on http://${config.host}:${config.port}`);
  console.log(`Database mode: ${db.dialect === "postgres" ? "Supabase PostgreSQL" : `SQLite (${config.dbPath})`}`);
});

function shutdown() {
  console.log("\nShutting down backend server...");
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
