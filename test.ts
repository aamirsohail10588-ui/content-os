import "dotenv/config";
import { generateVideo } from "./src/pipeline/generateVideo";
import { DEFAULT_CONTENT_CONFIG } from "./src/config";

generateVideo("ipl 2026 champion prediction", DEFAULT_CONTENT_CONFIG).then(
  (r) => {
    if (!r.script) {
      console.log("No script");
      return;
    }
    console.log("\n=== HOOK ===");
    console.log(r.hook?.text);
    console.log("\n=== FULL SCRIPT ===");
    r.script.segments.forEach((s, i) => {
      console.log(`\n[${i + 1}] TEXT: ${s.text}`);
      console.log(`    VISUAL: ${s.visual_query}`);
      console.log(`    DURATION: ${s.estimatedDurationSeconds}s`);
    });
    console.log("\n=== STATS ===");
    console.log("Total duration:", r.script.totalDurationSeconds, "seconds");
    console.log("Word count:", r.script.wordCount);
  },
);
