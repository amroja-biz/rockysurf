import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type SettingsChange, type SettingsField } from '../lib/api'
import {
  cidrListField,
  genericField,
  patternProblem,
  shapeProblems,
  type Edits,
  type FieldsContext,
} from './settingsFields'

/**
 * THE TWO THINGS THE FIELD CONTROLS LEARNED FROM THE FIRST-CONTACT TEST.
 *
 * An engineer was handed the published wizard and watched setting a cloud up. Two of the three
 * things they hit are in this file, because both are properties of the CONTROLS rather than of
 * either page that draws them — which is also why they only had to be fixed once:
 *
 *  - the SSH allow-list help said "your own address as a /32 is the usual answer" and gave them
 *    no way to find out what that was, so they left the browser and ran `curl`;
 *  - a mis-click put `sandbox` in the Region box and nothing said a word until the save came
 *    back refused, by which time they were three fields further down the page.
 *
 * The controls are called, not rendered (`textField(ctx, …)`, not `<TextField/>`) — see the note
 * at the top of `settingsFields.tsx` — so the harness below is a component that calls them.
 */

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, getMyIp: vi.fn() }
})

const { getMyIp } = await import('../lib/api')

const AWS_REGION: SettingsField = {
  path: 'providers.aws.region',
  kind: 'string',
  label: 'Region',
  example: 'us-east-1',
  pattern: '^[a-z]{2}(-[a-z]+)+-\\d$',
  patternMessage: 'That does not look like an AWS region, for example us-east-1.',
  writable: true,
  appliesAt: 'save',
  help: 'Which AWS region new instances are created in.',
}

const AWS_PROFILE: SettingsField = {
  path: 'providers.aws.profile',
  kind: 'string',
  label: 'Profile',
  example: 'default',
  writable: true,
  appliesAt: 'save',
  help: 'A named profile from your shared AWS credentials file.',
}

const AWS_CIDR: SettingsField = {
  path: 'providers.aws.sshAllowedCidr',
  kind: 'sshCidrList',
  label: 'SSH allowed from',
  example: '203.0.113.7/32',
  writable: true,
  appliesAt: 'save',
  help: 'Which networks may reach SSH on the boxes AWS creates here.',
}

const specsOf = (fields: SettingsField[]) => new Map(fields.map((field) => [field.path, field]))

/** A page, reduced to the one thing these controls need from one: somewhere to put an edit. */
function Harness({
  fields,
  values = {},
  draw,
}: {
  fields: SettingsField[]
  values?: Record<string, unknown>
  draw: (ctx: FieldsContext) => ReactNode
}) {
  const [edits, setEdits] = useState<Edits>({})
  const [cidrDrafts, setCidrDrafts] = useState<Record<string, string>>({})
  const specs = specsOf(fields)
  const ctx: FieldsContext = {
    values,
    defaults: {},
    specs,
    edits,
    fieldErrors: {},
    warnings: {},
    setEdit: (path: (string | number)[], change: SettingsChange | null) =>
      setEdits((prev) => {
        const next = { ...prev }
        const key = path.join('.')
        if (change === null) delete next[key]
        else next[key] = change
        return next
      }),
    providers: [],
    cidrDrafts,
    setCidrDrafts,
    confirm: (request) => void request.confirm(),
    draw: () => {},
    hoistedWarnings: new Set<string>(),
    passwordFormOwners: [],
  }
  return (
    <>
      {draw(ctx)}
      {/* What a page's Save button reads to decide whether it may be pressed. */}
      <p data-testid="problems">{shapeProblems(specs, edits).map((problem) => problem.label).join(',')}</p>
    </>
  )
}

beforeEach(() => {
  vi.mocked(getMyIp).mockResolvedValue({ ip: '203.0.113.7', source: 'socket' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('a box says when what is in it is not the shape of the setting', () => {
  const drawRegion = (ctx: FieldsContext) => genericField(ctx, AWS_REGION)

  it('says nothing while the box is still being typed into', () => {
    render(<Harness fields={[AWS_REGION]} draw={drawRegion} />)
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'sandbox' } })
    // Complaining about `us-` halfway through `us-east-1` would be an editor arguing with a
    // half-written word, so nothing is said until focus leaves.
    expect(document.querySelector('[data-shape-problem]')).toBeNull()
  })

  it('says so the moment focus leaves, in the Provider’s own words', () => {
    render(<Harness fields={[AWS_REGION]} draw={drawRegion} />)
    const box = screen.getByLabelText('Region')
    fireEvent.change(box, { target: { value: 'sandbox' } })
    fireEvent.blur(box)

    expect(screen.getByText('That does not look like an AWS region, for example us-east-1.')).toBeTruthy()
    expect(box.getAttribute('aria-invalid')).toBe('true')
  })

  it('takes the complaint back as soon as the value is right', () => {
    render(<Harness fields={[AWS_REGION]} draw={drawRegion} />)
    const box = screen.getByLabelText('Region')
    fireEvent.change(box, { target: { value: 'sandbox' } })
    fireEvent.blur(box)
    fireEvent.change(box, { target: { value: 'eu-west-1' } })

    expect(document.querySelector('[data-shape-problem]')).toBeNull()
    expect(screen.getByTestId('problems').textContent).toBe('')
  })

  it('names the box for a Save button to refuse, and only while it is wrong', () => {
    render(<Harness fields={[AWS_REGION]} draw={drawRegion} />)
    const box = screen.getByLabelText('Region')
    fireEvent.change(box, { target: { value: 'sandbox' } })
    expect(screen.getByTestId('problems').textContent).toBe('Region')
    fireEvent.change(box, { target: { value: 'ap-southeast-4' } })
    expect(screen.getByTestId('problems').textContent).toBe('')
  })

  it('leaves a field that declared no pattern completely alone', () => {
    render(<Harness fields={[AWS_PROFILE]} draw={(ctx) => genericField(ctx, AWS_PROFILE)} />)
    const box = screen.getByLabelText('Profile')
    fireEvent.change(box, { target: { value: 'anything at all' } })
    fireEvent.blur(box)
    expect(document.querySelector('[data-shape-problem]')).toBeNull()
    expect(screen.getByTestId('problems').textContent).toBe('')
  })

  it('treats an emptied box as saying nothing, not as a badly-shaped value', () => {
    render(<Harness fields={[AWS_REGION]} draw={drawRegion} />)
    const box = screen.getByLabelText('Region')
    fireEvent.change(box, { target: { value: 'sandbox' } })
    fireEvent.blur(box)
    fireEvent.change(box, { target: { value: '' } })
    expect(document.querySelector('[data-shape-problem]')).toBeNull()
    expect(screen.getByTestId('problems').textContent).toBe('')
  })
})

describe('the shape check itself', () => {
  const check = (value: string) => patternProblem(AWS_REGION, value)

  it('accepts the region shapes AWS actually sells', () => {
    for (const region of ['us-east-1', 'eu-central-1', 'ap-southeast-4', 'us-gov-west-1', 'il-central-1']) {
      expect(check(region)).toBeNull()
    }
  })

  it('refuses the ones a mis-click produces', () => {
    for (const typo of ['sandbox', 'US-EAST-1', 'us-east', 'eastus', 'us east 1']) {
      expect(check(typo)).toBe('That does not look like an AWS region, for example us-east-1.')
    }
  })

  /*
    A pattern that does not compile means the field has NO shape check — never a refused value.
    One bad character in a Provider's declaration must not be able to stop an operator saving.
  */
  it('ignores a pattern that is not a regular expression', () => {
    expect(patternProblem({ ...AWS_REGION, pattern: '^[a-z' }, 'sandbox')).toBeNull()
  })

  it('ignores a pattern with no message to print', () => {
    const noMessage = { ...AWS_REGION }
    delete noMessage.patternMessage
    expect(patternProblem(noMessage, 'sandbox')).toBeNull()
  })

  it('reads the shape off the SPEC, so a cloud this package never heard of gets it too', () => {
    const nimbus: SettingsField = {
      path: 'providers.nimbus.region',
      kind: 'string',
      label: 'Region',
      example: 'sky-2',
      pattern: '^sky-\\d$',
      patternMessage: 'That does not look like a Nimbus Cloud region, for example sky-2.',
      writable: true,
      appliesAt: 'save',
      help: 'Where Nimbus Cloud puts things.',
    }
    expect(patternProblem(nimbus, 'sky-2')).toBeNull()
    expect(patternProblem(nimbus, 'us-east-1')).toBe('That does not look like a Nimbus Cloud region, for example sky-2.')
  })

  it('never holds a save hostage over a value already in the file', () => {
    // The edits are what a page may refuse to send. A bad value the operator did not type is the
    // server's to refuse, not this page's.
    expect(shapeProblems(specsOf([AWS_REGION]), {})).toEqual([])
    expect(shapeProblems(specsOf([AWS_REGION]), { 'providers.aws.region': { path: ['providers', 'aws', 'region'], unset: true } })).toEqual([])
  })
})

describe('"Use my current IP" on the SSH allow-list', () => {
  const drawCidr = (ctx: FieldsContext) => cidrListField(ctx, 'aws', 'SSH allowed from')
  const withList = (
    <Harness
      fields={[AWS_CIDR]}
      values={{ providers: { aws: { sshAllowedCidr: ['198.51.100.0/24'] } } }}
      draw={drawCidr}
    />
  )

  it('fills the Add box with a /32 of the address core reports', async () => {
    render(withList)
    fireEvent.click(screen.getByTestId('use-my-ip-aws'))

    await waitFor(() =>
      expect((screen.getByLabelText('Add a network for aws') as HTMLInputElement).value).toBe('203.0.113.7/32'),
    )
    // It fills the box and stops: this is a firewall rule, and Add stays a deliberate act.
    expect(document.querySelectorAll('.settings-cidr-list li').length).toBe(1)
  })

  /**
   * The ordinary installation: the page is open on the machine running Rocky Surf, so the socket
   * says loopback and core answers with what the internet sees this COMPUTER at instead. Different
   * fact, so it is labelled as one rather than quietly handed over as the same number.
   */
  it('labels a public-lookup answer as the address of this computer', async () => {
    vi.mocked(getMyIp).mockResolvedValue({ ip: '198.51.100.4', source: 'public' })
    render(withList)
    fireEvent.click(screen.getByTestId('use-my-ip-aws'))

    const note = await screen.findByText(/198\.51\.100\.4 is your public address as seen from this computer/)
    expect(note).toBeTruthy()
    expect((screen.getByLabelText('Add a network for aws') as HTMLInputElement).value).toBe('198.51.100.4/32')
  })

  it('says which address it is when the socket already knew', async () => {
    render(withList)
    fireEvent.click(screen.getByTestId('use-my-ip-aws'))
    expect(await screen.findByText(/203\.0\.113\.7 is the address this browser reached Rocky Surf from/)).toBeTruthy()
  })

  it('prints core’s own sentence when neither lookup worked, rather than filling nothing in silence', async () => {
    vi.mocked(getMyIp).mockRejectedValue(
      new ApiError(500, 'Server Error', { error: 'Rocky Surf could not work out your address. Type the network in yourself.' }),
    )
    render(withList)
    fireEvent.click(screen.getByTestId('use-my-ip-aws'))

    expect(await screen.findByText(/Type the network in yourself/)).toBeTruthy()
    expect((screen.getByLabelText('Add a network for aws') as HTMLInputElement).value).toBe('')
  })

  it('adds the filled-in network when Add is pressed, like anything typed by hand', async () => {
    render(withList)
    fireEvent.click(screen.getByTestId('use-my-ip-aws'))
    await waitFor(() =>
      expect((screen.getByLabelText('Add a network for aws') as HTMLInputElement).value).toBe('203.0.113.7/32'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(document.querySelectorAll('.settings-cidr-list li').length).toBe(2))
    expect(screen.getByText('203.0.113.7/32')).toBeTruthy()
  })
})
