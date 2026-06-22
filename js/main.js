import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import { Avatar } from "./avatar.js";
import { LipSync } from "./lipsync.js";
import { streamChat } from "./llm.js";
import { speak, SpeakQueue } from "./tts.js";
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
controls.enablePan = false;
controls.enableZoom = true;
controls.zoomToCursor = true;
controls.zoomSpeed = 1.2;
controls.minDistance = 2.2;
controls.maxDistance = 4.5;
controls.minPolarAngle = Math.PI * 0.3;
controls.maxPolarAngle = Math.PI * 0.62;

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
let busy    = false;
let greeted = false;

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
  greeted = true;
  busy = true;
  sendBtn.disabled = true;
  addMsg("user", text);
  history.push({ role: "user", content: text });
  promptEl.value = "";

  setStatus("thinking");

  // Create bot message element immediately (text streams into it).
  const botDiv = document.createElement("div");
  botDiv.className = "msg bot";
  transcript.appendChild(botDiv);
  transcript.scrollTop = transcript.scrollHeight;

  const splitter = new SentenceSplitter();
  const queue    = new SpeakQueue(settings, lipsync);
  let fullText   = "";
  let firstToken = true;

  try {
    for await (const token of streamChat(settings, history)) {
      if (firstToken) { setStatus("speaking"); firstToken = false; }
      fullText     += token;
      botDiv.textContent = fullText;
      transcript.scrollTop = transcript.scrollHeight;

      // Flush any complete sentences into the TTS queue.
      for (const sentence of splitter.push(token)) queue.enqueue(sentence);
    }
  } catch (e) {
    console.error("LLM stream error:", e);
    const errMsg = `Sorry, I hit an error: ${e.message}`;
    if (!fullText) { botDiv.textContent = errMsg; fullText = errMsg; }
  }

  // Flush any trailing text not yet enqueued.
  const tail = splitter.flush();
  if (tail) queue.enqueue(tail);
  queue.seal();  // signal no more sentences coming

  history.push({ role: "assistant", content: fullText });

  // Block until the last audio chunk finishes playing.
  try { await queue.done(); } catch (e) { console.warn("Queue error:", e); }

  setStatus("idle");
  busy = false;
  sendBtn.disabled = false;
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
  baseUrl:      document.getElementById("baseUrl"),
  chatModel:    document.getElementById("chatModel"),
  ttsVoice:     document.getElementById("ttsVoice"),
  avatarUrl:    document.getElementById("avatarUrl"),
  systemPrompt: document.getElementById("systemPrompt"),
};

const cloudSettings = document.getElementById("cloudSettings");
const baseUrlField  = document.getElementById("baseUrlField");

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
  baseUrlField.style.display   = info.needsBaseUrl ? "" : "none";
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
  : "Running in offline demo mode — open settings (⚙) to add an OpenAI or Gemini key. Tap or click once to let me speak."));
setStatus("idle");

async function greet() {
  if (greeted || busy || history.length > 0) return;
  greeted = true;
  busy = true;
  lipsync.ensureCtx();
  setStatus("speaking");
  try { await speak(settings, lipsync, GREETING); } catch (e) { console.warn(e); }
  lipsync.stop();
  setStatus("idle");
  busy = false;
}

await loadAvatar();
["pointerdown", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, greet, { once: false }));
