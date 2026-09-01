import { test as base, expect, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startControlPlane, type ControlPlane } from './control-plane'

/**
 * SIGNING IN, THROUGH THE FORM (owner instruction, issue #310).
 *
 * The suite could have posted to `/api/v1/auth/login` and injected the cookie, and it would
 * have been faster and completely worthless as evidence: the login page is UI, it is the FIRST
 * UI anybody meets, and the reason UI bugs kept shipping is that every previous attempt at
 * browser verification stopped at the password box. So this fills the real input, clicks the
 * real button, and waits for the app to be somewhere that requires a session.
 *
 * It is exported because two callers need exactly this: the worker fixture below, which does it
 * once and keeps the cookie, and `login.e2e.ts`, which does it as the thing under test.
 */
export async function signInThroughTheForm(page: Page, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Admin password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  /* The form is gone and the nav is present — a check that the session took, rather than that
     the button reacted. `Sign out` only renders inside the authenticated shell. */
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

interface Options {
  /**
   * Whether the browser context starts with an admin session already in it.
   *
   * True for every test whose subject is a page behind the login. `login.e2e.ts` sets it false,
   * because a suite that can only ever start signed in cannot prove that signing in works — or
   * that a wrong password is refused.
   */
  signedIn: boolean
}

interface WorkerFixtures {
  controlPlane: ControlPlane
  /**
   * The admin session, made once per worker and reused.
   *
   * A FACTORY RATHER THAN A VALUE, so that asking for it is what performs the login. Playwright
   * resolves every fixture a test destructures, so a plain value here would sign in even for
   * the tests that exist to watch signing in happen.
   */
  adminStorageState: () => Promise<string>
}

export const test = base.extend<Options, WorkerFixtures>({
  signedIn: [true, { option: true }],

  /**
   * ONE REAL ROCKY SURF PER WORKER.
   *
   * Per worker rather than per test because a boot is a process, a database and a master key —
   * about a second, which is affordable a few times and not affordable forty. Per worker rather
   * than once for the whole run because these tests WRITE to the configuration file: one shared
   * installation would make the SSH-keys tests and the general-settings tests edit the same
   * file at the same time, and the resulting failure would be a mystery in whichever one lost.
   */
  controlPlane: [
    async ({}, use) => {
      const plane = await startControlPlane()
      await use(plane)
      await plane.stop()
    },
    { scope: 'worker' },
  ],

  adminStorageState: [
    async ({ controlPlane, browser }, use, workerInfo) => {
      let cached: string | undefined
      await use(async () => {
        if (cached) return cached
        const path = join(tmpdir(), `rockysurf-ui-admin-${process.pid}-${workerInfo.workerIndex}.json`)
        const context = await browser.newContext({ baseURL: controlPlane.origin })
        try {
          const page = await context.newPage()
          await signInThroughTheForm(page, controlPlane.password)
          await context.storageState({ path })
        } finally {
          await context.close()
        }
        cached = path
        return path
      })
      if (cached) rmSync(cached, { force: true })
    },
    { scope: 'worker' },
  ],

  baseURL: async ({ controlPlane }, use) => {
    await use(controlPlane.origin)
  },

  storageState: async ({ signedIn, adminStorageState }, use) => {
    await use(signedIn ? await adminStorageState() : undefined)
  },
})

export { expect }
