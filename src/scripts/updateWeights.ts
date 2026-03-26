// ============================================================
// SCRIPT: scripts/updateWeights.ts
// PURPOSE: CLI script to run hook weight update and exit
// USAGE: npm run weights:update
// ============================================================

import 'dotenv/config';
import { runWeightUpdate } from '../modules/hookWeightUpdater';

(async () => {
  try {
    await runWeightUpdate();
    console.log('Weight update complete.');
    process.exit(0);
  } catch (err) {
    console.error('Weight update failed:', (err as Error).message);
    process.exit(1);
  }
})();
