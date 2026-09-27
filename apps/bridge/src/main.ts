import { startBridge } from "./server.js";

const bridge = await startBridge();
const shutdown = () => {
  void bridge.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
