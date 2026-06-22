// Chat with Google Gemini (or canned offline replies).
//
// streamChat() is an async generator that yields text tokens as they arrive
// from Gemini's SSE stream, then yields a final { _stats } sentinel with
// token-usage data for the stats row in the UI.

import { providerInfo } from "./config.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const CANNED = [
  "Hi there! I'm your holographic home assistant. Add a Gemini API key in settings to unlock real conversations.",
  "Sure thing. I'm running in offline demo mode right now, but my voice and lip-sync are fully working.",
  "Got it. Open the settings panel (⚙) and paste your Google Gemini API key to get started.",
  "Happy to help around the house! What would you like me to do next?",
];

function cannedReply(history) {
  const last = history[history.length - 1]?.content || "";
  if (/time/i.test(last)) return `It's ${new Date().toLocaleTimeString()} right now.`;
  if (/\b(hi|hello|hey)\b/i.test(last)) return CANNED[0];
  return CANNED[Math.floor(Math.random() * CANNED.length)];
}

// ── Streaming ─────────────────────────────────────────────────────────────
export async function* streamChat(settings, history) {
  if (settings.provider === "gemini" && settings.apiKey) {
    yield* streamGemini(settings, history);
    return;
  }
  yield cannedReply(history);
}

async function* streamGemini(settings, history) {
  const model    = settings.chatModel || providerInfo("gemini").chatModel;
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

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
  let lastUsageMeta = null;

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
        if (chunk.usageMetadata) lastUsageMeta = chunk.usageMetadata;
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        const text  = parts.map((p) => p.text || "").join("");
        if (text) yield text;
      } catch { /* skip malformed events */ }
    }
  }

  if (lastUsageMeta) {
    yield {
      _stats: true,
      model,
      promptTokens:     lastUsageMeta.promptTokenCount,
      completionTokens: lastUsageMeta.candidatesTokenCount
        ?? (lastUsageMeta.totalTokenCount - lastUsageMeta.promptTokenCount),
    };
  }
}

// ── Non-streaming convenience wrapper (greeting / offline) ────────────────
export async function chat(settings, history) {
  let full = "";
  for await (const token of streamChat(settings, history)) {
    if (token && typeof token === "object") continue; // skip stats sentinel
    full += token;
  }
  return full || "…";
}
