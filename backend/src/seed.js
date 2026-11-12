import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { PortalService } from "./services.js";

const config = loadConfig();
const db = createDatabase(config);
const service = new PortalService(db, config);

try {
  await db.init();
  const row = await db.get("SELECT COUNT(*) AS c FROM organizations");
  if (Number(row.c) > 0) {
    console.log("Database already contains organizations; skipping demo seed.");
    process.exit(0);
  }

  const demoPassword = `Demo-${crypto.randomBytes(9).toString("base64url")}`;
  const reg = await service.registerOrganization({
    orgName: "Northstar Tech Recruiting",
    fullName: "Morgan Ellis",
    email: "admin@northstar.example",
    password: demoPassword,
  });

  const actor = {
    user_id: reg.user.id,
    organization_id: reg.user.organization_id,
    email: reg.user.email,
    role: reg.user.role,
  };

  const q1 = await service.createQuestion(actor, {
    prompt: "Which HTTP status code best represents a newly created resource?",
    pool_tag: "http",
    difficulty: "easy",
    points: 2,
    explanation: "201 Created indicates that the request succeeded and led to the creation of a resource.",
    options: [
      { text: "200 OK", is_correct: false },
      { text: "201 Created", is_correct: true },
      { text: "204 No Content", is_correct: false },
      { text: "304 Not Modified", is_correct: false },
    ],
  });

  const q2 = await service.createQuestion(actor, {
    prompt: "Why should answer keys and scoring logic stay strictly on the server before exam submission?",
    pool_tag: "security",
    difficulty: "medium",
    points: 3,
    explanation: "Anything sent to the browser can be inspected via DevTools or network logs.",
    options: [
      { text: "To prevent candidates from inspecting correct answers in browser DevTools", is_correct: true },
      { text: "Because browsers cannot store JSON objects", is_correct: false },
      { text: "To reduce CSS bundle size", is_correct: false },
      { text: "Because SQLite only runs in the browser", is_correct: false },
    ],
  });

  const q3 = await service.createQuestion(actor, {
    prompt: "What happens if a candidate exits fullscreen or switches tabs during a strict-lock exam?",
    pool_tag: "integrity",
    difficulty: "medium",
    points: 2,
    explanation: "Strict exam lock auto-submits the attempt and records the trigger reason for reviewer inspection.",
    options: [
      { text: "The paper auto-submits and logs the reason for human review", is_correct: true },
      { text: "The candidate receives extra bonus points", is_correct: false },
      { text: "All questions are deleted", is_correct: false },
      { text: "Nothing is recorded", is_correct: false },
    ],
  });

  const exam = await service.createOrUpdateExam(actor, {
    title: "Backend & Security Fundamentals",
    description: "Timed MCQ assessment covering HTTP, web security, and assessment integrity.",
    duration_minutes: 20,
    passing_score_percent: 70,
    shuffle_questions: true,
    shuffle_options: true,
    require_fullscreen: true,
    auto_submit_on_violation: true,
    lock_copy_paste: true,
    require_webcam_check: true,
    allow_non_webcam_alternative: true,
    status: "published",
    question_ids: [q1.id, q2.id, q3.id],
  });

  const inv = await service.createInvitation(actor, {
    exam_id: exam.id,
    candidate_name: "Taylor Jordan",
    candidate_email: "taylor.candidate@example.com",
    expires_hours: 72,
  });

  console.log("Demo organization seeded:");
  console.log("  Admin Email:    admin@northstar.example");
  console.log(`  Admin Password: ${demoPassword}`);
  console.log(`  Sample Exam:    ${exam.title}`);
  console.log(`  Candidate Link: ${inv.invite_path}`);
} finally {
  await db.close();
}
