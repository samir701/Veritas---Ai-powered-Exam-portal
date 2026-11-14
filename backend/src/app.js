import cors from "cors";
import express from "express";
import { loadConfig } from "./config.js";
import { createDatabase, nowTs, utcIso } from "./db.js";
import { RateLimiter } from "./security.js";
import { PortalError, PortalService } from "./services.js";

export const SESSION_COOKIE_NAME = "ep_session";

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function createApp(config) {
  const db = createDatabase(config);
  const service = new PortalService(db, config);
  const rateLimiter = new RateLimiter();

  const app = express();
  app.set("trust proxy", 1);

  const allowedOrigins = String(config.corsOrigin || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
          cb(null, true);
        } else {
          cb(null, false);
        }
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "1mb" }));

  // Security headers on every API response
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  function rateLimit(bucket, limit) {
    return (req, res, next) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      const { allowed, retryAfter } = rateLimiter.allow(`${ip}:${bucket}`, limit, 60);
      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          error: `Too many requests. Try again in ${retryAfter} seconds.`,
          code: "rate_limited",
        });
        return;
      }
      next();
    };
  }

  function setSessionCookie(res, value, maxAgeSeconds) {
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      `SameSite=${config.cookieSameSite || "Lax"}`,
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (config.cookieSecure) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function getSessionCookie(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[SESSION_COOKIE_NAME] || null;
  }

  async function actorFromReq(req, requireCsrf = false) {
    return service.authenticateRequest(getSessionCookie(req), {
      requireCsrf,
      csrfHeader: req.get("X-CSRF-Token") || null,
    });
  }

  function wrap(fn) {
    return async (req, res, next) => {
      try {
        await db.init();
        await fn(req, res, next);
      } catch (err) {
        next(err);
      }
    };
  }

  // ---- Health ----
  app.get(
    "/api/health",
    wrap(async (req, res) => {
      res.json({ status: "ok", db: db.dialect, server_time: utcIso(nowTs()) });
    })
  );

  // ---- Auth ----
  app.post(
    "/api/auth/register-org",
    rateLimit("auth", config.rateLimitAuthPerMin),
    wrap(async (req, res) => {
      const result = await service.registerOrganization({
        orgName: req.body?.org_name,
        fullName: req.body?.full_name,
        email: req.body?.email,
        password: req.body?.password,
        ipAddress: req.ip || "",
      });
      setSessionCookie(res, result.sessionCookie, config.sessionTtlHours * 3600);
      res.status(201).json({
        csrf_token: result.csrf_token,
        mfa_required: result.mfa_required,
        user: result.user,
      });
    })
  );

  app.post(
    "/api/auth/login",
    rateLimit("auth", config.rateLimitAuthPerMin),
    wrap(async (req, res) => {
      const result = await service.login({
        email: req.body?.email,
        password: req.body?.password,
        mfaCode: String(req.body?.mfa_code || ""),
        ipAddress: req.ip || "",
      });
      setSessionCookie(res, result.sessionCookie, config.sessionTtlHours * 3600);
      res.json({
        csrf_token: result.csrf_token,
        mfa_required: result.mfa_required,
        user: result.user,
      });
    })
  );

  app.post(
    "/api/auth/mfa/verify",
    rateLimit("auth", config.rateLimitAuthPerMin),
    wrap(async (req, res) => {
      const result = await service.verifySessionMfa(
        getSessionCookie(req),
        String(req.body?.mfa_code || ""),
        req.ip || ""
      );
      res.json(result);
    })
  );

  app.post(
    "/api/auth/accept-invite",
    rateLimit("auth", config.rateLimitAuthPerMin),
    wrap(async (req, res) => {
      const result = await service.acceptStaffInvite({
        token: req.body?.token,
        password: req.body?.password,
        ipAddress: req.ip || "",
      });
      setSessionCookie(res, result.sessionCookie, config.sessionTtlHours * 3600);
      res.status(201).json({
        csrf_token: result.csrf_token,
        mfa_required: result.mfa_required,
        user: result.user,
      });
    })
  );

  app.post(
    "/api/auth/logout",
    wrap(async (req, res) => {
      await service.logout(getSessionCookie(req));
      setSessionCookie(res, "", 0);
      res.json({ logged_out: true });
    })
  );

  app.get(
    "/api/auth/me",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      const user = await service.getUserContext(actor.user_id);
      res.json({ user, csrf_token: actor.csrf_token });
    })
  );

  app.post(
    "/api/auth/mfa/setup",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.setupMfa(actor));
    })
  );

  app.post(
    "/api/auth/mfa/enable",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.enableMfa(actor, String(req.body?.code || ""), req.ip || ""));
    })
  );

  app.post(
    "/api/auth/mfa/disable",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.disableMfa(actor, String(req.body?.password || ""), req.ip || ""));
    })
  );

  // ---- Organization & Staff ----
  app.get(
    "/api/org/members",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json(await service.listOrganizationMembers(actor));
    })
  );

  app.post(
    "/api/org/staff-invites",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.status(201).json(
        await service.createStaffInvite(actor, {
          email: req.body?.email,
          fullName: req.body?.full_name,
          role: req.body?.role,
          expiresHours: req.body?.expires_hours,
          ipAddress: req.ip || "",
        })
      );
    })
  );

  app.patch(
    "/api/org/members/:memberId",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      const member = await service.updateMember(actor, req.params.memberId, {
        role: req.body?.role,
        is_active: req.body?.is_active,
        ipAddress: req.ip || "",
      });
      res.json({ member });
    })
  );

  app.patch(
    "/api/org/settings",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      const org = await service.updateOrganizationSettings(actor, {
        name: req.body?.name,
        retention_days: req.body?.retention_days,
        ipAddress: req.ip || "",
      });
      res.json({ organization: org });
    })
  );

  app.post(
    "/api/org/retention/purge",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.purgeExpiredRecords(actor, req.ip || ""));
    })
  );

  app.get(
    "/api/org/audit-logs",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json({ logs: await service.listAuditLogs(actor, req.query.limit) });
    })
  );

  // ---- Questions ----
  app.get(
    "/api/questions",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json({
        questions: await service.listQuestions(actor, {
          poolTag: String(req.query.pool_tag || ""),
          includeArchived: req.query.include_archived === "1",
        }),
      });
    })
  );

  app.post(
    "/api/questions",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.status(201).json({ question: await service.createQuestion(actor, req.body || {}, req.ip || "") });
    })
  );

  app.post(
    "/api/questions/:questionId/archive",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.archiveQuestion(actor, req.params.questionId, req.ip || ""));
    })
  );

  // ---- Exams ----
  app.get(
    "/api/exams",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json({ exams: await service.listExams(actor) });
    })
  );

  app.post(
    "/api/exams",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.status(201).json({
        exam: await service.createOrUpdateExam(actor, req.body || {}, { ipAddress: req.ip || "" }),
      });
    })
  );

  app.get(
    "/api/exams/:examId",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json({ exam: await service.getExam(actor, req.params.examId) });
    })
  );

  app.put(
    "/api/exams/:examId",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json({
        exam: await service.createOrUpdateExam(actor, req.body || {}, {
          examId: req.params.examId,
          ipAddress: req.ip || "",
        }),
      });
    })
  );

  // ---- Invitations ----
  app.get(
    "/api/invitations",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json({
        invitations: await service.listInvitations(actor, { examId: String(req.query.exam_id || "") }),
      });
    })
  );

  app.post(
    "/api/invitations",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.status(201).json({
        invitation: await service.createInvitation(actor, req.body || {}, req.ip || ""),
      });
    })
  );

  app.post(
    "/api/invitations/:invId/regenerate",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(
        await service.regenerateInvitationLink(actor, req.params.invId, req.body?.expires_hours ?? 72, req.ip || "")
      );
    })
  );

  app.post(
    "/api/invitations/:invId/revoke",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.revokeInvitation(actor, req.params.invId, req.ip || ""));
    })
  );

  app.patch(
    "/api/invitations/:invId/webcam",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.updateInvitationWebcam(actor, req.params.invId, req.body || {}, req.ip || ""));
    })
  );

  // ---- Results & Support ----
  app.get(
    "/api/attempts",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json({ attempts: await service.listAttempts(actor, { examId: String(req.query.exam_id || "") }) });
    })
  );

  app.get(
    "/api/attempts/:attemptId",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      res.json(await service.getAttemptDetail(actor, req.params.attemptId));
    })
  );

  app.put(
    "/api/attempts/:attemptId/notes",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.updateReviewerNotes(actor, req.params.attemptId, req.body?.notes || "", req.ip || ""));
    })
  );

  app.post(
    "/api/attempts/:attemptId/extend-time",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(
        await service.extendAttemptTime(actor, req.params.attemptId, {
          extra_minutes: req.body?.extra_minutes ?? 10,
          reason: req.body?.reason || "",
          ipAddress: req.ip || "",
        })
      );
    })
  );

  app.post(
    "/api/attempts/:attemptId/anonymize",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.anonymizeAttempt(actor, req.params.attemptId, req.ip || ""));
    })
  );

  // ---- Live Webcam Streaming ----
  app.post(
    "/api/attempts/:attemptId/live-webcam/start",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.startLiveWebcam(actor, req.params.attemptId, req.ip || ""));
    })
  );

  app.get(
    "/api/attempts/:attemptId/live-webcam/token",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req);
      res.json(await service.getLiveWebcamToken(actor, req.params.attemptId));
    })
  );

  app.post(
    "/api/attempts/:attemptId/live-webcam/stop",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, true);
      res.json(await service.stopLiveWebcam(actor, req.params.attemptId, req.ip || ""));
    })
  );

  // Candidate fetches their own relay token (no CSRF — candidate-token auth)
  app.get(
    "/api/candidate/live-webcam/token",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const token = req.get("X-Candidate-Token") || String(req.query.token || "");
      res.json(await service.getCandidateLiveWebcamToken(token));
    })
  );

  // HTTP fallback: candidate pushes a transient JPEG frame (memory locally, ephemeral row on serverless)
  app.post(
    "/api/candidate/live-webcam/frame",
    rateLimit("live_frame_write", Math.max(config.rateLimitApiPerMin, 1200)),
    express.raw({ type: "image/jpeg", limit: "512kb" }),
    wrap(async (req, res) => {
      const candidateToken = req.get("X-Candidate-Token") || String(req.query.token || "");
      res.json(await service.saveLiveWebcamFrame(candidateToken, req.body));
    })
  );

  // HTTP fallback: authorized staff fetches the latest transient JPEG frame
  app.get(
    "/api/attempts/:attemptId/live-webcam/frame",
    rateLimit("live_frame_read", Math.max(config.rateLimitApiPerMin, 1200)),
    wrap(async (req, res) => {
      const actor = await actorFromReq(req, false);
      const frame = await service.getLiveWebcamFrame(actor, req.params.attemptId);
      if (!frame) {
        res.status(204).end();
        return;
      }
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(frame);
    })
  );

  // ---- Candidate Exam Workflow ----
  app.get(
    "/api/candidate/session",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const token = req.get("X-Candidate-Token") || String(req.query.token || "");
      res.json(await service.getCandidateSession(token));
    })
  );

  app.post(
    "/api/candidate/start",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const token = req.get("X-Candidate-Token") || String(req.body?.token || "");
      res.json(await service.startCandidateAttempt(token, req.body || {}));
    })
  );

  app.post(
    "/api/candidate/save",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const token = req.get("X-Candidate-Token") || String(req.body?.token || "");
      res.json(await service.saveCandidateAnswers(token, req.body?.answers || {}));
    })
  );

  app.post(
    "/api/candidate/events",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const token = req.get("X-Candidate-Token") || String(req.body?.token || "");
      res.json(await service.recordCandidateEvents(token, req.body?.events || []));
    })
  );

  app.post(
    "/api/candidate/submit",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const token = req.get("X-Candidate-Token") || String(req.body?.token || "");
      res.json(
        await service.submitCandidateAttempt(token, req.body?.answers ?? null, {
          reason: String(req.body?.reason || "manual"),
        })
      );
    })
  );

  // ---- Face Tracking Anti-Cheat ----

  // POST /api/candidate/face-events  (candidate-token auth)
  // Body: { events: [{type, detail, occurred_at}], signals: {windowSeconds, faceAbsentCount, multipleFacesCount, gazeDeviationCount, totalFrames} }
  app.post(
    "/api/candidate/face-events",
    rateLimit("api_write", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const token = req.get("X-Candidate-Token") || String(req.body?.token || "");
      const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
      const signals = req.body?.signals || {};

      // Validate token and get attempt
      const attempt = await service.getCandidateLiveWebcamToken(token);
      if (!attempt || !attempt.attempt_id) {
        throw new PortalError("Invalid or expired candidate token.", 401, "unauthorized");
      }
      const attemptId = attempt.attempt_id;

      // Normalize events (support both event_type and type)
      const events = rawEvents.map((e) => ({
        event_type: e.event_type || e.type,
        detail: typeof e.detail === "object" ? e.detail : { info: String(e.detail || "") },
        occurred_at: e.occurred_at || nowTs(),
      }));

      // Record events into session_events table using existing service method
      if (events.length > 0) {
        await service.recordCandidateEvents(token, events);
      }

      // Groq analysis
      let riskResult = { risk: "unknown", verdict: "Pending analysis.", flags: [] };
      if (signals && typeof signals === "object" && Object.keys(signals).length > 0) {
        const { analyzeFaceSignals } = await import("./groq-analysis.js");
        riskResult = await analyzeFaceSignals(signals, attemptId, config.groqApiKey);
      }

      res.json({ recorded: events.length, ...riskResult });
    })
  );

  // GET /api/attempts/:attemptId/face-analysis  (staff auth)
  app.get(
    "/api/attempts/:attemptId/face-analysis",
    rateLimit("api_read", config.rateLimitApiPerMin),
    wrap(async (req, res) => {
      const session = await actorFromReq(req, false);
      if (!session) throw new PortalError("Not authenticated.", "unauthenticated", 401);

      const { attemptId } = req.params;
      const { getLatestVerdict } = await import("./groq-analysis.js");
      const cached = getLatestVerdict(attemptId);

      // Fetch recent face events from session_events
      const faceEventTypes = ["face_absent", "multiple_faces", "gaze_deviation", "face_detected"];
      const allEvents = await service.getAttemptEvents(attemptId);
      const faceEvents = allEvents.filter(e => faceEventTypes.includes(e.event_type));

      const counts = { face_absent: 0, multiple_faces: 0, gaze_deviation: 0, face_detected: 0 };
      for (const e of faceEvents) counts[e.event_type] = (counts[e.event_type] || 0) + 1;

      res.json({
        attemptId,
        risk: cached?.risk || "unknown",
        verdict: cached?.verdict || "No analysis yet.",
        flags: cached?.flags || [],
        updatedAt: cached?.updatedAt || null,
        event_counts: counts,
        recentEvents: faceEvents.slice(-50),
      });
    })
  );

  // ---- 404 & Error Handler ----
  app.use((req, res) => {
    res.status(404).json({ error: "API endpoint not found.", code: "not_found" });
  });

  app.use((err, req, res, _next) => {
    if (err instanceof PortalError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON request body.", code: "invalid_json" });
      return;
    }
    res.status(500).json({ error: `Internal server error: ${err?.message || err}`, code: "internal_error" });
  });

  return { app, db, service };
}

let cachedDefaultApp = null;

/**
 * Default Express handler export for Vercel zero-config Node/Express runtime
 * when `src/app.js` is invoked directly as a serverless entrypoint.
 */
export default function handler(req, res) {
  if (!cachedDefaultApp) {
    cachedDefaultApp = createApp(loadConfig()).app;
  }
  return cachedDefaultApp(req, res);
}


