// Persistent user settings (stored in localStorage).

const KEY = "hologram-avatar-settings";

export const DEFAULTS = {
  provider: "local",            // "openai" | "gemini" | "local"
  apiKey: "",
  baseUrl: "https://api.openai.com/v1", // OpenAI-compatible only
  chatModel: "",                // empty => provider default (see PROVIDERS)
  ttsVoice: "",                 // empty => provider default
  avatarUrl: "./assets/avatar.glb",
  systemPrompt:
    "You are ARIA, a friendly holographic assistant built into a smart home " +
    "appliance. Keep replies warm, concise and spoken-aloud friendly (1-3 short " +
    "sentences). Avoid markdown, lists and emoji since your words are read out loud.",
};

// Per-provider defaults + voice lists used to populate the settings UI.
export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    chatModel: "gpt-4o-mini",
    ttsModel: "gpt-4o-mini-tts",
    voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    defaultVoice: "nova",
    needsBaseUrl: true,
  },
  gemini: {
    label: "Google Gemini",
    chatModel: "gemini-2.5-flash",
    ttsModel: "gemini-2.5-flash-preview-tts",
    voices: ["Kore", "Puck", "Charon", "Aoede", "Leda", "Zephyr", "Fenrir", "Sulafat"],
    defaultVoice: "Kore",
    needsBaseUrl: false,
  },
  local: {
    label: "Offline demo",
    chatModel: "",
    ttsModel: "",
    voices: [],
    defaultVoice: "",
    needsBaseUrl: false,
  },
};

export function providerInfo(provider) {
  return PROVIDERS[provider] || PROVIDERS.local;
}

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
