// TTS — Google Gemini audio or Web Speech API fallback.
//
//  speak()     — single sentence (greeting, offline replies)
//  SpeakQueue  — streaming pipeline: one TTS fetch per sentence,
//                gapless Web Audio scheduling, phoneme lip-sync per chunk.

import { providerInfo } from "./config.js";

const GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta";
const EST_MS_WORD  = 390;   // rough ms-per-word for SpeechSynthesis scheduling

// ── Helpers ───────────────────────────────────────────────────────────────
function pcm16ToAudioBuffer(ctx, base64, sampleRate) {
  const bin  = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const s16 = new Int16Array(bytes.buffer);
  const buf  = ctx.createBuffer(1, s16.length, sampleRate);
  const ch   = buf.getChannelData(0);
  for (let i = 0; i < s16.length; i++) ch[i] = s16[i] / 32768;
  return buf;
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  return (
    voices.find((v) => /female|samantha|zira|google us english/i.test(v.name)) ||
    voices.find((v) => v.lang?.startsWith("en")) ||
    voices[0]
  );
}

// ── Gemini audio fetch (returns AudioBuffer) ──────────────────────────────
async function fetchGeminiBuffer(lipsync, settings, text) {
  const model = providerInfo("gemini").ttsModel;
  const voice = settings.ttsVoice || providerInfo("gemini").defaultVoice;
  const res   = await fetch(
    `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini TTS ${res.status}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error("Gemini TTS: no audio in response");
  const rate = parseInt(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1] || "24000", 10);
  const ctx  = lipsync.ensureCtx();
  return pcm16ToAudioBuffer(ctx, part.inlineData.data, rate);
}

// ════════════════════════════════════════════════════════════════════════════
//  SpeakQueue — streaming TTS pipeline
// ════════════════════════════════════════════════════════════════════════════
export class SpeakQueue {
  constructor(settings, lipsync) {
    this.s  = settings;
    this.ls = lipsync;

    this._items       = [];   // [{ text, audioPromise }]
    this._cursor      = 0;
    this._sealed      = false;
    this._analyser    = null;
    this._nextCtxTime = null;

    this._doneResolve = null;
    this._donePromise = new Promise((r) => { this._doneResolve = r; });
    this._running     = false;

    this._pendingCount = 0; // for offline SpeechSynthesis

    // ── Timing (all performance.now() milliseconds) ──────────────────────────
    this._tFirstEnqueue    = null; // when first sentence was sent to TTS
    this._tFirstBufReady   = null; // when first audio buffer came back from API
    this._tFirstAudioStart = null; // when first audio chunk actually starts playing
    this._tDone            = null; // when the last audio chunk finishes
  }

  enqueue(text) {
    text = text.trim();
    if (!text) return;
    if (this._tFirstEnqueue === null) this._tFirstEnqueue = performance.now();
    this._items.push({ text, audioPromise: this._fetch(text) });
    if (!this._running) { this._running = true; this._loop(); }
  }

  seal()  { this._sealed = true; if (this._pendingCount === 0 && this.s.provider === "local") setTimeout(() => this._tryResolve(), 100); }
  done()  { return this._donePromise; }

  /** Returns timing data after done() resolves (all values are performance.now() ms). */
  getTimings() {
    return {
      tFirstEnqueue:    this._tFirstEnqueue,
      tFirstBufReady:   this._tFirstBufReady,
      tFirstAudioStart: this._tFirstAudioStart,
      tDone:            this._tDone,
    };
  }

  // ── Internal loop ─────────────────────────────────────────────────────────
  async _loop() {
    while (true) {
      if (this._cursor < this._items.length) {
        const item = this._items[this._cursor++];
        let buf = null;
        try {
          buf = await item.audioPromise;
          if (buf && this._tFirstBufReady === null) this._tFirstBufReady = performance.now();
        } catch (e) { console.warn("TTS chunk failed:", e); }
        if (buf) await this._playBuffer(item.text, buf);
        else     await this._playSpeechSynthesis(item.text);
      } else if (this._sealed) {
        break;
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    this._running = false;
    this._tryResolve();
  }

  _tryResolve() {
    if (this._sealed && !this._running && this._pendingCount === 0) {
      this._tDone = performance.now();
      this.ls.stop();
      this._doneResolve();
    }
  }

  // ── Web Audio scheduling ──────────────────────────────────────────────────
  async _playBuffer(text, audioBuffer) {
    const ctx = this.ls.ensureCtx();

    if (!this._analyser) {
      const a = ctx.createAnalyser();
      a.fftSize = 2048; a.smoothingTimeConstant = 0.25;
      a.connect(ctx.destination);
      this._analyser = a;
      this.ls.setAnalyser(a);
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this._analyser);

    if (this._nextCtxTime === null) this._nextCtxTime = ctx.currentTime + 0.06;
    const startTime   = Math.max(this._nextCtxTime, ctx.currentTime + 0.01);
    this._nextCtxTime = startTime + audioBuffer.duration;

    // Record wall-clock time when the first audio chunk is scheduled to start.
    if (this._tFirstAudioStart === null) {
      const delayMs = Math.max(0, startTime - ctx.currentTime) * 1000;
      this._tFirstAudioStart = performance.now() + delayMs;
    }

    src.start(startTime);
    this.ls.scheduleChunk(text, audioBuffer.duration * 1000, startTime);

    await new Promise((r) => { src.onended = r; });
  }

  // ── SpeechSynthesis fallback ──────────────────────────────────────────────
  async _playSpeechSynthesis(text) {
    if (!("speechSynthesis" in window)) return;
    this._pendingCount++;
    return new Promise((resolve) => {
      const u    = new SpeechSynthesisUtterance(text);
      const v    = pickVoice();
      if (v) u.voice = v;
      u.rate = 1.0; u.pitch = 1.05;
      const estMs     = text.trim().split(/\s+/).length * EST_MS_WORD;
      const totalChars = text.length;
      u.onstart = () => { this.ls.setSchedule(text, estMs); this.ls.mode = "procedural"; };
      u.onboundary = (e) => {
        if (e.name !== "word") return;
        this.ls.syncToChar(e.charIndex, totalChars);
        this.ls.onWord((text.slice(e.charIndex).match(/^\S+/) || [""])[0]);
      };
      const done = () => {
        this._pendingCount--;
        resolve();
        if (this._sealed && this._pendingCount === 0 && !this._running) this._tryResolve();
      };
      u.onend = done; u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  // ── Fetch audio ───────────────────────────────────────────────────────────
  async _fetch(text) {
    if (this.s.provider === "gemini" && this.s.apiKey) {
      return fetchGeminiBuffer(this.ls, this.s, text);
    }
    return null; // offline → SpeechSynthesis
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  speak() — single-sentence path (greeting + canned replies)
// ════════════════════════════════════════════════════════════════════════════

// Tracked so cancelSpeak() can stop it mid-playback.
let _activeSrc = null;

/** Stop whatever speak() is currently playing (used to interrupt the greeting). */
export function cancelSpeak() {
  if (_activeSrc) {
    try { _activeSrc.stop(); } catch (_) {}
    _activeSrc = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

export async function speak(settings, lipsync, text) {
  if (!text) return;
  if (settings.provider === "gemini" && settings.apiKey) {
    try { return await _speakGemini(settings, lipsync, text); } catch (e) {
      console.warn("Gemini TTS failed, falling back to browser voice:", e);
    }
  }
  await _speakWebSpeech(lipsync, text);
}

async function _speakGemini(settings, lipsync, text) {
  const buffer = await fetchGeminiBuffer(lipsync, settings, text);
  lipsync.setSchedule(text, buffer.duration * 1000);
  const ctx  = lipsync.ensureCtx();
  const src  = ctx.createBufferSource();
  src.buffer = buffer;
  _activeSrc = src;
  lipsync.attachNode(src);
  src.start();
  await new Promise((r) => { src.onended = () => { _activeSrc = null; r(); }; });
  lipsync.stop();
}

async function _speakWebSpeech(lipsync, text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { resolve(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.0; u.pitch = 1.05;
    const estMs      = text.trim().split(/\s+/).length * EST_MS_WORD;
    const totalChars = text.length;
    lipsync.setSchedule(text, estMs);
    lipsync.mode = "procedural";
    u.onboundary = (e) => {
      if (e.name !== "word") return;
      lipsync.syncToChar(e.charIndex, totalChars);
      lipsync.onWord((text.slice(e.charIndex).match(/^\S+/) || [""])[0]);
    };
    u.onend   = () => { lipsync.stop(); resolve(); };
    u.onerror = () => { lipsync.stop(); resolve(); };
    speechSynthesis.speak(u);
  });
}

if ("speechSynthesis" in window) speechSynthesis.getVoices();
