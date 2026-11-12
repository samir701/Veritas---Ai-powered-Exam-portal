import { nowTs, utcIso } from "./db.js";
import { gradeAttemptQuestions, selectAndOrderQuestions } from "./scoring.js";
import { broadcastLiveFrame, closeLiveWebcamSession, getLatestLiveFrame } from "./websocket.js";
import {
  generateMfaSecret,
  generateToken,
  hashPassword,
  hashToken,
  newId,
  signValue,
  totpUri,
  verifyPassword,
  verifySignedValue,
  verifyTotp,
} from "./security.js";

const VALID_ROLES = new Set(["admin", "interviewer", "reviewer"]);
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const VALID_EXAM_STATUSES = new Set(["draft", "published", "archived"]);
const ALLOWED_CANDIDATE_EVENTS = new Set([
  "device_check_completed",
  "fullscreen_entered",
  "fullscreen_exited",
  "tab_hidden",
  "tab_visible",
  "window_blur",
  "window_focus",
  "offline",
  "reconnected",
  "webcam_check_passed",
  "webcam_check_failed",
  "accommodation_requested",
  "copy_paste_blocked",
  "heartbeat",
]);

export class PortalError extends Error {
  constructor(message, statusCode = 400, code = "bad_request") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function slugify(name) {
  return (
    String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

function requireNonEmpty(value, field, maxLen = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PortalError(`${field} is required.`, 400, "validation_error");
  }
  const cleaned = value.trim();
  if (cleaned.length > maxLen) {
    throw new PortalError(`${field} exceeds maximum length of ${maxLen}.`, 400, "validation_error");
  }
  return cleaned;
}

function validateEmail(email) {
  const cleaned = requireNonEmpty(email, "Email", 254).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) {
    throw new PortalError("Please enter a valid email address.", 400, "validation_error");
  }
  return cleaned;
}

function placeholders(arr) {
  return arr.map(() => "?").join(",");
}

export class PortalService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  async _audit({
    organizationId,
    actorUserId = null,
    actorEmail = "",
    action,
    targetType = "",
    targetId = "",
    detail = {},
    ipAddress = "",
  }) {
    await this.db.run(
      `INSERT INTO audit_logs
         (id, organization_id, actor_user_id, actor_email, action, target_type, target_id, detail_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("aud"),
      organizationId,
      actorUserId,
      actorEmail,
      action,
      targetType,
      targetId,
      JSON.stringify(detail || {}),
      ipAddress,
      nowTs()
    );
  }

  _requireRole(actor, allowed) {
    if (!allowed.has(actor.role)) {
      throw new PortalError("You do not have permission to perform this action.", 403, "forbidden");
    }
  }

  // ------------------------------------------------------------------
  // Auth, Organizations & Staff Management
  // ------------------------------------------------------------------
  async registerOrganization({ orgName, fullName, email, password, ipAddress = "" }) {
    const orgNameC = requireNonEmpty(orgName, "Organization name", 120);
    const fullNameC = requireNonEmpty(fullName, "Full name", 120);
    const emailC = validateEmail(email);
    let pwHash;
    try {
      pwHash = hashPassword(password);
    } catch (err) {
      throw new PortalError(err.message, 400, "validation_error");
    }

    const now = nowTs();
    const baseSlug = slugify(orgNameC);
    const orgId = newId("org");
    const userId = newId("usr");

    const sessionData = await this.db.transaction(async () => {
      const existing = await this.db.get("SELECT id FROM users WHERE email = ?", emailC);
      if (existing) {
        throw new PortalError("An account with this email already exists.", 409, "email_exists");
      }

      let slug = baseSlug;
      let suffix = 1;
      while (await this.db.get("SELECT id FROM organizations WHERE slug = ?", slug)) {
        suffix += 1;
        slug = `${baseSlug}-${suffix}`;
      }

      await this.db.run(
        "INSERT INTO organizations (id, name, slug, retention_days, created_at) VALUES (?, ?, ?, ?, ?)",
        orgId,
        orgNameC,
        slug,
        90,
        now
      );
      await this.db.run(
        `INSERT INTO users (id, organization_id, email, full_name, role, password_hash, mfa_enabled, is_active, created_at)
         VALUES (?, ?, ?, ?, 'admin', ?, 0, 1, ?)`,
        userId,
        orgId,
        emailC,
        fullNameC,
        pwHash,
        now
      );
      const ses = await this._createSessionRow(userId, true);
      await this._audit({
        organizationId: orgId,
        actorUserId: userId,
        actorEmail: emailC,
        action: "organization.created",
        targetType: "organization",
        targetId: orgId,
        detail: { org_name: orgNameC },
        ipAddress,
      });
      return ses;
    });

    return {
      sessionCookie: sessionData.sessionCookie,
      csrf_token: sessionData.csrfToken,
      mfa_required: false,
      user: await this.getUserContext(userId),
    };
  }

  async _createSessionRow(userId, mfaVerified) {
    const rawToken = generateToken(32);
    const csrfToken = generateToken(24);
    const sessionId = newId("ses");
    const now = nowTs();
    const expiresAt = now + this.config.sessionTtlHours * 3600;
    await this.db.run(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token, mfa_verified, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      userId,
      hashToken(rawToken),
      csrfToken,
      mfaVerified ? 1 : 0,
      expiresAt,
      now
    );
    return {
      sessionCookie: signValue(this.config.secretKey, rawToken),
      csrfToken,
    };
  }

  async login({ email, password, mfaCode = "", ipAddress = "" }) {
    const emailC = validateEmail(email);
    if (typeof password !== "string" || !password) {
      throw new PortalError("Email and password are required.", 401, "invalid_credentials");
    }

    const result = await this.db.transaction(async () => {
      const row = await this.db.get(
        `SELECT u.*, o.name AS org_name
         FROM users u
         JOIN organizations o ON o.id = u.organization_id
         WHERE u.email = ?`,
        emailC
      );
      if (!row || !row.is_active || !verifyPassword(password, row.password_hash)) {
        throw new PortalError("Invalid email or password.", 401, "invalid_credentials");
      }

      let mfaVerified = true;
      if (row.mfa_enabled) {
        if (mfaCode) {
          if (!row.mfa_secret || !verifyTotp(row.mfa_secret, mfaCode)) {
            throw new PortalError("Invalid MFA verification code.", 401, "invalid_mfa");
          }
        } else {
          mfaVerified = false;
        }
      }

      const ses = await this._createSessionRow(row.id, mfaVerified);
      await this._audit({
        organizationId: row.organization_id,
        actorUserId: row.id,
        actorEmail: row.email,
        action: mfaVerified ? "auth.login" : "auth.login_mfa_pending",
        targetType: "user",
        targetId: row.id,
        ipAddress,
      });

      return {
        userId: row.id,
        mfaVerified,
        sessionCookie: ses.sessionCookie,
        csrfToken: ses.csrfToken,
      };
    });

    return {
      sessionCookie: result.sessionCookie,
      csrf_token: result.csrfToken,
      mfa_required: !result.mfaVerified,
      user: result.mfaVerified ? await this.getUserContext(result.userId) : null,
    };
  }

  async verifySessionMfa(sessionCookie, mfaCode, ipAddress = "") {
    const rawToken = verifySignedValue(this.config.secretKey, sessionCookie || "");
    if (!rawToken) {
      throw new PortalError("Authentication required.", 401, "unauthorized");
    }

    const info = await this.db.transaction(async () => {
      const row = await this.db.get(
        `SELECT s.id AS session_id, s.csrf_token, s.expires_at,
                u.id AS user_id, u.organization_id, u.email, u.mfa_secret, u.is_active
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
        hashToken(rawToken)
      );
      if (!row || !row.is_active || row.expires_at <= nowTs()) {
        throw new PortalError("Session expired or invalid.", 401, "unauthorized");
      }
      if (!row.mfa_secret || !verifyTotp(row.mfa_secret, mfaCode)) {
        throw new PortalError("Invalid 6-digit authenticator code.", 401, "invalid_mfa");
      }
      await this.db.run("UPDATE sessions SET mfa_verified = 1 WHERE id = ?", row.session_id);
      await this._audit({
        organizationId: row.organization_id,
        actorUserId: row.user_id,
        actorEmail: row.email,
        action: "auth.mfa_verified",
        targetType: "user",
        targetId: row.user_id,
        ipAddress,
      });
      return { csrfToken: row.csrf_token, userId: row.user_id };
    });

    return { csrf_token: info.csrfToken, user: await this.getUserContext(info.userId) };
  }

  async authenticateRequest(sessionCookie, { requireCsrf = false, csrfHeader = null } = {}) {
    if (!sessionCookie) {
      throw new PortalError("Authentication required.", 401, "unauthorized");
    }
    const rawToken = verifySignedValue(this.config.secretKey, sessionCookie);
    if (!rawToken) {
      throw new PortalError("Invalid session.", 401, "unauthorized");
    }

    const row = await this.db.get(
      `SELECT s.id AS session_id, s.csrf_token, s.mfa_verified, s.expires_at,
              u.id, u.organization_id, u.email, u.full_name, u.role, u.mfa_enabled, u.is_active,
              o.name AS organization_name, o.slug AS organization_slug, o.retention_days
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = u.organization_id
       WHERE s.token_hash = ?`,
      hashToken(rawToken)
    );

    if (!row || !row.is_active || row.expires_at <= nowTs()) {
      throw new PortalError("Session expired. Please sign in again.", 401, "unauthorized");
    }
    if (!row.mfa_verified) {
      throw new PortalError("MFA verification required to access the portal.", 401, "mfa_required");
    }
    if (requireCsrf && (!csrfHeader || csrfHeader !== row.csrf_token)) {
      throw new PortalError("CSRF validation failed.", 403, "csrf_invalid");
    }

    return {
      session_id: row.session_id,
      csrf_token: row.csrf_token,
      user_id: row.id,
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      organization_slug: row.organization_slug,
      retention_days: row.retention_days,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      mfa_enabled: Boolean(row.mfa_enabled),
    };
  }

  async logout(sessionCookie) {
    if (!sessionCookie) return;
    const rawToken = verifySignedValue(this.config.secretKey, sessionCookie);
    if (!rawToken) return;
    await this.db.run("DELETE FROM sessions WHERE token_hash = ?", hashToken(rawToken));
  }

  async getUserContext(userId) {
    const row = await this.db.get(
      `SELECT u.id, u.organization_id, u.email, u.full_name, u.role, u.mfa_enabled, u.is_active, u.created_at,
              o.name AS organization_name, o.slug AS organization_slug, o.retention_days
       FROM users u
       JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = ?`,
      userId
    );
    if (!row) {
      throw new PortalError("User not found.", 404, "not_found");
    }
    return {
      id: row.id,
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      organization_slug: row.organization_slug,
      retention_days: row.retention_days,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      mfa_enabled: Boolean(row.mfa_enabled),
      is_active: Boolean(row.is_active),
      created_at: utcIso(row.created_at),
    };
  }

  async setupMfa(actor) {
    const secret = generateMfaSecret();
    await this.db.run("UPDATE users SET mfa_secret = ? WHERE id = ?", secret, actor.user_id);
    return {
      secret,
      otpauth_uri: totpUri(secret, actor.email),
    };
  }

  async enableMfa(actor, code, ipAddress = "") {
    await this.db.transaction(async () => {
      const row = await this.db.get("SELECT mfa_secret FROM users WHERE id = ?", actor.user_id);
      if (!row || !row.mfa_secret) {
        throw new PortalError("Generate an MFA secret first.", 400, "bad_request");
      }
      if (!verifyTotp(row.mfa_secret, code)) {
        throw new PortalError("Invalid verification code. Check your authenticator clock.", 400, "invalid_mfa");
      }
      await this.db.run("UPDATE users SET mfa_enabled = 1 WHERE id = ?", actor.user_id);
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "auth.mfa_enabled",
        targetType: "user",
        targetId: actor.user_id,
        ipAddress,
      });
    });
    return { mfa_enabled: true };
  }

  async disableMfa(actor, password, ipAddress = "") {
    await this.db.transaction(async () => {
      const row = await this.db.get("SELECT password_hash FROM users WHERE id = ?", actor.user_id);
      if (!row || !verifyPassword(password || "", row.password_hash)) {
        throw new PortalError("Current password is incorrect.", 403, "forbidden");
      }
      await this.db.run("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?", actor.user_id);
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "auth.mfa_disabled",
        targetType: "user",
        targetId: actor.user_id,
        ipAddress,
      });
    });
    return { mfa_enabled: false };
  }

  async listOrganizationMembers(actor) {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    const users = await this.db.all(
      `SELECT id, email, full_name, role, mfa_enabled, is_active, created_at
       FROM users
       WHERE organization_id = ?
       ORDER BY created_at ASC`,
      actor.organization_id
    );
    const invites =
      actor.role === "admin"
        ? await this.db.all(
            `SELECT id, email, full_name, role, expires_at, accepted_at, created_at
             FROM staff_invites
             WHERE organization_id = ? AND accepted_at IS NULL
             ORDER BY created_at DESC`,
            actor.organization_id
          )
        : [];
    const now = nowTs();
    return {
      members: users.map((u) => ({
        id: u.id,
        email: u.email,
        full_name: u.full_name,
        role: u.role,
        mfa_enabled: Boolean(u.mfa_enabled),
        is_active: Boolean(u.is_active),
        created_at: utcIso(u.created_at),
      })),
      pending_invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        full_name: i.full_name,
        role: i.role,
        expires_at: utcIso(i.expires_at),
        is_expired: i.expires_at <= now,
      })),
    };
  }

  async createStaffInvite(actor, { email, fullName, role, expiresHours = 72, ipAddress = "" }) {
    this._requireRole(actor, new Set(["admin"]));
    const emailC = validateEmail(email);
    const fullNameC = requireNonEmpty(fullName, "Full name", 120);
    if (!VALID_ROLES.has(role)) {
      throw new PortalError("Invalid role.", 400, "validation_error");
    }

    const rawToken = generateToken(24);
    const now = nowTs();
    const hours = Math.max(1, Math.min(Number(expiresHours) || 72, 720));
    const expiresAt = now + hours * 3600;
    const inviteId = newId("stinv");

    await this.db.transaction(async () => {
      if (await this.db.get("SELECT id FROM users WHERE email = ?", emailC)) {
        throw new PortalError("A user with this email already exists.", 409, "email_exists");
      }
      await this.db.run(
        `INSERT INTO staff_invites (id, organization_id, email, full_name, role, token_hash, invited_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        inviteId,
        actor.organization_id,
        emailC,
        fullNameC,
        role,
        hashToken(rawToken),
        actor.user_id,
        expiresAt,
        now
      );
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "staff.invited",
        targetType: "staff_invite",
        targetId: inviteId,
        detail: { email: emailC, role },
        ipAddress,
      });
    });

    return {
      id: inviteId,
      email: emailC,
      full_name: fullNameC,
      role,
      invite_token: rawToken,
      expires_at: utcIso(expiresAt),
    };
  }

  async acceptStaffInvite({ token, password, ipAddress = "" }) {
    const rawToken = requireNonEmpty(token, "Invite token", 200);
    let pwHash;
    try {
      pwHash = hashPassword(password);
    } catch (err) {
      throw new PortalError(err.message, 400, "validation_error");
    }

    const now = nowTs();
    const res = await this.db.transaction(async () => {
      const inv = await this.db.get("SELECT * FROM staff_invites WHERE token_hash = ?", hashToken(rawToken));
      if (!inv || inv.accepted_at !== null) {
        throw new PortalError("Invitation not found or already used.", 404, "not_found");
      }
      if (inv.expires_at <= now) {
        throw new PortalError("This staff invitation has expired.", 410, "expired");
      }
      if (await this.db.get("SELECT id FROM users WHERE email = ?", inv.email)) {
        throw new PortalError("An account with this email already exists.", 409, "email_exists");
      }

      const userId = newId("usr");
      await this.db.run(
        `INSERT INTO users (id, organization_id, email, full_name, role, password_hash, mfa_enabled, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
        userId,
        inv.organization_id,
        inv.email,
        inv.full_name,
        inv.role,
        pwHash,
        now
      );
      await this.db.run("UPDATE staff_invites SET accepted_at = ? WHERE id = ?", now, inv.id);
      const ses = await this._createSessionRow(userId, true);
      await this._audit({
        organizationId: inv.organization_id,
        actorUserId: userId,
        actorEmail: inv.email,
        action: "staff.invite_accepted",
        targetType: "user",
        targetId: userId,
        detail: { role: inv.role },
        ipAddress,
      });
      return { userId, ...ses };
    });

    return {
      sessionCookie: res.sessionCookie,
      csrf_token: res.csrfToken,
      mfa_required: false,
      user: await this.getUserContext(res.userId),
    };
  }

  async updateMember(actor, memberId, { role, is_active: isActive, ipAddress = "" }) {
    this._requireRole(actor, new Set(["admin"]));
    await this.db.transaction(async () => {
      const target = await this.db.get(
        "SELECT * FROM users WHERE id = ? AND organization_id = ?",
        memberId,
        actor.organization_id
      );
      if (!target) {
        throw new PortalError("Member not found.", 404, "not_found");
      }

      let newRole = target.role;
      let newActive = target.is_active;
      if (role !== undefined && role !== null) {
        if (!VALID_ROLES.has(role)) {
          throw new PortalError("Invalid role.", 400, "validation_error");
        }
        newRole = role;
      }
      if (isActive !== undefined && isActive !== null) {
        if (target.id === actor.user_id && !isActive) {
          throw new PortalError("You cannot deactivate your own admin account.", 400, "validation_error");
        }
        newActive = isActive ? 1 : 0;
      }

      if ((target.role === "admin" && newRole !== "admin") || (target.is_active && !newActive)) {
        const otherRow = await this.db.get(
          `SELECT COUNT(*) AS c FROM users
           WHERE organization_id = ? AND role = 'admin' AND is_active = 1 AND id != ?`,
          actor.organization_id,
          target.id
        );
        if (Number(otherRow.c) === 0 && target.role === "admin") {
          throw new PortalError("Organization must retain at least one active admin.", 400, "last_admin");
        }
      }

      await this.db.run("UPDATE users SET role = ?, is_active = ? WHERE id = ?", newRole, newActive, memberId);
      if (!newActive) {
        await this.db.run("DELETE FROM sessions WHERE user_id = ?", memberId);
      }
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "staff.updated",
        targetType: "user",
        targetId: memberId,
        detail: { role: newRole, is_active: Boolean(newActive) },
        ipAddress,
      });
    });

    return this.getUserContext(memberId);
  }

  async updateOrganizationSettings(actor, { name, retention_days: retentionDays, ipAddress = "" }) {
    this._requireRole(actor, new Set(["admin"]));
    return this.db.transaction(async () => {
      const org = await this.db.get("SELECT * FROM organizations WHERE id = ?", actor.organization_id);
      if (!org) {
        throw new PortalError("Organization not found.", 404, "not_found");
      }
      const newName = name !== undefined ? requireNonEmpty(name, "Organization name", 120) : org.name;
      let newRet = org.retention_days;
      if (retentionDays !== undefined && retentionDays !== null) {
        const val = Number(retentionDays);
        if (!Number.isInteger(val) || val < 1 || val > 3650) {
          throw new PortalError("Retention days must be between 1 and 3650.", 400, "validation_error");
        }
        newRet = val;
      }
      await this.db.run(
        "UPDATE organizations SET name = ?, retention_days = ? WHERE id = ?",
        newName,
        newRet,
        actor.organization_id
      );
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "organization.updated",
        targetType: "organization",
        targetId: actor.organization_id,
        detail: { name: newName, retention_days: newRet },
        ipAddress,
      });
      return { id: actor.organization_id, name: newName, retention_days: newRet };
    });
  }

  // ------------------------------------------------------------------
  // Question Bank
  // ------------------------------------------------------------------
  async listQuestions(actor, { poolTag = "", includeArchived = false } = {}) {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    let sql = "SELECT * FROM questions WHERE organization_id = ?";
    const params = [actor.organization_id];
    if (!includeArchived) {
      sql += " AND is_archived = 0";
    }
    if (poolTag.trim()) {
      sql += " AND LOWER(pool_tag) = LOWER(?)";
      params.push(poolTag.trim());
    }
    sql += " ORDER BY created_at DESC";
    const qRows = await this.db.all(sql, ...params);
    const qIds = qRows.map((r) => r.id);
    const optsByQ = new Map(qIds.map((id) => [id, []]));

    if (qIds.length > 0) {
      const optRows = await this.db.all(
        `SELECT * FROM question_options WHERE question_id IN (${placeholders(qIds)}) ORDER BY sort_order ASC`,
        ...qIds
      );
      for (const opt of optRows) {
        optsByQ.get(opt.question_id).push({
          id: opt.id,
          text: opt.option_text,
          is_correct: Boolean(opt.is_correct),
        });
      }
    }

    return qRows.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      pool_tag: q.pool_tag,
      difficulty: q.difficulty,
      points: q.points,
      negative_points: q.negative_points,
      explanation: q.explanation,
      is_archived: Boolean(q.is_archived),
      options: optsByQ.get(q.id) || [],
      created_at: utcIso(q.created_at),
    }));
  }

  async createQuestion(actor, payload, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const prompt = requireNonEmpty(payload.prompt, "Question prompt", 4000);
    const poolTag = String(payload.pool_tag || "").trim().slice(0, 60);
    const difficulty = String(payload.difficulty || "medium").toLowerCase();
    if (!VALID_DIFFICULTIES.has(difficulty)) {
      throw new PortalError("Difficulty must be easy, medium, or hard.", 400, "validation_error");
    }

    const points = Number(payload.points ?? 1.0);
    const negativePoints = Number(payload.negative_points ?? 0.0);
    if (!Number.isFinite(points) || points <= 0 || points > 100) {
      throw new PortalError("Points must be between 0.1 and 100.", 400, "validation_error");
    }
    if (!Number.isFinite(negativePoints) || negativePoints < 0 || negativePoints > points) {
      throw new PortalError("Negative points must be between 0 and question points.", 400, "validation_error");
    }

    const explanation = String(payload.explanation || "").trim().slice(0, 2000);
    const options = payload.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 10) {
      throw new PortalError("Provide between 2 and 10 answer options.", 400, "validation_error");
    }

    let correctCount = 0;
    const parsedOpts = options.map((opt, idx) => {
      if (!opt || typeof opt !== "object") {
        throw new PortalError("Invalid option format.", 400, "validation_error");
      }
      const text = requireNonEmpty(opt.text, `Option ${idx + 1} text`, 1000);
      const isCorr = opt.is_correct ? 1 : 0;
      correctCount += isCorr;
      return { id: newId("opt"), text, isCorr, idx };
    });
    if (correctCount !== 1) {
      throw new PortalError("Exactly one option must be marked as correct.", 400, "validation_error");
    }

    const qId = newId("qst");
    const now = nowTs();
    await this.db.transaction(async () => {
      await this.db.run(
        `INSERT INTO questions
           (id, organization_id, created_by, prompt, pool_tag, difficulty, points, negative_points, explanation, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        qId,
        actor.organization_id,
        actor.user_id,
        prompt,
        poolTag,
        difficulty,
        points,
        negativePoints,
        explanation,
        now,
        now
      );
      for (const o of parsedOpts) {
        await this.db.run(
          "INSERT INTO question_options (id, question_id, option_text, is_correct, sort_order) VALUES (?, ?, ?, ?, ?)",
          o.id,
          qId,
          o.text,
          o.isCorr,
          o.idx
        );
      }
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "question.created",
        targetType: "question",
        targetId: qId,
        detail: { pool_tag: poolTag, points },
        ipAddress,
      });
    });

    return {
      id: qId,
      prompt,
      pool_tag: poolTag,
      difficulty,
      points,
      negative_points: negativePoints,
      explanation,
      is_archived: false,
      options: parsedOpts.map((o) => ({ id: o.id, text: o.text, is_correct: Boolean(o.isCorr) })),
      created_at: utcIso(now),
    };
  }

  async archiveQuestion(actor, questionId, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    await this.db.transaction(async () => {
      const row = await this.db.get(
        "SELECT id FROM questions WHERE id = ? AND organization_id = ?",
        questionId,
        actor.organization_id
      );
      if (!row) {
        throw new PortalError("Question not found.", 404, "not_found");
      }
      await this.db.run("UPDATE questions SET is_archived = 1, updated_at = ? WHERE id = ?", nowTs(), questionId);
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "question.archived",
        targetType: "question",
        targetId: questionId,
        ipAddress,
      });
    });
    return { id: questionId, is_archived: true };
  }

  // ------------------------------------------------------------------
  // Exams
  // ------------------------------------------------------------------
  _serializeExamRow(r) {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      duration_minutes: r.duration_minutes,
      passing_score_percent: r.passing_score_percent,
      draw_count: r.draw_count,
      pool_tag: r.pool_tag,
      shuffle_questions: Boolean(r.shuffle_questions),
      shuffle_options: Boolean(r.shuffle_options),
      require_fullscreen: Boolean(r.require_fullscreen),
      auto_submit_on_violation: Boolean(r.auto_submit_on_violation),
      lock_copy_paste: Boolean(r.lock_copy_paste),
      require_webcam_check: Boolean(r.require_webcam_check),
      require_live_webcam: Boolean(r.require_live_webcam),
      allow_non_webcam_alternative: Boolean(r.allow_non_webcam_alternative),
      allowed_materials: r.allowed_materials,
      rules_text: r.rules_text,
      privacy_notice: r.privacy_notice,
      status: r.status,
      attached_count: r.attached_count,
      invite_count: r.invite_count,
      completed_count: r.completed_count,
      created_at: utcIso(r.created_at),
      updated_at: utcIso(r.updated_at),
    };
  }

  async listExams(actor) {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    const rows = await this.db.all(
      `SELECT e.*,
              (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS attached_count,
              (SELECT COUNT(*) FROM candidate_invitations ci WHERE ci.exam_id = e.id) AS invite_count,
              (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status IN ('submitted', 'timed_out')) AS completed_count
       FROM exams e
       WHERE e.organization_id = ?
       ORDER BY e.created_at DESC`,
      actor.organization_id
    );
    return rows.map((r) => this._serializeExamRow(r));
  }

  async getExam(actor, examId) {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    const row = await this.db.get(
      `SELECT e.*,
              (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS attached_count,
              (SELECT COUNT(*) FROM candidate_invitations ci WHERE ci.exam_id = e.id) AS invite_count,
              (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status IN ('submitted', 'timed_out')) AS completed_count
       FROM exams e
       WHERE e.id = ? AND e.organization_id = ?`,
      examId,
      actor.organization_id
    );
    if (!row) {
      throw new PortalError("Exam not found.", 404, "not_found");
    }
    const data = this._serializeExamRow(row);
    if (actor.role === "admin" || actor.role === "interviewer") {
      const eqRows = await this.db.all(
        "SELECT question_id FROM exam_questions WHERE exam_id = ? ORDER BY sort_order ASC",
        examId
      );
      data.question_ids = eqRows.map((r) => r.question_id);
    }
    return data;
  }

  async createOrUpdateExam(actor, payload, { examId = null, ipAddress = "" } = {}) {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const title = requireNonEmpty(payload.title, "Exam title", 200);
    const description = String(payload.description || "").trim().slice(0, 2000);
    const durationMinutes = Number(payload.duration_minutes ?? 30);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 360) {
      throw new PortalError("Duration must be between 1 and 360 minutes.", 400, "validation_error");
    }

    const passingScore = Number(payload.passing_score_percent ?? 70.0);
    if (!Number.isFinite(passingScore) || passingScore < 0 || passingScore > 100) {
      throw new PortalError("Passing score must be between 0 and 100%.", 400, "validation_error");
    }

    const drawRaw = payload.draw_count;
    const drawCount =
      drawRaw !== undefined && drawRaw !== null && drawRaw !== "" && Number(drawRaw) !== 0
        ? Number(drawRaw)
        : null;
    if (drawCount !== null && (!Number.isInteger(drawCount) || drawCount < 1 || drawCount > 500)) {
      throw new PortalError("Draw count must be between 1 and 500.", 400, "validation_error");
    }

    const poolTag = String(payload.pool_tag || "").trim().slice(0, 60);
    const shuffleQuestions = payload.shuffle_questions !== false ? 1 : 0;
    const shuffleOptions = payload.shuffle_options !== false ? 1 : 0;
    const requireFullscreen = payload.require_fullscreen !== false ? 1 : 0;
    const autoSubmitOnViolation = payload.auto_submit_on_violation !== false ? 1 : 0;
    const lockCopyPaste = payload.lock_copy_paste !== false ? 1 : 0;
    const requireLiveWebcam = payload.require_live_webcam === true ? 1 : 0;
    const requireWebcamCheck = payload.require_webcam_check === true || requireLiveWebcam === 1 ? 1 : 0;
    const allowNonWebcamAlternative = payload.allow_non_webcam_alternative !== false ? 1 : 0;
    const allowedMaterials =
      String(payload.allowed_materials || "").trim().slice(0, 2000) ||
      "No external assistance unless explicitly permitted.";
    const rulesText =
      String(payload.rules_text || "").trim().slice(0, 4000) ||
      "Complete this assessment independently within the allotted time.";
    const privacyNotice =
      String(payload.privacy_notice || "").trim().slice(0, 4000) ||
      "Responses and session events are used only for assessment review.";
    const questionIds = payload.question_ids || [];
    if (!Array.isArray(questionIds)) {
      throw new PortalError("question_ids must be an array.", 400, "validation_error");
    }

    const status = String(payload.status || "draft");
    if (!VALID_EXAM_STATUSES.has(status)) {
      throw new PortalError("Invalid exam status.", 400, "validation_error");
    }

    const now = nowTs();
    const savedId = await this.db.transaction(async () => {
      const validQIds = [];
      for (const qid of questionIds) {
        const qrow = await this.db.get(
          "SELECT id FROM questions WHERE id = ? AND organization_id = ? AND is_archived = 0",
          qid,
          actor.organization_id
        );
        if (!qrow) {
          throw new PortalError(`Question ${qid} does not exist in your organization.`, 400, "invalid_question");
        }
        if (!validQIds.includes(qid)) validQIds.push(qid);
      }

      if (status === "published") {
        let avail = validQIds.length;
        if (avail === 0) {
          const cntRow = poolTag
            ? await this.db.get(
                "SELECT COUNT(*) AS c FROM questions WHERE organization_id = ? AND is_archived = 0 AND LOWER(pool_tag) = LOWER(?)",
                actor.organization_id,
                poolTag
              )
            : await this.db.get(
                "SELECT COUNT(*) AS c FROM questions WHERE organization_id = ? AND is_archived = 0",
                actor.organization_id
              );
          avail = Number(cntRow.c);
        }
        if (avail === 0) {
          throw new PortalError(
            "Cannot publish an exam without questions. Select questions or configure a matching question pool tag.",
            400,
            "no_questions"
          );
        }
      }

      let eid = examId;
      let action;
      if (!eid) {
        eid = newId("exm");
        await this.db.run(
          `INSERT INTO exams (
             id, organization_id, created_by, title, description, duration_minutes,
             passing_score_percent, draw_count, pool_tag, shuffle_questions, shuffle_options,
             require_fullscreen, auto_submit_on_violation, lock_copy_paste,
             require_webcam_check, require_live_webcam, allow_non_webcam_alternative,
             allowed_materials, rules_text, privacy_notice, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          eid,
          actor.organization_id,
          actor.user_id,
          title,
          description,
          durationMinutes,
          passingScore,
          drawCount,
          poolTag,
          shuffleQuestions,
          shuffleOptions,
          requireFullscreen,
          autoSubmitOnViolation,
          lockCopyPaste,
          requireWebcamCheck,
          requireLiveWebcam,
          allowNonWebcamAlternative,
          allowedMaterials,
          rulesText,
          privacyNotice,
          status,
          now,
          now
        );
        action = "exam.created";
      } else {
        const existing = await this.db.get(
          "SELECT id FROM exams WHERE id = ? AND organization_id = ?",
          eid,
          actor.organization_id
        );
        if (!existing) {
          throw new PortalError("Exam not found.", 404, "not_found");
        }
        await this.db.run(
          `UPDATE exams SET
             title = ?, description = ?, duration_minutes = ?, passing_score_percent = ?,
             draw_count = ?, pool_tag = ?, shuffle_questions = ?, shuffle_options = ?,
             require_fullscreen = ?, auto_submit_on_violation = ?, lock_copy_paste = ?,
             require_webcam_check = ?, require_live_webcam = ?, allow_non_webcam_alternative = ?,
             allowed_materials = ?, rules_text = ?, privacy_notice = ?, status = ?, updated_at = ?
           WHERE id = ?`,
          title,
          description,
          durationMinutes,
          passingScore,
          drawCount,
          poolTag,
          shuffleQuestions,
          shuffleOptions,
          requireFullscreen,
          autoSubmitOnViolation,
          lockCopyPaste,
          requireWebcamCheck,
          requireLiveWebcam,
          allowNonWebcamAlternative,
          allowedMaterials,
          rulesText,
          privacyNotice,
          status,
          now,
          eid
        );
        await this.db.run("DELETE FROM exam_questions WHERE exam_id = ?", eid);
        action = "exam.updated";
      }

      for (let idx = 0; idx < validQIds.length; idx += 1) {
        await this.db.run(
          "INSERT INTO exam_questions (exam_id, question_id, sort_order) VALUES (?, ?, ?)",
          eid,
          validQIds[idx],
          idx
        );
      }

      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action,
        targetType: "exam",
        targetId: eid,
        detail: { title, status, question_count: validQIds.length },
        ipAddress,
      });

      return eid;
    });

    return this.getExam(actor, savedId);
  }

  // ------------------------------------------------------------------
  // Candidate Invitations
  // ------------------------------------------------------------------
  async listInvitations(actor, { examId = "" } = {}) {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    let sql = `
      SELECT ci.*, e.title AS exam_title, e.require_live_webcam AS exam_require_live_webcam,
             a.id AS attempt_id, a.status AS attempt_status, a.score_percent, a.passed, a.submitted_at,
             a.live_webcam_active
      FROM candidate_invitations ci
      JOIN exams e ON e.id = ci.exam_id
      LEFT JOIN attempts a ON a.invitation_id = ci.id
      WHERE ci.organization_id = ?`;
    const params = [actor.organization_id];
    if (examId) {
      sql += " AND ci.exam_id = ?";
      params.push(examId);
    }
    sql += " ORDER BY ci.created_at DESC";
    const rows = await this.db.all(sql, ...params);
    const now = nowTs();
    return rows.map((r) => ({
      id: r.id,
      exam_id: r.exam_id,
      exam_title: r.exam_title,
      candidate_name: r.candidate_name,
      candidate_email: r.candidate_email,
      extra_time_minutes: r.extra_time_minutes,
      accommodation_notes: r.accommodation_notes,
      webcam_waived: Boolean(r.webcam_waived),
      require_live_webcam: Boolean(r.require_live_webcam),
      exam_require_live_webcam: Boolean(r.exam_require_live_webcam),
      effective_live_webcam:
        (Boolean(r.require_live_webcam) || Boolean(r.exam_require_live_webcam)) && !Boolean(r.webcam_waived),
      live_webcam_active: Boolean(r.live_webcam_active),
      status: r.status,
      is_expired: r.expires_at <= now && r.status === "pending",
      expires_at: utcIso(r.expires_at),
      attempt_id: r.attempt_id,
      attempt_status: r.attempt_status,
      score_percent: r.score_percent,
      passed: r.passed !== null && r.passed !== undefined ? Boolean(r.passed) : null,
      submitted_at: utcIso(r.submitted_at),
      created_at: utcIso(r.created_at),
    }));
  }

  async createInvitation(actor, payload, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const examId = requireNonEmpty(payload.exam_id, "Exam", 100);
    const candidateName = requireNonEmpty(payload.candidate_name, "Candidate name", 120);
    const candidateEmail = validateEmail(payload.candidate_email);
    const expiresHours = Number(payload.expires_hours ?? this.config.inviteDefaultHours);
    if (!Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 720) {
      throw new PortalError("Expiry must be between 1 and 720 hours.", 400, "validation_error");
    }
    const extraTime = Number(payload.extra_time_minutes ?? 0);
    if (!Number.isInteger(extraTime) || extraTime < 0 || extraTime > 240) {
      throw new PortalError("Extra time accommodation must be between 0 and 240 minutes.", 400, "validation_error");
    }
    const accommodationNotes = String(payload.accommodation_notes || "").trim().slice(0, 500);
    const webcamWaived = payload.webcam_waived ? 1 : 0;
    const requireLiveWebcam = !webcamWaived && payload.require_live_webcam ? 1 : 0;

    const rawToken = generateToken(28);
    const invId = newId("inv");
    const now = nowTs();
    const expiresAt = now + expiresHours * 3600;

    const exam = await this.db.transaction(async () => {
      const ex = await this.db.get(
        "SELECT id, title, status FROM exams WHERE id = ? AND organization_id = ?",
        examId,
        actor.organization_id
      );
      if (!ex) {
        throw new PortalError("Exam not found.", 404, "not_found");
      }
      if (ex.status !== "published") {
        throw new PortalError("Publish the exam before inviting candidates.", 400, "exam_not_published");
      }
      await this.db.run(
        `INSERT INTO candidate_invitations (
           id, organization_id, exam_id, invited_by, candidate_name, candidate_email,
           token_hash, extra_time_minutes, accommodation_notes, webcam_waived, require_live_webcam, expires_at, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        invId,
        actor.organization_id,
        examId,
        actor.user_id,
        candidateName,
        candidateEmail,
        hashToken(rawToken),
        extraTime,
        accommodationNotes,
        webcamWaived,
        requireLiveWebcam,
        expiresAt,
        now
      );
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "invitation.created",
        targetType: "invitation",
        targetId: invId,
        detail: {
          exam_id: examId,
          candidate_email: candidateEmail,
          extra_time_minutes: extraTime,
          require_live_webcam: Boolean(requireLiveWebcam),
        },
        ipAddress,
      });
      return ex;
    });

    return {
      id: invId,
      exam_id: examId,
      exam_title: exam.title,
      candidate_name: candidateName,
      candidate_email: candidateEmail,
      extra_time_minutes: extraTime,
      webcam_waived: Boolean(webcamWaived),
      require_live_webcam: Boolean(requireLiveWebcam),
      status: "pending",
      expires_at: utcIso(expiresAt),
      invite_token: rawToken,
      invite_path: `/candidate?token=${rawToken}`,
    };
  }

  async updateInvitationWebcam(actor, invitationId, payload = {}, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const requireLive = Boolean(payload.require_live_webcam);
    const result = await this.db.transaction(async () => {
      const inv = await this.db.get(
        "SELECT * FROM candidate_invitations WHERE id = ? AND organization_id = ?",
        invitationId,
        actor.organization_id
      );
      if (!inv) {
        throw new PortalError("Invitation not found.", 404, "not_found");
      }
      if (["completed", "revoked", "anonymized"].includes(inv.status)) {
        throw new PortalError(`Cannot update webcam setting for a ${inv.status} invitation.`, 400, "invalid_state");
      }

      const nextWaived = requireLive ? 0 : inv.webcam_waived;
      await this.db.run(
        "UPDATE candidate_invitations SET require_live_webcam = ?, webcam_waived = ? WHERE id = ?",
        requireLive ? 1 : 0,
        nextWaived,
        invitationId
      );

      const att = await this.db.get("SELECT * FROM attempts WHERE invitation_id = ?", invitationId);
      if (att && att.status === "in_progress") {
        if (requireLive) {
          const token = att.live_webcam_token || generateToken(32);
          await this.db.run(
            "UPDATE attempts SET live_webcam_token = ?, live_webcam_active = 1 WHERE id = ?",
            token,
            att.id
          );
        } else {
          if (att.live_webcam_token) {
            closeLiveWebcamSession(att.live_webcam_token);
          }
          await this.db.run(
            "UPDATE attempts SET live_webcam_token = NULL, live_webcam_active = 0 WHERE id = ?",
            att.id
          );
          await this.db.run("DELETE FROM live_webcam_frames WHERE attempt_id = ?", att.id);
        }
      }

      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "invitation.webcam_updated",
        targetType: "invitation",
        targetId: invitationId,
        detail: { require_live_webcam: requireLive },
        ipAddress,
      });

      return { id: invitationId, require_live_webcam: requireLive, webcam_waived: Boolean(nextWaived) };
    });
    return result;
  }

  async regenerateInvitationLink(actor, invitationId, expiresHours = 72, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const rawToken = generateToken(28);
    const now = nowTs();
    const hours = Math.max(1, Math.min(Number(expiresHours) || 72, 720));
    const expiresAt = now + hours * 3600;

    await this.db.transaction(async () => {
      const inv = await this.db.get(
        "SELECT * FROM candidate_invitations WHERE id = ? AND organization_id = ?",
        invitationId,
        actor.organization_id
      );
      if (!inv) {
        throw new PortalError("Invitation not found.", 404, "not_found");
      }
      if (["completed", "revoked", "anonymized"].includes(inv.status)) {
        throw new PortalError(`Cannot regenerate link for a ${inv.status} invitation.`, 400, "invalid_state");
      }
      await this.db.run(
        "UPDATE candidate_invitations SET token_hash = ?, expires_at = ? WHERE id = ?",
        hashToken(rawToken),
        expiresAt,
        invitationId
      );
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "invitation.link_regenerated",
        targetType: "invitation",
        targetId: invitationId,
        ipAddress,
      });
    });

    return {
      id: invitationId,
      invite_token: rawToken,
      invite_path: `/candidate?token=${rawToken}`,
      expires_at: utcIso(expiresAt),
    };
  }

  async revokeInvitation(actor, invitationId, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    await this.db.transaction(async () => {
      const inv = await this.db.get(
        "SELECT * FROM candidate_invitations WHERE id = ? AND organization_id = ?",
        invitationId,
        actor.organization_id
      );
      if (!inv) {
        throw new PortalError("Invitation not found.", 404, "not_found");
      }
      if (["completed", "anonymized"].includes(inv.status)) {
        throw new PortalError("Cannot revoke a completed invitation.", 400, "invalid_state");
      }
      await this.db.run("UPDATE candidate_invitations SET status = 'revoked' WHERE id = ?", invitationId);
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "invitation.revoked",
        targetType: "invitation",
        targetId: invitationId,
        ipAddress,
      });
    });
    return { id: invitationId, status: "revoked" };
  }

  // ------------------------------------------------------------------
  // Candidate Exam Workflow (Token-Authenticated, Zero Answer Key Leaks)
  // ------------------------------------------------------------------
  async _loadCandidateInvitation(rawToken) {
    if (!rawToken || rawToken.length < 16) {
      throw new PortalError("Invalid or missing exam invitation link.", 404, "invalid_invite");
    }
    const inv = await this.db.get(
      `SELECT ci.*, e.title AS exam_title, e.description AS exam_description,
              e.duration_minutes, e.draw_count, e.pool_tag,
              e.shuffle_questions, e.shuffle_options,
              e.require_fullscreen, e.auto_submit_on_violation, e.lock_copy_paste,
              e.require_webcam_check, e.require_live_webcam AS exam_require_live_webcam, e.allow_non_webcam_alternative,
              e.allowed_materials, e.rules_text, e.privacy_notice, e.passing_score_percent,
              e.status AS exam_status,
              o.name AS organization_name
       FROM candidate_invitations ci
       JOIN exams e ON e.id = ci.exam_id
       JOIN organizations o ON o.id = ci.organization_id
       WHERE ci.token_hash = ?`,
      hashToken(rawToken)
    );
    if (!inv) {
      throw new PortalError("Exam invitation not found or link has been replaced.", 404, "invalid_invite");
    }
    if (inv.status === "revoked" || inv.status === "anonymized") {
      throw new PortalError("This exam invitation is no longer active.", 403, "invite_revoked");
    }
    return inv;
  }

  async _finalizeAttemptLocked(attemptRow, { finalStatus, passingScorePercent, submitReason = "" }) {
    if (attemptRow.status !== "in_progress") {
      return attemptRow;
    }
    const reason = submitReason || (finalStatus === "timed_out" ? "timeout" : "manual");
    const now = nowTs();
    const aqRows = await this.db.all(
      "SELECT * FROM attempt_questions WHERE attempt_id = ? ORDER BY display_order ASC",
      attemptRow.id
    );
    const qIds = aqRows.map((r) => r.question_id);
    const correctMap = new Map();
    if (qIds.length > 0) {
      const cRows = await this.db.all(
        `SELECT question_id, id FROM question_options WHERE question_id IN (${placeholders(qIds)}) AND is_correct = 1`,
        ...qIds
      );
      for (const r of cRows) {
        correctMap.set(r.question_id, r.id);
      }
    }

    const grade = gradeAttemptQuestions(aqRows, correctMap, passingScorePercent);
    for (const qr of grade.questionResults) {
      await this.db.run(
        "UPDATE attempt_questions SET is_correct = ?, points_awarded = ? WHERE id = ?",
        qr.isCorrect,
        qr.pointsAwarded,
        qr.attemptQuestionId
      );
    }

    const submittedAt = finalStatus === "timed_out" ? Math.min(now, attemptRow.expires_at) : now;
    if (attemptRow.live_webcam_token) {
      closeLiveWebcamSession(attemptRow.live_webcam_token);
    }
    await this.db.run("DELETE FROM live_webcam_frames WHERE attempt_id = ?", attemptRow.id);
    await this.db.run(
      `UPDATE attempts
       SET status = ?, submitted_at = ?, submit_reason = ?, score_earned = ?, score_possible = ?, score_percent = ?, passed = ?,
           live_webcam_token = NULL, live_webcam_active = 0
       WHERE id = ?`,
      finalStatus,
      submittedAt,
      reason,
      grade.scoreEarned,
      grade.scorePossible,
      grade.scorePercent,
      grade.passed,
      attemptRow.id
    );
    await this.db.run("UPDATE candidate_invitations SET status = 'completed' WHERE id = ?", attemptRow.invitation_id);

    const eventName =
      finalStatus === "timed_out"
        ? "attempt_timed_out"
        : reason === "tab_switched" || reason === "fullscreen_exited"
        ? "attempt_auto_submitted"
        : "attempt_submitted";

    await this.db.run(
      `INSERT INTO session_events (id, attempt_id, event_type, detail_json, occurred_at, server_received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      newId("evt"),
      attemptRow.id,
      eventName,
      JSON.stringify({ answered: aqRows.filter((r) => r.selected_option_id).length, reason }),
      now,
      now
    );
    return this.db.get("SELECT * FROM attempts WHERE id = ?", attemptRow.id);
  }

  async _buildCandidateQuestionsPayload(attemptId) {
    const aqRows = await this.db.all(
      `SELECT aq.question_id, aq.display_order, aq.option_order_json, aq.points_possible, aq.selected_option_id,
              q.prompt
       FROM attempt_questions aq
       JOIN questions q ON q.id = aq.question_id
       WHERE aq.attempt_id = ?
       ORDER BY aq.display_order ASC`,
      attemptId
    );
    const qIds = aqRows.map((r) => r.question_id);
    const optsById = new Map();
    if (qIds.length > 0) {
      const optRows = await this.db.all(
        `SELECT id, option_text FROM question_options WHERE question_id IN (${placeholders(qIds)})`,
        ...qIds
      );
      for (const r of optRows) {
        optsById.set(r.id, r.option_text);
      }
    }

    return aqRows.map((r) => {
      const optionIds = JSON.parse(r.option_order_json);
      return {
        question_id: r.question_id,
        display_order: r.display_order,
        prompt: r.prompt,
        points: r.points_possible,
        selected_option_id: r.selected_option_id,
        options: optionIds
          .filter((oid) => optsById.has(oid))
          .map((oid) => ({ id: oid, text: optsById.get(oid) })),
      };
    });
  }

  async getCandidateSession(rawToken) {
    return this.db.transaction(async () => {
      const inv = await this._loadCandidateInvitation(rawToken);
      const now = nowTs();
      let attempt = await this.db.get("SELECT * FROM attempts WHERE invitation_id = ?", inv.id);

      let attemptState;
      let questions = [];
      let remainingSeconds;
      let expiresAt = null;
      let submittedAt = null;

      if (!attempt) {
        if (inv.expires_at <= now) {
          throw new PortalError("This exam invitation has expired.", 410, "invite_expired");
        }
        attemptState = "not_started";
        remainingSeconds = (inv.duration_minutes + inv.extra_time_minutes) * 60;
      } else {
        if (attempt.status === "in_progress" && now >= attempt.expires_at) {
          attempt = await this._finalizeAttemptLocked(attempt, {
            finalStatus: "timed_out",
            passingScorePercent: inv.passing_score_percent,
          });
        }
        attemptState = attempt.status;
        remainingSeconds = attemptState === "in_progress" ? Math.max(0, attempt.expires_at - now) : 0;
        expiresAt = utcIso(attempt.expires_at);
        submittedAt = utcIso(attempt.submitted_at);
        if (attemptState === "in_progress") {
          questions = await this._buildCandidateQuestionsPayload(attempt.id);
        }
      }

      const liveWebcamRequired =
        (Boolean(inv.require_live_webcam) || Boolean(inv.exam_require_live_webcam)) && !Boolean(inv.webcam_waived);
      const webcamCheckRequired = (Boolean(inv.require_webcam_check) || liveWebcamRequired) && !Boolean(inv.webcam_waived);

      return {
        invitation: {
          id: inv.id,
          candidate_name: inv.candidate_name,
          candidate_email: inv.candidate_email,
          extra_time_minutes: inv.extra_time_minutes,
          webcam_waived: Boolean(inv.webcam_waived),
          require_live_webcam: Boolean(inv.require_live_webcam),
          expires_at: utcIso(inv.expires_at),
        },
        exam: {
          id: inv.exam_id,
          organization_name: inv.organization_name,
          title: inv.exam_title,
          description: inv.exam_description,
          duration_minutes: inv.duration_minutes,
          total_minutes: inv.duration_minutes + inv.extra_time_minutes,
          require_fullscreen: Boolean(inv.require_fullscreen),
          auto_submit_on_violation: Boolean(inv.auto_submit_on_violation),
          lock_copy_paste: Boolean(inv.lock_copy_paste),
          require_webcam_check: webcamCheckRequired,
          require_live_webcam: liveWebcamRequired,
          allow_non_webcam_alternative: Boolean(inv.allow_non_webcam_alternative),
          allowed_materials: inv.allowed_materials,
          rules_text: inv.rules_text,
          privacy_notice: inv.privacy_notice,
        },
        attempt: {
          id: attempt ? attempt.id : null,
          status: attemptState,
          submit_reason: attempt ? attempt.submit_reason : "",
          webcam_consent_choice: attempt ? attempt.webcam_consent_choice : "not_required",
          live_webcam_active: attempt ? Boolean(attempt.live_webcam_active) : false,
          remaining_seconds: remainingSeconds,
          expires_at: expiresAt,
          submitted_at: submittedAt,
          server_time: utcIso(now),
        },
        questions,
      };
    });
  }

  async startCandidateAttempt(rawToken, payload) {
    if (!payload?.consent_accepted) {
      throw new PortalError(
        "You must review and accept the exam rules and privacy notice before starting.",
        400,
        "consent_required"
      );
    }

    let webcamChoice = String(payload.webcam_consent_choice || "not_required");
    if (!["not_required", "consented", "alternative_requested", "waived"].includes(webcamChoice)) {
      throw new PortalError("Invalid webcam consent choice.", 400, "validation_error");
    }

    const deviceCheck =
      payload.device_check && typeof payload.device_check === "object" ? payload.device_check : {};

    await this.db.transaction(async () => {
      const inv = await this._loadCandidateInvitation(rawToken);
      const now = nowTs();
      const existing = await this.db.get("SELECT * FROM attempts WHERE invitation_id = ?", inv.id);
      if (existing) {
        if (existing.status === "in_progress" && now < existing.expires_at) {
          return;
        }
        throw new PortalError("An attempt has already been used for this invitation.", 409, "attempt_already_exists");
      }

      if (inv.expires_at <= now) {
        throw new PortalError("This exam invitation has expired.", 410, "invite_expired");
      }
      if (inv.exam_status !== "published") {
        throw new PortalError("This exam is not currently active.", 400, "exam_not_published");
      }

      const liveWebcamRequired =
        (Boolean(inv.require_live_webcam) || Boolean(inv.exam_require_live_webcam)) && !Boolean(inv.webcam_waived);
      const webcamRequired = (Boolean(inv.require_webcam_check) || liveWebcamRequired) && !Boolean(inv.webcam_waived);
      if (webcamRequired) {
        if (webcamChoice === "alternative_requested" && !inv.allow_non_webcam_alternative) {
          throw new PortalError(
            "A webcam check is required for this exam. Contact the interviewer for accommodations.",
            400,
            "webcam_required"
          );
        }
        if (!["consented", "alternative_requested"].includes(webcamChoice)) {
          throw new PortalError(
            "Please complete the webcam check or request the non-webcam alternative.",
            400,
            "webcam_consent_required"
          );
        }
      } else if (inv.webcam_waived) {
        webcamChoice = "waived";
      }

      let eqRows = await this.db.all(
        `SELECT q.id, q.points, q.negative_points
         FROM exam_questions eq
         JOIN questions q ON q.id = eq.question_id
         WHERE eq.exam_id = ? AND q.is_archived = 0
         ORDER BY eq.sort_order ASC`,
        inv.exam_id
      );

      if (eqRows.length === 0) {
        eqRows = inv.pool_tag
          ? await this.db.all(
              `SELECT id, points, negative_points FROM questions
               WHERE organization_id = ? AND is_archived = 0 AND LOWER(pool_tag) = LOWER(?)
               ORDER BY created_at ASC`,
              inv.organization_id,
              inv.pool_tag
            )
          : await this.db.all(
              `SELECT id, points, negative_points FROM questions
               WHERE organization_id = ? AND is_archived = 0
               ORDER BY created_at ASC`,
              inv.organization_id
            );
      }

      if (eqRows.length === 0) {
        throw new PortalError("No questions are configured for this exam.", 500, "exam_empty");
      }

      const qIds = eqRows.map((r) => r.id);
      const optRows = await this.db.all(
        `SELECT id, question_id FROM question_options WHERE question_id IN (${placeholders(qIds)}) ORDER BY sort_order ASC`,
        ...qIds
      );
      const optsByQ = new Map(qIds.map((id) => [id, []]));
      for (const o of optRows) {
        optsByQ.get(o.question_id).push(o.id);
      }

      const specs = eqRows.map((r) => ({
        questionId: r.id,
        pointsPossible: Number(r.points),
        negativePoints: Number(r.negative_points),
        optionIds: optsByQ.get(r.id) || [],
      }));

      const chosen = selectAndOrderQuestions(specs, {
        drawCount: inv.draw_count,
        shuffleQuestions: Boolean(inv.shuffle_questions),
        shuffleOptions: Boolean(inv.shuffle_options),
      });

      const totalSeconds = (inv.duration_minutes + inv.extra_time_minutes) * 60;
      const expiresAt = now + totalSeconds;
      const attemptId = newId("att");
      const autoLiveActive = liveWebcamRequired && webcamChoice === "consented" ? 1 : 0;
      const autoLiveToken = autoLiveActive ? generateToken(32) : null;

      await this.db.run(
        `INSERT INTO attempts (
           id, organization_id, exam_id, invitation_id, candidate_name, candidate_email,
           status, consent_accepted_at, webcam_consent_choice, device_check_json,
           started_at, expires_at, created_at, live_webcam_active, live_webcam_token
         ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, ?)`,
        attemptId,
        inv.organization_id,
        inv.exam_id,
        inv.id,
        inv.candidate_name,
        inv.candidate_email,
        now,
        webcamChoice,
        JSON.stringify(deviceCheck),
        now,
        expiresAt,
        now,
        autoLiveActive,
        autoLiveToken
      );

      for (let idx = 0; idx < chosen.length; idx += 1) {
        const item = chosen[idx];
        await this.db.run(
          `INSERT INTO attempt_questions (
             id, attempt_id, question_id, display_order, option_order_json, points_possible, negative_points
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          newId("atq"),
          attemptId,
          item.questionId,
          idx,
          JSON.stringify(item.optionIds),
          item.pointsPossible,
          item.negativePoints
        );
      }

      await this.db.run("UPDATE candidate_invitations SET status = 'started' WHERE id = ?", inv.id);
      await this.db.run(
        `INSERT INTO session_events (id, attempt_id, event_type, detail_json, occurred_at, server_received_at)
         VALUES (?, ?, 'attempt_started', ?, ?, ?)`,
        newId("evt"),
        attemptId,
        JSON.stringify({ webcam_consent_choice: webcamChoice, question_count: chosen.length }),
        now,
        now
      );
      if (webcamChoice === "alternative_requested") {
        await this.db.run(
          `INSERT INTO session_events (id, attempt_id, event_type, detail_json, occurred_at, server_received_at)
           VALUES (?, ?, 'accommodation_requested', ?, ?, ?)`,
          newId("evt"),
          attemptId,
          JSON.stringify({ type: "non_webcam_alternative" }),
          now,
          now
        );
      }
    });

    return this.getCandidateSession(rawToken);
  }

  async saveCandidateAnswers(rawToken, answers) {
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new PortalError("Answers must be an object mapping question_id to option_id.", 400, "validation_error");
    }

    return this.db.transaction(async () => {
      const inv = await this._loadCandidateInvitation(rawToken);
      const attempt = await this.db.get("SELECT * FROM attempts WHERE invitation_id = ?", inv.id);
      if (!attempt) {
        throw new PortalError("Exam has not been started.", 400, "not_started");
      }

      const now = nowTs();
      if (attempt.status === "in_progress" && now >= attempt.expires_at) {
        await this._finalizeAttemptLocked(attempt, {
          finalStatus: "timed_out",
          passingScorePercent: inv.passing_score_percent,
        });
        throw new PortalError(
          "Exam time has expired; your saved answers were submitted automatically.",
          409,
          "timed_out"
        );
      }
      if (attempt.status !== "in_progress") {
        throw new PortalError("This exam attempt is already closed.", 409, "already_submitted");
      }

      let savedCount = 0;
      for (const [qId, optId] of Object.entries(answers)) {
        const aq = await this.db.get(
          "SELECT id, option_order_json FROM attempt_questions WHERE attempt_id = ? AND question_id = ?",
          attempt.id,
          qId
        );
        if (!aq) continue;
        const validOpts = new Set(JSON.parse(aq.option_order_json));
        if (optId !== null && optId !== undefined && !validOpts.has(optId)) {
          throw new PortalError("Invalid answer option.", 400, "invalid_option");
        }
        await this.db.run(
          "UPDATE attempt_questions SET selected_option_id = ?, answered_at = ? WHERE id = ?",
          optId ?? null,
          optId ? now : null,
          aq.id
        );
        savedCount += 1;
      }

      return {
        saved_count: savedCount,
        remaining_seconds: Math.max(0, attempt.expires_at - now),
        server_time: utcIso(now),
      };
    });
  }

  async recordCandidateEvents(rawToken, events) {
    if (!Array.isArray(events)) {
      throw new PortalError("events must be a list.", 400, "validation_error");
    }

    return this.db.transaction(async () => {
      const inv = await this._loadCandidateInvitation(rawToken);
      let attempt = await this.db.get("SELECT * FROM attempts WHERE invitation_id = ?", inv.id);
      if (!attempt) {
        return { recorded: 0 };
      }
      if (attempt.status !== "in_progress") {
        return { recorded: 0, status: attempt.status, submit_reason: attempt.submit_reason };
      }

      const now = nowTs();
      let recorded = 0;
      let triggerReason = "";
      for (const evt of events.slice(0, 50)) {
        if (!evt || typeof evt !== "object") continue;
        const etype = String(evt.event_type || "");
        if (!ALLOWED_CANDIDATE_EVENTS.has(etype)) continue;
        const detail = evt.detail && typeof evt.detail === "object" ? evt.detail : {};
        const occ = Number(evt.occurred_at) || now;
        await this.db.run(
          `INSERT INTO session_events (id, attempt_id, event_type, detail_json, occurred_at, server_received_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          newId("evt"),
          attempt.id,
          etype,
          JSON.stringify(detail),
          occ,
          now
        );
        recorded += 1;
        if (inv.auto_submit_on_violation && !triggerReason) {
          if (etype === "fullscreen_exited") triggerReason = "fullscreen_exited";
          else if (etype === "tab_hidden") triggerReason = "tab_switched";
        }
      }

      let autoSubmitted = false;
      if (triggerReason) {
        attempt = await this._finalizeAttemptLocked(attempt, {
          finalStatus: "submitted",
          passingScorePercent: inv.passing_score_percent,
          submitReason: triggerReason,
        });
        autoSubmitted = true;
      }

      return {
        recorded,
        status: attempt.status,
        auto_submitted: autoSubmitted,
        submit_reason: attempt.submit_reason,
        remaining_seconds: attempt.status === "in_progress" ? Math.max(0, attempt.expires_at - nowTs()) : 0,
      };
    });
  }

  async submitCandidateAttempt(rawToken, finalAnswers = null, { reason = "manual" } = {}) {
    const safeReason = ["manual", "tab_switched", "fullscreen_exited", "timeout"].includes(reason)
      ? reason
      : "manual";

    return this.db.transaction(async () => {
      const inv = await this._loadCandidateInvitation(rawToken);
      let attempt = await this.db.get("SELECT * FROM attempts WHERE invitation_id = ?", inv.id);
      if (!attempt) {
        throw new PortalError("Exam has not been started.", 400, "not_started");
      }

      const now = nowTs();
      if (attempt.status === "in_progress") {
        if (finalAnswers && typeof finalAnswers === "object" && !Array.isArray(finalAnswers) && now <= attempt.expires_at + 10) {
          for (const [qId, optId] of Object.entries(finalAnswers)) {
            const aq = await this.db.get(
              "SELECT id, option_order_json FROM attempt_questions WHERE attempt_id = ? AND question_id = ?",
              attempt.id,
              qId
            );
            if (aq && (optId === null || optId === undefined || new Set(JSON.parse(aq.option_order_json)).has(optId))) {
              await this.db.run(
                "UPDATE attempt_questions SET selected_option_id = ?, answered_at = ? WHERE id = ?",
                optId ?? null,
                optId ? now : null,
                aq.id
              );
            }
          }
        }

        if (safeReason === "tab_switched" || safeReason === "fullscreen_exited") {
          const evtType = safeReason === "tab_switched" ? "tab_hidden" : "fullscreen_exited";
          await this.db.run(
            `INSERT INTO session_events (id, attempt_id, event_type, detail_json, occurred_at, server_received_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            newId("evt"),
            attempt.id,
            evtType,
            JSON.stringify({ auto_submit: true }),
            now,
            now
          );
        }

        const finalStatus = now > attempt.expires_at + 10 ? "timed_out" : "submitted";
        const effectiveReason = finalStatus === "timed_out" ? "timeout" : safeReason;
        attempt = await this._finalizeAttemptLocked(attempt, {
          finalStatus,
          passingScorePercent: inv.passing_score_percent,
          submitReason: effectiveReason,
        });
      }

      return {
        attempt_id: attempt.id,
        status: attempt.status,
        submit_reason: attempt.submit_reason,
        submitted_at: utcIso(attempt.submitted_at),
        message: "Your exam has been submitted and recorded for review.",
      };
    });
  }

  // ------------------------------------------------------------------
  // Results, Integrity Signals & Reviewer / Support Operations
  // ------------------------------------------------------------------
  async listAttempts(actor, { examId = "" } = {}) {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    const rows = await this.db.transaction(async () => {
      const now = nowTs();
      const overdue = await this.db.all(
        `SELECT a.*, e.passing_score_percent
         FROM attempts a
         JOIN exams e ON e.id = a.exam_id
         WHERE a.organization_id = ? AND a.status = 'in_progress' AND a.expires_at <= ?`,
        actor.organization_id,
        now
      );
      for (const att of overdue) {
        await this._finalizeAttemptLocked(att, {
          finalStatus: "timed_out",
          passingScorePercent: att.passing_score_percent,
        });
      }

      let sql = `
        SELECT a.*, e.title AS exam_title, e.passing_score_percent,
               e.require_live_webcam AS exam_require_live_webcam,
               ci.require_live_webcam AS invite_require_live_webcam,
               ci.webcam_waived AS invite_webcam_waived,
               (SELECT COUNT(*) FROM session_events se
                WHERE se.attempt_id = a.id
                  AND se.event_type IN ('tab_hidden', 'window_blur', 'fullscreen_exited', 'copy_paste_blocked', 'offline', 'reconnected')) AS signal_count
        FROM attempts a
        JOIN exams e ON e.id = a.exam_id
        JOIN candidate_invitations ci ON ci.id = a.invitation_id
        WHERE a.organization_id = ?`;
      const params = [actor.organization_id];
      if (examId) {
        sql += " AND a.exam_id = ?";
        params.push(examId);
      }
      sql += " ORDER BY a.created_at DESC";
      return this.db.all(sql, ...params);
    });

    return rows.map((r) => ({
      id: r.id,
      exam_id: r.exam_id,
      exam_title: r.exam_title,
      invitation_id: r.invitation_id,
      candidate_name: r.candidate_name,
      candidate_email: r.candidate_email,
      status: r.status,
      submit_reason: r.submit_reason,
      webcam_consent_choice: r.webcam_consent_choice,
      require_live_webcam:
        (Boolean(r.invite_require_live_webcam) || Boolean(r.exam_require_live_webcam)) &&
        !Boolean(r.invite_webcam_waived),
      live_webcam_active: Boolean(r.live_webcam_active),
      started_at: utcIso(r.started_at),
      expires_at: utcIso(r.expires_at),
      submitted_at: utcIso(r.submitted_at),
      score_earned: r.score_earned,
      score_possible: r.score_possible,
      score_percent: r.score_percent,
      passing_score_percent: r.passing_score_percent,
      passed: r.passed !== null && r.passed !== undefined ? Boolean(r.passed) : null,
      signal_count: r.signal_count,
      is_anonymized: Boolean(r.is_anonymized),
    }));
  }

  async getAttemptDetail(actor, attemptId) {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    return this.db.transaction(async () => {
      let att = await this.db.get(
        `SELECT a.*, e.title AS exam_title, e.passing_score_percent,
                e.require_live_webcam AS exam_require_live_webcam,
                ci.require_live_webcam AS invite_require_live_webcam,
                ci.webcam_waived AS invite_webcam_waived
         FROM attempts a
         JOIN exams e ON e.id = a.exam_id
         JOIN candidate_invitations ci ON ci.id = a.invitation_id
         WHERE a.id = ? AND a.organization_id = ?`,
        attemptId,
        actor.organization_id
      );
      if (!att) {
        throw new PortalError("Attempt not found.", 404, "not_found");
      }

      if (att.status === "in_progress" && nowTs() >= att.expires_at) {
        await this._finalizeAttemptLocked(att, {
          finalStatus: "timed_out",
          passingScorePercent: att.passing_score_percent,
        });
        att = await this.db.get(
          `SELECT a.*, e.title AS exam_title, e.passing_score_percent,
                  e.require_live_webcam AS exam_require_live_webcam,
                  ci.require_live_webcam AS invite_require_live_webcam,
                  ci.webcam_waived AS invite_webcam_waived
           FROM attempts a
           JOIN exams e ON e.id = a.exam_id
           JOIN candidate_invitations ci ON ci.id = a.invitation_id
           WHERE a.id = ?`,
          attemptId
        );
      }

      const aqRows = await this.db.all(
        `SELECT aq.*, q.prompt, q.explanation, q.pool_tag
         FROM attempt_questions aq
         JOIN questions q ON q.id = aq.question_id
         WHERE aq.attempt_id = ?
         ORDER BY aq.display_order ASC`,
        attemptId
      );

      const qIds = aqRows.map((r) => r.question_id);
      const optsByQ = new Map(qIds.map((id) => [id, new Map()]));
      if (qIds.length > 0) {
        const optRows = await this.db.all(
          `SELECT id, question_id, option_text, is_correct FROM question_options WHERE question_id IN (${placeholders(qIds)})`,
          ...qIds
        );
        for (const o of optRows) {
          optsByQ.get(o.question_id).set(o.id, {
            id: o.id,
            text: o.option_text,
            is_correct: Boolean(o.is_correct),
          });
        }
      }

      const events = await this.db.all(
        "SELECT * FROM session_events WHERE attempt_id = ? ORDER BY server_received_at ASC",
        attemptId
      );

      const isCompleted = att.status === "submitted" || att.status === "timed_out";
      const showKeys = isCompleted || actor.role === "admin" || actor.role === "interviewer";

      const questionDetails = aqRows.map((r) => {
        const optOrder = JSON.parse(r.option_order_json);
        const qOpts = optsByQ.get(r.question_id) || new Map();
        const orderedOpts = [];
        for (const oid of optOrder) {
          if (qOpts.has(oid)) {
            const opt = qOpts.get(oid);
            const entry = { id: oid, text: opt.text };
            if (showKeys) entry.is_correct = opt.is_correct;
            orderedOpts.push(entry);
          }
        }
        const item = {
          display_order: r.display_order,
          question_id: r.question_id,
          prompt: r.prompt,
          pool_tag: r.pool_tag,
          points_possible: r.points_possible,
          selected_option_id: r.selected_option_id,
          options: orderedOpts,
        };
        if (isCompleted) {
          item.is_correct = Boolean(r.is_correct);
          item.points_awarded = r.points_awarded;
          item.explanation = r.explanation;
        }
        return item;
      });

      const eventList = events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        detail: JSON.parse(e.detail_json || "{}"),
        occurred_at: utcIso(e.occurred_at),
        server_received_at: utcIso(e.server_received_at),
      }));

      const signalSummary = {
        tab_hidden: events.filter((e) => e.event_type === "tab_hidden").length,
        window_blur: events.filter((e) => e.event_type === "window_blur").length,
        fullscreen_exited: events.filter((e) => e.event_type === "fullscreen_exited").length,
        copy_paste_blocked: events.filter((e) => e.event_type === "copy_paste_blocked").length,
        network_interruptions: events.filter((e) => e.event_type === "offline" || e.event_type === "reconnected").length,
      };

      return {
        attempt: {
          id: att.id,
          exam_id: att.exam_id,
          exam_title: att.exam_title,
          invitation_id: att.invitation_id,
          candidate_name: att.candidate_name,
          candidate_email: att.candidate_email,
          status: att.status,
          submit_reason: att.submit_reason,
          webcam_consent_choice: att.webcam_consent_choice,
          require_live_webcam:
            (Boolean(att.invite_require_live_webcam) || Boolean(att.exam_require_live_webcam)) &&
            !Boolean(att.invite_webcam_waived),
          live_webcam_active: Boolean(att.live_webcam_active),
          device_check: JSON.parse(att.device_check_json || "{}"),
          started_at: utcIso(att.started_at),
          expires_at: utcIso(att.expires_at),
          submitted_at: utcIso(att.submitted_at),
          score_earned: att.score_earned,
          score_possible: att.score_possible,
          score_percent: att.score_percent,
          passing_score_percent: att.passing_score_percent,
          passed: att.passed !== null && att.passed !== undefined ? Boolean(att.passed) : null,
          reviewer_notes: att.reviewer_notes,
          is_anonymized: Boolean(att.is_anonymized),
        },
        integrity_notice:
          "Browser events are signals for human review, not proof of misconduct. Web browsers cannot fully block external devices or screen capture.",
        signal_summary: signalSummary,
        events: eventList,
        questions: questionDetails,
      };
    });
  }

  async updateReviewerNotes(actor, attemptId, notes, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    const cleaned = String(notes || "").trim().slice(0, 4000);
    await this.db.transaction(async () => {
      const att = await this.db.get(
        "SELECT id FROM attempts WHERE id = ? AND organization_id = ?",
        attemptId,
        actor.organization_id
      );
      if (!att) {
        throw new PortalError("Attempt not found.", 404, "not_found");
      }
      await this.db.run("UPDATE attempts SET reviewer_notes = ? WHERE id = ?", cleaned, attemptId);
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "attempt.notes_updated",
        targetType: "attempt",
        targetId: attemptId,
        ipAddress,
      });
    });
    return { id: attemptId, reviewer_notes: cleaned };
  }

  async extendAttemptTime(actor, attemptId, { extra_minutes: extraMinutes, reason, ipAddress = "" }) {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const mins = Number(extraMinutes);
    if (!Number.isInteger(mins) || mins < 1 || mins > 180) {
      throw new PortalError("Extra minutes must be between 1 and 180.", 400, "validation_error");
    }
    const reasonC = requireNonEmpty(reason, "Reason for extension", 500);
    const now = nowTs();

    const newExpires = await this.db.transaction(async () => {
      const att = await this.db.get(
        "SELECT * FROM attempts WHERE id = ? AND organization_id = ?",
        attemptId,
        actor.organization_id
      );
      if (!att) {
        throw new PortalError("Attempt not found.", 404, "not_found");
      }
      if (att.is_anonymized) {
        throw new PortalError("Cannot extend an anonymized attempt.", 400, "invalid_state");
      }
      if (att.status === "submitted" && ["", "manual"].includes(att.submit_reason)) {
        throw new PortalError("Cannot extend a manually submitted attempt.", 400, "invalid_state");
      }

      const base = att.status === "in_progress" ? Math.max(now, att.expires_at) : now;
      const nextExp = base + mins * 60;
      await this.db.run(
        `UPDATE attempts
         SET status = 'in_progress', expires_at = ?, submitted_at = NULL, submit_reason = '',
             score_earned = NULL, score_possible = NULL, score_percent = NULL, passed = NULL
         WHERE id = ?`,
        nextExp,
        attemptId
      );
      await this.db.run("UPDATE candidate_invitations SET status = 'started' WHERE id = ?", att.invitation_id);
      await this.db.run(
        `INSERT INTO session_events (id, attempt_id, event_type, detail_json, occurred_at, server_received_at)
         VALUES (?, ?, 'time_extended', ?, ?, ?)`,
        newId("evt"),
        attemptId,
        JSON.stringify({ extra_minutes: mins, reason: reasonC }),
        now,
        now
      );
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "attempt.time_extended",
        targetType: "attempt",
        targetId: attemptId,
        detail: { extra_minutes: mins, reason: reasonC },
        ipAddress,
      });
      return nextExp;
    });

    return { id: attemptId, status: "in_progress", expires_at: utcIso(newExpires) };
  }

  // ------------------------------------------------------------------
  // Live Webcam Streaming (admin-initiated or pre-required, candidate-streamed)
  // ------------------------------------------------------------------

  /** Admin starts/opens a live-webcam relay: reuses active token or generates one and stores it on the attempt. */
  async startLiveWebcam(actor, attemptId, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const att = await this.db.get(
      "SELECT * FROM attempts WHERE id = ? AND organization_id = ?",
      attemptId,
      actor.organization_id
    );
    if (!att) throw new PortalError("Attempt not found.", 404, "not_found");
    if (att.status !== "in_progress") throw new PortalError("Attempt is not in progress.", 400, "invalid_state");
    if (att.is_anonymized) throw new PortalError("Attempt is anonymized.", 400, "invalid_state");
    const token = att.live_webcam_token || generateToken(32);
    await this.db.run(
      "UPDATE attempts SET live_webcam_token = ?, live_webcam_active = 1 WHERE id = ?",
      token,
      attemptId
    );
    await this._audit({
      organizationId: actor.organization_id,
      actorUserId: actor.user_id,
      actorEmail: actor.email,
      action: "live_webcam.started",
      targetType: "attempt",
      targetId: attemptId,
      ipAddress,
    });
    return { token, active: true };
  }

  /** Admin fetches the existing relay token (to open the WS as viewer). */
  async getLiveWebcamToken(actor, attemptId) {
    this._requireRole(actor, new Set(["admin", "interviewer", "reviewer"]));
    const att = await this.db.get(
      "SELECT live_webcam_token, status, live_webcam_active FROM attempts WHERE id = ? AND organization_id = ?",
      attemptId,
      actor.organization_id
    );
    if (!att) throw new PortalError("Attempt not found.", 404, "not_found");
    if (att.status !== "in_progress") return { token: null, active: false };
    return { token: att.live_webcam_token || null, active: Boolean(att.live_webcam_active) };
  }

  /** Admin stops the live stream, clears the token and closes relay sockets. */
  async stopLiveWebcam(actor, attemptId, ipAddress = "") {
    this._requireRole(actor, new Set(["admin", "interviewer"]));
    const att = await this.db.get(
      "SELECT id, live_webcam_token FROM attempts WHERE id = ? AND organization_id = ?",
      attemptId,
      actor.organization_id
    );
    if (!att) throw new PortalError("Attempt not found.", 404, "not_found");
    if (att.live_webcam_token) {
      closeLiveWebcamSession(att.live_webcam_token);
    }
    await this.db.run("DELETE FROM live_webcam_frames WHERE attempt_id = ?", attemptId);
    await this.db.run("UPDATE attempts SET live_webcam_token = NULL, live_webcam_active = 0 WHERE id = ?", attemptId);
    await this._audit({
      organizationId: actor.organization_id,
      actorUserId: actor.user_id,
      actorEmail: actor.email,
      action: "live_webcam.stopped",
      targetType: "attempt",
      targetId: attemptId,
      ipAddress,
    });
    return { stopped: true };
  }

  /** Candidate fetches their own relay token so their browser can stream as sender. */
  async getCandidateLiveWebcamToken(candidateToken) {
    const inv = await this._loadCandidateInvitation(candidateToken);
    const att = await this.db.get(
      "SELECT id, status, live_webcam_token, live_webcam_active FROM attempts WHERE invitation_id = ?",
      inv.id
    );
    if (!att || att.status !== "in_progress") {
      return { token: null, active: false, attempt_id: null };
    }
    return { token: att.live_webcam_token || null, active: Boolean(att.live_webcam_active), attempt_id: att.id };
  }

  /** Stores only the single latest transient JPEG frame (never any history) for HTTP/serverless relay. */
  async saveLiveWebcamFrame(candidateToken, frameBuffer) {
    const { token, attempt_id: attemptId } = await this.getCandidateLiveWebcamToken(candidateToken);
    if (!token || !attemptId) return { ok: false, active: false };
    if (Buffer.isBuffer(frameBuffer) && frameBuffer.length > 0 && frameBuffer.length <= 512 * 1024) {
      broadcastLiveFrame(token, frameBuffer);
      if (this.db.dialect === "postgres") {
        await this.db.run(
          `INSERT INTO live_webcam_frames (attempt_id, frame_data, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (attempt_id) DO UPDATE SET frame_data = EXCLUDED.frame_data, updated_at = EXCLUDED.updated_at`,
          attemptId,
          frameBuffer,
          nowTs()
        );
      }
    }
    return { ok: true, active: true };
  }

  /** Fetches the latest transient JPEG frame from memory or PostgreSQL ephemeral row. */
  async getLiveWebcamFrame(actor, attemptId) {
    const { token } = await this.getLiveWebcamToken(actor, attemptId);
    if (!token) return null;
    const latestMem = getLatestLiveFrame(token);
    if (latestMem?.frame) return latestMem.frame;
    if (this.db.dialect === "postgres") {
      const row = await this.db.get(
        "SELECT frame_data FROM live_webcam_frames WHERE attempt_id = ? AND updated_at >= ?",
        attemptId,
        nowTs() - 15
      );
      if (row?.frame_data) {
        return Buffer.isBuffer(row.frame_data) ? row.frame_data : Buffer.from(row.frame_data);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Data Retention, Deletion & Audit Logs
  // ------------------------------------------------------------------
  async anonymizeAttempt(actor, attemptId, ipAddress = "") {
    this._requireRole(actor, new Set(["admin"]));
    await this.db.transaction(async () => {
      const att = await this.db.get(
        "SELECT * FROM attempts WHERE id = ? AND organization_id = ?",
        attemptId,
        actor.organization_id
      );
      if (!att) {
        throw new PortalError("Attempt not found.", 404, "not_found");
      }
      await this._anonymizeAttemptRows(att.id, att.invitation_id);
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "candidate_data.anonymized",
        targetType: "attempt",
        targetId: attemptId,
        ipAddress,
      });
    });
    return { id: attemptId, is_anonymized: true };
  }

  async purgeExpiredRecords(actor, ipAddress = "") {
    this._requireRole(actor, new Set(["admin"]));
    const count = await this.db.transaction(async () => {
      const org = await this.db.get("SELECT retention_days FROM organizations WHERE id = ?", actor.organization_id);
      const cutoff = nowTs() - Number(org.retention_days) * 86400;
      const rows = await this.db.all(
        `SELECT id, invitation_id FROM attempts
         WHERE organization_id = ? AND is_anonymized = 0 AND created_at < ?`,
        actor.organization_id,
        cutoff
      );
      for (const r of rows) {
        await this._anonymizeAttemptRows(r.id, r.invitation_id);
      }
      await this._audit({
        organizationId: actor.organization_id,
        actorUserId: actor.user_id,
        actorEmail: actor.email,
        action: "retention.purged",
        targetType: "organization",
        targetId: actor.organization_id,
        detail: { anonymized_count: rows.length, retention_days: org.retention_days },
        ipAddress,
      });
      return rows.length;
    });
    return { anonymized_count: count };
  }

  async _anonymizeAttemptRows(attemptId, invitationId) {
    const existing = await this.db.get("SELECT live_webcam_token FROM attempts WHERE id = ?", attemptId);
    if (existing?.live_webcam_token) {
      closeLiveWebcamSession(existing.live_webcam_token);
    }
    await this.db.run("DELETE FROM live_webcam_frames WHERE attempt_id = ?", attemptId);
    const suffix = attemptId.slice(-6);
    const anonLabel = `Deleted Candidate (${suffix})`;
    const anonEmail = `deleted-${suffix}@anonymized.local`;
    await this.db.run(
      `UPDATE attempts
       SET candidate_name = ?, candidate_email = ?, device_check_json = '{}', reviewer_notes = '',
           live_webcam_token = NULL, live_webcam_active = 0, is_anonymized = 1
       WHERE id = ?`,
      anonLabel,
      anonEmail,
      attemptId
    );
    await this.db.run(
      `UPDATE candidate_invitations
       SET candidate_name = ?, candidate_email = ?, accommodation_notes = '', status = 'anonymized'
       WHERE id = ?`,
      anonLabel,
      anonEmail,
      invitationId
    );
    await this.db.run("DELETE FROM session_events WHERE attempt_id = ?", attemptId);
  }

  async listAuditLogs(actor, limit = 100) {
    this._requireRole(actor, new Set(["admin"]));
    const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = await this.db.all(
      `SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`,
      actor.organization_id,
      lim
    );
    return rows.map((r) => ({
      id: r.id,
      actor_email: r.actor_email,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      detail: JSON.parse(r.detail_json || "{}"),
      ip_address: r.ip_address,
      created_at: utcIso(r.created_at),
    }));
  }
}

