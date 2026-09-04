import { choiceDecide } from './ladder.js';
import { exhaustedLimit, headroomRate, usageForModel, UsageSnapshot } from './usage.js';
import { LoopConfig, RunChoice } from './types.js';

export type ProviderUsage = { claude: UsageSnapshot | null; codex: UsageSnapshot | null };

export function choiceExhausted(choice: RunChoice, usage: ProviderUsage, threshold: number, now = Date.now()): boolean {
  return choice.runtime !== 'mock' && Boolean(exhaustedLimit(usageForModel(usage[choice.runtime], choice.model, now), threshold));
}

/** Shared by the live loop and the read-only routing preview. */
export function selectRun(loop: LoopConfig, usage: ProviderUsage, iteration: number, threshold: number, now = Date.now()) {
  return choiceDecide({
    choices: loop.choices,
    fallbacks: loop.fallbacks,
    iteration,
    exhausted: (choice) => choiceExhausted(choice, usage, threshold, now),
    headroom: loop.routing === 'headroom'
      ? (choice) => choice.runtime === 'mock' ? null : headroomRate(usage[choice.runtime], choice.model, threshold, now)
      : undefined,
  });
}
