import { fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, downloadBackup, restoreBackup, type RestoreResult } from '../lib/api'
import { BackupRestoreCards } from './BackupRestoreCards'

/** The card links to /help#backup, so it renders inside a router, as on the page. */
const render = (props: ComponentProps<typeof BackupRestoreCards>) =>
  baseRender(
    <MemoryRouter>
      <BackupRestoreCards {...props} />
    </MemoryRouter>,
  )

/**
 * The Backup tab's two cards (issue #331), mocked at the API-client boundary like every card
 * test here. What these cases pin is the HONESTY of the surface: the exact-count token
 * disclosure, the restore that needs a second explicit click, the report that names what to
 * re-enter, and the failure text for a file that was never a backup.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    downloadBackup: vi.fn(),
    restoreBackup: vi.fn(),
  }
})

const mocked = {
  download: vi.mocked(downloadBackup),
  restore: vi.mocked(restoreBackup),
}

beforeEach(() => {
  vi.clearAllMocks()
})

const emptyDomain = { restored: 0, skipped: 0, refused: [] }

const RESULT: RestoreResult = {
  report: {
    users: { restored: 0, skipped: 1, refused: [] },
    tools: { restored: 2, skipped: 0, refused: [] },
    toolState: { applied: 0, skipped: 0 },
    packs: emptyDomain,
    servers: { restored: 1, skipped: 0, refused: [] },
    repositories: { restored: 0, skipped: 0 },
    secrets: { restored: 3, skipped: 0, readable: 3, unreadable: 0, dropped: [] },
    spend: {},
  },
  config: { written: true, applied: true, pinnedKept: ['server.port'] },
  tokensToReenter: ['acme/widgets', 'instance-wide github.pat'],
}

const pickFile = (text: string, name = 'rockysurf-backup.json') => {
  const input = screen.getByLabelText('Backup file')
  fireEvent.change(input, { target: { files: [new File([text], name, { type: 'application/json' })] } })
}

describe('the Backup card', () => {
  it('discloses the exact number of tokens that will not travel', () => {
    render({ literalTokenCount: 2, onRestored: () => {} })
    expect(screen.getByText(/The 2 GitHub tokens pasted into your configuration file will NOT be included/)).toBeTruthy()
  })

  it('says nothing about tokens when the file holds none — no warning-shaped reassurance', () => {
    render({ literalTokenCount: 0, onRestored: () => {} })
    expect(screen.queryByText(/will NOT be included/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Download backup' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('reports a failed download in place', async () => {
    mocked.download.mockRejectedValueOnce(new ApiError(500, 'boom', { error: 'the database is on fire' }))
    render({ literalTokenCount: 0, onRestored: () => {} })
    fireEvent.click(screen.getByRole('button', { name: 'Download backup' }))
    await waitFor(() => expect(screen.getByText('the database is on fire')).toBeTruthy())
  })
})

describe('the Restore card', () => {
  it('restores only on the second, explicit click, then reports and reloads', async () => {
    mocked.restore.mockResolvedValueOnce(RESULT)
    const onRestored = vi.fn()
    render({ literalTokenCount: 0, onRestored: onRestored })

    pickFile(JSON.stringify({ artifact: 'rockysurf-backup' }))
    expect(mocked.restore).not.toHaveBeenCalled()

    const confirm = await screen.findByRole('button', { name: /Restore rockysurf-backup\.json/ })
    fireEvent.click(confirm)

    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    expect(screen.getByText(/Servers: 1 restored/)).toBeTruthy()
    expect(screen.getByText(/Tools: 2 restored/)).toBeTruthy()
    expect(screen.getByText(/all readable with this machine/)).toBeTruthy()
    // The owner-required list: exactly which tokens to paste back in, by name.
    expect(screen.getByText(/acme\/widgets, instance-wide github\.pat/)).toBeTruthy()
    expect(screen.getByText(/Kept this machine’s server\.port/)).toBeTruthy()
  })

  it('refuses a file that is not JSON without calling the API', async () => {
    render({ literalTokenCount: 0, onRestored: () => {} })
    pickFile('definitely not json', 'holiday-photos.tar')
    fireEvent.click(await screen.findByRole('button', { name: /Restore holiday-photos\.tar/ }))
    await waitFor(() =>
      expect(screen.getByText(/holiday-photos\.tar is not a Rocky Surf backup/)).toBeTruthy(),
    )
    expect(mocked.restore).not.toHaveBeenCalled()
  })

  it('renders the server refusal text when the API declines', async () => {
    mocked.restore.mockRejectedValueOnce(
      new ApiError(400, 'Bad Request', {
        error: 'this backup was made by a newer Rocky Surf than the one restoring it — upgrade this installation first, then restore.',
      }),
    )
    render({ literalTokenCount: 0, onRestored: () => {} })
    pickFile(JSON.stringify({ artifact: 'rockysurf-backup', formatVersion: 99 }))
    fireEvent.click(await screen.findByRole('button', { name: /Restore/ }))
    await waitFor(() => expect(screen.getByText(/made by a newer Rocky Surf/)).toBeTruthy())
  })

  it('shows the config refusal with the fix-and-rerun instruction', async () => {
    mocked.restore.mockResolvedValueOnce({
      ...RESULT,
      config: {
        written: false,
        applied: false,
        refused: [{ path: 'providers.hetzner.token', message: 'names an unset variable' }],
        pinnedKept: [],
      },
      tokensToReenter: [],
    })
    render({ literalTokenCount: 0, onRestored: () => {} })
    pickFile(JSON.stringify({ artifact: 'rockysurf-backup' }))
    fireEvent.click(await screen.findByRole('button', { name: /Restore/ }))
    await waitFor(() => expect(screen.getByText(/configuration portion was refused/)).toBeTruthy())
    expect(screen.getByText(/restore the same file again/)).toBeTruthy()
  })
})
