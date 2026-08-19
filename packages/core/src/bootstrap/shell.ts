/** Single-quote for bash, the only form with no escape sequences to reason about. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
