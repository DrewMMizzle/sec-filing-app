// Claude pricing, in its own module so both review.ts (which spends) and
// storage.ts (which totals the spend) can use it without importing each other.
// They did briefly, and a storage <-> review cycle is the kind of thing that
// works until a bundler reorders the modules and one side sees `undefined`.

// Opus 4.7 / 4.8 / 5 pricing (USD per 1M tokens) — identical across those
// generations, so the model bumps didn't change the spend-cap math.
export const PRICE_INPUT = 5;
export const PRICE_OUTPUT = 25;
export const PRICE_CACHE_READ = 0.5;
export const PRICE_CACHE_WRITE = 6.25;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

// Dollar cost of a set of token counts.
export function reviewCostUsd(u: TokenUsage): number {
  return (
    (u.inputTokens * PRICE_INPUT +
      u.outputTokens * PRICE_OUTPUT +
      u.cacheReadTokens * PRICE_CACHE_READ +
      u.cacheCreationTokens * PRICE_CACHE_WRITE) /
    1_000_000
  );
}
