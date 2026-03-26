// ============================================================
// MODULE: core/engines.ts
// PURPOSE: Singleton instances of Phase 4 intelligence engines
// ============================================================

import { DecisionEngine } from '../modules/decisionEngine';
import { EvolutionEngine } from '../modules/evolutionEngine';
import { ExperimentEngine } from '../modules/experimentEngine';
import { PortfolioEngine } from '../modules/portfolioEngine';

export const decisionEngine = new DecisionEngine();
export const evolutionEngine = new EvolutionEngine();
export const experimentEngine = new ExperimentEngine();
export const portfolioEngine = new PortfolioEngine();

// Wire up the live hook-pattern A/B experiment that tracks real production events
export const HOOK_AB_EXPERIMENT = experimentEngine.create(
  'Hook Pattern: Shocking Stat vs Contrarian (live)',
  [
    { id: 'shocking_stat', label: 'Shocking Stat', data: { pattern: 'shocking_stat' } },
    { id: 'contrarian',    label: 'Contrarian',    data: { pattern: 'contrarian' } },
  ]
);
