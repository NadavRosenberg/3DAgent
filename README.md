# Hologram Avatar Assistant

A tiny, dependency-free 3D **holographic avatar** for a home appliance:
speak to it → an LLM replies → the reply is spoken aloud (TTS) → the avatar's
mouth lip-syncs to the audio. Built with plain HTML + [three.js] (loaded from a
CDN), no build step.

```
3DAgent/
├── index.html        # UI shell + three.js import map
├── styles.css        # hologram styling (scanlines, glow, chat dock)
├── assets/avatar.glb # bundled avatar with facial blendshapes (lip-sync ready)
└── js/
    ├── main.js       # scene, hologram effects, render loop, UI glue
    ├── avatar.js     # GLB loading, morph-target detection, blink/idle/mouth
    ├── lipsync.js    # audio-analyser + procedural lip-sync
    ├── llm.js        # OpenAI-compatible chat (+ offline canned fallback)
    ├── tts.js        # OpenAI voice (real lip-sync) + browser voice fallback
    └── config.js     # settings persisted in localStorage
```

## Run it

ES modules + GLB loading need to be served over HTTP (opening the file
directly with `file://` will not work). Any static server is fine:

```bash
cd 3DAgent
python3 -m http.server 8000
# then open http://localhost:8000
```

Or: `npx serve` / VS Code "Live Server".

## How it works

1. **Avatar** – `assets/avatar.glb` ships with ARKit facial blendshapes
   (`jawOpen`, `mouthFunnel`, `eyeBlink_*`, …). The loader auto-detects whether
   a model uses ARKit blendshapes or Ready Player Me "Oculus" visemes, so you
   can swap in your own avatar. (Compressed KTX2 textures + meshopt are
   supported via CDN transcoders.)
2. **LLM** – sends the conversation to **OpenAI** (`/chat/completions`) or
   **Google Gemini** (`generateContent`). With no key it returns friendly
   canned replies so the full pipeline still runs.
3. **TTS + lip-sync** – the reply is spoken aloud and the mouth follows it:
   - **OpenAI**: `/audio/speech` returns an MP3 → played through Web Audio → an
     analyser reads loudness/spectrum → **real lip-sync**.
   - **Gemini**: `generateContent` with `responseModalities:["AUDIO"]` returns
     PCM audio → decoded into an `AudioBuffer` → same analyser → **real
     lip-sync**.
   - **Offline (no key)**: the browser's `speechSynthesis` voice. It exposes no
     audio stream, so the mouth uses a **word-synced procedural** motion driven
     by `onboundary` word events.
4. **Greeting** – the avatar speaks a short greeting the first time you click /
   tap / press a key (browsers block audio until a user gesture).

## Make it smart (optional) — pick a provider

Click the ⚙ icon, choose a **provider**, paste your **API key** (stored only in
your browser's localStorage; requests go straight from your machine to the
provider), then **Save**.

### Option A — Google Gemini (step by step)

1. Go to **https://aistudio.google.com/apikey** (Google AI Studio).
2. Sign in and click **Create API key** (create/select a Google Cloud project
   if asked). Copy the key.
3. In the app, open ⚙ **Settings** → set **provider** to *Google Gemini*.
4. Paste the key into **API key**.
5. (Optional) Change **Voice** (e.g. `Kore`, `Puck`, `Charon`) or **Chat
   model** (default `gemini-2.5-flash`). Leave Chat model blank to use the
   default.
6. Click **Save**, then click the scene once and start chatting.

Defaults used: chat `gemini-2.5-flash`, TTS `gemini-2.5-flash-preview-tts`
(set in `js/config.js` under `PROVIDERS.gemini`).

### Option B — OpenAI

1. Get a key at **https://platform.openai.com/api-keys**.
2. ⚙ Settings → provider *OpenAI* → paste **API key**.
3. (Optional) change **Voice** (`nova`, `alloy`, …) or **Chat model**
   (default `gpt-4o-mini`). **Base URL** can point at any OpenAI-compatible API
   (Azure OpenAI, a local LLM server, etc.).
4. **Save**, click the scene once, and chat.

## Use your own avatar

Create one at [readyplayer.me], copy the `.glb` URL, and paste it into the
**Avatar GLB URL** field. For visemes, append
`?morphTargets=Oculus%20Visemes,ARKit` to the URL. Any GLB with ARKit
blendshapes or Oculus visemes will lip-sync automatically.

## Notes

- Microphone (🎙) speech-to-text uses the Web Speech API (Chrome/Edge).
- Everything runs client-side; there is no backend.

[three.js]: https://threejs.org
[readyplayer.me]: https://readyplayer.me
