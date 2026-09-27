import { describe, expect, it } from "vitest";
import { BUILTIN_MODELS, DEFAULT_CONFIG, isAllowedModelUrl, mergeConfig, resolveConfig, slotForMaterial } from "./config.js";

describe("resolveConfig", () => {
  it("returns defaults for garbage input", () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig("nope")).toEqual(DEFAULT_CONFIG);
  });

  it("keeps valid values and rejects invalid ones", () => {
    const c = resolveConfig({
      name: "Ada",
      appearance: { hair: "#FF0000", top: "red", glasses: "round", height: 9 },
      voice: { provider: "openai", rate: 0.1 },
      scene: { framing: "full", background: "#000000" },
      behavior: { mood: "furious" },
    });
    expect(c.name).toBe("Ada");
    expect(c.appearance.hair).toBe("#ff0000");
    expect(c.appearance.top).toBeNull();
    expect(c.appearance.glasses).toBe("round");
    expect(c.appearance.height).toBe(1.15);
    expect(c.voice.provider).toBe("openai");
    expect(c.voice.rate).toBe(0.5);
    expect(c.scene.framing).toBe("full");
    expect(c.behavior.mood).toBe("neutral");
  });

  it("allows clearing a color override with null", () => {
    const base = mergeConfig(DEFAULT_CONFIG, { appearance: { hair: "#123456" } });
    expect(mergeConfig(base, { appearance: { hair: null } }).appearance.hair).toBeNull();
    expect(mergeConfig(base, { appearance: {} }).appearance.hair).toBe("#123456");
  });

  it("validates model references", () => {
    expect(resolveConfig({ model: { source: "builtin", id: "nope" } }).model).toEqual(DEFAULT_CONFIG.model);
    expect(resolveConfig({ model: { source: "url", url: "/models/user/me.vrm", format: "vrm" } }).model).toEqual({
      source: "url",
      url: "/models/user/me.vrm",
      format: "vrm",
    });
    expect(isAllowedModelUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedModelUrl("/models/../secret")).toBe(false);
  });
});

describe("slotForMaterial", () => {
  const mpfb = BUILTIN_MODELS.find((m) => m.id === "mpfb");
  it("uses explicit mappings first", () => {
    expect(slotForMaterial("Human.female_casualsuit01", mpfb)).toBe("top");
  });
  it("falls back to heuristics", () => {
    expect(slotForMaterial("Wolf3D_Outfit_Footwear")).toBe("shoes");
    expect(slotForMaterial("HairMaterial")).toBe("hair");
    expect(slotForMaterial("Eyelash")).toBeNull();
  });
});
