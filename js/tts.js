// TTS with two operating modes:
//
//  speak()     — single sentence, used for the greeting and offline replies.
//  SpeakQueue  — streaming pipeline used during a conversation turn:
//
//    1. Each sentence is enqueued as soon as the LLM emits it.
//    2. The TTS fetch starts immediately (parallel with LLM streaming).
//    3. Audio buffers are scheduled gaplessly via Web Audio API.
//    4. lipsync.scheduleChunk() registers a phoneme schedule per chunk so
//       the avatar's mouth tracks each sentence accurately.
//    5. For offline (no key), utterances are queued in SpeechSynthesis.

import { providerInfo } from "./config.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EST_MS_PER_WORD = 390;   // rough SpeechSynthesis pace

// ── PCM helper (Gemini returns raw 16-bit PCM) ────────────────────────────
function pcm16ToAudioBuffer(ctx, base64, sampleRate) {
  const bin   = atob(base64);
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

// ════════════════════════════════════════════════════════════════════════════
//  SpeakQueue — streaming TTS pipeline
// ════════════════════════════════════════════════════════════════════════════
export class SpeakQueue {
  constructor(settings, lipsync) {
    this.s  = settings;
    this.ls = lipsync;

    // Ordered list of items; each starts a TTS fetch immediately on enqueue.
    this._items = [];    // [{ text, audioPromise }]
    this._cursor = 0;    // next item to play

    // Shared persistent Web Audio analyser — created once, reused per chunk.
    this._analyser     = null;
    this._nextCtxTime  = null; // AudioContext time for the next chunk start

    // Done signal
    this._sealed       = false;
    this._doneResolve  = null;
    this._donePromise  = new Promise((r) => { this._doneResolve = r; });
    this._running      = false;

    // For offline SpeechSynthesis
    this._pendingCount = 0;
  }

  // Call once per sentence as it arrives from the LLM.
  enqueue(text) {
    text = text.trim();
    if (!text) return;
    this._items.push({ text, audioPromise: this._fetch(text) });
    if (!this._running) { this._running = true; this._loop(); }
  }

  // Call when the LLM stream is finished (no more sentences coming).
  seal() {
    this._sealed = true;
    // If offline SpeechSynthesis already finished all its utterances, resolve.
    if (this._pendingCount === 0 && this.s.provider === "local") {
      setTimeout(() => this._tryResolve(), 100);
    }
  }

  done() { return this._donePromise; }

  // ── Internal playback loop ────────────────────────────────────────────────
  async _loop() {
    while (true) {
      if (this._cursor < this._items.length) {
        const item = this._items[this._cursor++];
        let buf = null;
        try { buf = await item.audioPromise; } catch (e) {
          console.warn("TTS chunk failed, using browser voice:", e);
        }
        if (buf) {
          await this._playBuffer(item.text, buf);
        } else {
          // Fallback to SpeechSynthesis for this chunk.
          await this._playSpeechSynthesis(item.text);
        }
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
      this.ls.stop();
      this._doneResolve();
    }
  }

  // ── Web Audio scheduling (cloud providers) ────────────────────────────────
  async _playBuffer(text, audioBuffer) {
    const ctx = this.ls.ensureCtx();

    // Create the shared analyser once; all chunk sources connect to it.
    if (!this._analyser) {
      const a = ctx.createAnalyser();
      a.fftSize               = 2048;
      a.smoothingTimeConstant = 0.25;
      a.connect(ctx.destination);
      this._analyser = a;
      this.ls.setAnalyser(a);
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this._analyser);

    // Gapless scheduling: each chunk starts exactly when the previous ends.
    if (this._nextCtxTime === null) {
      this._nextCtxTime = ctx.currentTime + 0.06; // tiny initial buffer
    }
    const startTime      = Math.max(this._nextCtxTime, ctx.currentTime + 0.01);
    this._nextCtxTime    = startTime + audioBuffer.duration;

    src.start(startTime);

    // Register phoneme schedule for this chunk.
    this.ls.scheduleChunk(text, audioBuffer.duration * 1000, startTime);

    // Wait until this chunk has actually played out.
    await new Promise((r) => { src.onended = r; });
  }

  // ── SpeechSynthesis fallback (offline or cloud TTS error) ─────────────────
  async _playSpeechSynthesis(text) {
    if (!("speechSynthesis" in window)) return;
    this._pendingCount++;
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate  = 1.0;
      u.pitch = 1.05;

      const wordCount = text.trim().split(/\s+/).length;
      const estMs     = wordCount * EST_MS_PER_WORD;
      const totalChars = text.length;

      u.onstart = () => {
        // Kick off the phoneme schedule when this utterance actually starts.
        this.ls.setSchedule(text, estMs);
        this.ls.mode = "procedural";
      };
      u.onboundary = (e) => {
        if (e.name === "word") {
          this.ls.syncToChar(e.charIndex, totalChars);
          this.ls.onWord((text.slice(e.charIndex).match(/^\S+/) || [""])[0]);
        }
      };
      const done = () => {
        this._pendingCount--;
        resolve();
        if (this._sealed && this._pendingCount === 0 && !this._running) {
          this._tryResolve();
        }
      };
      u.onend   = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  // ── TTS fetch (returns AudioBuffer or null) ───────────────────────────────
  async _fetch(text) {
    if (this.s.provider === "openai" && this.s.apiKey) return this._fetchOpenAI(text);
    if (this.s.provider === "gemini" && this.s.apiKey) return this._fetchGemini(text);
    return null; // offline → SpeechSynthesis handled in _loop
  }

  async _fetchOpenAI(text) {
    const base = (this.s.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const res  = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.s.apiKey}`,
      },
      body: JSON.stringify({
        model: providerInfo("openai").ttsModel,
        voice: this.s.ttsVoice || providerInfo("openai").defaultVoice,
        input: text,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}`);
    const ab  = await res.arrayBuffer();
    const ctx = this.ls.ensureCtx();
    return ctx.decodeAudioData(ab);
  }

  async _fetchGemini(text) {
    const model = providerInfo("gemini").ttsModel;
    const voice = this.s.ttsVoice || providerInfo("gemini").defaultVoice;
    const res   = await fetch(
      `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(this.s.apiKey)}`,
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
    if (!part) throw new Error("Gemini: no audio in response");
    const rate = parseInt(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1] || "24000", 10);
    const ctx  = this.ls.ensureCtx();
    return pcm16ToAudioBuffer(ctx, part.inlineData.data, rate);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  speak() — single-sentence path (greeting + offline canned replies)
// ════════════════════════════════════════════════════════════════════════════
let audioEl = null;
function getAudioEl() {
  if (!audioEl) { audioEl = new Audio(); audioEl.crossOrigin = "anonymous"; }
  return audioEl;
}

export async function speak(settings, lipsync, text) {
  if (!text) return;
  try {
    if (settings.provider === "openai" && settings.apiKey) return await _speakOpenAI(settings, lipsync, text);
    if (settings.provider === "gemini" && settings.apiKey) return await _speakGemini(settings, lipsync, text);
  } catch (e) { console.warn("Cloud TTS failed, using browser voice:", e); }
  await _speakWebSpeech(lipsync, text);
}

async function _speakOpenAI(settings, lipsync, text) {
  const base = (settings.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const res  = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: providerInfo("openai").ttsModel,
      voice: settings.ttsVoice || providerInfo("openai").defaultVoice,
      input: text,
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const el  = getAudioEl();
  el.src    = url;
  lipsync.attachElement(el);
  await new Promise((r, e) => { el.onloadedmetadata = r; el.onerror = e; el.load(); });
  lipsync.setSchedule(text, el.duration * 1000);
  await el.play();
  await new Promise((r) => { el.onended = r; el.onerror = r; });
  URL.revokeObjectURL(url);
  lipsync.stop();
}

async function _speakGemini(settings, lipsync, text) {
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
  if (!part) throw new Error("Gemini: no audio");
  const rate   = parseInt(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1] || "24000", 10);
  const ctx    = lipsync.ensureCtx();
  const buffer = pcm16ToAudioBuffer(ctx, part.inlineData.data, rate);
  lipsync.setSchedule(text, buffer.duration * 1000);
  const src    = ctx.createBufferSource();
  src.buffer   = buffer;
  lipsync.attachNode(src);
  src.start();
  await new Promise((r) => { src.onended = r; });
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
    const wordCount = text.trim().split(/\s+/).length;
    lipsync.setSchedule(text, wordCount * EST_MS_PER_WORD);
    lipsync.mode = "procedural";
    const totalChars = text.length;
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
