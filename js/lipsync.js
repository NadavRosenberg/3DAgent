// Phoneme-scheduled lip-sync engine — single-shot and streaming modes.
//
// Streaming mode (used by SpeakQueue)
// ────────────────────────────────────
//   SpeakQueue calls setAnalyser(node) once to plug in a persistent
//   Web-Audio analyser shared across all chunks.  For each audio buffer
//   about to be scheduled it calls scheduleChunk(text, durationMs, ctxTime).
//   update() uses ctx.currentTime to find which chunk is active and
//   interpolates the correct viseme shape — no manual clock needed.
//
// Single-shot mode (greeting / offline)
// ──────────────────────────────────────
//   setSchedule(text, durationMs) stores one schedule and advances
//   _clockMs manually with dt each frame.  attachElement / attachNode
//   hook the audio into an analyser.  stop() resets everything.

import { schedule, shape as visemeShape } from "./phoneme.js";

export class LipSync {
  constructor(avatar) {
    this.avatar   = avatar;
    this.ctx      = null;
    this.analyser = null;
    this.data     = null;
    this.mode     = "off";   // "off" | "active" | "procedural"

    // Streaming: time-stamped chunk list
    this._chunks = [];       // [{frames, startCtxMs, durationMs}]

    // Single-shot: manually clocked schedule
    this._frames     = null;
    this._clockMs    = 0;
    this._frameIdx   = 0;
    this._totalMs    = 0;

    // Energy smoothing
    this._energySmooth = 0;

    // Procedural (offline voice)
    this._procT       = 0;
    this._procEnergy  = 0;
    this._shapeTarget = 0.5;
    this._shapeCur    = 0.5;
  }

  // ── Audio context ─────────────────────────────────────────────────────────
  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  // ── Streaming API (SpeakQueue) ────────────────────────────────────────────

  // Attach a persistent Web-Audio analyser that receives all chunk sources.
  setAnalyser(analyser) {
    this.analyser = analyser;
    this.data     = new Uint8Array(analyser.frequencyBinCount);
    this.mode     = "active";
  }

  // Register a sentence/chunk that is scheduled to play at audioCtxStartTime.
  scheduleChunk(text, durationMs, audioCtxStartTime) {
    const frames = schedule(text, durationMs);
    this._chunks.push({
      frames,
      startCtxMs: audioCtxStartTime * 1000,
      durationMs,
    });
    // Discard chunks that finished more than 1 s ago to keep the list small.
    const cutoffMs = audioCtxStartTime * 1000 - 1000;
    this._chunks = this._chunks.filter((c) => c.startCtxMs + c.durationMs >= cutoffMs);
  }

  // ── Single-shot API (speak() / greeting) ──────────────────────────────────
  _makeAnalyser(source) {
    const ctx = this.ensureCtx();
    const a   = ctx.createAnalyser();
    a.fftSize                = 2048;
    a.smoothingTimeConstant  = 0.25;
    source.connect(a);
    a.connect(ctx.destination);
    this.analyser = a;
    this.data     = new Uint8Array(a.frequencyBinCount);
    this.mode     = "active";
    return a;
  }
  attachElement(el) {
    const ctx = this.ensureCtx();
    if (!el._mediaSource) el._mediaSource = ctx.createMediaElementSource(el);
    el._mediaSource.disconnect();
    return this._makeAnalyser(el._mediaSource);
  }
  attachNode(node) { return this._makeAnalyser(node); }

  setSchedule(text, durationMs) {
    this._frames   = schedule(text, durationMs);
    this._clockMs  = 0;
    this._frameIdx = 0;
    this._totalMs  = durationMs;
  }

  syncToChar(charIndex, totalChars) {
    if (!this._frames || !this._totalMs) return;
    const target = (charIndex / Math.max(totalChars, 1)) * this._totalMs;
    if (target > this._clockMs) {
      this._clockMs = target;
      while (
        this._frameIdx + 1 < this._frames.length &&
        this._frames[this._frameIdx + 1].tMs <= target
      ) this._frameIdx++;
    }
  }

  // ── Procedural fallback ───────────────────────────────────────────────────
  startProcedural() {
    this.mode        = "procedural";
    this._procT      = 0;
    this._procEnergy = 1;
  }
  onWord(word) {
    const w      = (word || "").toLowerCase();
    const vowels = (w.match(/[aeiouy]/g) || []).length;
    this._shapeTarget = w.length
      ? Math.min(1, 0.25 + (vowels / w.length) * 1.2)
      : 0.5;
    this._procEnergy = 1;
  }

  // ── Stop / reset ──────────────────────────────────────────────────────────
  stop() {
    this.mode          = "off";
    this._chunks       = [];
    this._frames       = null;
    this.analyser      = null;
    this._energySmooth = 0;
    this._procEnergy   = 0;
    this.avatar?.resetMouth();
  }

  // ── Energy helpers ────────────────────────────────────────────────────────
  _getAnalyserEnergy() {
    if (!this.analyser) return 1;
    this.analyser.getByteFrequencyData(this.data);
    const sr = this.ctx?.sampleRate || 44100;
    const n  = this.data.length;
    const lo = Math.floor(200  * n * 2 / sr);
    const hi = Math.min(n, Math.floor(4000 * n * 2 / sr));
    let sum  = 0;
    for (let i = lo; i < hi; i++) sum += this.data[i];
    return Math.min(1, (sum / ((hi - lo) * 255)) * 4.0);
  }

  // ── Shape interpolation ───────────────────────────────────────────────────
  _shapeAt(frames, elapsedMs) {
    let idx = 0;
    while (idx + 1 < frames.length && frames[idx + 1].tMs <= elapsedMs) idx++;
    const cur  = frames[idx];
    const next = frames[idx + 1];
    const s0   = visemeShape(cur.vis);
    if (!next) return s0;
    const t  = Math.max(0, Math.min(1, (elapsedMs - cur.tMs) / (next.tMs - cur.tMs)));
    const s1 = visemeShape(next.vis);
    return {
      open:   s0.open   + (s1.open   - s0.open)   * t,
      round:  s0.round  + (s1.round  - s0.round)  * t,
      smile:  s0.smile  + (s1.smile  - s0.smile)  * t,
      close:  s0.close  + (s1.close  - s0.close)  * t,
      bite:   s0.bite   + (s1.bite   - s0.bite)   * t,
      fwd:    s0.fwd    + (s1.fwd    - s0.fwd)    * t,
      tongue: s0.tongue + (s1.tongue - s0.tongue) * t,
    };
  }

  // Active shape from the streaming chunk timeline (uses ctx.currentTime).
  _chunkShape() {
    if (!this.ctx || !this._chunks.length) return null;
    const nowMs = this.ctx.currentTime * 1000;
    for (const c of this._chunks) {
      if (nowMs >= c.startCtxMs && nowMs < c.startCtxMs + c.durationMs) {
        return this._shapeAt(c.frames, nowMs - c.startCtxMs);
      }
    }
    return null;
  }

  // Active shape from the manually-clocked single schedule.
  _frameShape(dt) {
    if (!this._frames) return null;
    this._clockMs += dt * 1000;
    while (
      this._frameIdx + 1 < this._frames.length &&
      this._frames[this._frameIdx + 1].tMs <= this._clockMs
    ) this._frameIdx++;

    const cur  = this._frames[this._frameIdx];
    const next = this._frames[this._frameIdx + 1];
    const s0   = visemeShape(cur.vis);
    if (!next) return s0;
    const t  = Math.max(0, Math.min(1, (this._clockMs - cur.tMs) / (next.tMs - cur.tMs)));
    const s1 = visemeShape(next.vis);
    return {
      open:   s0.open   + (s1.open   - s0.open)   * t,
      round:  s0.round  + (s1.round  - s0.round)  * t,
      smile:  s0.smile  + (s1.smile  - s0.smile)  * t,
      close:  s0.close  + (s1.close  - s0.close)  * t,
      bite:   s0.bite   + (s1.bite   - s0.bite)   * t,
      fwd:    s0.fwd    + (s1.fwd    - s0.fwd)    * t,
      tongue: s0.tongue + (s1.tongue - s0.tongue) * t,
    };
  }

  // ── Main update — every render frame ─────────────────────────────────────
  update(dt) {
    if (this.mode === "off") return;

    // 1. Energy envelope
    let energy = 1.0;
    if (this.mode === "active" && this.analyser) {
      const raw = this._getAnalyserEnergy();
      this._energySmooth += (raw - this._energySmooth) * Math.min(1, dt * 22);
      energy = this._energySmooth;
    } else if (this.mode === "procedural") {
      this._procT      += dt;
      this._procEnergy  = Math.max(0, this._procEnergy - dt * 1.6);
      const osc  = 0.5 + 0.5 * Math.sin(this._procT * 11) * Math.sin(this._procT * 4.3 + 1);
      energy = Math.max(0.06, Math.abs(osc)) * (0.25 + 0.75 * this._procEnergy);
      this._shapeCur += (this._shapeTarget - this._shapeCur) * Math.min(1, dt * 7);
    }

    // 2. Viseme shape — streaming chunks take priority over single schedule
    const s = this._chunkShape() || this._frameShape(dt);
    if (s) {
      this.avatar.setViseme({
        open:   s.open   * energy,
        round:  s.round,
        smile:  s.smile,
        close:  s.close  * (energy > 0.08 ? 1 : 0),
        bite:   s.bite,
        fwd:    s.fwd,
        tongue: s.tongue * (energy > 0.08 ? 1 : 0),
      });
      return;
    }

    // 3. Fallback — energy only
    const shape = this.mode === "procedural" ? this._shapeCur : 0.5;
    this.avatar.setMouth(energy * 0.65, shape);
  }
}
