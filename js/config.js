// Persistent user settings (stored in localStorage).

const KEY = "hologram-avatar-settings";

export const DEFAULTS = {
  provider: "local",            // "gemini" | "local"
  apiKey: "",
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
  gemini: {
    label: "Google Gemini",
    chatModel: "gemini-2.5-flash",
    ttsModel: "gemini-2.5-flash-preview-tts",
    voices: ["Kore", "Puck", "Charon", "Aoede", "Leda", "Zephyr", "Fenrir", "Sulafat"],
    defaultVoice: "Kore",
  },
  local: {
    label: "Offline demo",
    chatModel: "",
    ttsModel: "",
    voices: [],
    defaultVoice: "",
  },
};

export function providerInfo(provider) {
  return PROVIDERS[provider] || PROVIDERS.local;
}

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    // Migrate anyone who had "openai" saved — switch them to "gemini".
    if (saved.provider === "openai") saved.provider = "gemini";
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
