import fs from "node:fs";
import { loadConfig } from "./config.js";
import { Database, PgDatabase } from "./db.js";

const TABLES_IN_ORDER = [
  { name: "organizations", conflict: "(id)" },
  { name: "users", conflict: "(id)" },
  { name: "staff_invites", conflict: "(id)" },
  { name: "sessions", conflict: "(id)" },
  { name: "questions", conflict: "(id)" },
  { name: "question_options", conflict: "(id)" },
  { name: "exams", conflict: "(id)" },
  { name: "exam_questions", conflict: "(exam_id, question_id)" },
  { name: "candidate_invitations", conflict: "(id)" },
  { name: "attempts", conflict: "(id)" },
  { name: "attempt_questions", conflict: "(id)" },
  { name: "session_events", conflict: "(id)" },
  { name: "audit_logs", conflict: "(id)" },
];

async function migrate() {
  const config = loadConfig();

  if (!config.databaseUrl) {
    console.error("Error: DATABASE_URL is not set in backend/.env.");
    console.error("Paste your Supabase PostgreSQL Connection String into backend/.env as DATABASE_URL=postgresql://...");
    process.exit(1);
  }

  if (!fs.existsSync(config.dbPath)) {
    console.error(`Error: Local SQLite database not found at ${config.dbPath}`);
    process.exit(1);
  }

  const sqliteDb = new Database(config.dbPath);
  const pgDb = new PgDatabase(config.databaseUrl, { ssl: config.dbSsl !== "0" });

  try {
    await sqliteDb.init();
    await pgDb.init();

    console.log(`Migrating data from SQLite (${config.dbPath}) -> Supabase PostgreSQL...`);

    const report = [];
    await pgDb.transaction(async () => {
      for (const table of TABLES_IN_ORDER) {
        const rows = await sqliteDb.all(`SELECT * FROM ${table.name}`);
        let inserted = 0;

        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          const colList = cols.join(", ");
          const placeholders = cols.map(() => "?").join(", ");
          const insertSql = `INSERT INTO ${table.name} (${colList}) VALUES (${placeholders}) ON CONFLICT ${table.conflict} DO NOTHING`;

          for (const row of rows) {
            const values = cols.map((c) => row[c] ?? null);
            const res = await pgDb.run(insertSql, ...values);
            inserted += res.changes || 0;
          }
        }

        const pgCountRow = await pgDb.get(`SELECT COUNT(*) AS c FROM ${table.name}`);
        report.push({
          table: table.name,
          sqlite_rows: rows.length,
          newly_inserted: inserted,
          supabase_total: Number(pgCountRow.c),
        });
      }
    });

    console.table(report);
    console.log("Migration to Supabase completed successfully.");
  } finally {
    await sqliteDb.close();
    await pgDb.close();
  }
}

migrate().catch((err) => {
  console.error("Supabase migration failed:", err.message || err);
  process.exit(1);
});

