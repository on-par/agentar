// Downloads the built-in avatar models into assets/models/.
// They are not committed to git because they are large (5–37 MB each).
// Usage: npm run fetch:models [-- --all]
import { defaultModelsDir, fetchModels } from "@agentar/bridge";

const all = process.argv.includes("--all");
const ok = await fetchModels(defaultModelsDir(), { all });
if (!all) console.log("\nTip: `npm run fetch:models -- --all` also downloads the non-commercial sample avatars.");
process.exitCode = ok ? 0 : 1;
