// setTimeout stores its delay in 32 bits: past this, or at Infinity, it fires at once instead of waiting.
const MAX_DELAY_MS = 2 ** 31 - 1

export const clampDelay = (ms: number): number => Math.min(Math.max(ms, 0), MAX_DELAY_MS)
