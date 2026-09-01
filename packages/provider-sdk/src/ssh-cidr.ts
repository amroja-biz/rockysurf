/**
 * Normalizing an operator's `sshAllowedCidr` into the list the providers actually enforce.
 *
 * Issue #304 made this setting a LIST, because the operator it exists for is the one who moves:
 * home, office, a cafe, a new ISP lease. Before, "add the new network" meant overwriting the old
 * one, so an operator who worked from two places could keep exactly one of them — or reach for
 * `0.0.0.0/0`, which is the outcome the two-act guard around that value exists to discourage.
 *
 * Lives in the SDK, with the rest of the pure helpers and no runtime dependency, because all
 * three providers that maintain a whitelist have to agree about it down to the character: the
 * list is diffed against what the cloud reports, and two providers disagreeing about whether
 * ` 10.0.0.0/8 ` and `10.0.0.0/8` are the same entry would show up as a phantom change that never
 * converges.
 */

/**
 * Trim, drop blanks, and remove EXACT duplicates, preserving the operator's order.
 *
 * Deduping is limited to exact string equality on purpose. It is tempting to notice that
 * `203.0.113.7/32` is inside `203.0.113.0/24` and collapse them, and it would be wrong: the two
 * entries mean different things to the person maintaining the file. The wide one is "the office",
 * the narrow one is "my laptop at the office", and an operator who later removes the office range
 * expects to keep their laptop. Collapsing them also makes removal lossy in a way the UI cannot
 * explain — the entry the operator clicks remove on would not be the entry that disappears.
 *
 * So: overlapping ranges are left exactly as written, and only a literal repeat is folded away.
 */
export function normalizeSshCidrs(input: string | readonly string[]): string[] {
  const raw = typeof input === 'string' ? [input] : input
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Does this list open SSH to the whole internet?
 *
 * ANY element being `0.0.0.0/0` is what triggers the second act (`allowAllCidr: true`) — not just
 * a list whose only entry is `/0`. A list of five careful office ranges with a `/0` appended is
 * open to the entire internet and the four careful entries change nothing about that, so hiding
 * the guard behind "the list is exactly [/0]" would let the dangerous value in through the door
 * the guard is standing at.
 */
export function opensSshToTheInternet(cidrs: readonly string[]): boolean {
  return cidrs.includes('0.0.0.0/0')
}
