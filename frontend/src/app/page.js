"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, formatDate, getApiBase, getWebSocketUrl } from "../lib/api";

const DEFAULT_MATERIALS =
  "No external assistance or unauthorized reference materials unless explicitly permitted by the interviewer.";
const DEFAULT_RULES =
  "Complete this assessment independently within the allotted time. Your answers are autosaved continuously. Exiting fullscreen or switching tabs may auto-submit your exam.";
const DEFAULT_PRIVACY =
  "We collect your exam responses, timestamps, device compatibility checks, and browser session events solely to administer and evaluate this assessment fairly.";

export default function StaffPortalPage() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState(null);
  const [section, setSection] = useState("overview");
  const [globalAlert, setGlobalAlert] = useState(null);

  const [questions, setQuestions] = useState([]);
  const [exams, setExams] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [members, setMembers] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [inspectAttemptId, setInspectAttemptId] = useState(null);
  const [inspectAutoLive, setInspectAutoLive] = useState(false);

  const notify = useCallback((msg, type = "info") => {
    setGlobalAlert({ msg, type });
  }, []);

  const refreshCore = useCallback(async () => {
    const [exRes, invRes, attRes] = await Promise.all([
      apiFetch("/api/exams"),
      apiFetch("/api/invitations"),
      apiFetch("/api/attempts"),
    ]);
    setExams(exRes.exams);
    setInvitations(invRes.invitations);
    setAttempts(attRes.attempts);
  }, []);

  const refreshQuestions = useCallback(
    async (tag = "") => {
      if (!user || user.role === "reviewer") return;
      const qRes = await apiFetch(`/api/questions${tag ? `?pool_tag=${encodeURIComponent(tag)}` : ""}`);
      setQuestions(qRes.questions);
    },
    [user]
  );

  const refreshSecurity = useCallback(async () => {
    const me = await apiFetch("/api/auth/me");
    setUser(me.user);
    setCsrfToken(me.csrf_token);
    if (me.user.role === "admin") {
      const [memRes, audRes] = await Promise.all([
        apiFetch("/api/org/members"),
        apiFetch("/api/org/audit-logs?limit=50"),
      ]);
      setMembers(memRes.members);
      setAuditLogs(audRes.logs);
    }
  }, []);

  useEffect(() => {
    apiFetch("/api/auth/me")
      .then((res) => {
        setUser(res.user);
        setCsrfToken(res.csrf_token);
      })
      .catch(() => {})
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    setGlobalAlert(null);
    if (section === "overview") refreshCore().catch((e) => notify(e.message, "danger"));
    if (section === "questions") refreshQuestions().catch((e) => notify(e.message, "danger"));
    if (section === "exams") {
      Promise.all([
        apiFetch("/api/exams").then((r) => setExams(r.exams)),
        user.role !== "reviewer" ? apiFetch("/api/questions").then((r) => setQuestions(r.questions)) : Promise.resolve(),
      ]).catch((e) => notify(e.message, "danger"));
    }
    if (section === "invitations") refreshCore().catch((e) => notify(e.message, "danger"));
    if (section === "results" || section === "live") refreshCore().catch((e) => notify(e.message, "danger"));
    if (section === "security") refreshSecurity().catch((e) => notify(e.message, "danger"));
  }, [user, section, refreshCore, refreshQuestions, refreshSecurity, notify]);

  // Keep live proctoring & active attempts refreshed while viewing Live Webcam or Results
  useEffect(() => {
    if (!user || (section !== "live" && section !== "results" && section !== "overview")) return undefined;
    const id = setInterval(() => {
      refreshCore().catch(() => {});
    }, 8000);
    return () => clearInterval(id);
  }, [user, section, refreshCore]);

  async function handleLogout() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    setCsrfToken(null);
    setSection("overview");
  }

  const activeInProgressCount = attempts.filter((a) => a.status === "in_progress" && !a.is_anonymized).length;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">V</span>
          <span>Veritas Exam Portal</span>
          {user && <span className="badge badge-blue">{user.organization_name}</span>}
        </div>
        {user && (
          <div className="topbar-right">
            <span>{user.full_name}</span>
            <span className="badge badge-slate">{user.role}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
              Sign Out
            </button>
          </div>
        )}
      </header>

      {booting ? (
        <main className="container">
          <div className="card muted">Loading portal...</div>
        </main>
      ) : !user ? (
        <AuthView
          onAuthenticated={(u, csrf) => {
            setUser(u);
            setCsrfToken(csrf);
            setSection("overview");
          }}
        />
      ) : (
        <>
          <nav className="nav-tabs" aria-label="Portal sections">
            {[
              { id: "overview", label: "Overview" },
              ...(user.role !== "reviewer" ? [{ id: "questions", label: "Question Bank" }] : []),
              { id: "exams", label: "Exams" },
              { id: "invitations", label: "Invitations" },
              {
                id: "live",
                label: activeInProgressCount > 0 ? `Live Webcam (${activeInProgressCount})` : "Live Webcam",
              },
              { id: "results", label: "Results & Review" },
              { id: "security", label: "Organization & Security" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`nav-tab${section === tab.id ? " active" : ""}`}
                onClick={() => setSection(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <main className="container">
            {globalAlert && (
              <div className={`alert alert-${globalAlert.type}`} role="status">
                {globalAlert.msg}
              </div>
            )}

            {section === "overview" && (
              <OverviewSection
                user={user}
                exams={exams}
                invitations={invitations}
                attempts={attempts}
                onNavigate={setSection}
              />
            )}

            {section === "questions" && user.role !== "reviewer" && (
              <QuestionsSection
                csrfToken={csrfToken}
                questions={questions}
                onRefresh={refreshQuestions}
                notify={notify}
              />
            )}

            {section === "exams" && (
              <ExamsSection
                user={user}
                csrfToken={csrfToken}
                exams={exams}
                questions={questions}
                onRefresh={refreshCore}
                notify={notify}
              />
            )}

            {section === "invitations" && (
              <InvitationsSection
                user={user}
                csrfToken={csrfToken}
                exams={exams}
                invitations={invitations}
                onRefresh={refreshCore}
                notify={notify}
              />
            )}

            {section === "live" && (
              <LiveProctoringSection
                user={user}
                csrfToken={csrfToken}
                attempts={attempts}
                invitations={invitations}
                onRefresh={refreshCore}
                onInspect={(id) => {
                  setInspectAutoLive(false);
                  setInspectAttemptId(id);
                }}
                notify={notify}
              />
            )}

            {section === "results" && (
              <ResultsSection
                exams={exams}
                attempts={attempts}
                onFilterExam={async (examId) => {
                  const res = await apiFetch(
                    `/api/attempts${examId ? `?exam_id=${encodeURIComponent(examId)}` : ""}`
                  );
                  setAttempts(res.attempts);
                }}
                onInspect={(id, autoLive = false) => {
                  setInspectAutoLive(autoLive);
                  setInspectAttemptId(id);
                }}
              />
            )}

            {section === "security" && (
              <SecuritySection
                user={user}
                csrfToken={csrfToken}
                members={members}
                auditLogs={auditLogs}
                onRefresh={refreshSecurity}
                notify={notify}
              />
            )}
          </main>

          {inspectAttemptId && (
            <AttemptReviewModal
              attemptId={inspectAttemptId}
              autoStartLive={inspectAutoLive}
              user={user}
              csrfToken={csrfToken}
              onClose={() => {
                setInspectAttemptId(null);
                setInspectAutoLive(false);
              }}
              onChanged={refreshCore}
              notify={notify}
            />
          )}
        </>
      )}
    </>
  );
}

function AuthView({ onAuthenticated }) {
  const [tab, setTab] = useState("login");
  const [mfaPending, setMfaPending] = useState(false);
  const [alert, setAlert] = useState(null);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  const [orgName, setOrgName] = useState("");
  const [fullName, setFullName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");

  const [inviteToken, setInviteToken] = useState("");
  const [invitePassword, setInvitePassword] = useState("");

  async function submitLogin(e) {
    e.preventDefault();
    setAlert(null);
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: { email: loginEmail, password: loginPassword },
      });
      if (res.mfa_required) {
        setMfaPending(true);
      } else {
        onAuthenticated(res.user, res.csrf_token);
      }
    } catch (err) {
      setAlert({ msg: err.message, type: "danger" });
    }
  }

  async function submitMfa(e) {
    e.preventDefault();
    setAlert(null);
    try {
      const res = await apiFetch("/api/auth/mfa/verify", {
        method: "POST",
        body: { mfa_code: mfaCode },
      });
      onAuthenticated(res.user, res.csrf_token);
    } catch (err) {
      setAlert({ msg: err.message, type: "danger" });
    }
  }

  async function submitRegister(e) {
    e.preventDefault();
    setAlert(null);
    try {
      const res = await apiFetch("/api/auth/register-org", {
        method: "POST",
        body: { org_name: orgName, full_name: fullName, email: regEmail, password: regPassword },
      });
      onAuthenticated(res.user, res.csrf_token);
    } catch (err) {
      setAlert({ msg: err.message, type: "danger" });
    }
  }

  async function submitAcceptInvite(e) {
    e.preventDefault();
    setAlert(null);
    try {
      const res = await apiFetch("/api/auth/accept-invite", {
        method: "POST",
        body: { token: inviteToken, password: invitePassword },
      });
      onAuthenticated(res.user, res.csrf_token);
    } catch (err) {
      setAlert({ msg: err.message, type: "danger" });
    }
  }

  return (
    <main className="auth-wrapper">
      <div className="card">
        <h1 style={{ margin: "0 0 6px 0", fontSize: "1.35rem" }}>Company Assessment Portal</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Reliable, fair MCQ assessments with fullscreen/tab-switch lockdown and clipboard protection.
        </p>

        {alert && (
          <div className={`alert alert-${alert.type}`} role="alert">
            {alert.msg}
          </div>
        )}

        {mfaPending ? (
          <form onSubmit={submitMfa}>
            <div className="alert alert-info">
              Multi-factor authentication is enabled. Enter the 6-digit code from your authenticator app.
            </div>
            <div className="form-row">
              <label htmlFor="mfaCode">6-Digit Code</label>
              <input
                id="mfaCode"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
                required
              />
            </div>
            <div className="btn-group">
              <button type="submit" className="btn btn-primary">
                Verify &amp; Continue
              </button>
              <button type="button" className="btn" onClick={() => setMfaPending(false)}>
                Back
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="auth-tabs" role="tablist">
              {[
                { id: "login", label: "Sign In" },
                { id: "register", label: "Create Org" },
                { id: "invite", label: "Staff Invite" },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`auth-tab${tab === t.id ? " active" : ""}`}
                  onClick={() => {
                    setTab(t.id);
                    setAlert(null);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "login" && (
              <form onSubmit={submitLogin}>
                <div className="form-row">
                  <label htmlFor="loginEmail">Work Email</label>
                  <input
                    id="loginEmail"
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="loginPassword">Password</label>
                  <input
                    id="loginPassword"
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                  Sign In
                </button>
              </form>
            )}

            {tab === "register" && (
              <form onSubmit={submitRegister}>
                <div className="form-row">
                  <label htmlFor="orgName">Company / Organization Name</label>
                  <input
                    id="orgName"
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Acme Engineering"
                    required
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="fullName">Your Full Name</label>
                  <input
                    id="fullName"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jordan Rivera"
                    required
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="regEmail">Admin Email</label>
                  <input
                    id="regEmail"
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="jordan@acme.example"
                    required
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="regPassword">Password (min 8 characters)</label>
                  <input
                    id="regPassword"
                    type="password"
                    minLength={8}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                  Create Organization
                </button>
              </form>
            )}

            {tab === "invite" && (
              <form onSubmit={submitAcceptInvite}>
                <div className="form-row">
                  <label htmlFor="inviteToken">Staff Invitation Token</label>
                  <input
                    id="inviteToken"
                    type="text"
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder="Paste token from admin"
                    required
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="invitePassword">Choose Password (min 8 characters)</label>
                  <input
                    id="invitePassword"
                    type="password"
                    minLength={8}
                    value={invitePassword}
                    onChange={(e) => setInvitePassword(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                  Accept Invite &amp; Join
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function OverviewSection({ user, exams, invitations, attempts, onNavigate }) {
  const published = exams.filter((e) => e.status === "published").length;
  const activeInvites = invitations.filter((i) => i.status === "pending" && !i.is_expired).length;
  const completed = attempts.filter((a) => a.status === "submitted" || a.status === "timed_out");
  const avgScore = completed.length
    ? `${(completed.reduce((s, a) => s + (a.score_percent || 0), 0) / completed.length).toFixed(1)}%`
    : "—";

  return (
    <>
      <div className="grid-4">
        <div className="kpi-card">
          <div className="kpi-label">Published Exams</div>
          <div className="kpi-value">{published}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active Invitations</div>
          <div className="kpi-value">{activeInvites}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Completed Attempts</div>
          <div className="kpi-value">{completed.length}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Average Score</div>
          <div className="kpi-value">{avgScore}</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Assessment Integrity &amp; Lockdown</h2>
          </div>
          <ul className="muted" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Answer keys and scoring logic stay strictly on the Node.js server prior to submission.</li>
            <li>Fullscreen exit or tab switching can auto-submit exams immediately with recorded trigger reasons.</li>
            <li>Copy, cut, paste, text selection, and right-click can be locked inside the exam screen.</li>
            <li>Candidates can receive extra time accommodations and non-webcam alternatives.</li>
          </ul>
        </div>
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Quick Actions</h2>
          </div>
          <div className="btn-group">
            {user.role !== "reviewer" && (
              <>
                <button type="button" className="btn btn-primary" onClick={() => onNavigate("questions")}>
                  Add Questions
                </button>
                <button type="button" className="btn" onClick={() => onNavigate("exams")}>
                  Build Exam
                </button>
                <button type="button" className="btn" onClick={() => onNavigate("invitations")}>
                  Invite Candidate
                </button>
              </>
            )}
            <button type="button" className="btn" onClick={() => onNavigate("live")}>
              Live Webcam Monitor
            </button>
            <button type="button" className="btn" onClick={() => onNavigate("results")}>
              Review Results
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function QuestionsSection({ csrfToken, questions, onRefresh, notify }) {
  const [prompt, setPrompt] = useState("");
  const [poolTag, setPoolTag] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [points, setPoints] = useState(1);
  const [negPoints, setNegPoints] = useState(0);
  const [explanation, setExplanation] = useState("");
  const [options, setOptions] = useState([
    { text: "", is_correct: true },
    { text: "", is_correct: false },
    { text: "", is_correct: false },
    { text: "", is_correct: false },
  ]);
  const [filterTag, setFilterTag] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      await apiFetch("/api/questions", {
        method: "POST",
        csrfToken,
        body: {
          prompt,
          pool_tag: poolTag,
          difficulty,
          points: Number(points),
          negative_points: Number(negPoints),
          explanation,
          options,
        },
      });
      setPrompt("");
      setPoolTag("");
      setExplanation("");
      setOptions([
        { text: "", is_correct: true },
        { text: "", is_correct: false },
        { text: "", is_correct: false },
        { text: "", is_correct: false },
      ]);
      notify("Question saved to bank.", "success");
      await onRefresh(filterTag);
    } catch (err) {
      notify(err.message, "danger");
    }
  }

  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Add MCQ Question</h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <label htmlFor="qPrompt">Question Prompt</label>
            <textarea
              id="qPrompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Which HTTP status code indicates a resource was created?"
              required
            />
          </div>
          <div className="grid-2">
            <div className="form-row">
              <label htmlFor="qPool">Pool / Topic Tag</label>
              <input
                id="qPool"
                type="text"
                value={poolTag}
                onChange={(e) => setPoolTag(e.target.value)}
                placeholder="backend-apis"
              />
            </div>
            <div className="form-row">
              <label htmlFor="qDiff">Difficulty</label>
              <select id="qDiff" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
          </div>
          <div className="grid-2">
            <div className="form-row">
              <label htmlFor="qPts">Points</label>
              <input
                id="qPts"
                type="number"
                step="0.5"
                min="0.5"
                max="100"
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                required
              />
            </div>
            <div className="form-row">
              <label htmlFor="qNeg">Wrong Answer Penalty (0 = none)</label>
              <input
                id="qNeg"
                type="number"
                step="0.25"
                min="0"
                max="100"
                value={negPoints}
                onChange={(e) => setNegPoints(e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <label>Answer Options (select the single correct answer)</label>
            {options.map((opt, idx) => (
              <div key={idx} className="checkbox-row" style={{ alignItems: "center" }}>
                <input
                  type="radio"
                  name="correctOptionRadio"
                  checked={opt.is_correct}
                  onChange={() =>
                    setOptions((prev) => prev.map((o, i) => ({ ...o, is_correct: i === idx })))
                  }
                  aria-label={`Mark option ${idx + 1} correct`}
                />
                <input
                  type="text"
                  placeholder={`Option ${idx + 1}`}
                  value={opt.text}
                  onChange={(e) =>
                    setOptions((prev) =>
                      prev.map((o, i) => (i === idx ? { ...o, text: e.target.value } : o))
                    )
                  }
                  required
                />
              </div>
            ))}
            {options.length < 10 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setOptions((prev) => [...prev, { text: "", is_correct: false }])}
              >
                + Add Option
              </button>
            )}
          </div>
          <div className="form-row">
            <label htmlFor="qExp">Reviewer Explanation (shown after submission)</label>
            <textarea
              id="qExp"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary">
            Save Question
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Question Bank</h2>
          <div className="btn-group">
            <input
              type="text"
              placeholder="Filter by pool tag..."
              value={filterTag}
              onChange={(e) => setFilterTag(e.target.value)}
              style={{ width: 170 }}
            />
            <button type="button" className="btn btn-sm" onClick={() => onRefresh(filterTag)}>
              Filter
            </button>
          </div>
        </div>
        {questions.length === 0 ? (
          <p className="muted">No questions yet. Add your first MCQ question on the left.</p>
        ) : (
          questions.map((q) => (
            <div key={q.id} className="card" style={{ padding: 14, marginBottom: 10, boxShadow: "none" }}>
              <div className="card-header" style={{ marginBottom: 8 }}>
                <div className="btn-group">
                  {q.pool_tag && <span className="badge badge-blue">{q.pool_tag}</span>}
                  <span className="badge badge-slate">{q.difficulty}</span>
                  <span className="badge badge-green">
                    {q.points} pt{q.points === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await apiFetch(`/api/questions/${q.id}/archive`, { method: "POST", csrfToken, body: {} });
                    onRefresh(filterTag);
                  }}
                >
                  Archive
                </button>
              </div>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{q.prompt}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: "0.88rem" }}>
                {q.options.map((o) => (
                  <li
                    key={o.id}
                    style={{
                      color: o.is_correct ? "var(--success)" : "var(--text-muted)",
                      fontWeight: o.is_correct ? 700 : 400,
                    }}
                  >
                    {o.text} {o.is_correct ? "(Correct)" : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ExamsSection({ user, csrfToken, exams, questions, onRefresh, notify }) {
  const canEdit = user.role === "admin" || user.role === "interviewer";
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);

  function openNew() {
    setEditing("new");
    setForm({
      id: null,
      title: "",
      status: "draft",
      description: "",
      duration_minutes: 30,
      passing_score_percent: 70,
      draw_count: "",
      pool_tag: "",
      shuffle_questions: true,
      shuffle_options: true,
      require_fullscreen: true,
      auto_submit_on_violation: true,
      lock_copy_paste: true,
      require_webcam_check: false,
      require_live_webcam: false,
      allow_non_webcam_alternative: true,
      allowed_materials: DEFAULT_MATERIALS,
      rules_text: DEFAULT_RULES,
      privacy_notice: DEFAULT_PRIVACY,
      question_ids: [],
    });
  }

  async function openExisting(examId) {
    const res = await apiFetch(`/api/exams/${examId}`);
    const ex = res.exam;
    setEditing(examId);
    setForm({
      ...ex,
      draw_count: ex.draw_count || "",
      question_ids: ex.question_ids || [],
    });
  }

  async function saveExam(e) {
    e.preventDefault();
    try {
      const payload = {
        ...form,
        duration_minutes: Number(form.duration_minutes),
        passing_score_percent: Number(form.passing_score_percent),
        draw_count: form.draw_count ? Number(form.draw_count) : null,
      };
      if (form.id) {
        await apiFetch(`/api/exams/${form.id}`, { method: "PUT", csrfToken, body: payload });
      } else {
        await apiFetch("/api/exams", { method: "POST", csrfToken, body: payload });
      }
      setEditing(null);
      setForm(null);
      notify("Exam saved.", "success");
      await onRefresh();
    } catch (err) {
      notify(err.message, "danger");
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Exams</h2>
          {canEdit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={openNew}>
              + Create Exam
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Pass %</th>
                <th>Questions / Pool</th>
                <th>Integrity &amp; Lockdown</th>
                <th>Invites / Done</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {exams.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    No exams created yet.
                  </td>
                </tr>
              ) : (
                exams.map((ex) => {
                  const badgeCls =
                    ex.status === "published" ? "badge-green" : ex.status === "draft" ? "badge-amber" : "badge-slate";
                  const poolDesc = ex.attached_count
                    ? `${ex.attached_count} attached${ex.draw_count ? ` (draw ${ex.draw_count})` : ""}`
                    : ex.pool_tag
                    ? `Pool "${ex.pool_tag}"${ex.draw_count ? ` (draw ${ex.draw_count})` : ""}`
                    : "All bank";
                  const flags =
                    [
                      ex.shuffle_questions ? "Shuffle Q" : null,
                      ex.require_fullscreen ? "Fullscreen" : null,
                      ex.auto_submit_on_violation ? "Auto-submit lock" : null,
                      ex.lock_copy_paste ? "Copy/Paste locked" : null,
                      ex.require_webcam_check ? "Webcam check" : null,
                      ex.require_live_webcam ? "Live webcam monitor" : null,
                    ]
                      .filter(Boolean)
                      .join(", ") || "Standard";
                  return (
                    <tr key={ex.id}>
                      <td>
                        <strong>{ex.title}</strong>
                      </td>
                      <td>
                        <span className={`badge ${badgeCls}`}>{ex.status}</span>
                      </td>
                      <td>{ex.duration_minutes}m</td>
                      <td>{ex.passing_score_percent}%</td>
                      <td>{poolDesc}</td>
                      <td className="muted">{flags}</td>
                      <td>
                        {ex.invite_count} / {ex.completed_count}
                      </td>
                      <td>
                        {canEdit ? (
                          <button type="button" className="btn btn-sm" onClick={() => openExisting(ex.id)}>
                            Edit
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && form && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{form.id ? "Edit Exam" : "Create Exam"}</h2>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
          <form onSubmit={saveExam}>
            <div className="grid-2">
              <div className="form-row">
                <label htmlFor="exTitle">Exam Title</label>
                <input
                  id="exTitle"
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="exStatus">Status</label>
                <select
                  id="exStatus"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published (Ready for invites)</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="exDesc">Description</label>
              <textarea
                id="exDesc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="grid-4">
              <div className="form-row">
                <label htmlFor="exDur">Duration (minutes)</label>
                <input
                  id="exDur"
                  type="number"
                  min={1}
                  max={360}
                  value={form.duration_minutes}
                  onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="exPass">Passing Score (%)</label>
                <input
                  id="exPass"
                  type="number"
                  min={0}
                  max={100}
                  value={form.passing_score_percent}
                  onChange={(e) => setForm({ ...form, passing_score_percent: e.target.value })}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="exDraw">Random Draw Count</label>
                <input
                  id="exDraw"
                  type="number"
                  min={1}
                  max={500}
                  placeholder="All"
                  value={form.draw_count}
                  onChange={(e) => setForm({ ...form, draw_count: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label htmlFor="exPool">Pool Tag</label>
                <input
                  id="exPool"
                  type="text"
                  placeholder="Optional tag"
                  value={form.pool_tag}
                  onChange={(e) => setForm({ ...form, pool_tag: e.target.value })}
                />
              </div>
            </div>

            <div className="grid-2">
              <div className="form-row">
                <label>Question &amp; Lockdown Settings</label>
                {[
                  ["shuffle_questions", "Randomize question order per candidate"],
                  ["shuffle_options", "Randomize answer option order per candidate"],
                  ["require_fullscreen", "Require fullscreen mode during exam"],
                  ["auto_submit_on_violation", "Auto-submit exam if candidate exits fullscreen or switches tabs"],
                  ["lock_copy_paste", "Lock copy, cut, paste, text selection, and context menu during exam"],
                  ["require_webcam_check", "Require pre-exam webcam & mic check (with explicit consent)"],
                  ["require_live_webcam", "Require live webcam monitoring during exam (live preview in admin portal)"],
                  ["allow_non_webcam_alternative", "Allow candidates to request a non-webcam alternative"],
                ].map(([key, labelText]) => (
                  <div key={key} className="checkbox-row">
                    <input
                      id={`ex_${key}`}
                      type="checkbox"
                      checked={Boolean(form[key])}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setForm((prev) => ({
                          ...prev,
                          [key]: checked,
                          ...(key === "require_live_webcam" && checked ? { require_webcam_check: true } : {}),
                        }));
                      }}
                    />
                    <label htmlFor={`ex_${key}`}>{labelText}</label>
                  </div>
                ))}
              </div>

              <div className="form-row">
                <label>Attach Specific Questions (optional if Pool Tag is set)</label>
                <div
                  style={{
                    maxHeight: 220,
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    padding: 10,
                  }}
                >
                  {questions.length === 0 ? (
                    <span className="muted">No questions in bank yet.</span>
                  ) : (
                    questions.map((q) => {
                      const checked = form.question_ids.includes(q.id);
                      return (
                        <div key={q.id} className="checkbox-row">
                          <input
                            id={`pick_${q.id}`}
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...form.question_ids, q.id]
                                : form.question_ids.filter((id) => id !== q.id);
                              setForm({ ...form, question_ids: next });
                            }}
                          />
                          <label htmlFor={`pick_${q.id}`}>
                            {q.pool_tag ? `[${q.pool_tag}] ` : ""}
                            {q.prompt.slice(0, 90)}
                          </label>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="exMat">Allowed Materials</label>
              <textarea
                id="exMat"
                value={form.allowed_materials}
                onChange={(e) => setForm({ ...form, allowed_materials: e.target.value })}
              />
            </div>
            <div className="grid-2">
              <div className="form-row">
                <label htmlFor="exRules">Candidate Rules</label>
                <textarea
                  id="exRules"
                  value={form.rules_text}
                  onChange={(e) => setForm({ ...form, rules_text: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label htmlFor="exPriv">Privacy Notice</label>
                <textarea
                  id="exPriv"
                  value={form.privacy_notice}
                  onChange={(e) => setForm({ ...form, privacy_notice: e.target.value })}
                />
              </div>
            </div>

            <button type="submit" className="btn btn-primary">
              Save Exam
            </button>
          </form>
        </div>
      )}
    </>
  );
}

function InvitationsSection({ user, csrfToken, exams, invitations, onRefresh, notify }) {
  const canManage = user.role === "admin" || user.role === "interviewer";
  const published = exams.filter((e) => e.status === "published");

  const [examId, setExamId] = useState("");
  const [candName, setCandName] = useState("");
  const [candEmail, setCandEmail] = useState("");
  const [expiresHours, setExpiresHours] = useState(72);
  const [extraTime, setExtraTime] = useState(0);
  const [requireLiveWebcam, setRequireLiveWebcam] = useState(false);
  const [webcamWaived, setWebcamWaived] = useState(false);
  const [accommNotes, setAccommNotes] = useState("");
  const [generatedUrl, setGeneratedUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!examId && published.length > 0) {
      setExamId(published[0].id);
    }
  }, [examId, published]);

  function showLink(path) {
    setGeneratedUrl(`${window.location.origin}${path}`);
  }

  async function handleInvite(e) {
    e.preventDefault();
    try {
      const res = await apiFetch("/api/invitations", {
        method: "POST",
        csrfToken,
        body: {
          exam_id: examId,
          candidate_name: candName,
          candidate_email: candEmail,
          expires_hours: Number(expiresHours),
          extra_time_minutes: Number(extraTime),
          require_live_webcam: requireLiveWebcam && !webcamWaived,
          webcam_waived: webcamWaived,
          accommodation_notes: accommNotes,
        },
      });
      showLink(res.invitation.invite_path);
      setCandName("");
      setCandEmail("");
      setAccommNotes("");
      await onRefresh();
    } catch (err) {
      notify(err.message, "danger");
    }
  }

  return (
    <div className="grid-2">
      {canManage && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Invite Candidate</h2>
          </div>
          <form onSubmit={handleInvite}>
            <div className="form-row">
              <label htmlFor="invExam">Published Exam</label>
              <select id="invExam" value={examId} onChange={(e) => setExamId(e.target.value)} required>
                {published.length === 0 ? (
                  <option value="">Publish an exam first</option>
                ) : (
                  published.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.title} ({ex.duration_minutes}m)
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="grid-2">
              <div className="form-row">
                <label htmlFor="invName">Candidate Name</label>
                <input
                  id="invName"
                  type="text"
                  value={candName}
                  onChange={(e) => setCandName(e.target.value)}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="invEmail">Candidate Email</label>
                <input
                  id="invEmail"
                  type="email"
                  value={candEmail}
                  onChange={(e) => setCandEmail(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="grid-2">
              <div className="form-row">
                <label htmlFor="invExp">Link Expires In (hours)</label>
                <input
                  id="invExp"
                  type="number"
                  min={1}
                  max={720}
                  value={expiresHours}
                  onChange={(e) => setExpiresHours(e.target.value)}
                  required
                />
              </div>
              <div className="form-row">
                <label htmlFor="invExtra">Extra Time Accommodation (mins)</label>
                <input
                  id="invExtra"
                  type="number"
                  min={0}
                  max={240}
                  value={extraTime}
                  onChange={(e) => setExtraTime(e.target.value)}
                />
              </div>
            </div>
            <div className="checkbox-row">
              <input
                id="invLiveCam"
                type="checkbox"
                checked={requireLiveWebcam}
                disabled={webcamWaived}
                onChange={(e) => setRequireLiveWebcam(e.target.checked)}
              />
              <label htmlFor="invLiveCam">
                Require live webcam monitoring for this candidate (admin live preview)
              </label>
            </div>
            <div className="checkbox-row">
              <input
                id="invWaive"
                type="checkbox"
                checked={webcamWaived}
                onChange={(e) => {
                  setWebcamWaived(e.target.checked);
                  if (e.target.checked) setRequireLiveWebcam(false);
                }}
              />
              <label htmlFor="invWaive">Waive webcam check for this candidate (accommodation)</label>
            </div>
            <div className="form-row">
              <label htmlFor="invNotes">Accommodation Notes (internal)</label>
              <input
                id="invNotes"
                type="text"
                value={accommNotes}
                onChange={(e) => setAccommNotes(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={published.length === 0}>
              Generate Secure Invite Link
            </button>
          </form>

          {generatedUrl && (
            <div className="alert alert-success" style={{ marginTop: 14 }}>
              <strong>Unique Candidate Link Generated:</strong>
              <p className="muted" style={{ margin: "4px 0 8px 0" }}>
                Copy and share this link now. Only its SHA-256 hash is stored in the database.
              </p>
              <div className="copy-box">
                <input type="text" readOnly value={generatedUrl} />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(generatedUrl).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
                <a className="btn btn-sm" href={generatedUrl} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Candidate Invitations</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Exam</th>
                <th>Status</th>
                <th>Accommodations</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    No candidate invitations yet.
                  </td>
                </tr>
              ) : (
                invitations.map((i) => {
                  const badgeCls =
                    i.status === "completed"
                      ? "badge-green"
                      : i.status === "started"
                      ? "badge-blue"
                      : i.status === "revoked" || i.is_expired
                      ? "badge-red"
                      : "badge-amber";
                  const accomm =
                    [
                      i.extra_time_minutes ? `+${i.extra_time_minutes}m` : null,
                      i.effective_live_webcam ? "Live webcam" : null,
                      i.webcam_waived ? "Webcam waived" : null,
                    ]
                      .filter(Boolean)
                      .join(", ") || "None";
                  return (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.candidate_name}</strong>
                        <div className="muted">{i.candidate_email}</div>
                      </td>
                      <td>{i.exam_title}</td>
                      <td>
                        <span className={`badge ${badgeCls}`}>{i.is_expired ? "expired" : i.status}</span>
                        {i.effective_live_webcam && (
                          <div>
                            <span className="badge badge-blue" style={{ marginTop: 4 }}>
                              Live Webcam
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="muted">{accomm}</td>
                      <td className="muted">{formatDate(i.expires_at)}</td>
                      <td>
                        {canManage && (i.status === "pending" || i.status === "started") ? (
                          <div className="btn-group">
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={async () => {
                                await apiFetch(`/api/invitations/${i.id}/webcam`, {
                                  method: "PATCH",
                                  csrfToken,
                                  body: { require_live_webcam: !i.require_live_webcam },
                                });
                                notify(
                                  !i.require_live_webcam
                                    ? `Live webcam monitoring enabled for ${i.candidate_name}.`
                                    : `Per-candidate live webcam monitoring disabled for ${i.candidate_name}.`,
                                  "info"
                                );
                                onRefresh();
                              }}
                            >
                              {i.require_live_webcam ? "Webcam Off" : "Require Webcam"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={async () => {
                                const res = await apiFetch(`/api/invitations/${i.id}/regenerate`, {
                                  method: "POST",
                                  csrfToken,
                                  body: {},
                                });
                                showLink(res.invite_path);
                              }}
                            >
                              New Link
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={async () => {
                                await apiFetch(`/api/invitations/${i.id}/revoke`, {
                                  method: "POST",
                                  csrfToken,
                                  body: {},
                                });
                                onRefresh();
                              }}
                            >
                              Revoke
                            </button>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LiveWebcamMonitor({
  attemptId,
  canControl,
  csrfToken,
  initialActive = false,
  autoStart = false,
  notify,
  onStatusChange,
}) {
  const [watching, setWatching] = useState(false);
  const [statusLabel, setStatusLabel] = useState("Idle");
  const [frameUrl, setFrameUrl] = useState("");
  const [lastFrameAt, setLastFrameAt] = useState(null);
  const [faceAnalysis, setFaceAnalysis] = useState(null);

  const wsRef = useRef(null);
  const fallbackTimerRef = useRef(null);
  const prevUrlRef = useRef("");
  const lastWsFrameAtRef = useRef(0);
  const autoTriggeredRef = useRef(false);

  useEffect(() => {
    let cancel = false;
    const fetchAnalysis = async () => {
      try {
        const data = await apiFetch(`/api/attempts/${attemptId}/face-analysis`);
        if (!cancel && data) {
          setFaceAnalysis(data);
        }
      } catch {
        // ignore polling errors
      }
    };
    fetchAnalysis();
    const interval = setInterval(fetchAnalysis, 7000);
    return () => {
      cancel = true;
      clearInterval(interval);
    };
  }, [attemptId]);

  const updateFrameBlob = useCallback((blob) => {
    if (!blob || blob.size === 0) return;
    const nextUrl = URL.createObjectURL(blob);
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current);
    }
    prevUrlRef.current = nextUrl;
    setFrameUrl(nextUrl);
    setLastFrameAt(new Date().toLocaleTimeString());
    setStatusLabel("Live");
  }, []);

  const disconnectViewer = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current);
      prevUrlRef.current = "";
    }
    setFrameUrl("");
    setLastFrameAt(null);
    setWatching(false);
    setStatusLabel("Idle");
  }, []);

  useEffect(() => () => disconnectViewer(), [disconnectViewer]);

  const startPreview = useCallback(async () => {
    try {
      setStatusLabel("Connecting...");
      let token = null;
      if (canControl) {
        const res = await apiFetch(`/api/attempts/${attemptId}/live-webcam/start`, {
          method: "POST",
          csrfToken,
          body: {},
        });
        token = res.token;
      } else {
        const res = await apiFetch(`/api/attempts/${attemptId}/live-webcam/token`);
        token = res.token;
      }

      if (!token) {
        setStatusLabel("No active stream token");
        if (notify) notify("Live webcam stream has not been started for this attempt yet.", "info");
        return;
      }

      disconnectViewer();
      setWatching(true);
      setStatusLabel("Waiting for candidate camera...");

      const apiBase = getApiBase();
      const shouldUseHttpOnly = window.location.protocol === "https:" && !apiBase;
      if (!shouldUseHttpOnly) {
        const wsUrl = getWebSocketUrl(`/live-webcam?token=${encodeURIComponent(token)}&role=admin`);
        try {
          const ws = new WebSocket(wsUrl);
          ws.binaryType = "arraybuffer";
          wsRef.current = ws;

          ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
              lastWsFrameAtRef.current = Date.now();
              updateFrameBlob(new Blob([event.data], { type: "image/jpeg" }));
            }
          };

          ws.onerror = () => {
            // Fallback polling below handles environments without WS
          };
        } catch {
          // ignore WS errors; HTTP fallback handles preview
        }
      }

      // HTTP frame fallback (or primary over HTTPS Next.js proxy)
      fallbackTimerRef.current = setInterval(async () => {
        if (Date.now() - lastWsFrameAtRef.current < 1500) return;
        try {
          const r = await fetch(`${apiBase}/api/attempts/${attemptId}/live-webcam/frame`, {
            credentials: "include",
            cache: "no-store",
          });
          if (r.status === 200) {
            const blob = await r.blob();
            updateFrameBlob(blob);
          }
        } catch {
          // ignore transient poll errors
        }
      }, shouldUseHttpOnly ? 500 : 1000);

      if (onStatusChange) onStatusChange();
    } catch (err) {
      setStatusLabel("Error");
      if (notify) notify(err.message, "danger");
    }
  }, [attemptId, canControl, csrfToken, disconnectViewer, notify, onStatusChange, updateFrameBlob]);

  const stopPreview = useCallback(async () => {
    disconnectViewer();
    if (canControl) {
      try {
        await apiFetch(`/api/attempts/${attemptId}/live-webcam/stop`, {
          method: "POST",
          csrfToken,
          body: {},
        });
      } catch {
        // ignore
      }
      if (onStatusChange) onStatusChange();
    }
  }, [attemptId, canControl, csrfToken, disconnectViewer, onStatusChange]);

  useEffect(() => {
    if (!autoTriggeredRef.current && (autoStart || initialActive)) {
      autoTriggeredRef.current = true;
      startPreview();
    }
  }, [autoStart, initialActive, startPreview]);

  return (
    <div
      className="card"
      style={{
        borderColor: watching ? "#86efac" : "#bfdbfe",
        background: watching ? "#f0fdf4" : "#eff6ff",
        marginBottom: 12,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: "0.95rem" }}>Live Webcam Preview</strong>
          <span
            className={`badge ${
              statusLabel === "Live" ? "badge-green" : watching ? "badge-blue" : "badge-slate"
            }`}
          >
            {statusLabel}
          </span>
          {lastFrameAt && <span className="muted" style={{ fontSize: "0.78rem" }}>Updated {lastFrameAt}</span>}
        </div>
        <div className="btn-group">
          {!watching ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={startPreview}>
              Start Live Preview
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={stopPreview}>
              {canControl ? "Stop Preview" : "Disconnect"}
            </button>
          )}
        </div>
      </div>

      {watching ? (
        frameUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={frameUrl}
            alt="Live candidate webcam preview"
            style={{
              display: "block",
              width: "100%",
              maxWidth: 480,
              borderRadius: 8,
              background: "#000",
              border: "1px solid var(--border)",
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              maxWidth: 480,
              height: 220,
              borderRadius: 8,
              background: "#0f172a",
              color: "#cbd5e1",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              textAlign: "center",
              fontSize: "0.86rem",
            }}
          >
            Waiting for candidate browser to share webcam frames... (Updates automatically within a few seconds.)
          </div>
        )
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: "0.84rem" }}>
          Real-time in-memory webcam preview. No video is recorded or stored on disk. Click{" "}
          <strong>Start Live Preview</strong> to view the candidate&apos;s camera.
        </p>
      )}

      {/* AI Proctoring & Face Tracking Analysis */}
      {faceAnalysis && (
        <div
          style={{
            marginTop: 10,
            padding: "10px 14px",
            borderRadius: 7,
            background:
              faceAnalysis.risk === "high"
                ? "#fef2f2"
                : faceAnalysis.risk === "medium"
                ? "#fffbeb"
                : "#f0fdf4",
            border: `1px solid ${
              faceAnalysis.risk === "high"
                ? "#fecaca"
                : faceAnalysis.risk === "medium"
                ? "#fde68a"
                : "#bbf7d0"
            }`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              <span>🧠 AI Anti-Cheat Proctor (Groq LLM)</span>
            </span>
            <span
              className={`badge ${
                faceAnalysis.risk === "high"
                  ? "badge-red"
                  : faceAnalysis.risk === "medium"
                  ? "badge-amber"
                  : faceAnalysis.risk === "low"
                  ? "badge-green"
                  : "badge-slate"
              }`}
              style={{ fontWeight: 700 }}
            >
              {faceAnalysis.risk === "high"
                ? "🚨 High Cheating Risk"
                : faceAnalysis.risk === "medium"
                ? "⚠️ Suspicious Patterns"
                : faceAnalysis.risk === "low"
                ? "✅ Low Risk / Verified"
                : "Awaiting Signals"}
            </span>
          </div>

          <p style={{ margin: "4px 0 6px 0", fontSize: "0.82rem", color: "#1e293b", lineHeight: 1.45 }}>
            {faceAnalysis.verdict || "Monitoring candidate face orientation, presence, and multiple identities in real time..."}
          </p>

          {faceAnalysis.event_counts && (
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap", fontSize: "0.75rem" }}>
              <span className="badge badge-slate" style={{ background: "#e2e8f0" }}>
                Face Absent: <strong>{faceAnalysis.event_counts.face_absent || 0}</strong>
              </span>
              <span
                className={`badge ${(faceAnalysis.event_counts.multiple_faces || 0) > 0 ? "badge-red" : "badge-slate"}`}
                style={{ background: (faceAnalysis.event_counts.multiple_faces || 0) > 0 ? undefined : "#e2e8f0" }}
              >
                Multiple Faces: <strong>{faceAnalysis.event_counts.multiple_faces || 0}</strong>
              </span>
              <span className="badge badge-slate" style={{ background: "#e2e8f0" }}>
                Gaze Deviations: <strong>{faceAnalysis.event_counts.gaze_deviation || 0}</strong>
              </span>
            </div>
          )}

          {Array.isArray(faceAnalysis.flags) && faceAnalysis.flags.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {faceAnalysis.flags.map((flag, idx) => (
                <span
                  key={idx}
                  style={{
                    fontSize: "0.72rem",
                    padding: "2px 7px",
                    borderRadius: 4,
                    background: "#fee2e2",
                    color: "#991b1b",
                    fontWeight: 600,
                  }}
                >
                  ⚠ {flag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiveProctoringSection({ user, csrfToken, attempts, invitations, onRefresh, onInspect, notify }) {
  const canControl = user.role === "admin" || user.role === "interviewer";
  const activeAttempts = attempts.filter((a) => a.status === "in_progress" && !a.is_anonymized);
  const scheduledLiveInvites = invitations.filter(
    (i) => i.status === "pending" && !i.is_expired && i.effective_live_webcam
  );

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Live Webcam Monitoring</h2>
            <p className="muted" style={{ margin: "4px 0 0 0", fontSize: "0.88rem" }}>
              View real-time webcam previews for candidates currently taking an exam. Nothing is recorded or saved to
              disk.
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => onRefresh()}>
            Refresh
          </button>
        </div>

        {activeAttempts.length === 0 ? (
          <div className="alert alert-info" style={{ marginBottom: 0 }}>
            No candidates are currently in an active exam session. Once a candidate opens their invite link and clicks{" "}
            <strong>Start Timed Exam</strong>, their live webcam card will appear here automatically.
          </div>
        ) : (
          <div className="grid-2">
            {activeAttempts.map((a) => (
              <div key={a.id} className="card" style={{ marginBottom: 0, boxShadow: "none" }}>
                <div className="card-header">
                  <div>
                    <strong>{a.candidate_name}</strong>
                    <div className="muted" style={{ fontSize: "0.82rem" }}>
                      {a.candidate_email} &bull; {a.exam_title}
                    </div>
                  </div>
                  <div className="btn-group">
                    {a.require_live_webcam && <span className="badge badge-blue">Webcam Required</span>}
                    <span className="badge badge-slate">Choice: {a.webcam_consent_choice}</span>
                  </div>
                </div>

                <LiveWebcamMonitor
                  attemptId={a.id}
                  canControl={canControl}
                  csrfToken={csrfToken}
                  initialActive={a.live_webcam_active || a.require_live_webcam}
                  notify={notify}
                  onStatusChange={onRefresh}
                />

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="muted" style={{ fontSize: "0.82rem" }}>
                    Signals: {a.signal_count} &bull; Started {formatDate(a.started_at)}
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => onInspect(a.id)}>
                    Inspect Attempt
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {scheduledLiveInvites.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Pending Candidates Requiring Live Webcam</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Exam</th>
                  <th>Status</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {scheduledLiveInvites.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.candidate_name}</strong>
                      <div className="muted">{i.candidate_email}</div>
                    </td>
                    <td>{i.exam_title}</td>
                    <td>
                      <span className="badge badge-amber">Waiting to start</span>
                    </td>
                    <td className="muted">{formatDate(i.expires_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function ResultsSection({ exams, attempts, onFilterExam, onInspect }) {
  const [examFilter, setExamFilter] = useState("");
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Candidate Results &amp; Session Review</h2>
        <select
          style={{ width: 240 }}
          value={examFilter}
          onChange={(e) => {
            setExamFilter(e.target.value);
            onFilterExam(e.target.value);
          }}
        >
          <option value="">All Exams</option>
          {exams.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.title}
            </option>
          ))}
        </select>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Exam</th>
              <th>Status</th>
              <th>Score</th>
              <th>Signals</th>
              <th>Submitted</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {attempts.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No candidate attempts recorded yet.
                </td>
              </tr>
            ) : (
              attempts.map((a) => {
                const statusCls =
                  a.status === "submitted" ? "badge-green" : a.status === "timed_out" ? "badge-amber" : "badge-blue";
                return (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.candidate_name}</strong>
                      <div className="muted">{a.candidate_email}</div>
                    </td>
                    <td>{a.exam_title}</td>
                    <td>
                      <span className={`badge ${statusCls}`}>{a.status}</span>{" "}
                      {a.live_webcam_active && <span className="badge badge-green">Live Cam</span>}{" "}
                      {!a.live_webcam_active && a.require_live_webcam && a.status === "in_progress" && (
                        <span className="badge badge-blue">Webcam Req</span>
                      )}{" "}
                      {a.submit_reason && !["", "manual"].includes(a.submit_reason) && (
                        <span className="badge badge-amber">{a.submit_reason.replace("_", " ")}</span>
                      )}
                    </td>
                    <td>
                      {a.score_percent !== null ? (
                        <>
                          <strong>{a.score_percent}%</strong> ({a.score_earned}/{a.score_possible}){" "}
                          <span className={`badge ${a.passed ? "badge-green" : "badge-red"}`}>
                            {a.passed ? "Pass" : "Below pass"}
                          </span>
                        </>
                      ) : (
                        <span className="muted">In progress</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${a.signal_count > 0 ? "badge-amber" : "badge-slate"}`}>
                        {a.signal_count} signal{a.signal_count === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td className="muted">{formatDate(a.submitted_at || a.started_at)}</td>
                    <td>
                      <div className="btn-group">
                        {a.status === "in_progress" && !a.is_anonymized && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => onInspect(a.id, true)}
                          >
                            Live Preview
                          </button>
                        )}
                        <button type="button" className="btn btn-sm" onClick={() => onInspect(a.id, false)}>
                          Review
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AttemptReviewModal({ attemptId, autoStartLive = false, user, csrfToken, onClose, onChanged, notify }) {
  const [detail, setDetail] = useState(null);
  const [notes, setNotes] = useState("");
  const [extMins, setExtMins] = useState(10);
  const [extReason, setExtReason] = useState("");

  const load = useCallback(async () => {
    const data = await apiFetch(`/api/attempts/${attemptId}`);
    setDetail(data);
    setNotes(data.attempt.reviewer_notes || "");
  }, [attemptId]);

  useEffect(() => {
    load().catch((e) => {
      notify(e.message, "danger");
      onClose();
    });
  }, [load, notify, onClose]);

  if (!detail) return null;
  const a = detail.attempt;
  const canSupport = user.role === "admin" || user.role === "interviewer";
  const canExtend =
    canSupport &&
    !a.is_anonymized &&
    (a.status === "in_progress" || a.status === "timed_out" || (a.status === "submitted" && !["", "manual"].includes(a.submit_reason)));
  const canLiveMonitor = a.status === "in_progress" && !a.is_anonymized && (canSupport || a.live_webcam_active);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="attemptModalTitle">
      <div className="modal-panel">
        <div className="card-header">
          <h2 id="attemptModalTitle" className="card-title">
            Attempt Review
          </h2>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="alert alert-info">{detail.integrity_notice}</div>

        {canLiveMonitor && (
          <LiveWebcamMonitor
            attemptId={a.id}
            canControl={canSupport}
            csrfToken={csrfToken}
            initialActive={a.live_webcam_active}
            autoStart={autoStartLive}
            notify={notify}
            onStatusChange={onChanged}
          />
        )}

        <div className="grid-2">
          <div>
            <div>
              <strong>Candidate:</strong> {a.candidate_name} ({a.candidate_email})
            </div>
            <div>
              <strong>Exam:</strong> {a.exam_title}
            </div>
            <div>
              <strong>Status:</strong> <span className="badge badge-blue">{a.status}</span>{" "}
              {a.submit_reason && <span className="badge badge-slate">{a.submit_reason}</span>}
            </div>
            <div>
              <strong>Webcam Choice:</strong> {a.webcam_consent_choice}
            </div>
          </div>
          <div>
            <div>
              <strong>Score:</strong>{" "}
              {a.score_percent !== null ? `${a.score_percent}% (${a.score_earned}/${a.score_possible})` : "In progress"}
            </div>
            <div>
              <strong>Started:</strong> {formatDate(a.started_at)}
            </div>
            <div>
              <strong>Submitted:</strong> {formatDate(a.submitted_at)}
            </div>
          </div>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "14px 0" }} />

        <h3 style={{ margin: "0 0 8px 0", fontSize: "1rem" }}>Session Event Signals</h3>
        <div className="btn-group" style={{ marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
          <span className="badge badge-slate">Tab Hidden: {detail.signal_summary.tab_hidden}</span>
          <span className="badge badge-slate">Window Blur: {detail.signal_summary.window_blur}</span>
          <span className="badge badge-slate">Fullscreen Exits: {detail.signal_summary.fullscreen_exited}</span>
          <span className="badge badge-slate">Copy/Paste Blocked: {detail.signal_summary.copy_paste_blocked || 0}</span>
          <span className="badge badge-slate">Network Interruptions: {detail.signal_summary.network_interruptions}</span>
          {typeof detail.signal_summary.face_absent === "number" && (
            <span className={`badge ${detail.signal_summary.face_absent > 0 ? "badge-amber" : "badge-slate"}`}>
              Face Absent: {detail.signal_summary.face_absent}
            </span>
          )}
          {typeof detail.signal_summary.multiple_faces === "number" && (
            <span className={`badge ${detail.signal_summary.multiple_faces > 0 ? "badge-red" : "badge-slate"}`}>
              Multiple Faces: {detail.signal_summary.multiple_faces}
            </span>
          )}
          {typeof detail.signal_summary.gaze_deviation === "number" && (
            <span className={`badge ${detail.signal_summary.gaze_deviation > 0 ? "badge-amber" : "badge-slate"}`}>
              Gaze Deviations: {detail.signal_summary.gaze_deviation}
            </span>
          )}
        </div>

        <div
          style={{
            maxHeight: 150,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 7,
            padding: 8,
            marginBottom: 14,
            fontSize: "0.84rem",
          }}
        >
          {detail.events.length === 0 ? (
            <span className="muted">No session events recorded.</span>
          ) : (
            detail.events.map((ev) => (
              <div key={ev.id}>
                <span className="mono">{formatDate(ev.server_received_at)}</span> — <strong>{ev.event_type}</strong>{" "}
                <span className="muted">{JSON.stringify(ev.detail)}</span>
              </div>
            ))
          )}
        </div>

        <h3 style={{ margin: "0 0 8px 0", fontSize: "1rem" }}>Question Responses</h3>
        {detail.questions.map((q, i) => (
          <div key={q.question_id} style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 10, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>
                Q{i + 1}. {q.prompt}
              </strong>
              {q.points_awarded !== undefined && (
                <span className={`badge ${q.is_correct ? "badge-green" : "badge-red"}`}>
                  {q.points_awarded}/{q.points_possible} pts
                </span>
              )}
            </div>
            <ul style={{ margin: "6px 0 0 0", paddingLeft: 18, fontSize: "0.88rem" }}>
              {q.options.map((o) => {
                const chosen = o.id === q.selected_option_id;
                return (
                  <li
                    key={o.id}
                    style={{
                      color: o.is_correct ? "var(--success)" : undefined,
                      fontWeight: o.is_correct ? 700 : 400,
                    }}
                  >
                    {o.text} {chosen && <strong>[Candidate Selected]</strong>} {o.is_correct && "[Correct]"}
                  </li>
                );
              })}
            </ul>
            {q.explanation && (
              <div className="muted" style={{ marginTop: 6 }}>
                Explanation: {q.explanation}
              </div>
            )}
          </div>
        ))}

        <div className="form-row" style={{ marginTop: 14 }}>
          <label htmlFor="revNotes">Reviewer Notes</label>
          <textarea id="revNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ marginTop: 6 }}
            onClick={async () => {
              await apiFetch(`/api/attempts/${a.id}/notes`, {
                method: "PUT",
                csrfToken,
                body: { notes },
              });
              notify("Reviewer notes saved.", "success");
            }}
          >
            Save Notes
          </button>
        </div>

        {canExtend && (
          <div className="card" style={{ background: "var(--surface-muted)", marginTop: 12, padding: 12 }}>
            <strong>Support Tool — Interrupted / Reopened Attempt</strong>
            <div className="grid-2" style={{ marginTop: 8 }}>
              <input
                type="number"
                min={1}
                max={180}
                value={extMins}
                onChange={(e) => setExtMins(e.target.value)}
                placeholder="Extra minutes"
              />
              <input
                type="text"
                value={extReason}
                onChange={(e) => setExtReason(e.target.value)}
                placeholder="Reason (e.g. ISP outage)"
              />
            </div>
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 8 }}
              onClick={async () => {
                try {
                  await apiFetch(`/api/attempts/${a.id}/extend-time`, {
                    method: "POST",
                    csrfToken,
                    body: { extra_minutes: Number(extMins), reason: extReason },
                  });
                  notify("Attempt time extended.", "success");
                  await load();
                  await onChanged();
                } catch (err) {
                  alert(err.message);
                }
              }}
            >
              Grant Extra Time &amp; Reopen
            </button>
          </div>
        )}

        {user.role === "admin" && !a.is_anonymized && (
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                if (!confirm("Anonymize candidate PII and delete session events for this attempt?")) return;
                await apiFetch(`/api/attempts/${a.id}/anonymize`, { method: "POST", csrfToken, body: {} });
                await onChanged();
                onClose();
              }}
            >
              Delete / Anonymize Candidate PII
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SecuritySection({ user, csrfToken, members, auditLogs, onRefresh, notify }) {
  const [mfaSecret, setMfaSecret] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [disablePw, setDisablePw] = useState("");

  const [orgName, setOrgName] = useState(user.organization_name);
  const [retDays, setRetDays] = useState(user.retention_days);

  const [staffName, setStaffName] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffRole, setStaffRole] = useState("interviewer");
  const [staffInviteToken, setStaffInviteToken] = useState("");

  useEffect(() => {
    setOrgName(user.organization_name);
    setRetDays(user.retention_days);
  }, [user]);

  return (
    <>
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Multi-Factor Authentication (Your Account)</h2>
            <span className={`badge ${user.mfa_enabled ? "badge-green" : "badge-amber"}`}>
              {user.mfa_enabled ? "Enabled" : "Not Enabled"}
            </span>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Protect your staff account with a time-based 6-digit authenticator code (TOTP).
          </p>
          {user.mfa_enabled ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await apiFetch("/api/auth/mfa/disable", {
                    method: "POST",
                    csrfToken,
                    body: { password: disablePw },
                  });
                  setDisablePw("");
                  notify("MFA disabled.", "info");
                  onRefresh();
                } catch (err) {
                  notify(err.message, "danger");
                }
              }}
            >
              <div className="form-row">
                <label htmlFor="disMfa">Enter current password to disable MFA</label>
                <input
                  id="disMfa"
                  type="password"
                  value={disablePw}
                  onChange={(e) => setDisablePw(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="btn btn-danger btn-sm">
                Disable MFA
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  const res = await apiFetch("/api/auth/mfa/setup", { method: "POST", csrfToken, body: {} });
                  setMfaSecret(res.secret);
                }}
              >
                Set Up Authenticator MFA
              </button>
              {mfaSecret && (
                <div style={{ marginTop: 12 }}>
                  <div className="alert alert-info">
                    Add this secret key to your authenticator app: <strong className="mono">{mfaSecret}</strong>
                  </div>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await apiFetch("/api/auth/mfa/enable", {
                          method: "POST",
                          csrfToken,
                          body: { code: mfaCode },
                        });
                        setMfaSecret("");
                        setMfaCode("");
                        notify("MFA enabled for your account.", "success");
                        onRefresh();
                      } catch (err) {
                        notify(err.message, "danger");
                      }
                    }}
                  >
                    <div className="form-row">
                      <label htmlFor="enMfa">Enter 6-digit verification code</label>
                      <input
                        id="enMfa"
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={mfaCode}
                        onChange={(e) => setMfaCode(e.target.value)}
                        required
                      />
                    </div>
                    <button type="submit" className="btn btn-primary btn-sm">
                      Verify &amp; Enable MFA
                    </button>
                  </form>
                </div>
              )}
            </>
          )}
        </div>

        {user.role === "admin" && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Organization &amp; Data Retention</h2>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await apiFetch("/api/org/settings", {
                    method: "PATCH",
                    csrfToken,
                    body: { name: orgName, retention_days: Number(retDays) },
                  });
                  notify("Organization settings updated.", "success");
                  onRefresh();
                } catch (err) {
                  notify(err.message, "danger");
                }
              }}
            >
              <div className="form-row">
                <label htmlFor="orgN">Organization Name</label>
                <input id="orgN" type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
              </div>
              <div className="form-row">
                <label htmlFor="orgRet">Candidate Data Retention Period (days)</label>
                <input
                  id="orgRet"
                  type="number"
                  min={1}
                  max={3650}
                  value={retDays}
                  onChange={(e) => setRetDays(e.target.value)}
                  required
                />
              </div>
              <div className="btn-group">
                <button type="submit" className="btn btn-primary">
                  Save Settings
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={async () => {
                    if (!confirm("Anonymize all attempts older than the configured retention period?")) return;
                    const res = await apiFetch("/api/org/retention/purge", {
                      method: "POST",
                      csrfToken,
                      body: {},
                    });
                    notify(`Purge complete: ${res.anonymized_count} record(s) anonymized.`, "info");
                    onRefresh();
                  }}
                >
                  Purge Expired Records Now
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {user.role === "admin" && (
        <>
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Team Members &amp; Role Management</h2>
            </div>
            <form
              className="grid-4"
              style={{ alignItems: "end", marginBottom: 14 }}
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const res = await apiFetch("/api/org/staff-invites", {
                    method: "POST",
                    csrfToken,
                    body: { full_name: staffName, email: staffEmail, role: staffRole },
                  });
                  setStaffInviteToken(res.invite_token);
                  setStaffName("");
                  setStaffEmail("");
                  onRefresh();
                } catch (err) {
                  notify(err.message, "danger");
                }
              }}
            >
              <div>
                <label htmlFor="stName">Full Name</label>
                <input id="stName" type="text" value={staffName} onChange={(e) => setStaffName(e.target.value)} required />
              </div>
              <div>
                <label htmlFor="stEmail">Email</label>
                <input
                  id="stEmail"
                  type="email"
                  value={staffEmail}
                  onChange={(e) => setStaffEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="stRole">Role</label>
                <select id="stRole" value={staffRole} onChange={(e) => setStaffRole(e.target.value)}>
                  <option value="interviewer">Interviewer</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                  Invite Staff
                </button>
              </div>
            </form>

            {staffInviteToken && (
              <div className="alert alert-success">
                <strong>Staff Invite Token:</strong> <span className="mono">{staffInviteToken}</span>
              </div>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>MFA</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>{m.full_name}</td>
                      <td>{m.email}</td>
                      <td>
                        <select
                          value={m.role}
                          onChange={async (e) => {
                            try {
                              await apiFetch(`/api/org/members/${m.id}`, {
                                method: "PATCH",
                                csrfToken,
                                body: { role: e.target.value },
                              });
                              onRefresh();
                            } catch (err) {
                              notify(err.message, "danger");
                              onRefresh();
                            }
                          }}
                        >
                          <option value="admin">Admin</option>
                          <option value="interviewer">Interviewer</option>
                          <option value="reviewer">Reviewer</option>
                        </select>
                      </td>
                      <td>
                        <span className={`badge ${m.mfa_enabled ? "badge-green" : "badge-slate"}`}>
                          {m.mfa_enabled ? "Enabled" : "Off"}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${m.is_active ? "badge-green" : "badge-red"}`}>
                          {m.is_active ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td>
                        {m.id === user.id ? (
                          <span className="muted">You</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              await apiFetch(`/api/org/members/${m.id}`, {
                                method: "PATCH",
                                csrfToken,
                                body: { is_active: !m.is_active },
                              });
                              onRefresh();
                            }}
                          >
                            {m.is_active ? "Disable" : "Enable"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Security Audit Log</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((l) => (
                    <tr key={l.id}>
                      <td className="muted">{formatDate(l.created_at)}</td>
                      <td>{l.actor_email}</td>
                      <td className="mono">{l.action}</td>
                      <td className="mono">
                        {l.target_type} {l.target_id}
                      </td>
                      <td className="mono muted">{JSON.stringify(l.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

