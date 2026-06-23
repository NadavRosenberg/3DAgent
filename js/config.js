// Persistent user settings (stored in localStorage).

const KEY = "hologram-avatar-settings";

export const DEFAULTS = {
  provider: "local",            // "gemini" | "local"
  apiKey: "",
  chatModel: "",                // empty => provider default (see PROVIDERS)
  ttsVoice: "",                 // empty => provider default
  avatarUrl: "./assets/avatar_fullbody.glb",
  systemPrompt:
    "You are ARIA, a friendly holographic assistant built into a smart home " +
    "appliance. Keep replies warm, concise and spoken-aloud friendly (1-3 short " +
    "sentences). Avoid markdown, lists and emoji since your words are read out loud.",
};

// Preset avatars shown in the settings panel.
// Add new entries here and they will appear automatically as preset cards.
export const AVATAR_PRESETS = [
  {
    id: "human",
    label: "Human",
    icon: "👩",
    url: "./assets/avatar_fullbody.glb",
    hint: "Full-body human, Mixamo rig",
  },
  {
    id: "robot",
    label: "Robot",
    icon: "🤖",
    url: "./assets/avatar_robot.glb",
    hint: "Expressive robot with Idle animation",
  },
  {
    id: "custom",
    label: "Custom",
    icon: "🔗",
    url: null, // signals "use the URL field below"
    hint: "Paste any GLB/GLTF URL",
  },
];

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

// Old avatar URL from before the full-body refactor — always migrate to default.
const LEGACY_AVATAR_URL = "./assets/avatar.glb";

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    // Migrate: OpenAI provider → Gemini.
    if (saved.provider === "openai") saved.provider = "gemini";
    // Migrate: old face-only avatar → new full-body default.
    if (!saved.avatarUrl || saved.avatarUrl === LEGACY_AVATAR_URL) {
      delete saved.avatarUrl; // let DEFAULTS.avatarUrl take over
    }
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
