import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startStubServer, type StubServer } from './test-server'
import { testOrigin } from './test-setup'

/**
 * The stub server helper, and the rule it exists to enforce (rockysurf-t215, rockysurf-qokr).
 *
 * Five page tests used to bind one hardcoded port, and the resulting collision did not present
 * as a port problem at all: one file's `beforeEach` hung to its ten-second limit on an
 * unhandled `EADDRINUSE`, and the NEXT file produced seven `Unable to find role="row"` failures
 * because nothing was serving. Diagnosing that from the symptoms took a reproduction loop.
 *
 * So the guard is here rather than in a reviewer's memory.
 */

const opened: StubServer[] = []
const start = async () => {
  const stub = await startStubServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  opened.push(stub)
  return stub
}

afterEach(async () => {
  for (const stub of opened.splice(0)) await stub.close()
})

describe('the stub server', () => {
  it('takes a port from the OS, so two of them can never want the same one', async () => {
    const [a, b] = [await start(), await start()]
    expect(a.port).toBeGreaterThan(0)
    expect(a.port).not.toBe(b.port)
  })

  it('serves, and relative URLs reach it without the SPA being given a base URL', async () => {
    // The property the fixed port used to provide: the page writes `/api/v1/...` and it lands
    // on the stub. That is the production code path, and it still is.
    const stub = await start()
    expect(testOrigin()).toBe(stub.origin)
    expect(await (await fetch('/anything')).json()).toEqual({ ok: true })
  })

  it('stops claiming relative URLs once it is closed', async () => {
    // A relative URL resolved after close belongs to nothing. Pointing it at a dying server is
    // how a test gets a confusing error instead of an obvious one.
    const stub = await start()
    await stub.close()
    expect(testOrigin()).toBe(globalThis.location.origin)
  })

  it('is safe to close twice, which an afterEach after a failed test will do', async () => {
    const stub = await start()
    await stub.close()
    await expect(stub.close()).resolves.toBeUndefined()
  })
})

/**
 * THE RULE, checked against the tree rather than remembered.
 *
 * A positive match on the broken shape: a literal port passed to `listen`. `listen(0, …)` is
 * the correct spelling and is what this permits — anything else is a shared resource two test
 * files can collide over, which is the bug above.
 */
describe('no web test binds a fixed port', () => {
  const srcDir = join(process.cwd(), 'src')

  const testFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return testFiles(path)
      return /\.test\.tsx?$/.test(entry.name) ? [path] : []
    })

  it('finds the test files it is scanning, so a passing scan means something', () => {
    // The commonest way to get a green check you have not earned is to scan nothing.
    expect(testFiles(srcDir).length).toBeGreaterThan(15)
  })

  it('never calls listen with a literal port', () => {
    const offenders = testFiles(srcDir).filter((path) =>
      // `listen(0` is the ephemeral spelling; `listen(PORT` and `listen(34567` are not.
      /\.listen\(\s*(?!0\b)\d/.test(readFileSync(path, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('declares no shared port constant', () => {
    const offenders = testFiles(srcDir).filter((path) => /\bSTUB_PORT\b/.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
