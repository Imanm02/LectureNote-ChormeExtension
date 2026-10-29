import { runPackagedBrowserSmoke, runStableChromeSmokeProcess } from "./package-browser-smoke.mjs";

await runPackagedBrowserSmoke({
  runSmoke: runStableChromeSmokeProcess,
  description: "stable Chrome",
});
