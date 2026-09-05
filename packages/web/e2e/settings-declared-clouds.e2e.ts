import { test, expect } from './fixtures'

/**
 * EVERY SHIPPED PROVIDER'S PANEL, IN A REAL BROWSER (ADR-0027, issue #370).
 *
 * All five providers now declare their settings on their factory, and the SPA has no hand-written
 * block for any of them: what an operator sees on the Hetzner, AWS, Azure, Google Cloud and Your
 * own machines tabs is `settings/inventory.ts` turning a declaration into rows and the generic
 * renderer drawing them. That is exactly the arrangement two component-test-green regressions were
 * shipped under, so it is driven here instead — the fields, their order, their labels, their help
 * sentences, the two-act firewall control, and a save that reaches the file.
 *
 * The control plane runs BYO only (see `control-plane.ts`), which is what makes the other four
 * worth driving: their sections are not in the config file at all, so a panel built from a
 * declaration has to work for a provider whose section the operator has never written.
 */
test.describe.configure({ mode: 'serial' })

/** What each panel draws, in the order the declaration puts it in: the path, then its label. */
const PANELS: { id: string; heading: string; fields: [string, string][] }[] = [
  {
    id: 'hetzner',
    heading: 'Hetzner',
    fields: [
      ['providers.hetzner.enabled', 'Enabled'],
      ['providers.hetzner.token', 'Token Environment Variable'],
      ['providers.hetzner.location', 'Location'],
      ['providers.hetzner.consoleProjectId', 'Console project id'],
      ['providers.hetzner.sizes', 'Offered server types'],
    ],
  },
  {
    id: 'aws',
    heading: 'AWS',
    fields: [
      ['providers.aws.enabled', 'Enabled'],
      ['providers.aws.region', 'Region'],
      ['providers.aws.profile', 'Profile'],
      ['providers.aws.sshAllowedCidr', 'SSH allowed from'],
      ['providers.aws.securityGroupName', 'Security group name'],
      ['providers.aws.sizes', 'Offered instance types'],
    ],
  },
  {
    id: 'azure',
    heading: 'Azure',
    fields: [
      ['providers.azure.enabled', 'Enabled'],
      ['providers.azure.subscriptionId', 'Subscription id'],
      ['providers.azure.resourceGroup', 'Resource group'],
      ['providers.azure.location', 'Location'],
      ['providers.azure.sshAllowedCidr', 'SSH allowed from'],
      ['providers.azure.sizes', 'Offered VM sizes'],
    ],
  },
  {
    id: 'gcp',
    heading: 'Google Cloud',
    fields: [
      ['providers.gcp.enabled', 'Enabled'],
      ['providers.gcp.projectId', 'Project id'],
      ['providers.gcp.zone', 'Zone'],
      ['providers.gcp.sshAllowedCidr', 'SSH allowed from'],
      ['providers.gcp.sizes', 'Offered machine types'],
    ],
  },
  {
    /* The BYO tab carries two cards: the provider's own field, then its declared `hosts` list. */
    id: 'byo',
    heading: 'Your own machines',
    fields: [
      ['providers.byo.enabled', 'Enabled'],
      ['providers.byo.identityFile', 'Default private key path'],
      ['providers.byo.hosts.0.name', 'Name'],
      ['providers.byo.hosts.0.host', 'Address'],
      ['providers.byo.hosts.0.user', 'Admin login'],
      ['providers.byo.hosts.0.port', 'SSH port'],
      ['providers.byo.hosts.0.fingerprint', 'Host key fingerprint'],
      ['providers.byo.hosts.0.identityFile', 'Private key path'],
    ],
  },
]

const panelOf = (id: string) => `#settings-panel-providers\\.${id}`

/** A dotted config path as a CSS id selector. `CSS.escape` is a browser API; this runs in Node. */
const cssId = (id: string) => id.replaceAll('.', '\\.')

for (const panel of PANELS) {
  test(`the ${panel.id} panel draws its declared fields, in order, each labelled and explained`, async ({ page }) => {
    await page.goto(`/settings?section=providers.${panel.id}`)
    await expect(page.getByRole('heading', { name: panel.heading, exact: true })).toBeVisible()

    const controls = page.locator(`${panelOf(panel.id)} [data-field]`)
    expect(await controls.evaluateAll((els) => els.map((el) => el.getAttribute('data-field')))).toEqual(
      panel.fields.map(([path]) => path),
    )

    for (const [path, label] of panel.fields) {
      const group = page.locator(`${panelOf(panel.id)} [data-field="${path}"]`)
      /* A plain control wears a `<label>`; the CIDR list is a fieldset and wears a `<legend>`. */
      await expect(group.locator('label, legend').first(), `${path} is not labelled`).toHaveText(label)
      /* Rule 3 of this page: every control says what it is for, and since #370 that sentence is
         the provider's own — moved verbatim off the rows core used to carry. */
      await expect(page.locator(`#${cssId(`${path}-help`)}`), `${path} has no help under it`).toBeVisible()
    }
  })
}

test('the three firewall clouds each get the two-act whitelist control, and no bare checkbox', async ({ page }) => {
  for (const id of ['aws', 'azure', 'gcp']) {
    await page.goto(`/settings?section=providers.${id}`)
    const cidr = page.locator(`[data-field="providers.${id}.sshAllowedCidr"]`)
    await expect(cidr.getByRole('group')).toBeVisible()
    await expect(cidr.getByText('None set.', { exact: false })).toBeVisible()
    await expect(cidr.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
    /* `allowAllCidr` is the list's second act and appears only once 0.0.0.0/0 is in the list; a
       permanent checkbox offering to open SSH to the internet is what ADR-0021 forbids. */
    await expect(page.locator(`#providers\\.${id}\\.allowAllCidr`)).toHaveCount(0)
  }
})

test('a network typed into the GCP whitelist is saved into a file that had no gcp section at all', async ({
  page,
  controlPlane,
}) => {
  await page.goto('/settings?section=providers.gcp')
  expect(controlPlane.readConfig()).not.toContain('gcp:')

  const cidr = page.locator('[data-field="providers.gcp.sshAllowedCidr"]')
  await cidr.getByLabel('Add a network for gcp').fill('203.0.113.7/32')
  await cidr.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(cidr.getByText('203.0.113.7/32')).toBeVisible()

  await page.locator('#providers\\.gcp\\.projectId').fill('my-project-123456')
  await page.getByRole('button', { name: 'Save to the file' }).click()

  await expect.poll(() => controlPlane.readConfig()).toMatch(/gcp:[\s\S]*203\.0\.113\.7\/32/)
  expect(controlPlane.readConfig()).toContain('projectId: my-project-123456')
  /* GCP is not enabled here, so nothing was composed and nothing was pushed at a real cloud —
     what this case is about is the panel and the write, not the converge. */
  await expect(page.locator('.settings-sync-report')).toHaveCount(0)
})

/**
 * BYO'S HOSTS, THE FIRST LIST A SHIPPED PROVIDER DECLARES.
 *
 * The card, its six boxes and their labels used to be a hand-written block in `SettingsPage.tsx`.
 * They are `byoProviderFactory.settings.lists[0]` now, drawn by the same `genericList` that draws
 * `ssh.keys` — so a wrong label here would be a declaration the page ignored.
 */
test('the BYO hosts card is drawn from the declared list, with the provider’s own Add form', async ({ page }) => {
  await page.goto('/settings?section=providers.byo.hosts')
  await expect(page.getByRole('heading', { name: 'Hosts', exact: true })).toBeVisible()
  await expect(page.locator('#providers\\.byo\\.hosts\\.0\\.name')).toHaveValue('workshop')
  await expect(page.getByRole('button', { name: 'Add host' })).toBeVisible()
})

/**
 * A PERSONAL SECTION WHOSE `package` IS A TYPO (ADR-0026, issue #377).
 *
 * The failure mode this rules out is the silent drop: a section the loader could not resolve
 * vanishing from the page, so the one place an operator could fix the typo is the place that
 * refuses to show it.
 */
test('a personal section with a mistyped package still has a panel, with the package box writable', async ({ page }) => {
  await page.goto('/settings?section=providers.stratus')
  await expect(page.getByRole('heading', { name: 'stratus', exact: true })).toBeVisible()

  const pkg = page.locator('#providers\\.stratus\\.package')
  await expect(pkg).toBeVisible()
  await expect(pkg).toBeEditable()
  await expect(pkg).toHaveValue(/personal-providerrr?$/)
  await expect(page.locator('#providers\\.stratus\\.enabled')).toBeVisible()
})
