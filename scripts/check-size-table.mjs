#!/usr/bin/env node
/**
 * Size-table drift lint (rockysurf-clf2).
 *
 * What a t-shirt size MEANS is written down twice, and both copies have a job the other
 * cannot do:
 *
 *   - `packages/core/src/servers/offerings.ts` — the authority. Every create passes through
 *     it, whoever the caller is, and it is the only copy that decides what gets billed.
 *   - `packages/web/src/lib/requirements.ts` — the browser's copy. The New Server page has to
 *     resolve BEFORE submit, so it can show the concrete machine and its price rather than
 *     letting the user discover both on the detail page.
 *
 * They cannot be one module: the dependency lint keeps `@rockysurf/core` and `@rockysurf/web`
 * apart, and for good reason — core's tree pulls in better-sqlite3 and ssh2, neither of which
 * belongs in a browser bundle.
 *
 * So the risk is drift, and the cost of drift is specific and nasty: the page quotes the price
 * of the machine IT resolved, core provisions the machine IT resolved, and if the two tables
 * disagree about `medium` the user is shown one number and billed another. Nothing would fail;
 * it would just be wrong, on the invoice, silently.
 *
 * Usage: node scripts/check-size-table.mjs [--print]
 * Exits 0 when the tables agree, 1 on any difference.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CORE = 'packages/core/src/servers/offerings.ts'
const WEB = 'packages/web/src/lib/requirements.ts'

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8')

/**
 * The `SIZE_REQUIREMENTS` rows, as `{ small: { vcpu, memGb }, ... }`.
 *
 * A line scanner rather than an import, because importing would mean building both packages
 * first — this lint runs in `pnpm run lint`, which is the step BEFORE the build in a fresh
 * clone, and a gate that only works after a successful build is a gate that stops running
 * exactly when someone is in a hurry.
 *
 * It is deliberately strict about the shape it accepts: an unparseable table is reported as a
 * failure rather than silently yielding zero rows, so reformatting the constant into something
 * this cannot read fails loudly instead of disabling the check.
 */
function sizeTable(source, label) {
  const start = source.indexOf('SIZE_REQUIREMENTS')
  if (start === -1) throw new Error(`${label}: no SIZE_REQUIREMENTS declaration found`)

  const open = source.indexOf('{', start)
  const close = source.indexOf('}\n', open)
  if (open === -1 || close === -1) throw new Error(`${label}: could not find the bounds of SIZE_REQUIREMENTS`)

  const body = source.slice(open, close)
  const rows = {}
  for (const match of body.matchAll(/(\w+):\s*\{\s*vcpu:\s*([\d.]+),\s*memGb:\s*([\d.]+)\s*\}/g)) {
    rows[match[1]] = { vcpu: Number(match[2]), memGb: Number(match[3]) }
  }
  if (Object.keys(rows).length === 0) {
    throw new Error(`${label}: SIZE_REQUIREMENTS parsed to no rows — has the constant been reformatted?`)
  }
  return rows
}

const describe = (row) => (row ? `${row.vcpu} vCPU / ${row.memGb} GB` : '(absent)')

function main() {
  const core = sizeTable(read(CORE), CORE)
  const web = sizeTable(read(WEB), WEB)

  if (process.argv.includes('--print')) {
    for (const size of Object.keys(core)) console.log(`${size}: ${describe(core[size])}`)
  }

  const sizes = [...new Set([...Object.keys(core), ...Object.keys(web)])].sort()
  const problems = []
  for (const size of sizes) {
    const a = core[size]
    const b = web[size]
    if (!a || !b || a.vcpu !== b.vcpu || a.memGb !== b.memGb) {
      problems.push(`  ${size}: ${CORE} says ${describe(a)}, ${WEB} says ${describe(b)}`)
    }
  }

  if (problems.length > 0) {
    console.error('Size tables disagree — the New Server page would quote a machine core does not create:\n')
    console.error(problems.join('\n'))
    console.error('\nChange both, or neither. What a size means is a pricing decision.')
    process.exit(1)
  }

  console.log(`size tables agree (${sizes.length} sizes)`)
}

try {
  main()
} catch (err) {
  console.error(`check-size-table: ${err.message}`)
  process.exit(1)
}
