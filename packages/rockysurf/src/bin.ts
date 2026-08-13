#!/usr/bin/env node
/**
 * The `rockysurf` binary — what `npx rockysurf` runs.
 *
 * Moved here from `@rockysurf/core` by rockysurf-55fx.12: the binary belongs with the package
 * that can actually wire the providers, and core stays a private implementation package.
 *
 * Deliberately tiny, and deliberately written in the oldest syntax in the repository. It has
 * ONE job before anything else happens: check the Node version and say something useful if it
 * is too old.
 *
 * That is why the real CLI is reached through a dynamic `import()` rather than a top-level
 * one. Static imports are hoisted and evaluated before any statement in this file runs, so a
 * module using syntax an old Node cannot parse would throw a `SyntaxError` from a file the
 * operator has never heard of, before the version check ever executed. Loading it lazily
 * means the check always wins.
 */

const MIN_NODE_MAJOR = 24

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
  process.stderr.write(
    `rockysurf needs Node ${MIN_NODE_MAJOR} or newer — this is Node v${process.versions.node}.\n` +
      '\n' +
      "  nvm install 24 && nvm use 24     # or your platform's installer\n" +
      '\n' +
      'Then run `npx rockysurf` again.\n',
  )
  process.exit(1)
}

import('./cli.js')
  .then(({ runRockysurfCli }) => runRockysurfCli(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    // Anything that reaches here is a bug or an unhandled boot failure. Config and key
    // problems exit earlier with their own printed message.
    process.stderr.write(`rockysurf failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exitCode = 1
  })
