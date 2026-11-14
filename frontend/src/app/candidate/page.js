"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch, getApiBase, getWebSocketUrl, postCandidateLiveFrame } from "../../lib/api";
import { FaceTracker } from "../../lib/face-tracker";

async function requestCameraStream(constraints) {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new Error("Browser environment not available.");
  }
  if (!window.isSecureContext) {
    throw new Error(
      "HTTPS_REQUIRED: Mobile and LAN browsers block camera access on plain http:// addresses. Open this link over https:// (port 3443 locally, or on a deployed HTTPS URL)."
    );
  }
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacyGetUserMedia =
    navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
  if (typeof legacyGetUserMedia === "function") {
    return new Promise((resolve, reject) => {
      legacyGetUserMedia.call(navigator, constraints, resolve, reject);
    });
  }
  throw new Error("Camera API is not supported by this mobile browser. Try Chrome or Safari.");
}
function formatTimer(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(rem)}` : `${pad(mins)}:${pad(rem)}`;
}

export default function CandidatePage() {
  return (
    <Suspense
      fallback={
        <main className="narrow-container">
          <div className="card muted">Loading assessment...</div>
        </main>
      }
    >
      <CandidateExamRunner />
    </Suspense>
  );
}

function CandidateExamRunner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const draftKey = `veritas_draft_${token.slice(0, 16)}`;

  const [step, setStep] = useState("loading"); // loading | error | onboarding | device | exam | completed
  const [errorMsg, setErrorMsg] = useState("");
  const [session, setSession] = useState(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [webcamChoice, setWebcamChoice] = useState("not_required");

  const [deviceCheck, setDeviceCheck] = useState(null);
  const [mediaStatus, setMediaStatus] = useState("");
  const [startingExam, setStartingExam] = useState(false);

  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [autosaveState, setAutosaveState] = useState({ text: "Saved", cls: "badge-slate" });
  const [isOffline, setIsOffline] = useState(false);
  const [fsExitBanner, setFsExitBanner] = useState(false);
  const [lockNotice, setLockNotice] = useState("");
  const [completedInfo, setCompletedInfo] = useState(null);
  const [liveStreamingActive, setLiveStreamingActive] = useState(false);
  const [liveCamError, setLiveCamError] = useState("");

  const pendingRef = useRef({});
  const flushInFlightRef = useRef(false);
  const mediaStreamRef = useRef(null);
  const videoRef = useRef(null);
  const liveVideoRef = useRef(null);
  const autoSubmittingRef = useRef(false);
  const enteredFsRef = useRef(false);
  const armedAtRef = useRef(0);
  const sessionStatusRef = useRef("");
  const examConfigRef = useRef({});
  const lockTimerRef = useRef(null);
  const lastLockEvtRef = useRef(0);
  // Live webcam streaming refs
  const liveWsRef = useRef(null);
  const liveTimerRef = useRef(null);
  const liveStreamObjRef = useRef(null);
  const liveTokenRef = useRef(null);
  const faceTrackerRef = useRef(null);
  const [faceStatus, setFaceStatus] = useState({ status: "idle", message: "" });

  const stopMedia = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  // Stop live webcam relay (frame timer + WebSocket + live camera stream)
  const stopLiveStream = useCallback(() => {
    if (liveTimerRef.current) {
      clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    try {
      liveWsRef.current?.close();
    } catch {}
    liveWsRef.current = null;
    if (liveStreamObjRef.current) {
      liveStreamObjRef.current.getTracks().forEach((t) => t.stop());
      liveStreamObjRef.current = null;
    }
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = null;
    }
    if (faceTrackerRef.current) {
      faceTrackerRef.current.stop();
      faceTrackerRef.current = null;
    }
    setFaceStatus({ status: "idle", message: "" });
    liveTokenRef.current = null;
    setLiveStreamingActive(false);
    setLiveCamError("");
  }, []);

  const enterCompleted = useCallback(
    (attempt) => {
      sessionStatusRef.current = attempt.status || "submitted";
      stopMedia();
      stopLiveStream();
      if (typeof document !== "undefined" && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      setCompletedInfo(attempt);
      setStep("completed");
    },
    [stopMedia, stopLiveStream]
  );

  const enterActiveExam = useCallback(
    (data) => {
      stopMedia();
      setSession(data);
      examConfigRef.current = data.exam;
      sessionStatusRef.current = data.attempt.status;
      autoSubmittingRef.current = false;
      enteredFsRef.current = typeof document !== "undefined" && Boolean(document.fullscreenElement);
      armedAtRef.current = Date.now() + 800;

      const qs = data.questions || [];
      setQuestions(qs);
      setRemainingSeconds(data.attempt.remaining_seconds || 0);

      const initialAnswers = {};
      qs.forEach((q) => {
        if (q.selected_option_id) initialAnswers[q.question_id] = q.selected_option_id;
      });
      try {
        const cached = JSON.parse(localStorage.getItem(draftKey) || "{}");
        Object.entries(cached).forEach(([qid, oid]) => {
          if (initialAnswers[qid] !== oid) {
            initialAnswers[qid] = oid;
            pendingRef.current[qid] = oid;
          }
        });
      } catch {
        // ignore storage errors
      }
      setAnswers(initialAnswers);
      setStep("exam");
    },
    [draftKey, stopMedia]
  );

  const loadSession = useCallback(async () => {
    if (!token) {
      setErrorMsg("No exam invitation token found in the URL. Please use the exact link sent by your interviewer.");
      setStep("error");
      return;
    }
    try {
      const data = await apiFetch("/api/candidate/session", { candidateToken: token });
      setSession(data);
      examConfigRef.current = data.exam;
      sessionStatusRef.current = data.attempt.status;

      if (data.attempt.status === "not_started") {
        setWebcamChoice(
          data.exam.require_webcam_check || data.exam.require_live_webcam
            ? "consented"
            : data.invitation.webcam_waived
            ? "waived"
            : "not_required"
        );
        setStep("onboarding");
      } else if (data.attempt.status === "in_progress") {
        if (data.attempt.webcam_consent_choice) {
          setWebcamChoice(data.attempt.webcam_consent_choice);
        }
        enterActiveExam(data);
      } else {
        enterCompleted(data.attempt);
      }
    } catch (err) {
      setErrorMsg(err.message);
      setStep("error");
    }
  }, [token, enterActiveExam, enterCompleted]);

  useEffect(() => {
    loadSession();
    return () => {
      stopMedia();
      stopLiveStream();
    };
  }, [loadSession, stopMedia, stopLiveStream]);

  const flushPendingAnswers = useCallback(async () => {
    const keys = Object.keys(pendingRef.current);
    if (flushInFlightRef.current || keys.length === 0) return;
    flushInFlightRef.current = true;
    const batch = { ...pendingRef.current };
    setAutosaveState({ text: "Saving...", cls: "badge-blue" });

    try {
      const res = await apiFetch("/api/candidate/save", {
        method: "POST",
        candidateToken: token,
        body: { answers: batch },
      });
      Object.keys(batch).forEach((qid) => {
        if (pendingRef.current[qid] === batch[qid]) {
          delete pendingRef.current[qid];
        }
      });
      if (typeof res.remaining_seconds === "number") {
        setRemainingSeconds(res.remaining_seconds);
      }
      setAutosaveState({ text: "Saved", cls: "badge-green" });
    } catch (err) {
      if (err.code === "timed_out" || err.code === "already_submitted") {
        loadSession();
      } else {
        setAutosaveState({ text: "Offline — queued", cls: "badge-amber" });
      }
    } finally {
      flushInFlightRef.current = false;
      if (Object.keys(pendingRef.current).length > 0 && navigator.onLine) {
        setTimeout(() => flushPendingAnswers(), 1200);
      }
    }
  }, [token, loadSession]);

  const sendEvent = useCallback(
    (eventType, detail = {}) => {
      if (sessionStatusRef.current !== "in_progress") return;
      apiFetch("/api/candidate/events", {
        method: "POST",
        candidateToken: token,
        body: {
          events: [{ event_type: eventType, detail, occurred_at: Math.floor(Date.now() / 1000) }],
        },
      })
        .then((res) => {
          if (res?.auto_submitted) {
            try {
              localStorage.removeItem(draftKey);
            } catch {}
            enterCompleted({
              status: res.status || "submitted",
              submit_reason: res.submit_reason || "",
              submitted_at: new Date().toISOString(),
            });
          }
        })
        .catch(() => {});
    },
    [token, draftKey, enterCompleted]
  );

  const triggerAutoSubmit = useCallback(
    async (reason) => {
      if (autoSubmittingRef.current || sessionStatusRef.current !== "in_progress") return;
      autoSubmittingRef.current = true;
      sessionStatusRef.current = "submitted";

      try {
        const res = await apiFetch("/api/candidate/submit", {
          method: "POST",
          candidateToken: token,
          keepalive: true,
          body: { answers: pendingRef.current, reason },
        });
        try {
          localStorage.removeItem(draftKey);
        } catch {}
        enterCompleted(res);
      } catch {
        enterCompleted({
          status: "submitted",
          submit_reason: reason,
          submitted_at: new Date().toISOString(),
        });
      }
    },
    [token, draftKey, enterCompleted]
  );

  // Flush any restored localStorage drafts on entering exam
  useEffect(() => {
    if (step === "exam" && Object.keys(pendingRef.current).length > 0) {
      flushPendingAnswers();
    }
  }, [step, flushPendingAnswers]);

  // Live webcam streaming: poll for relay token and stream JPEG frames over WS (+ HTTP fallback).
  useEffect(() => {
    if (step !== "exam") return undefined;

    let cancelled = false;
    let pollId = null;

    async function startStreaming(relayToken) {
      if (liveTokenRef.current === relayToken && liveTimerRef.current) return;
      stopLiveStream();
      liveTokenRef.current = relayToken;

      let stream;
      try {
        try {
          stream = await requestCameraStream({
            video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 10 } },
            audio: false,
          });
        } catch (firstErr) {
          if (String(firstErr?.message || "").startsWith("HTTPS_REQUIRED")) throw firstErr;
          stream = await requestCameraStream({ video: true, audio: false });
        }
      } catch (err) {
        const cleanMsg = String(err?.message || "Camera permission needed for live monitoring.").replace(
          /^HTTPS_REQUIRED:\s*/,
          ""
        );
        setLiveCamError(cleanMsg);
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      liveStreamObjRef.current = stream;
      setLiveCamError("");
      setLiveStreamingActive(true);

      const hiddenVideo = document.createElement("video");
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.setAttribute("playsinline", "true");
      hiddenVideo.srcObject = stream;
      await hiddenVideo.play().catch(() => {});

      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");

      const shouldUseHttpOnly = window.location.protocol === "https:" && !getApiBase();
      let ws = null;
      if (!shouldUseHttpOnly) {
        const wsUrl = getWebSocketUrl(`/live-webcam?token=${encodeURIComponent(relayToken)}&role=candidate`);
        try {
          ws = new WebSocket(wsUrl);
          ws.binaryType = "arraybuffer";
          liveWsRef.current = ws;
          ws.onerror = () => {};
        } catch {
          ws = null;
        }
      }

      let lastHttpSend = 0;
      let sending = false;
      liveTimerRef.current = setInterval(() => {
        if (cancelled || sending || hiddenVideo.readyState < 2 || !ctx) return;
        sending = true;
        try {
          ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            async (blob) => {
              try {
                if (!blob || cancelled) return;
                const activeWs = liveWsRef.current;
                if (activeWs && activeWs.readyState === WebSocket.OPEN) {
                  const buf = await blob.arrayBuffer();
                  activeWs.send(buf);
                } else {
                  const now = Date.now();
                  if (now - lastHttpSend >= 450) {
                    lastHttpSend = now;
                    await postCandidateLiveFrame(token, blob).catch(() => {});
                  }
                }
              } finally {
                sending = false;
              }
            },
            "image/jpeg",
            0.65
          );
        } catch {
          sending = false;
        }
      }, 220);
    }

    async function pollForToken() {
      if (cancelled) return;
      try {
        const res = await apiFetch("/api/candidate/live-webcam/token", { candidateToken: token });
        if (res.token) {
          if (liveTokenRef.current !== res.token || !liveTimerRef.current) {
            await startStreaming(res.token);
          }
        } else if (liveTokenRef.current || liveTimerRef.current) {
          stopLiveStream();
        }
      } catch {
        // ignore transient network errors during exam
      }
      if (!cancelled) {
        pollId = setTimeout(pollForToken, 4000);
      }
    }

    pollId = setTimeout(pollForToken, 400);

    return () => {
      cancelled = true;
      clearTimeout(pollId);
      stopLiveStream();
    };
  }, [step, token, stopLiveStream]);

  // Keep candidate's small self-view video synced when stream starts
  useEffect(() => {
    if (liveStreamingActive && liveVideoRef.current && liveStreamObjRef.current) {
      liveVideoRef.current.srcObject = liveStreamObjRef.current;
    }
  }, [liveStreamingActive]);

  // AI Face tracking proctoring loop
  useEffect(() => {
    if (liveStreamingActive && liveVideoRef.current && step === "exam") {
      if (!faceTrackerRef.current) {
        const tracker = new FaceTracker({
          onStatus: (st) => setFaceStatus(st),
          onEvents: async ({ events, signals }) => {
            try {
              await apiFetch("/api/candidate/face-events", {
                method: "POST",
                candidateToken: token,
                body: { events, signals },
              });
            } catch {
              // Silently ignore reporting hiccups to prevent disrupting candidate
            }
          },
        });
        faceTrackerRef.current = tracker;
        tracker.init(liveVideoRef.current);
      }
    } else if (!liveStreamingActive && faceTrackerRef.current) {
      faceTrackerRef.current.stop();
      faceTrackerRef.current = null;
      setFaceStatus({ status: "idle", message: "" });
    }
  }, [liveStreamingActive, step, token]);

  // Timer + heartbeat loop during active exam
  useEffect(() => {
    if (step !== "exam") return undefined;

    const timerId = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timerId);
          triggerAutoSubmit("timeout");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    const hbId = setInterval(async () => {
      if (!navigator.onLine || sessionStatusRef.current !== "in_progress") return;
      try {
        const res = await apiFetch("/api/candidate/events", {
          method: "POST",
          candidateToken: token,
          body: { events: [{ event_type: "heartbeat", occurred_at: Math.floor(Date.now() / 1000) }] },
        });
        if (typeof res.remaining_seconds === "number") {
          setRemainingSeconds(res.remaining_seconds);
        }
        if (res.status && res.status !== "in_progress") {
          loadSession();
        }
      } catch {
        // ignore transient network errors
      }
    }, 20000);

    return () => {
      clearInterval(timerId);
      clearInterval(hbId);
    };
  }, [step, token, triggerAutoSubmit, loadSession]);

  // Lockdown & Integrity Event Listeners while exam is active
  useEffect(() => {
    if (step !== "exam") return undefined;

    function showLockToast(msg) {
      setLockNotice(msg);
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = setTimeout(() => setLockNotice(""), 3000);
      const now = Date.now();
      if (now - lastLockEvtRef.current > 3000) {
        lastLockEvtRef.current = now;
        sendEvent("copy_paste_blocked", { action: msg });
      }
    }

    function isClipboardLocked() {
      return sessionStatusRef.current === "in_progress" && Boolean(examConfigRef.current?.lock_copy_paste);
    }

    const onBlockedClipboard = (e) => {
      if (!isClipboardLocked()) return;
      e.preventDefault();
      e.stopPropagation();
      showLockToast("Copy, cut, paste, text selection, and right-click are disabled during the exam.");
    };

    const onKeyDown = (e) => {
      if (!isClipboardLocked()) return;
      const key = (e.key || "").toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const blockedMod = ["c", "v", "x", "a", "u", "s", "p"];
      const blockedDev = key === "f12" || (mod && e.shiftKey && ["i", "j", "c"].includes(key));
      if ((mod && blockedMod.includes(key)) || blockedDev) {
        e.preventDefault();
        e.stopPropagation();
        showLockToast("Clipboard and developer shortcuts are disabled during the exam.");
      }
    };

    const onVisibility = () => {
      if (sessionStatusRef.current !== "in_progress") return;
      if (document.hidden) {
        if (examConfigRef.current?.auto_submit_on_violation && Date.now() >= armedAtRef.current) {
          triggerAutoSubmit("tab_switched");
        } else {
          sendEvent("tab_hidden");
        }
      } else {
        sendEvent("tab_visible");
      }
    };

    const onBlur = () => sendEvent("window_blur");
    const onFocus = () => sendEvent("window_focus");

    const onFullscreenChange = () => {
      if (sessionStatusRef.current !== "in_progress") return;
      const inFs = Boolean(document.fullscreenElement);
      if (inFs) {
        enteredFsRef.current = true;
        setFsExitBanner(false);
        sendEvent("fullscreen_entered");
        return;
      }
      if (enteredFsRef.current && examConfigRef.current?.auto_submit_on_violation && Date.now() >= armedAtRef.current) {
        triggerAutoSubmit("fullscreen_exited");
        return;
      }
      sendEvent("fullscreen_exited");
      if (examConfigRef.current?.require_fullscreen) {
        setFsExitBanner(true);
      }
    };

    const onOffline = () => {
      setIsOffline(true);
      setAutosaveState({ text: "Offline — queued", cls: "badge-amber" });
      sendEvent("offline");
    };

    const onOnline = () => {
      setIsOffline(false);
      sendEvent("reconnected");
      flushPendingAnswers();
    };

    const clipEvents = ["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart"];
    clipEvents.forEach((evt) => document.addEventListener(evt, onBlockedClipboard));
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      clipEvents.forEach((evt) => document.removeEventListener(evt, onBlockedClipboard));
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [step, sendEvent, triggerAutoSubmit, flushPendingAnswers]);

  async function runDeviceChecks() {
    const hasFetch = typeof window.fetch === "function";
    let hasStorage = false;
    try {
      localStorage.setItem("_ep_test", "1");
      localStorage.removeItem("_ep_test");
      hasStorage = true;
    } catch {
      hasStorage = false;
    }
    const hasVisibility = typeof document.visibilityState === "string";
    const hasFullscreen = Boolean(document.documentElement.requestFullscreen);

    let latencyMs = null;
    let netOk = false;
    try {
      const t0 = performance.now();
      await apiFetch("/api/health");
      latencyMs = Math.round(performance.now() - t0);
      netOk = true;
    } catch {
      netOk = false;
    }

    setDeviceCheck({
      fetch: hasFetch,
      local_storage: hasStorage,
      visibility_api: hasVisibility,
      fullscreen_api: hasFullscreen,
      network_ok: netOk,
      latency_ms: latencyMs,
      user_agent: navigator.userAgent.slice(0, 140),
    });
  }

  async function testCameraAndMic() {
    stopMedia();
    try {
      let stream;
      let audioOk = true;
      try {
        stream = await requestCameraStream({ video: { facingMode: "user" }, audio: true });
      } catch (firstErr) {
        const msg = String(firstErr?.message || "");
        if (msg.startsWith("HTTPS_REQUIRED")) throw firstErr;
        // Retry video-only (mobile devices or browsers without mic permission still allow camera preview)
        audioOk = false;
        stream = await requestCameraStream({ video: { facingMode: "user" }, audio: false });
      }
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setMediaStatus(
        audioOk
          ? "Camera and microphone permissions verified locally."
          : "Camera verified locally (microphone unavailable or not needed)."
      );
      setDeviceCheck((d) => ({ ...(d || {}), media_ok: true }));
    } catch (err) {
      const msg = String(err?.message || "Permission denied").replace(/^HTTPS_REQUIRED:\s*/, "");
      setMediaStatus(
        `${msg} ${session?.exam?.allow_non_webcam_alternative ? "You may return and select the non-webcam alternative." : ""}`.trim()
      );
      setDeviceCheck((d) => ({ ...(d || {}), media_ok: false }));
    }
  }

  function selectOption(questionId, optionId) {
    setAnswers((prev) => {
      const next = { ...prev };
      if (optionId === null) delete next[questionId];
      else next[questionId] = optionId;
      try {
        localStorage.setItem(draftKey, JSON.stringify(next));
      } catch {}
      return next;
    });
    pendingRef.current[questionId] = optionId;
    flushPendingAnswers();
  }

  async function submitManual() {
    const unanswered = questions.filter((q) => !answers[q.question_id]).length;
    const msg =
      unanswered > 0
        ? `You have ${unanswered} unanswered question(s). Submit your exam now?`
        : "Submit your exam now? You cannot change answers after submission.";
    if (!confirm(msg)) return;
    try {
      const res = await apiFetch("/api/candidate/submit", {
        method: "POST",
        candidateToken: token,
        body: { answers: pendingRef.current, reason: "manual" },
      });
      try {
        localStorage.removeItem(draftKey);
      } catch {}
      enterCompleted(res);
    } catch (err) {
      alert(err.message);
    }
  }

  const currentQ = questions[currentIndex];
  const answeredCount = questions.filter((q) => Boolean(answers[q.question_id])).length;
  const timerCls =
    remainingSeconds <= 60 ? "timer-pill critical" : remainingSeconds <= 300 ? "timer-pill warning" : "timer-pill";

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">V</span>
          <span>{session?.exam?.title || "Assessment Portal"}</span>
        </div>
        {step === "exam" && (
          <div className="topbar-right">
            <span className={`badge ${autosaveState.cls}`} aria-live="polite">
              {autosaveState.text}
            </span>
            <span className={timerCls} role="timer" aria-live="off">
              {formatTimer(remainingSeconds)}
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={submitManual}>
              Submit Exam
            </button>
          </div>
        )}
      </header>

      <main className="container">
        {step === "loading" && (
          <div className="narrow-container">
            <div className="card muted">Loading your assessment...</div>
          </div>
        )}

        {step === "error" && (
          <div className="narrow-container">
            <div className="card">
              <h1 style={{ marginTop: 0 }}>Unable to Open Assessment</h1>
              <p className="alert alert-danger">{errorMsg}</p>
            </div>
          </div>
        )}

        {step === "onboarding" && session && (
          <section className="narrow-container">
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="muted" style={{ fontWeight: 700 }}>
                    {session.exam.organization_name}
                  </div>
                  <h1 style={{ margin: "4px 0 0 0", fontSize: "1.45rem" }}>{session.exam.title}</h1>
                </div>
                <span className="badge badge-blue">
                  {session.exam.total_minutes} min{session.exam.total_minutes === 1 ? "" : "s"}
                </span>
              </div>
              <p className="muted">{session.exam.description || `Welcome, ${session.invitation.candidate_name}.`}</p>

              {(session.invitation.extra_time_minutes > 0 || session.invitation.webcam_waived) && (
                <div className="alert alert-info">
                  Accommodations applied:{" "}
                  {[
                    session.invitation.extra_time_minutes > 0
                      ? `+${session.invitation.extra_time_minutes} minutes extra time`
                      : null,
                    session.invitation.webcam_waived ? "webcam check waived" : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  .
                </div>
              )}

              {(session.exam.auto_submit_on_violation || session.exam.lock_copy_paste) && (
                <div className="alert alert-warning">
                  {session.exam.auto_submit_on_violation &&
                    "Exiting fullscreen or switching tabs will immediately auto-submit your exam. "}
                  {session.exam.lock_copy_paste &&
                    "Copy, cut, paste, text selection, and right-click are locked during the exam."}
                </div>
              )}

              <div className="card" style={{ background: "var(--surface-muted)", boxShadow: "none" }}>
                <h2 style={{ margin: "0 0 6px 0", fontSize: "1rem" }}>Allowed Materials</h2>
                <p style={{ margin: 0 }}>{session.exam.allowed_materials}</p>
              </div>

              <div className="card" style={{ background: "var(--surface-muted)", boxShadow: "none" }}>
                <h2 style={{ margin: "0 0 6px 0", fontSize: "1rem" }}>Exam Rules &amp; Integrity Notice</h2>
                <p style={{ margin: 0 }}>{session.exam.rules_text}</p>
              </div>

              <div className="card" style={{ background: "var(--surface-muted)", boxShadow: "none" }}>
                <h2 style={{ margin: "0 0 6px 0", fontSize: "1rem" }}>Privacy Notice</h2>
                <p style={{ margin: 0 }}>{session.exam.privacy_notice}</p>
              </div>

              {(session.exam.require_webcam_check || session.exam.require_live_webcam) && (
                <div className="card" style={{ borderColor: "#bfdbfe", background: "#eff6ff", boxShadow: "none" }}>
                  <h2 style={{ margin: "0 0 6px 0", fontSize: "1rem" }}>
                    {session.exam.require_live_webcam
                      ? "Live Webcam Monitoring Required"
                      : "Pre-Exam Camera & Microphone Check"}
                  </h2>
                  <p className="muted" style={{ marginTop: 0 }}>
                    {session.exam.require_live_webcam
                      ? "Authorized administrators will view a live webcam preview during this assessment. No video is recorded or stored on disk, and no automated facial scoring is performed."
                      : "Local device check before starting. No video or automated face/attention scoring is performed."}
                  </p>
                  <div className="checkbox-row">
                    <input
                      type="radio"
                      name="webcamChoice"
                      id="wcConsent"
                      checked={webcamChoice === "consented"}
                      onChange={() => setWebcamChoice("consented")}
                    />
                    <label htmlFor="wcConsent">
                      {session.exam.require_live_webcam
                        ? "I consent to camera access and live webcam preview monitoring during this exam."
                        : "I consent to the pre-exam camera and microphone permission check."}
                    </label>
                  </div>
                  {session.exam.allow_non_webcam_alternative && (
                    <div className="checkbox-row">
                      <input
                        type="radio"
                        name="webcamChoice"
                        id="wcAlt"
                        checked={webcamChoice === "alternative_requested"}
                        onChange={() => setWebcamChoice("alternative_requested")}
                      />
                      <label htmlFor="wcAlt">Request a non-webcam alternative (logged for interviewer review).</label>
                    </div>
                  )}
                </div>
              )}

              <div className="checkbox-row" style={{ marginTop: 14 }}>
                <input
                  id="consentCheckbox"
                  type="checkbox"
                  checked={consentAccepted}
                  onChange={(e) => setConsentAccepted(e.target.checked)}
                />
                <label htmlFor="consentCheckbox">
                  I have read and understood the exam rules, allowed materials, and privacy notice.
                </label>
              </div>

              <div className="btn-group" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!consentAccepted}
                  onClick={() => {
                    setStep("device");
                    runDeviceChecks();
                  }}
                >
                  Continue to Device Check
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "device" && session && (
          <section className="narrow-container">
            <div className="card">
              <div className="card-header">
                <h1 style={{ margin: 0, fontSize: "1.3rem" }}>Pre-Exam Device &amp; Connectivity Check</h1>
                <button type="button" className="btn btn-sm" onClick={runDeviceChecks}>
                  Re-run Checks
                </button>
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                Verify your browser and internet connection before your server-controlled timer begins.
              </p>

              {deviceCheck ? (
                <div style={{ marginBottom: 14 }}>
                  {[
                    [
                      "Browser Compatibility",
                      deviceCheck.fetch && deviceCheck.local_storage,
                      deviceCheck.visibility_api ? "Modern browser APIs available" : "Partial API support",
                    ],
                    [
                      "Server Connectivity",
                      deviceCheck.network_ok,
                      deviceCheck.network_ok ? `Connected (${deviceCheck.latency_ms} ms)` : "Check internet connection",
                    ],
                    [
                      "Fullscreen Support",
                      deviceCheck.fullscreen_api,
                      deviceCheck.fullscreen_api ? "Supported" : "Not available in this browser",
                    ],
                  ].map(([lbl, ok, det]) => (
                    <div
                      key={lbl}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "8px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span>
                        <strong>{lbl}</strong> <span className="muted">{det}</span>
                      </span>
                      <span className={`badge ${ok ? "badge-green" : "badge-amber"}`}>{ok ? "Ready" : "Limited"}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted" style={{ marginBottom: 14 }}>
                  Running diagnostics...
                </div>
              )}

              {webcamChoice === "consented" && (
                <div style={{ marginBottom: 14 }}>
                  {typeof window !== "undefined" && !window.isSecureContext && (
                    <div className="alert alert-warning" style={{ marginBottom: 10 }}>
                      Mobile browsers require <strong>https://</strong> to access the camera on a network IP. Open this
                      assessment over HTTPS (for example{" "}
                      <span className="mono">
                        https://{window.location.hostname}:3443{window.location.pathname}
                        {window.location.search}
                      </span>{" "}
                      during local testing, or your deployed HTTPS URL).
                    </div>
                  )}
                  <button type="button" className="btn btn-sm" onClick={testCameraAndMic}>
                    Test Camera &amp; Microphone
                  </button>
                  {mediaStatus && (
                    <div className="muted" style={{ marginTop: 6 }}>
                      {mediaStatus}
                    </div>
                  )}
                  <video
                    ref={videoRef}
                    className={`video-preview${mediaStreamRef.current ? "" : " hidden"}`}
                    style={{ display: mediaStreamRef.current ? "block" : "none", marginTop: 8 }}
                    autoPlay
                    muted
                    playsInline
                  />
                </div>
              )}

              {session.exam.require_fullscreen && (
                <div className="alert alert-warning">
                  {session.exam.auto_submit_on_violation
                    ? "This exam requires fullscreen mode. Exiting fullscreen or switching tabs during the exam will automatically submit your paper."
                    : "This exam requests fullscreen mode while active."}
                </div>
              )}

              <div className="btn-group">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    stopMedia();
                    setStep("onboarding");
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={startingExam}
                  onClick={async () => {
                    setStartingExam(true);
                    try {
                      if (session.exam.require_fullscreen && document.documentElement.requestFullscreen) {
                        await document.documentElement.requestFullscreen().catch(() => {});
                      }
                      const data = await apiFetch("/api/candidate/start", {
                        method: "POST",
                        candidateToken: token,
                        body: {
                          consent_accepted: true,
                          webcam_consent_choice: webcamChoice,
                          device_check: deviceCheck || {},
                        },
                      });
                      enterActiveExam(data);
                    } catch (err) {
                      alert(err.message);
                      setStartingExam(false);
                    }
                  }}
                >
                  Start Timed Exam
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "exam" && currentQ && (
          <section className={session?.exam?.lock_copy_paste ? "exam-locked" : undefined}>
            {fsExitBanner && (
              <div
                className="alert alert-warning"
                role="alert"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
              >
                <span>Fullscreen mode ended. This event has been logged for reviewer context.</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}
                >
                  Re-enter Fullscreen
                </button>
              </div>
            )}

            {lockNotice && (
              <div className="alert alert-warning" role="status">
                {lockNotice}
              </div>
            )}

            {isOffline && (
              <div className="alert alert-danger" role="alert">
                Network connection lost. Your answers are safely saved locally and will automatically sync when your
                connection returns.
              </div>
            )}

            <div className="exam-layout">
              <aside className="card" aria-label="Question navigator">
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Questions</div>
                <div className="muted" style={{ marginBottom: 10 }}>
                  {answeredCount} / {questions.length} answered
                </div>
                <div className="q-nav-grid">
                  {questions.map((q, idx) => {
                    const cls =
                      idx === currentIndex
                        ? "q-nav-btn current"
                        : answers[q.question_id]
                        ? "q-nav-btn answered"
                        : "q-nav-btn";
                    return (
                      <button
                        key={q.question_id}
                        type="button"
                        className={cls}
                        onClick={() => setCurrentIndex(idx)}
                      >
                        {idx + 1}
                      </button>
                    );
                  })}
                </div>
                <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "14px 0" }} />
                {(liveStreamingActive || liveCamError) && (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: 10,
                      borderRadius: 8,
                      border: "1px solid #bfdbfe",
                      background: "#eff6ff",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: "0.82rem", fontWeight: 700 }}>Webcam Monitor</span>
                      <span className={`badge ${liveStreamingActive ? "badge-green" : "badge-amber"}`}>
                        {liveStreamingActive ? "Live" : "Issue"}
                      </span>
                    </div>
                    {liveCamError && (
                      <div className="muted" style={{ fontSize: "0.78rem" }}>
                        {liveCamError}
                      </div>
                    )}
                    <video
                      ref={liveVideoRef}
                      autoPlay
                      muted
                      playsInline
                      style={{
                        display: liveStreamingActive ? "block" : "none",
                        width: "100%",
                        borderRadius: 6,
                        background: "#000",
                      }}
                    />
                    {faceStatus.status !== "idle" && (
                      <div
                        style={{
                          marginTop: 6,
                          padding: "4px 8px",
                          borderRadius: 6,
                          fontSize: "0.74rem",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          background:
                            faceStatus.status === "ok"
                              ? "#ecfdf5"
                              : faceStatus.status === "gaze"
                              ? "#fefce8"
                              : faceStatus.status === "loading"
                              ? "#f1f5f9"
                              : "#fef2f2",
                          color:
                            faceStatus.status === "ok"
                              ? "#065f46"
                              : faceStatus.status === "gaze"
                              ? "#854d0e"
                              : faceStatus.status === "loading"
                              ? "#475569"
                              : "#991b1b",
                          border: `1px solid ${
                            faceStatus.status === "ok"
                              ? "#a7f3d0"
                              : faceStatus.status === "gaze"
                              ? "#fde047"
                              : faceStatus.status === "loading"
                              ? "#cbd5e1"
                              : "#fecaca"
                          }`,
                        }}
                      >
                        <span>
                          {faceStatus.status === "ok"
                            ? "🟢"
                            : faceStatus.status === "gaze"
                            ? "🟡"
                            : faceStatus.status === "loading"
                            ? "⏳"
                            : "🔴"}
                        </span>
                        <span>{faceStatus.message}</span>
                      </div>
                    )}
                  </div>
                )}
                <button type="button" className="btn btn-primary" style={{ width: "100%" }} onClick={submitManual}>
                  Submit Exam
                </button>
              </aside>

              <div className="card" aria-live="polite">
                <div className="card-header">
                  <span className="badge badge-blue">
                    Question {currentIndex + 1} of {questions.length}
                  </span>
                  <span className="badge badge-slate">
                    {currentQ.points} pt{currentQ.points === 1 ? "" : "s"}
                  </span>
                </div>
                <h2 style={{ fontSize: "1.15rem", marginTop: 0 }}>{currentQ.prompt}</h2>
                <div role="radiogroup" aria-label={currentQ.prompt}>
                  {currentQ.options.map((opt, idx) => {
                    const chosen = answers[currentQ.question_id] === opt.id;
                    return (
                      <label key={opt.id} className={`option-card${chosen ? " selected" : ""}`}>
                        <input
                          type="radio"
                          name={`q_${currentQ.question_id}`}
                          checked={chosen}
                          onChange={() => selectOption(currentQ.question_id, opt.id)}
                        />
                        <span>
                          {String.fromCharCode(65 + idx)}. {opt.text}
                        </span>
                      </label>
                    );
                  })}
                </div>

                <div className="card-header" style={{ marginTop: 18, marginBottom: 0 }}>
                  <div className="btn-group">
                    <button
                      type="button"
                      className="btn"
                      disabled={currentIndex === 0}
                      onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={currentIndex >= questions.length - 1}
                      onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
                    >
                      Next
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => selectOption(currentQ.question_id, null)}
                  >
                    Clear Choice
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {step === "completed" && completedInfo && (
          <section className="narrow-container">
            <div className="card">
              <span className="badge badge-green" style={{ marginBottom: 8 }}>
                Assessment Recorded
              </span>
              <h1 style={{ margin: "4px 0 8px 0" }}>
                {completedInfo.status === "timed_out" || completedInfo.submit_reason === "timeout"
                  ? "Time Expired — Exam Auto-Submitted"
                  : completedInfo.submit_reason === "tab_switched"
                  ? "Tab Switch Detected — Exam Auto-Submitted"
                  : completedInfo.submit_reason === "fullscreen_exited"
                  ? "Fullscreen Exited — Exam Auto-Submitted"
                  : "Exam Submitted Successfully"}
              </h1>
              <p className="muted">
                {completedInfo.submit_reason === "tab_switched"
                  ? "Leaving or switching the exam tab triggered automatic submission. "
                  : completedInfo.submit_reason === "fullscreen_exited"
                  ? "Exiting fullscreen mode triggered automatic submission. "
                  : ""}
                {completedInfo.submitted_at
                  ? `Recorded at ${new Date(completedInfo.submitted_at).toLocaleString()}.`
                  : "Your attempt has been recorded."}
              </p>
              <div className="alert alert-info" style={{ marginBottom: 0 }}>
                Your responses have been securely saved on the server for authorized reviewers. You may now close this
                browser window.
              </div>
            </div>
          </section>
        )}
      </main>
    </>
  );
}

