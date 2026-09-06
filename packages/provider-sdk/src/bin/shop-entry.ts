#!/usr/bin/env node
/**
 * `rockysurf-shop-entry` — print the shop listing entry for a packed provider (issue #418).
 *
 * The whole command is argument parsing and one call into `shop-entry.ts`. It writes the JSON
 * object to stdout and nothing else, so it pipes: `rockysurf-shop-entry … | pbcopy`, or into
 * `jq`, or into a `providers.json` edit. Anything the human is meant to read — what was refused,
 * and why — goes to stderr, which is what keeps stdout a document rather than a transcript.
 *
 * A failure exits 1 with one sentence. There is no stack trace: every throw in `shop-entry.ts`
 * is written as a sentence for the author of the package being read, and a stack on top of it
 * would bury the sentence in frames from a file they have never opened.
 */

import { shopEntryFor, readTarballFile } from '../shop-entry.js'

const USAGE = `Usage: rockysurf-shop-entry <package.tgz> --tarball-url <https URL> --description "<one line>"

Prints the amroja-biz/rockysurf-shop providers.json entry for a packed provider package.
Every field but the two options is read out of the tarball: the manifest's name and version,
the factory's id, its declared settings, and the capabilities of the provider it constructs.`

interface Args {
  tarball: string
  tarballUrl: string
  description: string
}

/** Long options with a value each, and exactly one positional. Nothing clever, nothing implicit. */
export function parseArgs(argv: readonly string[]): Args {
  let tarball: string | undefined
  let tarballUrl: string | undefined
  let description: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--tarball-url' || arg === '--description') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      if (arg === '--tarball-url') tarballUrl = value
      else description = value
      i++
      continue
    }
    if (arg.startsWith('--')) throw new Error(`${arg} is not an option this command takes`)
    if (tarball !== undefined) throw new Error(`two tarballs were named (${tarball} and ${arg}); this reads one`)
    tarball = arg
  }

  if (tarball === undefined) throw new Error('name the packed .tgz to read')
  if (tarballUrl === undefined) throw new Error('--tarball-url is where the same bytes will be downloaded from')
  if (description === undefined) throw new Error('--description is the one line a person reads before installing')
  return { tarball, tarballUrl, description }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const args = parseArgs(argv)
  const entry = await shopEntryFor({
    tarball: readTarballFile(args.tarball),
    tarballUrl: args.tarballUrl,
    description: args.description,
  })
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`)
}

await main().catch((err: unknown) => {
  console.error(`rockysurf-shop-entry: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
