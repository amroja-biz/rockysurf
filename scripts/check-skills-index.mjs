#!/usr/bin/env node
/**
 * `.agents/skills/README.md` must list every skill in `.agents/skills/` (issue #289).
 *
 * WHY THIS NEEDS A CHECK AT ALL. The README's table is the index a human reads to find out what
 * skills exist; the directories are what an agent actually discovers. Those two drift in one
 * direction and one direction only — somebody adds a skill and does not add the row — and the
 * result is a skill that works perfectly and that nobody knows about. This repository ships
 * skills as a product (`.agents/skills/README.md` says so), so an unlisted one is a feature
 * that silently did not launch.
 *
 * It caught its own motivating bug: the Help page said "two skills" while three shipped. That
 * number is now gone from the page entirely, on the rule in
 * `docs/memories/2026-08-13-measured-numbers-in-prose.md` — a measurement in prose needs one
 * dated, re-measured home, and a count of directories written into a sentence is neither.
 *
 * Deliberately NOT a check that the README mentions nothing extra: a row for something that does
 * not exist is a broken link a reader notices immediately, while a missing row is invisible.
 *
 * Exits 0 when every skill is listed, 1 when one is not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const skillsDir = fileURLToPath(new URL('../.agents/skills/', import.meta.url))
const readmePath = join(skillsDir, 'README.md')

const readme = readFileSync(readmePath, 'utf8')
const skills = readdirSync(skillsDir)
  .filter((entry) => statSync(join(skillsDir, entry)).isDirectory())
  .sort()

if (skills.length === 0) {
  console.error('check-skills-index: no skill directories found — is the path right?')
  process.exit(1)
}

/** A skill counts as listed when the README links its directory, which is what the table does. */
const missing = skills.filter((name) => !readme.includes(`(${name}/)`))

if (missing.length > 0) {
  console.error(
    `check-skills-index: ${missing.length} skill(s) missing from .agents/skills/README.md: ${missing.join(', ')}`,
  )
  console.error('Add a row to the table linking the directory, e.g. | [`name`](name/) | Use it when … |')
  process.exit(1)
}

console.log(`check-skills-index: ${skills.length} skill(s), all listed`)
