import type { Bridge, BridgeOptions } from "@agentar/bridge";

/** Start the bridge after ensuring the default (CC0) avatar models are downloaded. */
export async function startBridgeWithModels(opts: BridgeOptions = {}): Promise<Bridge> {
  const { defaultModelsDir, fetchModels, startBridge } = await import("@agentar/bridge");
  const modelsDir = opts.modelsDir ?? process.env.AGENTAR_MODELS_DIR ?? defaultModelsDir();
  await fetchModels(modelsDir, { quiet: true });
  return startBridge({ ...opts, modelsDir });
}
