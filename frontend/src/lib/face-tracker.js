/**
 * face-tracker.js
 * Browser-side face detection using @vladmandic/face-api (TensorFlow.js-based).
 * Accumulates face events and flushes them every FLUSH_INTERVAL_MS via onEvents callback.
 * Only face signals (counts/types) are sent — no raw video frames.
 */

const DETECTION_INTERVAL_MS = 600; // Run detection every 600ms
const FLUSH_INTERVAL_MS = 10000;   // Flush events to backend every 10s
const GAZE_CENTER_THRESHOLD = 0.28; // Fraction of face width for gaze deviation

let faceApiLoaded = false;
let faceapi = null;
let modelsLoaded = false;

async function loadFaceApi() {
  if (faceApiLoaded && faceapi) return faceapi;
  try {
    const mod = await import("@vladmandic/face-api");
    faceapi = mod.default || mod;
    faceApiLoaded = true;
    return faceapi;
  } catch (err) {
    console.error("[FaceTracker] Failed to load face-api:", err);
    return null;
  }
}

async function loadModels(fa) {
  if (modelsLoaded) return true;
  const MODEL_URL = "/models";
  try {
    await Promise.all([
      fa.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      fa.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
    ]);
    modelsLoaded = true;
    return true;
  } catch (err) {
    console.error("[FaceTracker] Failed to load models from /models:", err);
    return false;
  }
}

export class FaceTracker {
  constructor({ onEvents, onStatus } = {}) {
    this.onEvents = onEvents || (() => {});
    this.onStatus = onStatus || (() => {});
    this._detectionTimer = null;
    this._flushTimer = null;
    this._pendingEvents = [];
    this._videoEl = null;
    this._running = false;
    this._totalFrames = 0;
    this._windowCounts = { face_absent: 0, multiple_faces: 0, gaze_deviation: 0, face_detected: 0 };
    this._windowStart = Date.now();
    this._consecutiveAbsent = 0;
    this._consecutiveMultiple = 0;
  }

  async init(videoElement) {
    if (this._running) return;
    this._videoEl = videoElement;

    this.onStatus({ status: "loading", message: "Loading AI face tracker..." });

    const fa = await loadFaceApi();
    if (!fa) {
      this.onStatus({ status: "error", message: "Face tracking library failed to load." });
      return;
    }

    const ok = await loadModels(fa);
    if (!ok) {
      this.onStatus({ status: "error", message: "Face tracking AI models failed to load." });
      return;
    }

    this._running = true;
    this.onStatus({ status: "ok", message: "AI Proctoring Active" });

    this._detectionTimer = setInterval(() => this._detect(fa), DETECTION_INTERVAL_MS);
    this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
  }

  async _detect(fa) {
    if (!this._running || !this._videoEl) return;
    const video = this._videoEl;
    if (video.readyState < 2 || video.paused || video.ended) return;

    try {
      const detections = await fa.detectAllFaces(
        video,
        new fa.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.45 })
      ).withFaceLandmarks(true);

      this._totalFrames++;
      const now = new Date().toISOString();
      const faceCount = detections ? detections.length : 0;

      let eventType = "face_detected";

      if (faceCount === 0) {
        this._consecutiveAbsent++;
        this._consecutiveMultiple = 0;
        eventType = "face_absent";
        this.onStatus({ status: "absent", message: "Face not visible in camera" });
      } else if (faceCount > 1) {
        this._consecutiveMultiple++;
        this._consecutiveAbsent = 0;
        eventType = "multiple_faces";
        this.onStatus({ status: "multiple", message: `Warning: ${faceCount} faces detected!` });
      } else {
        this._consecutiveAbsent = 0;
        this._consecutiveMultiple = 0;
        // Check gaze deviation using nose landmark vs center of bounding box
        const landmarks = detections[0]?.landmarks;
        const box = detections[0]?.detection?.box;
        let isGazeDeviated = false;

        if (landmarks && box && box.width > 0) {
          const nose = landmarks.getNose();
          if (nose && nose.length > 0) {
            const noseTip = nose[nose.length - 1];
            const faceCenterX = box.x + box.width / 2;
            const deviationX = Math.abs(noseTip.x - faceCenterX) / box.width;
            if (deviationX > GAZE_CENTER_THRESHOLD) {
              isGazeDeviated = true;
            }
          }
        }

        if (isGazeDeviated) {
          eventType = "gaze_deviation";
          this.onStatus({ status: "gaze", message: "Please look directly at your screen" });
        } else {
          eventType = "face_detected";
          this.onStatus({ status: "ok", message: "Face Verified" });
        }
      }

      this._windowCounts[eventType] = (this._windowCounts[eventType] || 0) + 1;

      // Only queue alert events (absent, multiple, gaze) to avoid flooding
      if (eventType !== "face_detected") {
        this._pendingEvents.push({
          type: eventType,
          detail: `face_count:${faceCount},consecutive:${eventType === "face_absent" ? this._consecutiveAbsent : this._consecutiveMultiple}`,
          occurred_at: now,
        });
      }
    } catch {
      // Ignore frame detection hiccups
    }
  }

  _flush() {
    if (!this._running) return;

    const events = [...this._pendingEvents];
    this._pendingEvents = [];

    const windowSeconds = Math.max(1, Math.round((Date.now() - this._windowStart) / 1000));
    const signals = {
      windowSeconds,
      faceAbsentCount: this._windowCounts.face_absent,
      multipleFacesCount: this._windowCounts.multiple_faces,
      gazeDeviationCount: this._windowCounts.gaze_deviation,
      totalFrames: this._totalFrames,
    };

    // Reset counts for the next window
    this._windowCounts = { face_absent: 0, multiple_faces: 0, gaze_deviation: 0, face_detected: 0 };
    this._windowStart = Date.now();
    this._totalFrames = 0;

    if (events.length > 0 || signals.totalFrames > 0) {
      this.onEvents({ events, signals });
    }
  }

  stop() {
    this._running = false;
    if (this._detectionTimer) clearInterval(this._detectionTimer);
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._detectionTimer = null;
    this._flushTimer = null;

    if (this._pendingEvents.length > 0) {
      this.onEvents({ events: [...this._pendingEvents], signals: null });
      this._pendingEvents = [];
    }
  }
}
