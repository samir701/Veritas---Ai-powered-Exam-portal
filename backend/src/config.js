import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BASE_DIR = path.resolve(__dirname, "..");
export const DEFAULT_DATA_DIR = path.resolve(
  process.env.EXAM_PORTAL_DATA_DIR || (process.env.VERCEL ? path.join(os.tmpdir(), "veritas-data") : path.join(BASE_DIR, "data"))
);

function loadEnvFileOnce() {
  const envPath = path.join(BASE_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function loadOrCreateSecret(dataDir) {
  if (process.env.EXAM_PORTAL_SECRET) {
    return process.env.EXAM_PORTAL_SECRET;
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const secretFile = path.join(dataDir, ".secret_key");
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, "utf8").trim();
      if (stored.length >= 32) {
        return stored;
      }
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(secretFile, generated, "utf8");
    return generated;
  } catch {
    return crypto.randomBytes(32).toString("hex");
  }
}

export function loadConfig(overrides = {}) {
  if (overrides.loadEnv !== false) {
    loadEnvFileOnce();
  }

  let databaseUrl = String(overrides.databaseUrl ?? process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl && overrides.databaseUrl === undefined) {
    const dbHost = String(process.env.DB_HOST ?? "").trim();
    const dbPort = String(process.env.DB_PORT ?? "5432").trim();
    const dbName = String(process.env.DB_NAME ?? "postgres").trim();
    const dbUser = String(process.env.DB_USER ?? "postgres").trim();
    const dbPassword = String(process.env.DB_PASSWORD ?? "");
    if (dbHost && dbPassword) {
      databaseUrl = `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;
    }
  }
  const dbPath = path.resolve(
    overrides.dbPath || process.env.EXAM_PORTAL_DB || path.join(DEFAULT_DATA_DIR, "exam_portal.db")
  );
  if (!databaseUrl) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const secretKey = overrides.secretKey || loadOrCreateSecret(path.dirname(dbPath));
  const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

  return {
    host: overrides.host || process.env.HOST || "0.0.0.0",
    port: Number(overrides.port ?? process.env.PORT ?? 4000),
    dbPath,
    databaseUrl,
    dbSsl: overrides.dbSsl ?? process.env.DB_SSL ?? (databaseUrl ? "1" : "0"),
    supabaseUrl: String(overrides.supabaseUrl ?? process.env.SUPABASE_URL ?? "").trim(),
    supabaseAnonKey: String(overrides.supabaseAnonKey ?? process.env.SUPABASE_ANON_KEY ?? "").trim(),
    supabaseServiceRoleKey: String(
      overrides.supabaseServiceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
    ).trim(),
    secretKey,
    corsOrigin: overrides.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:3000",
    sessionTtlHours: Number(overrides.sessionTtlHours ?? process.env.EXAM_PORTAL_SESSION_HOURS ?? 12),
    inviteDefaultHours: Number(overrides.inviteDefaultHours ?? process.env.EXAM_PORTAL_INVITE_HOURS ?? 72),
    cookieSecure: overrides.cookieSecure ?? (process.env.EXAM_PORTAL_COOKIE_SECURE === "1" || isProd),
    cookieSameSite: overrides.cookieSameSite || process.env.EXAM_PORTAL_COOKIE_SAMESITE || "Lax",
    rateLimitAuthPerMin: Number(overrides.rateLimitAuthPerMin ?? process.env.EXAM_PORTAL_RATE_AUTH ?? 25),
    rateLimitApiPerMin: Number(overrides.rateLimitApiPerMin ?? process.env.EXAM_PORTAL_RATE_API ?? 180),
  };
}
