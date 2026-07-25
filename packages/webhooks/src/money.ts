// packages/webhooks/src/money.ts — micro-USDC → decimal string. The ONE place integer µUSDC
// becomes a decimal, by integer ops (never a float divide) so the cents can't drift. Lifted from
// cloud's csv.ts so the payload builder has no cloud dependency.

/** Format integer micro-USDC as a fixed 6-dp decimal string (e.g. 1_500_000 → "1.500000"). */
export function microToUsdc(micro: number): string {
  const n = Math.abs(Math.trunc(micro));
  const whole = Math.trunc(n / 1_000_000);
  const frac = (n % 1_000_000).toString().padStart(6, "0");
  return `${micro < 0 ? "-" : ""}${whole}.${frac}`;
}
