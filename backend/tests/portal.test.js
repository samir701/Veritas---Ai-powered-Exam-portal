import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { nowTs, translateSqlToPg } from "../src/db.js";
import { currentTotp } from "../src/security.js";
import { setupWebSocket } from "../src/websocket.js";

class HttpClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = "";
    this.csrfToken = null;
  }

  async request(method, reqPath, body = undefined, { includeCsrf = true } = {}) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (includeCsrf && method !== "GET" && this.csrfToken) {
      headers["X-CSRF-Token"] = this.csrfToken;
    }

    const res = await fetch(`${this.baseUrl}${reqPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      if (pair.endsWith("=")) {
        this.cookie = "";
      } else {
        this.cookie = pair;
      }
    }

    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  }
}

async function startTestServer(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veritas-test-"));
  const cfg = loadConfig({
    loadEnv: false,
    databaseUrl: "",
    host: "127.0.0.1",
    port: 0,
    dbPath: path.join(tmpDir, "test.db"),
    secretKey: "test-secret-key-for-node-tests-only-32bytes",
    rateLimitAuthPerMin: 15,
    rateLimitApiPerMin: 500,
    ...overrides,
  });
  const { app, db } = createApp(cfg);
  await db.init();
  const server = http.createServer(app);
  setupWebSocket(server, db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    db,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function registerOrg(client, orgName, email, password = "StrongPass123!") {
  const { status, data } = await client.request("POST", "/api/auth/register-org", {
    org_name: orgName,
    full_name: "Admin User",
    email,
    password,
  });
  assert.equal(status, 201);
  client.csrfToken = data.csrf_token;
  return data;
}

test("end-to-end exam workflow, RBAC, CSRF, answer-key protection, and isolation", async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const admin = new HttpClient(srv.baseUrl);
  await registerOrg(admin, "Acme Corp", "admin@acme.test");

  // 1. CSRF check
  const noCsrf = await admin.request(
    "POST",
    "/api/questions",
    { prompt: "No CSRF", options: [{ text: "A", is_correct: true }, { text: "B", is_correct: false }] },
    { includeCsrf: false }
  );
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.code, "csrf_invalid");

  // 2. Create 3 questions
  const qIds = [];
  const correctTexts = {};
  for (let i = 0; i < 3; i += 1) {
    const corrText = `Correct Answer ${i}`;
    const qRes = await admin.request("POST", "/api/questions", {
      prompt: `Sample Question ${i}`,
      pool_tag: "core",
      difficulty: "medium",
      points: 2.0,
      negative_points: 0.5,
      explanation: `Explanation ${i}`,
      options: [
        { text: corrText, is_correct: true },
        { text: `Wrong A ${i}`, is_correct: false },
        { text: `Wrong B ${i}`, is_correct: false },
      ],
    });
    assert.equal(qRes.status, 201);
    const qid = qRes.data.question.id;
    qIds.push(qid);
    correctTexts[qid] = corrText;
  }

  // 3. Invite reviewer & verify RBAC
  const sinv = await admin.request("POST", "/api/org/staff-invites", {
    email: "rev@acme.test",
    full_name: "Ray Reviewer",
    role: "reviewer",
  });
  assert.equal(sinv.status, 201);

  const reviewer = new HttpClient(srv.baseUrl);
  const acc = await reviewer.request("POST", "/api/auth/accept-invite", {
    token: sinv.data.invite_token,
    password: "ReviewerPass123!",
  });
  assert.equal(acc.status, 201);
  reviewer.csrfToken = acc.data.csrf_token;

  const blockedQ = await reviewer.request("POST", "/api/questions", {
    prompt: "Blocked",
    options: [{ text: "A", is_correct: true }, { text: "B", is_correct: false }],
  });
  assert.equal(blockedQ.status, 403);
  const blockedAudit = await reviewer.request("GET", "/api/org/audit-logs");
  assert.equal(blockedAudit.status, 403);

  // 4. Create exam (human review mode without auto-submit) drawing 2 random questions
  const exRes = await admin.request("POST", "/api/exams", {
    title: "Backend Assessment",
    duration_minutes: 15,
    passing_score_percent: 50,
    draw_count: 2,
    shuffle_questions: true,
    shuffle_options: true,
    require_fullscreen: true,
    auto_submit_on_violation: false,
    require_webcam_check: true,
    allow_non_webcam_alternative: true,
    status: "published",
    question_ids: qIds,
  });
  assert.equal(exRes.status, 201);
  const examId = exRes.data.exam.id;

  // 5. Invite candidate
  const invRes = await admin.request("POST", "/api/invitations", {
    exam_id: examId,
    candidate_name: "Sam Candidate",
    candidate_email: "sam@cand.test",
    extra_time_minutes: 5,
  });
  assert.equal(invRes.status, 201);
  const candToken = invRes.data.invitation.invite_token;

  // 6. Candidate session before start
  const cand = new HttpClient(srv.baseUrl);
  const sess = await cand.request("GET", `/api/candidate/session?token=${candToken}`);
  assert.equal(sess.status, 200);
  assert.equal(sess.data.attempt.status, "not_started");
  assert.equal(sess.data.exam.total_minutes, 20);
  assert.deepEqual(sess.data.questions, []);

  // Consent required
  const noConsent = await cand.request("POST", "/api/candidate/start", {
    token: candToken,
    consent_accepted: false,
  });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.data.code, "consent_required");

  // Start exam with non-webcam alternative
  const started = await cand.request("POST", "/api/candidate/start", {
    token: candToken,
    consent_accepted: true,
    webcam_consent_choice: "alternative_requested",
    device_check: { fetch: true, network_ok: true, latency_ms: 12 },
  });
  assert.equal(started.status, 200);
  assert.equal(started.data.attempt.status, "in_progress");
  assert.equal(started.data.questions.length, 2);

  const rawJson = JSON.stringify(started.data.questions);
  assert.ok(!rawJson.includes("is_correct"));
  assert.ok(!rawJson.includes("explanation"));

  // 7. Save 1 right, 1 wrong
  const [q0, q1] = started.data.questions;
  const q0Right = q0.options.find((o) => o.text === correctTexts[q0.question_id]).id;
  const q1Wrong = q1.options.find((o) => o.text !== correctTexts[q1.question_id]).id;

  const saveRes = await cand.request("POST", "/api/candidate/save", {
    token: candToken,
    answers: { [q0.question_id]: q0Right, [q1.question_id]: q1Wrong },
  });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.data.saved_count, 2);

  // Record signals
  const evtRes = await cand.request("POST", "/api/candidate/events", {
    token: candToken,
    events: [{ event_type: "tab_hidden" }, { event_type: "fullscreen_exited" }, { event_type: "reconnected" }],
  });
  assert.equal(evtRes.status, 200);
  assert.equal(evtRes.data.recorded, 3);

  // 8. Submit & verify grading (2.0 - 0.5 = 1.5 / 4.0 = 37.5%)
  const subRes = await cand.request("POST", "/api/candidate/submit", { token: candToken });
  assert.equal(subRes.status, 200);
  assert.equal(subRes.data.status, "submitted");
  const attemptId = subRes.data.attempt_id;

  const det = await reviewer.request("GET", `/api/attempts/${attemptId}`);
  assert.equal(det.status, 200);
  assert.equal(det.data.attempt.score_earned, 1.5);
  assert.equal(det.data.attempt.score_possible, 4.0);
  assert.equal(det.data.attempt.score_percent, 37.5);
  assert.equal(det.data.attempt.passed, false);
  assert.equal(det.data.signal_summary.tab_hidden, 1);
  assert.equal(det.data.signal_summary.fullscreen_exited, 1);

  // 9. Cross-tenant isolation
  const rival = new HttpClient(srv.baseUrl);
  await registerOrg(rival, "Rival Org", "boss@rival.test");
  assert.equal((await rival.request("GET", `/api/attempts/${attemptId}`)).status, 404);
  assert.equal((await rival.request("GET", `/api/exams/${examId}`)).status, 404);

  // 10. Anonymize candidate data
  assert.equal((await admin.request("POST", `/api/attempts/${attemptId}/anonymize`, {})).status, 200);
  const detAfter = await admin.request("GET", `/api/attempts/${attemptId}`);
  assert.equal(detAfter.data.attempt.is_anonymized, true);
  assert.ok(!detAfter.data.attempt.candidate_name.includes("Sam Candidate"));
  assert.deepEqual(detAfter.data.events, []);
});

test("server timer expiration and support time extension", async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const admin = new HttpClient(srv.baseUrl);
  await registerOrg(admin, "Timer Org", "admin@timer.test");

  const qRes = await admin.request("POST", "/api/questions", {
    prompt: "1 + 1 = ?",
    options: [{ text: "2", is_correct: true }, { text: "3", is_correct: false }],
  });
  const exRes = await admin.request("POST", "/api/exams", {
    title: "Quick Math",
    duration_minutes: 10,
    status: "published",
    question_ids: [qRes.data.question.id],
  });
  const invRes = await admin.request("POST", "/api/invitations", {
    exam_id: exRes.data.exam.id,
    candidate_name: "Timed User",
    candidate_email: "timed@timer.test",
  });
  const token = invRes.data.invitation.invite_token;

  const cand = new HttpClient(srv.baseUrl);
  const startRes = await cand.request("POST", "/api/candidate/start", { token, consent_accepted: true });
  assert.equal(startRes.status, 200);
  const attemptId = startRes.data.attempt.id;

  await srv.db.run("UPDATE attempts SET expires_at = ? WHERE id = ?", nowTs() - 5, attemptId);

  const saveErr = await cand.request("POST", "/api/candidate/save", { token, answers: {} });
  assert.equal(saveErr.status, 409);
  assert.equal(saveErr.data.code, "timed_out");

  const ext = await admin.request("POST", `/api/attempts/${attemptId}/extend-time`, {
    extra_minutes: 10,
    reason: "Power outage during exam",
  });
  assert.equal(ext.status, 200);
  assert.equal(ext.data.status, "in_progress");

  const resumed = await cand.request("GET", `/api/candidate/session?token=${token}`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.attempt.status, "in_progress");
  assert.ok(resumed.data.attempt.remaining_seconds > 500);
});

test("MFA login challenge and auth rate limiting", async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const admin = new HttpClient(srv.baseUrl);
  await registerOrg(admin, "MFA Org", "mfa@org.test", "MfaPassword123!");

  const setup = await admin.request("POST", "/api/auth/mfa/setup", {});
  assert.equal(setup.status, 200);
  const secret = setup.data.secret;

  const enabled = await admin.request("POST", "/api/auth/mfa/enable", { code: currentTotp(secret) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.mfa_enabled, true);

  const loginClient = new HttpClient(srv.baseUrl);
  const loginRes = await loginClient.request("POST", "/api/auth/login", {
    email: "mfa@org.test",
    password: "MfaPassword123!",
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.data.mfa_required, true);

  const blocked = await loginClient.request("GET", "/api/auth/me");
  assert.equal(blocked.status, 401);
  assert.equal(blocked.data.code, "mfa_required");

  const verified = await loginClient.request("POST", "/api/auth/mfa/verify", {
    mfa_code: currentTotp(secret),
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.user.email, "mfa@org.test");

  let hit429 = false;
  for (let i = 0; i < 20; i += 1) {
    const r = await loginClient.request("POST", "/api/auth/login", {
      email: "mfa@org.test",
      password: "WrongPassword",
    });
    if (r.status === 429) {
      hit429 = true;
      break;
    }
  }
  assert.equal(hit429, true);
});

test("single-attempt resume and retention purge", async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const admin = new HttpClient(srv.baseUrl);
  await registerOrg(admin, "Retention Org", "admin@ret.test");

  const setRes = await admin.request("PATCH", "/api/org/settings", { retention_days: 30 });
  assert.equal(setRes.status, 200);
  assert.equal(setRes.data.organization.retention_days, 30);

  const qRes = await admin.request("POST", "/api/questions", {
    prompt: "Capital of France?",
    options: [{ text: "Paris", is_correct: true }, { text: "Rome", is_correct: false }],
  });
  const exRes = await admin.request("POST", "/api/exams", {
    title: "Geo Check",
    duration_minutes: 10,
    status: "published",
    question_ids: [qRes.data.question.id],
  });
  const invRes = await admin.request("POST", "/api/invitations", {
    exam_id: exRes.data.exam.id,
    candidate_name: "Old Candidate",
    candidate_email: "old@ret.test",
  });
  const token = invRes.data.invitation.invite_token;

  const cand = new HttpClient(srv.baseUrl);
  const started = await cand.request("POST", "/api/candidate/start", { token, consent_accepted: true });
  assert.equal(started.status, 200);
  const attemptId = started.data.attempt.id;

  const resumed = await cand.request("POST", "/api/candidate/start", { token, consent_accepted: true });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.attempt.id, attemptId);

  assert.equal((await cand.request("POST", "/api/candidate/submit", { token })).status, 200);
  const dup = await cand.request("POST", "/api/candidate/start", { token, consent_accepted: true });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, "attempt_already_exists");

  await srv.db.run("UPDATE attempts SET created_at = ? WHERE id = ?", nowTs() - 45 * 86400, attemptId);
  const purge = await admin.request("POST", "/api/org/retention/purge", {});
  assert.equal(purge.status, 200);
  assert.equal(purge.data.anonymized_count, 1);
});

test("strict auto-submit on tab switch / fullscreen exit and copy-paste lock events", async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const admin = new HttpClient(srv.baseUrl);
  await registerOrg(admin, "Strict Org", "admin@strict.test");

  const qRes = await admin.request("POST", "/api/questions", {
    prompt: "Strict Q?",
    points: 5.0,
    options: [{ text: "Yes", is_correct: true }, { text: "No", is_correct: false }],
  });

  const exRes = await admin.request("POST", "/api/exams", {
    title: "Locked Assessment",
    duration_minutes: 20,
    status: "published",
    question_ids: [qRes.data.question.id],
  });
  assert.equal(exRes.status, 201);
  assert.equal(exRes.data.exam.require_fullscreen, true);
  assert.equal(exRes.data.exam.auto_submit_on_violation, true);
  assert.equal(exRes.data.exam.lock_copy_paste, true);

  // Candidate 1: copy_paste_blocked then tab_hidden triggers auto-submit
  const inv1 = await admin.request("POST", "/api/invitations", {
    exam_id: exRes.data.exam.id,
    candidate_name: "Tab Switcher",
    candidate_email: "tab@strict.test",
  });
  const tok1 = inv1.data.invitation.invite_token;
  const cand1 = new HttpClient(srv.baseUrl);
  const sess1 = await cand1.request("POST", "/api/candidate/start", { token: tok1, consent_accepted: true });
  assert.equal(sess1.status, 200);

  const cpRes = await cand1.request("POST", "/api/candidate/events", {
    token: tok1,
    events: [{ event_type: "copy_paste_blocked", detail: { action: "copy" } }],
  });
  assert.equal(cpRes.status, 200);
  assert.equal(cpRes.data.auto_submitted, false);
  assert.equal(cpRes.data.status, "in_progress");

  const tabRes = await cand1.request("POST", "/api/candidate/events", {
    token: tok1,
    events: [{ event_type: "tab_hidden" }],
  });
  assert.equal(tabRes.status, 200);
  assert.equal(tabRes.data.auto_submitted, true);
  assert.equal(tabRes.data.status, "submitted");
  assert.equal(tabRes.data.submit_reason, "tab_switched");

  const qItem = sess1.data.questions[0];
  const saveErr = await cand1.request("POST", "/api/candidate/save", {
    token: tok1,
    answers: { [qItem.question_id]: qItem.options[0].id },
  });
  assert.equal(saveErr.status, 409);
  assert.equal(saveErr.data.code, "already_submitted");

  const attempts = await admin.request("GET", "/api/attempts");
  const det1 = await admin.request("GET", `/api/attempts/${attempts.data.attempts[0].id}`);
  assert.equal(det1.data.attempt.submit_reason, "tab_switched");
  assert.equal(det1.data.signal_summary.copy_paste_blocked, 1);
  assert.equal(det1.data.signal_summary.tab_hidden, 1);

  // Candidate 2: fullscreen_exited submit flushes answers and records reason
  const inv2 = await admin.request("POST", "/api/invitations", {
    exam_id: exRes.data.exam.id,
    candidate_name: "FS Exiter",
    candidate_email: "fs@strict.test",
  });
  const tok2 = inv2.data.invitation.invite_token;
  const cand2 = new HttpClient(srv.baseUrl);
  const sess2 = await cand2.request("POST", "/api/candidate/start", { token: tok2, consent_accepted: true });
  const q2 = sess2.data.questions[0];
  const yesOpt = q2.options.find((o) => o.text === "Yes").id;

  const sub2 = await cand2.request("POST", "/api/candidate/submit", {
    token: tok2,
    answers: { [q2.question_id]: yesOpt },
    reason: "fullscreen_exited",
  });
  assert.equal(sub2.status, 200);
  assert.equal(sub2.data.status, "submitted");
  assert.equal(sub2.data.submit_reason, "fullscreen_exited");

  const det2 = await admin.request("GET", `/api/attempts/${sub2.data.attempt_id}`);
  assert.equal(det2.data.attempt.score_percent, 100);
  assert.equal(det2.data.attempt.submit_reason, "fullscreen_exited");
  assert.equal(det2.data.signal_summary.fullscreen_exited, 1);
});

test("live webcam monitoring per-candidate, WebSocket relay, HTTP frame fallback, and cleanup", async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const admin = new HttpClient(srv.baseUrl);
  await registerOrg(admin, "Live Cam Org", "admin@livecam.test");

  const otherAdmin = new HttpClient(srv.baseUrl);
  await registerOrg(otherAdmin, "Other Org", "admin@othercam.test");

  const qRes = await admin.request("POST", "/api/questions", {
    prompt: "Camera check question",
    options: [
      { text: "True", is_correct: true },
      { text: "False", is_correct: false },
    ],
  });
  assert.equal(qRes.status, 201);

  const exRes = await admin.request("POST", "/api/exams", {
    title: "Live Monitored Exam",
    duration_minutes: 30,
    require_webcam_check: false,
    require_live_webcam: false,
    allow_non_webcam_alternative: false,
    status: "published",
    question_ids: [qRes.data.question.id],
  });
  assert.equal(exRes.status, 201);

  // Invite candidate with per-candidate live webcam required
  const invRes = await admin.request("POST", "/api/invitations", {
    exam_id: exRes.data.exam.id,
    candidate_name: "Monitored Candidate",
    candidate_email: "cam@livecam.test",
    require_live_webcam: true,
  });
  assert.equal(invRes.status, 201);
  assert.equal(invRes.data.invitation.require_live_webcam, true);
  const rawToken = invRes.data.invitation.invite_token;

  // Candidate session shows live webcam required
  const sessGet = await fetch(`${srv.baseUrl}/api/candidate/session?token=${encodeURIComponent(rawToken)}`);
  const sessData = await sessGet.json();
  assert.equal(sessGet.status, 200);
  assert.equal(sessData.exam.require_live_webcam, true);
  assert.equal(sessData.exam.require_webcam_check, true);

  // Starting without consent fails
  const badStart = await fetch(`${srv.baseUrl}/api/candidate/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: rawToken, consent_accepted: true, webcam_consent_choice: "not_required" }),
  });
  assert.equal(badStart.status, 400);

  // Starting with consent activates live_webcam_active automatically
  const okStart = await fetch(`${srv.baseUrl}/api/candidate/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: rawToken, consent_accepted: true, webcam_consent_choice: "consented" }),
  });
  assert.equal(okStart.status, 200);
  const started = await okStart.json();
  assert.equal(started.attempt.live_webcam_active, true);
  const attemptId = started.attempt.id;

  // Candidate fetches relay token
  const candTokRes = await fetch(`${srv.baseUrl}/api/candidate/live-webcam/token`, {
    headers: { "X-Candidate-Token": rawToken },
  });
  const candTokData = await candTokRes.json();
  assert.equal(candTokRes.status, 200);
  assert.ok(candTokData.token);

  // Cross-org admin cannot fetch token
  const crossOrgRes = await otherAdmin.request("GET", `/api/attempts/${attemptId}/live-webcam/token`);
  assert.equal(crossOrgRes.status, 404);

  // Connect candidate + admin WebSockets and verify binary JPEG frame relay
  const wsBase = srv.baseUrl.replace(/^http/, "ws");
  const relayToken = candTokData.token;
  const adminWs = new WebSocket(`${wsBase}/live-webcam?token=${encodeURIComponent(relayToken)}&role=admin`);
  const candWs = new WebSocket(`${wsBase}/live-webcam?token=${encodeURIComponent(relayToken)}&role=candidate`);

  await Promise.all([
    new Promise((resolve, reject) => {
      adminWs.once("open", resolve);
      adminWs.once("error", reject);
    }),
    new Promise((resolve, reject) => {
      candWs.once("open", resolve);
      candWs.once("error", reject);
    }),
  ]);

  const sampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9]);
  const receivedFrame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS frame")), 3000);
    adminWs.on("message", (data, isBinary) => {
      if (isBinary) {
        clearTimeout(timer);
        resolve(Buffer.from(data));
      }
    });
    candWs.send(sampleJpeg);
  });
  assert.deepEqual(receivedFrame, sampleJpeg);

  // HTTP fallback returns latest in-memory frame
  const httpFrameRes = await fetch(`${srv.baseUrl}/api/attempts/${attemptId}/live-webcam/frame`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(httpFrameRes.status, 200);
  const httpBuf = Buffer.from(await httpFrameRes.arrayBuffer());
  assert.deepEqual(httpBuf, sampleJpeg);

  // Admin stops preview -> clears token & memory
  const stopRes = await admin.request("POST", `/api/attempts/${attemptId}/live-webcam/stop`, {});
  assert.equal(stopRes.status, 200);
  assert.equal(stopRes.data.stopped, true);

  const afterStopCand = await fetch(`${srv.baseUrl}/api/candidate/live-webcam/token`, {
    headers: { "X-Candidate-Token": rawToken },
  });
  const afterStopData = await afterStopCand.json();
  assert.equal(afterStopData.token, null);

  adminWs.close();
  candWs.close();
});

test("PostgreSQL placeholder translation preserves quoted literals and Vercel handler exports Express app", async () => {
  const translated = translateSqlToPg(
    "SELECT * FROM questions WHERE prompt = 'What is 1 + 1?' AND organization_id = ? AND is_archived = ?"
  );
  assert.equal(
    translated,
    "SELECT * FROM questions WHERE prompt = 'What is 1 + 1?' AND organization_id = $1 AND is_archived = $2"
  );

  const escaped = translateSqlToPg("SELECT 'It''s ok?' AS q FROM users WHERE id = ?");
  assert.equal(escaped, "SELECT 'It''s ok?' AS q FROM users WHERE id = $1");

  const { default: vercelApp } = await import("../api/index.js");
  assert.equal(typeof vercelApp, "function");

  const { default: appHandler } = await import("../src/app.js");
  assert.equal(typeof appHandler, "function");
});



