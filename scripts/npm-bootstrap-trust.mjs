#!/usr/bin/env node
/**
 * One-time npm setup for trusted publishing (issue #275). The owner runs this once, logged in.
 *
 * WHAT IT DOES, per publishable package (every packages/* without `private: true`):
 *   1. If the name does not exist on the registry yet, publish a `0.0.0` PLACEHOLDER — a
 *      manifest, a README and nothing else — and deprecate it on the spot. This is not vanity:
 *      npm will not attach a trusted publisher to a package that does not exist
 *      (docs.npmjs.com/cli/v11/commands/npm-trust: "The package you're configuring must already
 *      exist on the npm registry"), so a brand-new package needs one publish by a human before
 *      the workflow can publish it. 0.0.0 is below every real version, so `npx rockysurf@latest`
 *      and `^0.1.0` ranges never resolve to it, and the deprecation message says what it is.
 *   2. `npm trust github <pkg> --file release.yml --repo amroja-biz/rockysurf --env npm
 *      --allow-publish`: the registry now accepts a publish of this package ONLY from
 *      .github/workflows/release.yml in this repository, running in the `npm` environment.
 *   3. `npm access set mfa=publish <pkg>`: a human publish needs a second factor, and the
 *      automation-token bypass is off. Trusted publishers are unaffected by this setting.
 *
 * WHAT IT NEEDS. `npm login` done (2FA on the account, which the registry enforces for `npm
 * trust`), npm >= 11.15.0 (`npm install -g npm@latest`), and a terminal: step 1 prompts for a
 * one-time password per placeholder publish. It never reads or writes a token.
 *
 * It is idempotent: a package that exists is not re-published, an existing trust entry is
 * reported and left alone, and the mfa setting is simply set again.
 *
 * Usage: node scripts/npm-bootstrap-trust.mjs [--dry-run] [--only <name>]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'amroja-biz/rockysurf'
const WORKFLOW = 'release.yml'
const ENVIRONMENT = 'npm'
const PLACEHOLDER_VERSION = '0.0.0'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(repoRoot, 'packages')

function run(cmd, cmdArgs, { input, quiet } = {}) {
  const shown = [cmd, ...cmdArgs].join(' ')
  if (dryRun) {
    console.log(`  [dry-run] ${shown}`)
    return ''
  }
  if (!quiet) console.log(`  $ ${shown}`)
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: input === undefined ? ['inherit', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], input })
  if (result.status !== 0) {
    const err = new Error(`${shown} exited ${result.status}\n${result.stderr}`)
    err.stderr = result.stderr
    err.status = result.status
    throw err
  }
  return result.stdout
}

function semverAtLeast(actual, floor) {
  const a = actual.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false
  }
  return true
}

function publishablePackages() {
  const found = []
  for (const dir of readdirSync(packagesDir)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (manifest.private) continue
    if (only && manifest.name !== only) continue
    found.push({ dir: join(packagesDir, dir), manifest })
  }
  return found.sort((x, y) => x.manifest.name.localeCompare(y.manifest.name))
}

function existsOnRegistry(name) {
  const result = spawnSync('npm', ['view', name, 'name', '--json'], { encoding: 'utf8' })
  if (result.status === 0) return true
  if (/E404|404 Not Found/.test(result.stderr + result.stdout)) return false
  throw new Error(`npm view ${name} failed:\n${result.stderr}`)
}

function publishPlaceholder({ dir, manifest }) {
  const tmp = mkdtempSync(join(tmpdir(), 'rockysurf-placeholder-'))
  try {
    const placeholder = {
      name: manifest.name,
      version: PLACEHOLDER_VERSION,
      description: `${manifest.description ?? manifest.name} — placeholder that reserves the name; the first real version is published by ${REPO}'s release workflow.`,
      license: manifest.license ?? 'MIT',
      repository: manifest.repository,
      homepage: manifest.homepage,
      bugs: manifest.bugs,
      keywords: manifest.keywords,
      publishConfig: { access: 'public' },
    }
    writeFileSync(join(tmp, 'package.json'), JSON.stringify(placeholder, null, 2) + '\n')
    let readme = `# ${manifest.name}\n\nPlaceholder ${PLACEHOLDER_VERSION}. It reserves the name so that npm Trusted Publishing can be configured; the first real version is published from https://github.com/${REPO} by its release workflow. Install a real version, never this one.\n`
    try {
      readme += '\n---\n\n' + readFileSync(join(dir, 'README.md'), 'utf8')
    } catch {
      /* no README beside the package; the placeholder text stands alone */
    }
    writeFileSync(join(tmp, 'README.md'), readme)
    try {
      writeFileSync(join(tmp, 'LICENSE'), readFileSync(join(repoRoot, 'LICENSE'), 'utf8'))
    } catch {
      /* the real tarballs get LICENSE from pnpm; a placeholder without one is still MIT by manifest */
    }
    console.log(`  publishing ${manifest.name}@${PLACEHOLDER_VERSION} from ${tmp} (npm will ask for your one-time password)`)
    if (!dryRun) {
      const result = spawnSync('npm', ['publish', '--access', 'public'], { cwd: tmp, stdio: 'inherit' })
      if (result.status !== 0) throw new Error(`npm publish of the ${manifest.name} placeholder exited ${result.status}`)
    }
    run('npm', ['deprecate', `${manifest.name}@${PLACEHOLDER_VERSION}`, `Placeholder that reserved the name. Real versions are published by ${REPO}'s release workflow; install one of those.`])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function trustAlreadyConfigured(name) {
  const result = spawnSync('npm', ['trust', 'list', name, '--json'], { encoding: 'utf8' })
  if (result.status !== 0) return false
  try {
    const parsed = JSON.parse(result.stdout)
    const entries = Array.isArray(parsed) ? parsed : parsed.trustedPublishers ?? parsed.publishers ?? []
    return entries.some((e) => JSON.stringify(e).includes(WORKFLOW) && JSON.stringify(e).includes(REPO))
  } catch {
    return /release\.yml/.test(result.stdout) && result.stdout.includes(REPO)
  }
}

function main() {
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  if (!semverAtLeast(npmVersion, '11.15.0')) {
    console.error(`npm ${npmVersion} is too old for \`npm trust\` (needs 11.15.0+). Run: npm install -g npm@latest`)
    process.exit(2)
  }
  const who = spawnSync('npm', ['whoami'], { encoding: 'utf8' })
  if (who.status !== 0 && !dryRun) {
    console.error('Not logged in to npm. Run `npm login` (the account needs 2FA enabled), then re-run this script.')
    process.exit(2)
  }
  const user = who.status === 0 ? `logged in as ${who.stdout.trim()}` : 'not logged in'
  console.log(`npm ${npmVersion}, ${user}${dryRun ? ' — DRY RUN, nothing will be changed' : ''}`)

  const packages = publishablePackages()
  if (packages.length === 0) {
    console.error(only ? `no publishable package named ${only}` : 'no publishable packages found')
    process.exit(2)
  }

  const summary = []
  for (const pkg of packages) {
    const { name } = pkg.manifest
    console.log(`\n${name}`)
    const exists = existsOnRegistry(name)
    if (exists) {
      console.log('  exists on the registry')
    } else {
      console.log('  not on the registry: a placeholder is needed before a trusted publisher can be attached')
      publishPlaceholder(pkg)
    }

    if (trustAlreadyConfigured(name)) {
      console.log(`  trusted publisher for ${REPO}/${WORKFLOW} already present; leaving it`)
    } else {
      run('npm', ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPO, '--env', ENVIRONMENT, '--allow-publish', '--yes'])
    }

    run('npm', ['access', 'set', 'mfa=publish', name])
    summary.push({ name, placeholder: !exists })
  }

  console.log('\nDone.')
  for (const s of summary) console.log(`  ${s.name}${s.placeholder ? `  (placeholder ${PLACEHOLDER_VERSION} published and deprecated)` : ''}`)
  console.log(`\nEvery package above now accepts a publish only from ${REPO}/.github/workflows/${WORKFLOW} in the \`${ENVIRONMENT}\` environment.`)
  console.log('Check on the website: https://www.npmjs.com/package/<name>/access — "Trusted Publisher" names this repository and workflow.')
  console.log('Next release: merge the version bump, tag vX.Y.Z on main, push the tag, approve the deployment in Actions (docs/contributing/RELEASING.md).')
}

try {
  main()
} catch (err) {
  console.error(`\n${err.message}`)
  process.exit(1)
}
