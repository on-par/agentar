import {
  CHAT_CONNECTORS,
  CHAT_CONNECTOR_INFO,
  FRAMINGS,
  GESTURES,
  GLASSES,
  HATS,
  LIGHTINGS,
  MOODS,
  VOICE_PROVIDERS,
  toSpeakable,
  type AvatarConfig,
  type ChatConfigView,
  type ChatConnectorId,
  type ChatMessage,
  type ChatSettingKey,
  type Gesture,
  type Mood,
  type VoiceInfo,
} from "@agentar/core";
import { browserVoices } from "@agentar/avatar";
import type { BridgeClient, BridgeInfo, ConnectionState, ModelList } from "./bridge-client.js";
import { AUDIO_NOTE, joinACallSteps, RECALL_DOCS_URL, SKILL_NAME, skillDirFromCli, SPEECH_NOTE, stageUrl } from "./join-a-call.js";

type Patch = Record<string, unknown>;
type Syncer = (c: AvatarConfig) => void;

export interface PanelDeps {
  client: BridgeClient;
  config(): AvatarConfig;
  /** Apply a partial config locally and persist it via the bridge. */
  patch(p: Patch): void;
  gesture(g: Gesture): void;
  mood(m: Mood): void;
}

const LABELS: Record<string, string> = {
  system: "System (offline)",
  browser: "Browser (Web Speech)",
  edge: "Microsoft Edge (online)",
  kokoro: "Kokoro (local server)",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  xai: "Grok (xAI)",
  none: "None",
  model: "Model's own",
  round: "Round",
  square: "Square",
  beanie: "Beanie",
  cap: "Cap",
  head: "Head",
  bust: "Head & shoulders",
  full: "Full body",
  studio: "Studio",
  warm: "Warm",
  cool: "Cool",
  dramatic: "Dramatic",
};

const SWATCHES: Record<string, string[]> = {
  skin: ["#f3d4c0", "#e5b598", "#c98e6a", "#a06a48", "#6e4630", "#4a2e20"],
  hair: ["#1c1714", "#4a3020", "#8a5a30", "#d8b070", "#b04a2a", "#9aa0a8"],
  eyes: ["#3a2a1c", "#6a4a2a", "#3a6a4a", "#3a5a8a", "#7a8a9a"],
  top: ["#20242c", "#e8e8e8", "#2d5aa0", "#3a7a5a", "#a03a3a", "#c89a3a"],
  bottom: ["#1a1e26", "#3a3a3a", "#2a3a5a", "#6a5a4a", "#d8d0c0"],
  shoes: ["#101010", "#f0f0f0", "#5a3a2a", "#2a3a6a"],
};

/** Minimal element builder. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; dataset?: Record<string, string> } = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, dataset, ...rest } = props;
  if (cls) el.className = cls;
  if (dataset) Object.assign(el.dataset, dataset);
  Object.assign(el, rest);
  for (const c of children) if (c != null) el.append(c);
  return el;
}

/** The customisation side panel. */
export class Panel {
  readonly el: HTMLElement;
  private readonly syncers: Syncer[] = [];
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly modelSelect: HTMLSelectElement;
  private readonly voiceSelect: HTMLSelectElement;
  private readonly voiceNote: HTMLElement;
  private readonly talkStatus: HTMLElement;
  private voicesFor = "";
  private models: ModelList = { builtin: [], user: [] };
  private readonly snippets = h("div", { class: "snippets" }, h("p", { class: "note", textContent: "Waiting for the bridge…" }));
  private readonly chat = {
    view: null as ChatConfigView | null,
    connector: h("select", { ariaLabel: "Agent" }),
    help: h("p", { class: "note" }),
    gap: h("p", { class: "note warn" }),
    settings: h("div", { class: "chat-fields" }),
    settingsStatus: h("p", { class: "note", role: "status" }),
    log: h("div", { class: "chat-log", role: "log", ariaLive: "polite" }),
    input: h("textarea", { rows: 3, placeholder: "Message your agent…" }),
    send: h("button", { type: "button", class: "primary", textContent: "Send" }),
    sayReplies: h("input", { type: "checkbox" }),
    status: h("p", { class: "note", role: "status" }),
    /** One conversation per connector, so switching agents does not lose a chat. */
    conversations: new Map<ChatConnectorId, { id: string; messages: ChatMessage[]; log: HTMLElement[] }>(),
    pending: null as AbortController | null,
  };

  constructor(private readonly deps: PanelDeps) {
    this.statusDot = h("span", { class: "dot" });
    this.statusText = h("span", { textContent: "Connecting…" });
    this.modelSelect = h("select", { id: "model" });
    this.voiceSelect = h("select", { id: "voice" });
    this.voiceNote = h("p", { class: "note" });
    this.talkStatus = h("p", { class: "note", role: "status" });

    const tabs = [
      { id: "talk", label: "Talk", body: this.talkTab() },
      { id: "chat", label: "Chat", body: this.chatTab() },
      { id: "look", label: "Look", body: this.lookTab() },
      { id: "voice", label: "Voice", body: this.voiceTab() },
      { id: "behavior", label: "Behavior", body: this.behaviorTab() },
      { id: "scene", label: "Scene", body: this.sceneTab() },
      { id: "connect", label: "Connect", body: this.connectTab() },
    ];
    const tabBar = h("nav", { class: "tabs", role: "tablist" });
    const bodies = h("div", { class: "tab-bodies" });
    const saved = safeStorage("agentar.tab") ?? "talk";
    for (const t of tabs) {
      const btn = h("button", { type: "button", textContent: t.label, role: "tab", dataset: { tab: t.id } });
      const body = h("section", { class: "tab-body", role: "tabpanel", dataset: { tab: t.id } }, ...t.body);
      const select = () => {
        tabBar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
        bodies.querySelectorAll<HTMLElement>(".tab-body").forEach((b) => (b.hidden = b !== body));
        safeStorage("agentar.tab", t.id);
      };
      btn.addEventListener("click", select);
      tabBar.append(btn);
      bodies.append(body);
      if (t.id === saved) queueMicrotask(select);
    }

    const nameInput = h("input", { type: "text", maxLength: 64, class: "name-input", ariaLabel: "Avatar name" });
    nameInput.addEventListener("change", () => this.deps.patch({ name: nameInput.value }));
    this.syncers.push((c) => {
      if (document.activeElement !== nameInput) nameInput.value = c.name;
    });

    const collapse = h("button", { type: "button", class: "collapse", title: "Hide panel (H)", textContent: "⟩" });
    collapse.addEventListener("click", () => document.body.classList.toggle("panel-hidden"));

    this.el = h(
      "aside",
      { class: "panel" },
      h(
        "header",
        {},
        h("div", { class: "brand" }, h("span", { class: "logo", textContent: "agentar" }), nameInput),
        h("div", { class: "status" }, this.statusDot, this.statusText),
        collapse,
      ),
      tabBar,
      bodies,
    );
  }

  sync(config: AvatarConfig): void {
    for (const s of this.syncers) s(config);
    const key = config.voice.provider;
    if (key !== this.voicesFor) void this.loadVoices(key);
  }

  setConnection(state: ConnectionState, clients?: number): void {
    this.statusDot.dataset.state = state;
    this.statusText.textContent =
      state === "open" ? `Bridge connected${clients && clients > 1 ? ` · ${clients} views` : ""}` : state === "connecting" ? "Connecting…" : "Bridge offline — retrying";
  }

  setTalkStatus(text: string): void {
    this.talkStatus.textContent = text;
  }

  setModels(list: ModelList): void {
    this.models = list;
    this.renderModelOptions(this.deps.config());
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  private talkTab(): Node[] {
    const text = h("textarea", {
      rows: 5,
      placeholder: "Type something for your agent to say…",
      value: "Hi! I'm your agent. I can talk while you work, and I'll let you know when I'm done.",
    });
    const speak = h("button", { type: "button", class: "primary", textContent: "Speak" });
    const stop = h("button", { type: "button", textContent: "Stop" });
    const run = async () => {
      const t = text.value.trim();
      if (!t) return;
      speak.disabled = true;
      this.setTalkStatus("Rendering speech…");
      try {
        const res = await this.deps.client.say({ text: t });
        this.setTalkStatus(res.status === "queued" ? "" : res.error ?? res.status);
      } catch (err) {
        this.setTalkStatus((err as Error).message);
      } finally {
        speak.disabled = false;
      }
    };
    speak.addEventListener("click", run);
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
    });
    stop.addEventListener("click", () => void this.deps.client.stop());

    const moods = h("div", { class: "chips" });
    for (const m of MOODS) {
      const b = h("button", { type: "button", textContent: m, dataset: { mood: m } });
      b.addEventListener("click", () => this.deps.mood(m));
      moods.append(b);
    }
    this.syncers.push((c) => moods.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mood === c.behavior.mood)));

    const gestures = h("div", { class: "chips" });
    for (const g of GESTURES) {
      const b = h("button", { type: "button", textContent: g.replace("-", " ") });
      b.addEventListener("click", () => this.deps.gesture(g));
      gestures.append(b);
    }

    return [
      field("Say something", text),
      h("div", { class: "row" }, speak, stop, h("span", { class: "hint", textContent: "⌘/Ctrl + Enter" })),
      this.talkStatus,
      field("Mood", moods),
      field("Gesture", gestures),
    ];
  }

  private chatTab(): Node[] {
    const c = this.chat;
    c.connector.append(
      ...CHAT_CONNECTORS.map((id) => {
        const info = CHAT_CONNECTOR_INFO[id];
        const suffix = info.transport === "none" ? " — can't chat yet" : info.transport === "agentmail" ? " — email, experimental" : "";
        return h("option", { value: id, textContent: info.label + suffix });
      }),
    );
    c.connector.addEventListener("change", () => {
      const id = c.connector.value as ChatConnectorId;
      this.renderChatConnector(id);
      void this.saveChat({ connector: id });
    });
    c.sayReplies.addEventListener("change", () => void this.saveChat({ sayReplies: c.sayReplies.checked }));

    c.send.addEventListener("click", () => void this.sendChat());
    c.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.sendChat();
      }
    });
    const reset = h("button", { type: "button", textContent: "New chat" });
    reset.addEventListener("click", () => {
      c.pending?.abort();
      c.conversations.delete(this.chatConnector());
      this.renderChatLog();
    });

    const settings = h("details", { class: "chat-settings" }, h("summary", { textContent: "Connection settings" }), c.settings, c.settingsStatus);
    this.renderChatConnector("openclaw");
    return [
      field("Agent", c.connector),
      c.help,
      c.gap,
      settings,
      c.log,
      c.input,
      h("div", { class: "row" }, c.send, reset, h("label", { class: "check hint" }, c.sayReplies, " Speak replies")),
      c.status,
    ];
  }

  /** Load the saved chat settings (keys stay in the bridge; we only learn whether one is set). */
  async loadChat(): Promise<void> {
    try {
      this.applyChatView(await this.deps.client.chatConfig());
    } catch (err) {
      this.chat.status.textContent = `Could not load chat settings: ${(err as Error).message}`;
    }
  }

  private applyChatView(view: ChatConfigView): void {
    const c = this.chat;
    c.view = view;
    c.sayReplies.checked = view.sayReplies;
    if (c.connector.value !== view.connector) c.connector.value = view.connector;
    this.renderChatConnector(view.connector);
  }

  private async saveChat(patch: unknown): Promise<boolean> {
    try {
      this.applyChatView(await this.deps.client.updateChatConfig(patch));
      return true;
    } catch (err) {
      this.chat.settingsStatus.textContent = `Could not save: ${(err as Error).message}`;
      return false;
    }
  }

  private chatConnector(): ChatConnectorId {
    return this.chat.connector.value as ChatConnectorId;
  }

  /** Show the help, caveats and settings of the selected connector. */
  private renderChatConnector(id: ChatConnectorId): void {
    const c = this.chat;
    const info = CHAT_CONNECTOR_INFO[id];
    const saved = c.view?.connectors[id];
    c.help.textContent = info.help;
    c.gap.textContent = info.gap ?? "";
    c.send.disabled = info.transport === "none" || c.pending !== null;
    c.input.disabled = info.transport === "none";
    c.input.placeholder = info.transport === "none" ? `${info.label} cannot chat through Agentar yet.` : `Message ${info.label}…`;
    c.settingsStatus.textContent = "";
    this.renderChatLog();

    const labels: Record<ChatSettingKey, string> = {
      baseUrl: "Base URL",
      model: "Model",
      apiKey: info.apiKeyLabel ?? "API key",
      inbox: "Your AgentMail inbox",
      to: `${info.label} email address`,
    };
    const inputs = new Map<ChatSettingKey, HTMLInputElement>();
    const rows = info.fields.map((key) => {
      const input = h("input", { type: key === "apiKey" ? "password" : "text", autocomplete: "off", spellcheck: false });
      if (key === "apiKey") {
        input.placeholder = saved?.apiKeyFromEnv ? `Using ${info.apiKeyEnv}` : saved?.apiKeySet ? "Saved (type to replace)" : "Not set";
      } else {
        input.value = saved?.[key] ?? "";
        input.placeholder = info.defaults[key] || (key === "inbox" ? "you@agentmail.to" : key === "to" ? "bot@yourworkspace.agentmail.to" : "");
      }
      inputs.set(key, input);
      return field(labels[key], input);
    });
    if (!rows.length) {
      c.settings.replaceChildren(h("p", { class: "note", textContent: "Nothing to set up: this agent has no chat connection." }));
      return;
    }
    const save = h("button", { type: "button", textContent: "Save" });
    save.addEventListener("click", async () => {
      const patch: Record<string, string> = {};
      for (const [key, input] of inputs) {
        // An empty key field keeps the saved key.
        if (key !== "apiKey" || input.value.trim()) patch[key] = input.value.trim();
      }
      const hadKey = saved?.apiKeySet && !saved.apiKeyFromEnv;
      if (!(await this.saveChat({ connectors: { [id]: patch } }))) return;
      const lostKey = hadKey && !this.chat.view?.connectors[id].apiKeySet;
      this.chat.settingsStatus.textContent = lostKey ? "Saved. The base URL changed, so the saved key was removed: paste it again." : "Saved.";
    });
    const buttons = h("div", { class: "row" }, save);
    if (saved?.apiKeySet && !saved.apiKeyFromEnv) {
      const forget = h("button", { type: "button", class: "ghost", textContent: "Forget key" });
      forget.addEventListener("click", async () => {
        if (await this.saveChat({ connectors: { [id]: { apiKey: "" } } })) this.chat.settingsStatus.textContent = "Key removed.";
      });
      buttons.append(forget);
    }
    const env = info.apiKeyEnv ? h("p", { class: "note", textContent: `Or set ${info.apiKeyEnv} where the bridge runs.` }) : null;
    c.settings.replaceChildren(...rows, ...(env ? [env] : []), buttons);
  }

  private conversation(id: ChatConnectorId) {
    let conv = this.chat.conversations.get(id);
    if (!conv) {
      conv = { id: crypto.randomUUID(), messages: [], log: [] };
      this.chat.conversations.set(id, conv);
    }
    return conv;
  }

  private renderChatLog(): void {
    const conv = this.conversation(this.chatConnector());
    this.chat.log.replaceChildren(...conv.log);
    this.chat.log.hidden = conv.log.length === 0;
    this.chat.log.scrollTop = this.chat.log.scrollHeight;
  }

  private chatBubble(id: ChatConnectorId, kind: "user" | "assistant" | "error", text: string): HTMLElement {
    const bubble = h("div", { class: `msg ${kind}`, textContent: text });
    this.conversation(id).log.push(bubble);
    if (this.chatConnector() === id) this.renderChatLog();
    return bubble;
  }

  private async sendChat(): Promise<void> {
    const c = this.chat;
    const text = c.input.value.trim();
    const id = this.chatConnector();
    const info = CHAT_CONNECTOR_INFO[id];
    if (!text || c.pending || info.transport === "none") return;
    const conv = this.conversation(id);
    conv.messages.push({ role: "user", content: text });
    this.chatBubble(id, "user", text);
    c.input.value = "";
    const bubble = this.chatBubble(
      id,
      "assistant",
      info.transport === "agentmail" ? `Emailed ${info.label}. Waiting for the reply (this can take minutes)…` : "…",
    );
    bubble.classList.add("pending");
    const abort = (c.pending = new AbortController());
    c.send.disabled = true;
    c.status.textContent = "";
    let streamed = "";
    try {
      const res = await this.deps.client.chat(
        { connector: id, messages: conv.messages, conversation: conv.id },
        (delta) => {
          streamed += delta;
          bubble.textContent = streamed;
          bubble.classList.remove("pending");
          if (this.chatConnector() === id) c.log.scrollTop = c.log.scrollHeight;
        },
        abort.signal,
      );
      bubble.textContent = res.reply;
      bubble.classList.remove("pending");
      conv.messages.push({ role: "assistant", content: res.reply });
      if (c.sayReplies.checked) {
        const said = await this.deps.client.say({ text: toSpeakable(res.reply, { maxChars: 1200 }) });
        if (said.status !== "queued") c.status.textContent = `The avatar could not speak the reply: ${said.error ?? said.status}`;
      }
    } catch (err) {
      // Take the failed message out of the history so a retry does not send it twice.
      conv.messages.pop();
      if (abort.signal.aborted) {
        bubble.remove();
      } else {
        bubble.className = "msg error";
        bubble.textContent = (err as Error).message;
        if (!c.input.value) c.input.value = text;
      }
    } finally {
      c.pending = null;
      c.send.disabled = CHAT_CONNECTOR_INFO[this.chatConnector()].transport === "none";
    }
  }

  private lookTab(): Node[] {
    this.modelSelect.addEventListener("change", () => {
      const v = this.modelSelect.value;
      if (v.startsWith("builtin:")) this.deps.patch({ model: { source: "builtin", id: v.slice(8) } });
      else if (v.startsWith("url:")) {
        const url = v.slice(4);
        this.deps.patch({ model: { source: "url", url, format: url.toLowerCase().endsWith(".vrm") ? "vrm" : "glb" } });
      }
    });
    this.syncers.push((c) => this.renderModelOptions(c));

    const upload = h("input", { type: "file", accept: ".glb,.vrm", hidden: true });
    const uploadBtn = h("button", { type: "button", textContent: "Upload .glb / .vrm…" });
    uploadBtn.addEventListener("click", () => upload.click());
    upload.addEventListener("change", async () => {
      const file = upload.files?.[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.textContent = "Uploading…";
      try {
        const saved = await this.deps.client.uploadModel(file);
        this.setModels(await this.deps.client.models());
        this.deps.patch({ model: { source: "url", url: saved.url, format: saved.name.toLowerCase().endsWith(".vrm") ? "vrm" : "glb" } });
      } catch (err) {
        alertInline(uploadBtn, (err as Error).message);
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = "Upload .glb / .vrm…";
        upload.value = "";
      }
    });

    const colors = (["skin", "hair", "eyes", "top", "bottom", "shoes"] as const).map((slot) =>
      this.colorField(slot[0]!.toUpperCase() + slot.slice(1), slot),
    );

    return [
      field("Body", this.modelSelect),
      h("div", { class: "row" }, uploadBtn, upload),
      h("p", { class: "note", textContent: "Any humanoid GLB with ARKit/Oculus visemes (Avaturn, MPFB, Character Creator…) or a VRM works." }),
      ...colors,
      this.selectField("Glasses", GLASSES, (c) => c.appearance.glasses, (v) => ({ appearance: { glasses: v } })),
      this.selectField("Hat", HATS, (c) => c.appearance.hat, (v) => ({ appearance: { hat: v } })),
      this.colorInput("Accessory color", (c) => c.appearance.accessoryColor, (v) => ({ appearance: { accessoryColor: v } })),
      this.slider("Height", 0.85, 1.15, 0.01, (c) => c.appearance.height, (v) => ({ appearance: { height: v } }), (v) => `${Math.round(v * 100)}%`),
    ];
  }

  private voiceTab(): Node[] {
    const provider = this.selectField("Engine", VOICE_PROVIDERS, (c) => c.voice.provider, (v) => ({ voice: { provider: v, voice: "" } }));
    this.voiceSelect.addEventListener("change", () => this.deps.patch({ voice: { voice: this.voiceSelect.value } }));
    this.syncers.push((c) => {
      if (this.voiceSelect.value !== c.voice.voice) this.voiceSelect.value = c.voice.voice;
    });
    const test = h("button", { type: "button", class: "primary", textContent: "Test voice" });
    test.addEventListener("click", () => {
      const name = this.deps.config().name;
      void this.deps.client.say({ text: `Hi, I'm ${name}. This is what I sound like. Pretty good, right?` }).then((r) => {
        if (r.status !== "queued") this.voiceNote.textContent = r.error ?? r.status;
      });
    });
    return [
      provider,
      field("Voice", this.voiceSelect),
      this.voiceNote,
      this.slider("Speed", 0.5, 2, 0.05, (c) => c.voice.rate, (v) => ({ voice: { rate: v } }), (v) => `${v.toFixed(2)}×`),
      this.slider("Pitch (browser engine)", 0.5, 2, 0.05, (c) => c.voice.pitch, (v) => ({ voice: { pitch: v } }), (v) => `${v.toFixed(2)}×`),
      this.slider("Volume", 0, 1, 0.05, (c) => c.voice.volume, (v) => ({ voice: { volume: v } }), (v) => `${Math.round(v * 100)}%`),
      h("div", { class: "row" }, test),
    ];
  }

  private behaviorTab(): Node[] {
    return [
      this.selectField("Resting mood", MOODS, (c) => c.behavior.mood, (v) => ({ behavior: { mood: v } })),
      this.slider("Expressiveness", 0, 1, 0.05, (c) => c.behavior.expressiveness, (v) => ({ behavior: { expressiveness: v } }), pct),
      this.slider("Idle motion", 0, 1, 0.05, (c) => c.behavior.idleMotion, (v) => ({ behavior: { idleMotion: v } }), pct),
      this.slider("Eye contact", 0, 1, 0.05, (c) => c.behavior.eyeContact, (v) => ({ behavior: { eyeContact: v } }), pct),
    ];
  }

  private sceneTab(): Node[] {
    const floor = h("input", { type: "checkbox" });
    floor.addEventListener("change", () => this.deps.patch({ scene: { showFloor: floor.checked } }));
    this.syncers.push((c) => (floor.checked = c.scene.showFloor));
    const captions = h("input", { type: "checkbox", checked: document.body.classList.contains("captions") });
    captions.addEventListener("change", () => {
      document.body.classList.toggle("captions", captions.checked);
      safeStorage("agentar.captions", captions.checked ? "1" : "0");
    });
    return [
      this.selectField("Framing", FRAMINGS, (c) => c.scene.framing, (v) => ({ scene: { framing: v } })),
      this.selectField("Lighting", LIGHTINGS, (c) => c.scene.lighting, (v) => ({ scene: { lighting: v } })),
      this.colorInput("Background", (c) => c.scene.background, (v) => ({ scene: { background: v } })),
      h("label", { class: "check" }, floor, " Floor shadow"),
      h("label", { class: "check" }, captions, " Show captions"),
    ];
  }

  private connectTab(): Node[] {
    return [
      h("p", { class: "note", textContent: "Keep this page open. Agents talk to the bridge, and every open avatar view speaks." }),
      this.snippets,
    ];
  }

  /** Fill the Connect tab with commands that point at this install. */
  setInfo(info: BridgeInfo): void {
    const origin = location.port === "5173" ? info.url : location.origin;
    const cli = `node ${shellQuote(info.cliPath)}`;
    const snippet = (title: string, code: string, note?: string, extra?: Node) => {
      const pre = h("pre", {}, h("code", { textContent: code }));
      const copy = h("button", { type: "button", class: "copy", textContent: "Copy" });
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(code).catch(() => undefined);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      return h(
        "div",
        { class: "snippet" },
        h("div", { class: "snippet-head" }, h("strong", { textContent: title }), h("span", { class: "snippet-actions" }, extra, copy)),
        pre,
        note ? h("p", { class: "note", textContent: note }) : null,
      );
    };
    const heading = (text: string) => h("h3", { class: "snippets-title", textContent: text });
    const stage = stageUrl(origin);
    const skillDir = skillDirFromCli(info.cliPath);
    this.snippets.replaceChildren(
      h(
        "div",
        { class: "join-call" },
        heading("Join a call · Zoom, Discord"),
        h("p", {
          class: "note",
          textContent:
            "Put agentar on camera. OBS turns this avatar into a webcam, so OpenClaw (or any agent) shows up in Zoom or Discord as agentar. Teams and Meet work the same way. Keep this page and the bridge running during the call.",
        }),
        snippet("Stage URL (the camera view)", stage, undefined, h("a", { class: "copy link-button", href: stage, target: "_blank", rel: "noopener", textContent: "Open stage" })),
        h("ol", { class: "steps" }, ...joinACallSteps(stage).map((s) => h("li", { textContent: s }))),
        h("p", { class: "note", textContent: AUDIO_NOTE }),
        h("p", { class: "note", textContent: SPEECH_NOTE }),
        h("p", { class: "note" }, "Zoom bot instead of OBS? ", h("a", { href: RECALL_DOCS_URL, target: "_blank", rel: "noopener", textContent: "Meeting bot (Recall spike)" })),
        snippet(
          "OpenClaw: install the Join-a-call skill",
          `openclaw skills install ${skillDir ? shellQuote(skillDir) : `<agentar>/skills/${SKILL_NAME}`}`,
          'Then ask OpenClaw to "join my Zoom call as agentar". If OBS is open with its WebSocket server on, the skill builds an "Agentar Stage" scene and starts the Virtual Camera for you; otherwise it walks you through the steps above.',
        ),
      ),
      heading("Talking agents (people path)"),
      h("p", {
        class: "note",
        textContent:
          "OpenClaw, Hermes, Grok Bot, Muse, or any agent that can send a web request: have it POST each reply to this address and the avatar speaks it.",
      }),
      snippet(
        "Make the avatar speak",
        `curl -X POST ${origin}/api/say -H "Content-Type: application/json" -d '{"text":"Hi! I am here.","mood":"happy"}'`,
        'Optional fields: "mood", "wait": true (answer after the avatar finishes), "interrupt": false (queue instead of cutting in).',
      ),
      heading("Chat with your agent"),
      h("p", {
        class: "note",
        textContent:
          "Open the Chat tab and pick OpenClaw, Hermes, Grok Bot, or Advanced (any OpenAI-compatible server). The bridge calls the agent for you, so keys stay on this machine. Muse has no chat API yet; it can still speak through /api/say.",
      }),
      snippet(
        "OpenClaw: turn on the chat endpoint",
        `{ "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }`,
        "Merge into ~/.openclaw/openclaw.json and restart the gateway. The token is gateway.auth.token (or OPENCLAW_GATEWAY_TOKEN).",
      ),
      snippet(
        "Hermes: turn on the API server",
        "API_SERVER_ENABLED=true\nAPI_SERVER_KEY=choose-a-secret",
        "Add to ~/.hermes/.env, run `hermes gateway`, and paste the same key into the Chat settings.",
      ),
      snippet(
        "Chat from a script",
        `curl -X POST ${origin}/api/chat -H "Content-Type: application/json" -d '{"connector":"openclaw","messages":[{"role":"user","content":"Hi!"}]}'`,
        'Returns {"reply": "..."}. Add "stream": true for NDJSON deltas.',
      ),
      heading("Builders"),
      snippet("Claude Code: MCP tools", `claude mcp add agentar -- ${cli} mcp`, "Gives Claude speak, set_mood and gesture tools it can call when it wants to talk."),
      snippet("Claude Code: speak every reply", `${cli} install claude-code`, "Adds a Stop hook to ~/.claude/settings.json that reads each final reply aloud."),
      snippet("Codex CLI", `${cli} install codex`, "Adds a notify hook and the MCP server to ~/.codex/config.toml."),
    );
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  private renderModelOptions(c: AvatarConfig): void {
    const current = c.model.source === "builtin" ? `builtin:${c.model.id}` : `url:${c.model.url}`;
    const opts: HTMLOptionElement[] = [];
    for (const m of this.models.builtin) {
      opts.push(h("option", { value: `builtin:${m.id}`, textContent: m.available ? m.label : `${m.label} — not downloaded`, disabled: !m.available }));
    }
    for (const u of this.models.user) opts.push(h("option", { value: `url:${u.url}`, textContent: `Custom: ${u.name}` }));
    if (!opts.some((o) => o.value === current)) opts.push(h("option", { value: current, textContent: current.replace(/^\w+:/, "") }));
    this.modelSelect.replaceChildren(...opts);
    this.modelSelect.value = current;
  }

  private async loadVoices(provider: AvatarConfig["voice"]["provider"]): Promise<void> {
    this.voicesFor = provider;
    this.voiceSelect.replaceChildren(h("option", { value: "", textContent: "Loading…" }));
    let voices: VoiceInfo[] = [];
    let note = "";
    try {
      if (provider === "browser") {
        voices = (await browserVoices()).map((v) => ({ id: v.voiceURI, name: v.name, language: v.lang }));
        note = voices.length ? "Speaks inside this browser tab. Lip-sync follows word timing events." : "This browser exposes no speech voices.";
      } else {
        const list = await this.deps.client.voices(provider);
        voices = list.voices;
        note = list.available ? "" : list.reason ?? "Unavailable";
      }
    } catch (err) {
      note = (err as Error).message;
    }
    if (this.voicesFor !== provider) return;
    // English voices first; they match the lip-sync rules best.
    voices.sort((a, b) => Number(!(a.language ?? "").startsWith("en")) - Number(!(b.language ?? "").startsWith("en")) || a.name.localeCompare(b.name));
    this.voiceSelect.replaceChildren(
      h("option", { value: "", textContent: "Default voice" }),
      ...voices.map((v) => h("option", { value: v.id, textContent: v.language ? `${v.name} (${v.language})` : v.name })),
    );
    this.voiceSelect.value = this.deps.config().voice.voice;
    this.voiceNote.textContent = note;
  }

  private colorField(label: string, slot: "skin" | "hair" | "eyes" | "top" | "bottom" | "shoes"): HTMLElement {
    const input = h("input", { type: "color" });
    const reset = h("button", { type: "button", class: "ghost", textContent: "Original", title: "Use the model's own texture" });
    const swatches = h("div", { class: "swatches" });
    for (const hex of SWATCHES[slot] ?? []) {
      const s = h("button", { type: "button", class: "swatch", title: hex });
      s.style.background = hex;
      s.addEventListener("click", () => this.deps.patch({ appearance: { [slot]: hex } }));
      swatches.append(s);
    }
    input.addEventListener("input", () => this.deps.patch({ appearance: { [slot]: input.value } }));
    reset.addEventListener("click", () => this.deps.patch({ appearance: { [slot]: null } }));
    this.syncers.push((c) => {
      const v = c.appearance[slot];
      input.value = v ?? "#888888";
      input.classList.toggle("unset", v === null);
      reset.disabled = v === null;
    });
    return field(label, h("div", { class: "color-row" }, input, swatches, reset));
  }

  private colorInput(label: string, get: (c: AvatarConfig) => string, set: (v: string) => Patch): HTMLElement {
    const input = h("input", { type: "color" });
    input.addEventListener("input", () => this.deps.patch(set(input.value)));
    this.syncers.push((c) => (input.value = get(c)));
    return field(label, input);
  }

  private selectField<T extends string>(label: string, options: readonly T[], get: (c: AvatarConfig) => T, set: (v: T) => Patch): HTMLElement {
    const select = h("select", {}, ...options.map((o) => h("option", { value: o, textContent: LABELS[o] ?? o })));
    select.addEventListener("change", () => this.deps.patch(set(select.value as T)));
    this.syncers.push((c) => (select.value = get(c)));
    return field(label, select);
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    get: (c: AvatarConfig) => number,
    set: (v: number) => Patch,
    format: (v: number) => string,
  ): HTMLElement {
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step) });
    const out = h("output", {});
    input.addEventListener("input", () => {
      out.textContent = format(Number(input.value));
      this.deps.patch(set(Number(input.value)));
    });
    this.syncers.push((c) => {
      if (document.activeElement !== input) input.value = String(get(c));
      out.textContent = format(get(c));
    });
    return field(label, h("div", { class: "slider" }, input, out));
  }
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "label", textContent: label }), control);
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function alertInline(anchor: HTMLElement, message: string): void {
  const p = h("p", { class: "note error", textContent: message });
  anchor.parentElement?.after(p);
  setTimeout(() => p.remove(), 6000);
}

/** localStorage get/set that never throws (private windows, sandboxed iframes). */
export function safeStorage(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}
