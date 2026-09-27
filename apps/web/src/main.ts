import "./style.css";
import { Avatar, Stage, type AvatarSource } from "@agentar/avatar";
import { BUILTIN_MODELS, DEFAULT_CONFIG, mergeConfig, type AvatarConfig, type Mood, type Utterance } from "@agentar/core";
import { BridgeClient } from "./bridge-client.js";
import { Panel, safeStorage } from "./panel.js";

const params = new URLSearchParams(location.search);
/** Clean view for OBS / virtual cameras: no panel, no orbit controls. */
const stageMode = params.has("stage");
/** Animate but stay silent (e.g. a second monitor next to the main view). */
const muted = params.has("mute");

document.body.classList.toggle("stage-mode", stageMode);
const captionsPref = params.get("captions") ?? safeStorage("agentar.captions");
document.body.classList.toggle("captions", captionsPref === null ? !stageMode : captionsPref === "1");

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const stageEl = $("#stage");
const overlay = $("#overlay");
const overlayText = $("#overlay-text");
const progress = $<HTMLProgressElement>("#progress");
const caption = $("#caption");
const unlockEl = $("#unlock");

const stage = new Stage(stageEl, { interactive: !stageMode });
const client = new BridgeClient();
let config: AvatarConfig = DEFAULT_CONFIG;
let loadedModelKey = "";
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const panel = new Panel({
  client,
  config: () => config,
  patch(p) {
    applyConfig(mergeConfig(config, p));
    // Persist the whole (valid) config shortly after the last change.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      client.updateConfig(config).catch((err: Error) => panel.setTalkStatus(`Could not save: ${err.message}`));
    }, 250);
  },
  gesture(g) {
    stage.currentAvatar?.playGesture(g);
    void fetch("/api/gesture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gesture: g }) });
  },
  mood(m) {
    this.patch({ behavior: { mood: m } });
  },
});
if (!stageMode) document.body.append(panel.el);
// Dev builds expose the stage for debugging from the console and browser automation.
if (import.meta.env.DEV) Object.assign(window, { agentar: { stage } });

function applyConfig(next: AvatarConfig): void {
  config = next;
  stage.applyConfig(config);
  panel.sync(config);
  document.title = `${config.name} · agentar`;
  void ensureModel(config);
}

function modelSource(c: AvatarConfig): AvatarSource {
  if (c.model.source === "builtin") {
    const id = c.model.id;
    const builtin = BUILTIN_MODELS.find((m) => m.id === id) ?? BUILTIN_MODELS[0]!;
    return { url: `/models/${builtin.file}`, builtin };
  }
  return { url: c.model.url, format: c.model.format };
}

async function ensureModel(c: AvatarConfig): Promise<void> {
  const key = JSON.stringify(c.model);
  if (key === loadedModelKey) return;
  loadedModelKey = key;
  const source = modelSource(c);
  showOverlay("Loading avatar…", 0);
  try {
    // Ignore progress from a load that a newer model choice has replaced.
    const avatar = await Avatar.load(source, (f) => {
      if (loadedModelKey === key) showOverlay("Loading avatar…", f);
    });
    if (loadedModelKey !== key) {
      avatar.dispose(); // a newer model was selected while this one loaded
      return;
    }
    stage.setAvatar(avatar);
    overlay.hidden = true;
  } catch (err) {
    if (loadedModelKey !== key) return;
    const missing = /404|not found/i.test(String((err as Error).message)) || c.model.source === "builtin";
    showOverlay(
      missing
        ? `Couldn't load ${source.url}. Download the built-in avatars with: agentar fetch-models`
        : `Couldn't load the avatar: ${(err as Error).message}`,
      null,
    );
    console.error("[agentar] model load failed", err);
  }
}

function showOverlay(text: string, fraction: number | null): void {
  overlay.hidden = false;
  overlayText.textContent = text;
  progress.hidden = fraction === null;
  if (fraction !== null) progress.value = fraction;
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

function audioBlocked(utt: Utterance): boolean {
  if (utt.audio) return !stage.speech.audioReady;
  // Chrome requires one user interaction before speechSynthesis works.
  return "userActivation" in navigator && !navigator.userActivation.hasBeenActive;
}

async function speak(utt: Utterance): Promise<void> {
  if (audioBlocked(utt)) {
    unlockEl.hidden = false;
    client.send({ type: "speech-end", id: utt.id, error: "Audio is blocked by the browser. Click the agentar page once to enable sound." });
    return;
  }
  const avatar = stage.currentAvatar;
  const restoreMood: Mood = config.behavior.mood;
  if (utt.mood) avatar?.setMood(utt.mood);
  caption.textContent = utt.text;
  caption.classList.add("visible");
  client.send({ type: "speech-start", id: utt.id });
  try {
    const voice = muted ? { ...config.voice, volume: 0 } : config.voice;
    const result = await stage.speech.play(utt, voice);
    client.send({ type: "speech-end", id: utt.id, interrupted: result.interrupted });
  } catch (err) {
    console.error("[agentar] speech failed", err);
    client.send({ type: "speech-end", id: utt.id, error: (err as Error).message });
  } finally {
    if (utt.mood && stage.currentAvatar === avatar) avatar?.setMood(restoreMood);
    if (!stage.speech.speaking) caption.classList.remove("visible");
  }
}

// Browsers only allow audio after a user gesture.
const unlock = () => {
  void stage.speech.unlock().then(() => {
    unlockEl.hidden = true;
  });
};
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);
// OBS and kiosk browsers allow autoplay; try right away.
stage.speech
  .unlock()
  .then(() => (unlockEl.hidden = stage.speech.audioReady))
  .catch(() => undefined);
setTimeout(() => {
  if (!stage.speech.audioReady && !stageMode) unlockEl.hidden = false;
}, 1500);

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

client.onState = (state) => {
  panel.setConnection(state);
  if (state === "open") {
    client.models().then((m) => panel.setModels(m)).catch(() => undefined);
    client.info().then((i) => panel.setInfo(i)).catch(() => undefined);
  }
};

client.onMessage = (msg) => {
  switch (msg.type) {
    case "hello":
    case "config":
      // Ignore echoes while a local edit is waiting to be saved.
      if (!saveTimer) applyConfig(msg.config);
      break;
    case "speak":
      void speak(msg.utterance);
      break;
    case "stop":
      stage.speech.stop();
      break;
    case "mood":
      stage.currentAvatar?.setMood(msg.mood);
      break;
    case "gesture":
      stage.currentAvatar?.playGesture(msg.gesture);
      break;
  }
};

window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
  if (!typing && e.key.toLowerCase() === "h" && !stageMode) document.body.classList.toggle("panel-hidden");
});

applyConfig(config);
client.connect();

// Handy for debugging and automated checks.
Object.assign(window, { agentar: { stage, client, config: () => config } });
