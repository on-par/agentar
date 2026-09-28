import { describe, expect, it } from "vitest";
import { CHAT_CONNECTORS, CHAT_CONNECTOR_INFO, DEFAULT_CHAT_CONFIG, effectiveChatSettings, mergeChatConfig, resolveChatConfig } from "./chat.js";

describe("chat config", () => {
  it("returns defaults for garbage input", () => {
    expect(resolveChatConfig(undefined)).toEqual(DEFAULT_CHAT_CONFIG);
    expect(resolveChatConfig("nope")).toEqual(DEFAULT_CHAT_CONFIG);
  });

  it("has a named connector for each agent, with OpenClaw as the default", () => {
    expect(CHAT_CONNECTORS).toEqual(["openclaw", "hermes", "grok", "muse", "http"]);
    expect(DEFAULT_CHAT_CONFIG.connector).toBe("openclaw");
    expect(DEFAULT_CHAT_CONFIG.connectors.openclaw).toMatchObject({ baseUrl: "http://127.0.0.1:18789/v1", model: "openclaw/default" });
    expect(DEFAULT_CHAT_CONFIG.connectors.hermes).toMatchObject({ baseUrl: "http://127.0.0.1:8642/v1", model: "hermes-agent" });
    expect(CHAT_CONNECTOR_INFO.muse.transport).toBe("none");
    expect(CHAT_CONNECTOR_INFO.muse.gap).toMatch(/no third-party chat API/);
    expect(CHAT_CONNECTOR_INFO.grok.transport).toBe("agentmail");
  });

  it("keeps valid values, rejects invalid ones, and keeps omitted keys", () => {
    const c = resolveChatConfig({
      connector: "hermes",
      sayReplies: "yes",
      connectors: { hermes: { baseUrl: " http://10.0.0.2:8642/v1 ", apiKey: "k1" }, openclaw: { baseUrl: "javascript:alert(1)" } },
    });
    expect(c.connector).toBe("hermes");
    expect(c.sayReplies).toBe(DEFAULT_CHAT_CONFIG.sayReplies);
    expect(c.connectors.hermes).toMatchObject({ baseUrl: "http://10.0.0.2:8642/v1", apiKey: "k1", model: "hermes-agent" });
    expect(c.connectors.openclaw.baseUrl).toBe("http://127.0.0.1:18789/v1");
    expect(resolveChatConfig({ connector: "clippy" }).connector).toBe("openclaw");

    const saved = mergeChatConfig(c, { connectors: { hermes: { model: "work" } } });
    expect(saved.connectors.hermes).toMatchObject({ apiKey: "k1", model: "work" });
    expect(mergeChatConfig(saved, { connectors: { hermes: { apiKey: "" } } }).connectors.hermes.apiKey).toBe("");
  });

  it("forgets a saved key when the base URL moves without a new key", () => {
    const saved = mergeChatConfig(DEFAULT_CHAT_CONFIG, { connectors: { openclaw: { apiKey: "tok" } } });
    expect(mergeChatConfig(saved, { connectors: { openclaw: { baseUrl: "http://127.0.0.1:18789/v1" } } }).connectors.openclaw.apiKey).toBe("tok");
    expect(mergeChatConfig(saved, { connectors: { openclaw: { baseUrl: "https://elsewhere.example/v1" } } }).connectors.openclaw.apiKey).toBe("");
    expect(
      mergeChatConfig(saved, { connectors: { openclaw: { baseUrl: "https://elsewhere.example/v1", apiKey: "new" } } }).connectors.openclaw.apiKey,
    ).toBe("new");
  });

  it("fills cleared fields from the connector defaults", () => {
    const c = mergeChatConfig(DEFAULT_CHAT_CONFIG, { connectors: { openclaw: { baseUrl: "", model: "" } } });
    expect(c.connectors.openclaw.baseUrl).toBe("");
    expect(effectiveChatSettings(c, "openclaw")).toMatchObject({ baseUrl: "http://127.0.0.1:18789/v1", model: "openclaw/default" });
  });
});
