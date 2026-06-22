import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import { Avatar } from "./avatar.js";
import { LipSync } from "./lipsync.js";
import { streamChat } from "./llm.js";
import { speak, SpeakQueue, cancelSpeak } from "./tts.js";
import { loadSettings, saveSettings, DEFAULTS, providerInfo } from "./config.js";

// ---------------------------------------------------------------------------
//  Scene / hologram stage
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(0, 1.45, 3.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.3, 0);
controls.enableDamping = true;
controls.enablePan  = true;     // always enabled; gated by ⌘ key below
controls.panSpeed   = 1.0;
controls.enableZoom = true;
controls.zoomToCursor = true;
controls.zoomSpeed = 1.2;
controls.minDistance = 2.2;
controls.maxDistance = 4.5;
controls.minPolarAngle = Math.PI * 0.3;
controls.maxPolarAngle = Math.PI * 0.62;

// Default: left-drag = rotate, scroll = zoom.
controls.mouseButtons = {
  LEFT:   THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT:  THREE.MOUSE.ROTATE,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};

// ── ⌘/Ctrl + drag = PAN ──────────────────────────────────────────────────
// We bypass OrbitControls entirely for this gesture: intercept the pointerdown
// at the window capture phase (runs before any canvas listener), call
// stopPropagation() so OrbitControls never sees it, then move the camera target
// manually based on subsequent pointermove events.
let _cmdHeld     = false;
let _panActive   = false;
let _panPtr      = null;
let _panLast     = null;

function _panBy(dx, dy) {
  const d     = camera.position.distanceTo(controls.target);
  const scale = d / canvas.clientHeight;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
  controls.target .addScaledVector(right, -dx * scale).addScaledVector(up,  dy * scale);
  camera.position .addScaledVector(right, -dx * scale).addScaledVector(up,  dy * scale);
  controls.update();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Meta" || e.key === "Control") { _cmdHeld = true;  canvas.style.cursor = "grab"; }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Meta" || e.key === "Control") { _cmdHeld = false; if (!_panActive) canvas.style.cursor = ""; }
});
window.addEventListener("blur", () => { _cmdHeld = false; canvas.style.cursor = ""; });

window.addEventListener("pointerdown", (e) => {
  if (e.target !== canvas || !_cmdHeld || e.button !== 0) return;
  e.stopPropagation();          // OrbitControls won't see this event
  _panActive = true;
  _panPtr    = e.pointerId;
  _panLast   = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
}, { capture: true });

window.addEventListener("pointermove", (e) => {
  if (!_panActive || e.pointerId !== _panPtr) return;
  _panBy(e.clientX - _panLast.x, e.clientY - _panLast.y);
  _panLast = { x: e.clientX, y: e.clientY };
}, { capture: true });

window.addEventListener("pointerup", (e) => {
  if (!_panActive || e.pointerId !== _panPtr) return;
  _panActive = false;
  _panPtr    = null;
  _panLast   = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  canvas.style.cursor = _cmdHeld ? "grab" : "";
}, { capture: true });

scene.add(new THREE.AmbientLight(0x6fd0ff, 0.35));
const key = new THREE.DirectionalLight(0x9ff0ff, 1.1);
key.position.set(2, 4, 3);
scene.add(key);
const rim = new THREE.DirectionalLight(0x3a7bff, 1.0);
rim.position.set(-3, 2, -2);
scene.add(rim);
const fill = new THREE.PointLight(0x5fe3ff, 2.2, 12);
fill.position.set(0, 1.2, 2.5);
scene.add(fill);

// Holographic projector base
const baseGroup = new THREE.Group();
scene.add(baseGroup);

const ringMat = () =>
  new THREE.MeshBasicMaterial({ color: 0x5fe3ff, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending });
const ring1 = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.012, 16, 80), ringMat());
const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.008, 16, 64), ringMat());
ring1.rotation.x = ring2.rotation.x = Math.PI / 2;
ring1.position.y = ring2.position.y = 0.02;
baseGroup.add(ring1, ring2);

const disc = new THREE.Mesh(
  new THREE.CircleGeometry(0.72, 64),
  new THREE.MeshBasicMaterial({ color: 0x0a3a4a, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending })
);
disc.rotation.x = -Math.PI / 2;
baseGroup.add(disc);

const cone = new THREE.Mesh(
  new THREE.ConeGeometry(0.7, 2.6, 48, 1, true),
  new THREE.MeshBasicMaterial({ color: 0x2bbbe0, transparent: true, opacity: 0.06,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
);
cone.position.y = 1.3;
cone.rotation.x = Math.PI;
baseGroup.add(cone);

const pCount = 220;
const pPos = new Float32Array(pCount * 3);
for (let i = 0; i < pCount; i++) {
  const r = Math.random() * 0.65;
  const a = Math.random() * Math.PI * 2;
  pPos[i * 3]     = Math.cos(a) * r;
  pPos[i * 3 + 1] = Math.random() * 2.4;
  pPos[i * 3 + 2] = Math.sin(a) * r;
}
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
const particles = new THREE.Points(
  pGeo,
  new THREE.PointsMaterial({ color: 0x9ff0ff, size: 0.012, transparent: true,
    opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })
);
baseGroup.add(particles);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.55, 0.55);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------------
//  Avatar + lip-sync + state
// ---------------------------------------------------------------------------
let settings = loadSettings();
const avatar  = new Avatar(renderer);
scene.add(avatar.root);
const lipsync = new LipSync(avatar);
const history = [];
let busy             = false;
let greeted          = false;
let _greetingActive  = false; // true while the opening greeting is playing

async function loadAvatar() {
  setLoader(true, "Loading avatar…");
  try {
    await avatar.load(settings.avatarUrl || DEFAULTS.avatarUrl);
  } catch (e) {
    console.error(e);
    if (settings.avatarUrl !== DEFAULTS.avatarUrl) {
      addMsg("bot", "Could not load that avatar URL — using the built-in one.");
      await avatar.load(DEFAULTS.avatarUrl);
    }
  }
  frameCameraToFace();
  setLoader(false);
}

function frameCameraToFace() {
  let { center, radius } = avatar.getFocus();
  if (!isFinite(radius) || radius <= 1e-3) {
    center = new THREE.Vector3(0, 1.3, 0);
    radius = 0.7;
  }
  const fov  = (camera.fov * Math.PI) / 180;
  const dist = (radius * 2.4) / Math.tan(fov / 2);
  controls.target.copy(center);
  camera.position.set(center.x, center.y + radius * 0.15, center.z + dist);
  controls.minDistance = Math.max(0.3, dist * 0.4);
  controls.maxDistance = dist * 2.5;
  controls.update();
  fill.position.set(center.x, center.y, center.z + radius * 2);
}

// ---------------------------------------------------------------------------
//  Render loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  const t  = clock.elapsedTime;

  ring1.rotation.z = t * 0.3;
  ring2.rotation.z = -t * 0.45;
  const pa = particles.geometry.attributes.position;
  for (let i = 0; i < pCount; i++) {
    pa.array[i * 3 + 1] += dt * 0.15;
    if (pa.array[i * 3 + 1] > 2.4) pa.array[i * 3 + 1] = 0;
  }
  pa.needsUpdate = true;

  avatar.update(dt);
  lipsync.update(dt);
  controls.update();
  composer.render();
}
animate();

// ---------------------------------------------------------------------------
//  Sentence splitter — feeds the streaming TTS queue
// ---------------------------------------------------------------------------
class SentenceSplitter {
  constructor() { this._buf = ""; }

  push(token) {
    this._buf += token;
    const sentences = [];
    let start = 0;

    for (let i = 0; i < this._buf.length; i++) {
      const ch = this._buf[i];
      if (!".!?;".includes(ch)) continue;
      // Need a space/newline or end of buffer after the punctuation.
      const next = this._buf[i + 1];
      if (next !== " " && next !== "\n" && next !== undefined) continue;
      const sentence = this._buf.slice(start, i + 1).trim();
      if (sentence.length >= 18) {
        sentences.push(sentence);
        start = i + 2;
        i = start - 1;
      }
    }

    if (start > 0) this._buf = this._buf.slice(start);

    // Force-split if no natural boundary for a long time.
    if (this._buf.length > 200) {
      const idx = this._buf.lastIndexOf(" ", 150);
      if (idx > 30) {
        sentences.push(this._buf.slice(0, idx).trim());
        this._buf = this._buf.slice(idx + 1);
      }
    }

    return sentences;
  }

  flush() {
    const s = this._buf.trim();
    this._buf = "";
    return s;
  }
}

// ---------------------------------------------------------------------------
//  Streaming conversation flow
// ---------------------------------------------------------------------------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;

  // If the opening greeting is still playing, cut it short and proceed.
  if (_greetingActive) {
    _greetingActive = false;
    cancelSpeak();
    lipsync.stop();
  }

  greeted = true;
  busy = true;
  sendBtn.disabled = true;
  addMsg("user", text);
  history.push({ role: "user", content: text });
  promptEl.value = "";

  setStatus("thinking");
  const t0 = performance.now();
  let ttft = null;

  // Typing indicator — three bouncing dots while waiting for the first token.
  const typingEl = document.createElement("div");
  typingEl.className = "msg bot";
  typingEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  transcript.appendChild(typingEl);
  transcript.scrollTop = transcript.scrollHeight;

  // Real bot message element — appended only once the first token arrives.
  const botDiv = document.createElement("div");
  botDiv.className = "msg bot";

  const splitter  = new SentenceSplitter();
  const queue     = new SpeakQueue(settings, lipsync);
  let fullText    = "";
  let firstToken  = true;
  let statsData   = null;  // populated by the _stats sentinel from streamChat

  try {
    for await (const chunk of streamChat(settings, history)) {
      // Sentinel object from llm.js carrying token-usage stats.
      if (chunk && typeof chunk === "object" && chunk._stats) {
        statsData = chunk;
        continue;
      }
      if (firstToken) {
        ttft = performance.now() - t0;
        setStatus("speaking");
        firstToken = false;
        typingEl.remove();           // swap dots → real message
        transcript.appendChild(botDiv);
        transcript.scrollTop = transcript.scrollHeight;
      }
      fullText += chunk;
      botDiv.textContent = fullText;
      transcript.scrollTop = transcript.scrollHeight;

      for (const sentence of splitter.push(chunk)) queue.enqueue(sentence);
    }
  } catch (e) {
    console.error("LLM stream error:", e);
    typingEl.remove();
    const errMsg = `Sorry, I hit an error: ${e.message}`;
    if (!fullText) { botDiv.textContent = errMsg; fullText = errMsg; transcript.appendChild(botDiv); }
  }

  const genMs = performance.now() - t0;

  // Flush any trailing text not yet enqueued.
  const tail = splitter.flush();
  if (tail) queue.enqueue(tail);
  queue.seal();  // signal no more sentences coming

  history.push({ role: "assistant", content: fullText });

  // Render meta row immediately — replay button is usable now, stats filled after audio.
  let statsEl = null;
  if (fullText) {
    const metaEl = document.createElement("div");
    metaEl.className = "msg-meta";

    statsEl = document.createElement("div");
    statsEl.className = "msg-stats";
    metaEl.appendChild(statsEl);

    const replayBtn = document.createElement("button");
    replayBtn.className = "replay-btn";
    replayBtn.title = "Replay response";
    replayBtn.textContent = "↺ replay";
    const capturedText = fullText;
    replayBtn.addEventListener("click", () => replay(capturedText, replayBtn));
    metaEl.appendChild(replayBtn);

    transcript.appendChild(metaEl);
    transcript.scrollTop = transcript.scrollHeight;
  }

  // Block until the last audio chunk finishes playing.
  try { await queue.done(); } catch (e) { console.warn("Queue error:", e); }

  // Populate stats now that all timings are known.
  if (statsEl) {
    const model        = statsData?.model ?? settings.chatModel ?? providerInfo(settings.provider).chatModel;
    const compTokens   = statsData?.completionTokens
      ?? Math.round(fullText.trim().split(/\s+/).length * 1.35);
    const promptTokens = statsData?.promptTokens ?? null;
    const tokPerSec    = (compTokens && genMs > 200)
      ? Math.round(compTokens / (genMs / 1000)) : null;

    const tm = queue.getTimings();
    // All durations relative to t0 (when the user hit send).
    const llmMs    = genMs;
    const ttfaMs   = tm.tFirstAudioStart ? tm.tFirstAudioStart - t0 : null;
    const ttsFetch = (tm.tFirstBufReady && tm.tFirstEnqueue)
                   ? tm.tFirstBufReady - tm.tFirstEnqueue : null;
    const speakMs  = (tm.tFirstAudioStart && tm.tDone)
                   ? tm.tDone - tm.tFirstAudioStart : null;

    const fmt = (ms) => (ms / 1000).toFixed(2) + "s";

    // Two rows: timing row + token row
    const timingParts = [];
    if (model)           timingParts.push(model);
    if (ttft !== null)   timingParts.push(`first token ${fmt(ttft)}`);
    if (llmMs > 200)     timingParts.push(`llm ${fmt(llmMs)}`);
    if (ttfaMs !== null) timingParts.push(`first audio ${fmt(ttfaMs)}`);
    if (ttsFetch !== null) timingParts.push(`tts ${fmt(ttsFetch)}`);
    if (speakMs !== null)  timingParts.push(`spoke ${fmt(speakMs)}`);

    const tokenParts = [];
    if (compTokens)    tokenParts.push(`out: ${compTokens} tok`);
    if (promptTokens)  tokenParts.push(`in: ${promptTokens} tok`);
    if (tokPerSec)     tokenParts.push(`${tokPerSec} tok/s`);

    statsEl.innerHTML =
      `<span class="stats-timing">${timingParts.join(" · ")}</span>` +
      (tokenParts.length ? `<span class="stats-tokens">${tokenParts.join(" · ")}</span>` : "");
  }

  setStatus("idle");
  busy = false;
  sendBtn.disabled = false;
  promptEl.focus();
}

// ---------------------------------------------------------------------------
//  Replay a previous response
// ---------------------------------------------------------------------------
async function replay(text, btn) {
  if (busy) return;
  busy = true;
  sendBtn.disabled = true;
  if (btn) { btn.textContent = "▶ playing…"; btn.disabled = true; }
  setStatus("speaking");
  try {
    await speak(settings, lipsync, text);
  } catch (e) {
    console.warn("Replay error:", e);
  }
  lipsync.stop();
  setStatus("idle");
  busy = false;
  sendBtn.disabled = false;
  if (btn) { btn.textContent = "↺ replay"; btn.disabled = false; }
  promptEl.focus();
}

// ---------------------------------------------------------------------------
//  UI helpers
// ---------------------------------------------------------------------------
const transcript = document.getElementById("transcript");
const promptEl   = document.getElementById("prompt");
const sendBtn    = document.getElementById("send");
const statusEl   = document.getElementById("status");
const loaderEl   = document.getElementById("loader");

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
}
function setStatus(state) {
  statusEl.textContent = state;
  statusEl.dataset.state = state;
}
function setLoader(on, text) {
  if (text) loaderEl.querySelector("p").textContent = text;
  loaderEl.classList.toggle("hidden", !on);
}

document.getElementById("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(promptEl.value);
});

// ── Drag handle — resize transcript area ──────────────────────────────────
const dockHandle = document.getElementById("dock-handle");
let _dragY0 = 0;
let _dragH0 = 0;
const MIN_H = 48;
const MAX_H_RATIO = 0.68;

dockHandle.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  _dragY0 = e.clientY;
  _dragH0 = transcript.clientHeight;
  dockHandle.setPointerCapture(e.pointerId);
  dockHandle.style.cursor = "ns-resize";
});

dockHandle.addEventListener("pointermove", (e) => {
  if (!dockHandle.hasPointerCapture(e.pointerId)) return;
  const delta  = _dragY0 - e.clientY;           // up = positive = taller
  const newH   = Math.max(MIN_H, Math.min(window.innerHeight * MAX_H_RATIO, _dragH0 + delta));
  transcript.style.maxHeight = newH + "px";
  transcript.scrollTop = transcript.scrollHeight;
});

dockHandle.addEventListener("pointerup", () => {
  dockHandle.releasePointerCapture(event.pointerId);
});

// Speech-to-text mic (Chrome / Edge)
const micBtn = document.getElementById("mic");
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  let listening = false;
  micBtn.addEventListener("click", () => { if (listening) { rec.stop(); return; } rec.start(); });
  rec.onstart  = () => { listening = true;  micBtn.classList.add("active"); };
  rec.onend    = () => { listening = false; micBtn.classList.remove("active"); };
  rec.onresult = (e) => { send(e.results[0][0].transcript); };
} else {
  micBtn.style.display = "none";
}

// ---------------------------------------------------------------------------
//  Settings panel
// ---------------------------------------------------------------------------
const settingsEl  = document.getElementById("settings");
const fields = {
  provider:     document.getElementById("provider"),
  apiKey:       document.getElementById("apiKey"),
  chatModel:    document.getElementById("chatModel"),
  ttsVoice:     document.getElementById("ttsVoice"),
  avatarUrl:    document.getElementById("avatarUrl"),
  systemPrompt: document.getElementById("systemPrompt"),
};

const cloudSettings = document.getElementById("cloudSettings");

function populateVoices(provider, selected) {
  const info = providerInfo(provider);
  fields.ttsVoice.innerHTML = "";
  for (const v of info.voices) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = v;
    fields.ttsVoice.appendChild(opt);
  }
  fields.ttsVoice.value = info.voices.includes(selected) ? selected : info.defaultVoice;
}

function syncProviderVisibility(selectedVoice) {
  const provider = fields.provider.value;
  const info     = providerInfo(provider);
  cloudSettings.style.display  = provider === "local" ? "none" : "";
  populateVoices(provider, selectedVoice ?? fields.ttsVoice.value);
  fields.chatModel.placeholder = info.chatModel || "(provider default)";
}

function fillSettingsForm() {
  for (const k of Object.keys(fields)) {
    if (k === "ttsVoice") continue;
    fields[k].value = settings[k] ?? "";
  }
  syncProviderVisibility(settings.ttsVoice);
}

function openSettings()  { fillSettingsForm(); settingsEl.classList.remove("hidden"); }
function closeSettings() { settingsEl.classList.add("hidden"); }

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("closeSettings").addEventListener("click", closeSettings);
fields.provider.addEventListener("change", () => {
  fields.chatModel.value = "";
  syncProviderVisibility();
});
settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) closeSettings(); });

document.getElementById("saveSettings").addEventListener("click", async () => {
  const prevAvatar = settings.avatarUrl;
  for (const k of Object.keys(fields)) settings[k] = fields[k].value.trim() || DEFAULTS[k];
  delete settings.baseUrl; // OpenAI-era field — no longer used
  saveSettings(settings);
  closeSettings();
  if (settings.avatarUrl !== prevAvatar) await loadAvatar();
});

// ---------------------------------------------------------------------------
//  Boot + spoken greeting (deferred until first user gesture for autoplay)
// ---------------------------------------------------------------------------
const configured = settings.provider !== "local" && !!settings.apiKey;
const GREETING   = "Hologram online. How can I help you today?";
addMsg("bot", "Hologram online. " + (configured
  ? "Ask me anything — tap or click once to let me speak."
  : "Running in offline demo mode — open settings (⚙) to add a Gemini API key. Tap or click once to let me speak."));
setStatus("idle");

async function greet() {
  if (greeted || history.length > 0) return;
  greeted = true;
  _greetingActive = true;
  lipsync.ensureCtx();
  setStatus("speaking");
  try { await speak(settings, lipsync, GREETING); } catch (e) { console.warn(e); }
  // Only clean up if send() didn't already interrupt us.
  if (_greetingActive) {
    _greetingActive = false;
    lipsync.stop();
    setStatus("idle");
  }
}

await loadAvatar();
["pointerdown", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, greet, { once: false }));
