// Chat with OpenAI-compatible or Google Gemini.
//
// streamChat() is an async generator that yields text *tokens* as they arrive
// from the provider's SSE stream. The caller accumulates them into sentences
// and feeds them to the TTS pipeline in real time.
//
// chat() is the non-streaming wrapper kept for the offline/greeting path.

import { providerInfo } from "./config.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const CANNED = [
  "Hi there! I'm your holographic home assistant. Connect an API key in settings and I'll get a lot smarter.",
  "Sure thing. I'm running in offline demo mode right now, but my voice and lip-sync are fully working.",
  "Got it. Add an OpenAI or Gemini key in the settings panel to unlock real conversations.",
  "Happy to help around the house! What would you like me to do next?",
];

function cannedReply(history) {
  const last = history[history.length - 1]?.content || "";
  if (/time/i.test(last)) return `It's ${new Date().toLocaleTimeString()} right now.`;
  if (/\b(hi|hello|hey)\b/i.test(last)) return CANNED[0];
  return CANNED[Math.floor(Math.random() * CANNED.length)];
}

// ── Streaming (primary path) ──────────────────────────────────────────────
// Yields string tokens as they arrive from the model's SSE stream.
export async function* streamChat(settings, history) {
  if (settings.provider === "openai" && settings.apiKey) {
    yield* streamOpenAI(settings, history);
    return;
  }
  if (settings.provider === "gemini" && settings.apiKey) {
    yield* streamGemini(settings, history);
    return;
  }
  yield cannedReply(history);
}

async function* streamOpenAI(settings, history) {
  const base  = (settings.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = settings.chatModel || providerInfo("openai").chatModel;

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model, temperature: 0.7, stream: true,
      messages: [{ role: "system", content: settings.systemPrompt }, ...history],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;
      try {
        const token = JSON.parse(data).choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch { /* skip bad JSON */ }
    }
  }
}

async function* streamGemini(settings, history) {
  const model    = settings.chatModel || providerInfo("gemini").chatModel;
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // alt=sse returns server-sent events; each event has a partial candidate.
  const res = await fetch(
    `${GEMINI_BASE}/models/${model}:streamGenerateContent?key=${encodeURIComponent(settings.apiKey)}&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: settings.systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.7 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        const text  = parts.map((p) => p.text || "").join("");
        if (text) yield text;
      } catch { /* skip */ }
    }
  }
}

// ── Non-streaming convenience wrapper (greeting / offline) ────────────────
export async function chat(settings, history) {
  let full = "";
  for await (const token of streamChat(settings, history)) full += token;
  return full || "…";
}
