/**
 * All money in SwitchBoard is integer micro-dollars (1_000_000 = $1.00).
 * Never use float/double for money arithmetic — see 05-data-model.md.
 */

export type Micros = number;

export const MICROS_PER_DOLLAR = 1_000_000;

export function dollarsToMicros(dollars: number): Micros {
  return Math.round(dollars * MICROS_PER_DOLLAR);
}

export function microsToDollars(micros: Micros): number {
  return micros / MICROS_PER_DOLLAR;
}

/** Human-readable display string, generated — never hand-written (see 06-api-spec.md). */
export function microsToDisplay(micros: Micros, currency = "USD"): string {
  const dollars = microsToDollars(micros);
  const symbol = currency === "USD" ? "$" : `${currency} `;
  // Six-decimal display below a cent so sub-cent pricing (Monid-style $0.0009) is legible.
  const decimals = Math.abs(dollars) < 0.01 && dollars !== 0 ? 6 : 2;
  return `${symbol}${dollars.toFixed(decimals)}`;
}
