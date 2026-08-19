import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  pollGithubConnect,
  startGithubConnect,
  type GithubConnection,
  type GithubDeviceFlowStart,
} from '../lib/api'

/**
 * Connect GitHub — one button for the credential that covers everything else (rockysurf-7fyf.2).
 *
 * Kept out of `SettingsPage.tsx` on purpose: that file is already 1200 lines of config-file
 * editor, and this is not a config field. It is a small state machine over a device flow whose
 * token never goes near the file — the encrypted store holds it, core reads that store live at
 * server-create, and so **this card shows no restart notice** while the token boxes below it
 * still do. That asymmetry is real and the copy says which half is which.
 *
 * WHAT IT DOES WHEN NOTHING IS CONFIGURED: renders, disabled, with the two setup steps. Not
 * hidden. `settings/fields.ts` draws the line — `hidden` is for a control whose only message is
 * "you cannot use this" and whose edit has no destination. This edit has one: register an app,
 * paste the id, the button works. Hiding it would hide the cure with the disease.
 *
 * THE BROWSER NEVER TALKS TO GITHUB. Core polls the device endpoints and hands back a status, so
 * every network call here goes through `lib/api` and there is no second path for a test to miss.
 *
 * POLLING STOPS. On every terminal state, on Cancel, and on unmount — an interval left running
 * after navigation is a leak, and a leak in a test is a flake.
 */

type Phase = 'idle' | 'awaiting' | 'connected' | 'denied' | 'expired' | 'error'

/**
 * The scope sentence, said HERE rather than left to GitHub's authorize screen.
 *
 * `repo` is read and write across every repository the account can reach. The owner accepted
 * that trade-off — it is the price of one click — but an operator should meet it on the page
 * where they decide, not on the page where they confirm.
 */
export const SCOPE_NOTE =
  'Rocky Surf asks for the repo scope, which is read and write access to every repository this ' +
  'account can reach. For narrower access, add a per-repository token below instead.'

/** The confirmation before disconnecting. Lives here so the card owns its own words. */
export const DISCONNECT_CONFIRMATION =
  'Rocky Surf will forget this token. It is NOT revoked at GitHub — revoking needs a client ' +
  'secret the device flow does not use, so to be certain it can no longer be used, remove Rocky ' +
  'Surf at github.com/settings/applications. Boxes you have already created keep the token they ' +
  'were built with.'

const EXPIRED_MESSAGE = 'The code expired before it was approved on github.com. Get a new code and try again.'

export interface ConnectGitHubCardProps {
  /** Null while the first read is in flight. */
  connection: GithubConnection | null
  /** Re-read the connection after it changes, so the rest of the page agrees with this card. */
  onChanged: () => void | Promise<void>
  /** Ask the page for its confirmation modal — one confirmation pattern on this page, not two. */
  onDisconnect: () => void
}

export function ConnectGitHubCard({ connection, onChanged, onDisconnect }: ConnectGitHubCardProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [flow, setFlow] = useState<GithubDeviceFlowStart | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [starting, setStarting] = useState(false)
  const [copied, setCopied] = useState(false)
  /** Survives a re-render without restarting the poll — see the effect below. */
  const intervalRef = useRef(5)

  /**
   * WHETHER THIS IS CONNECTED IS THE PARENT'S ANSWER, NOT THIS CARD'S MEMORY. A successful poll
   * refreshes the parent and the card re-renders from the refreshed fact, so a disconnect
   * elsewhere on the page cannot leave this claiming a connection that no longer exists.
   */
  const connected = connection?.connected === true
  const configured = connection?.clientIdConfigured === true
  const login = connection?.login ?? null
  const scopes = connection?.scopes ?? []

  const stop = useCallback(() => {
    setFlow(null)
    setRemaining(0)
    setCopied(false)
  }, [])

  /**
   * THE POLL. One `setTimeout` at a time, rescheduled from inside itself, so the gap between
   * polls is whatever the LAST response said it should be — which is how `slow_down` lengthens
   * it: core adds the five seconds and reports the new interval, and the next timer honours it.
   *
   * Keyed on the flow id rather than on the interval, deliberately. An interval in the
   * dependency array would tear down and restart the timer on every `slow_down`, which is the
   * one thing a backing-off poll must not do.
   */
  useEffect(() => {
    if (phase !== 'awaiting' || !flow) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      try {
        const result = await pollGithubConnect(flow.flowId)
        if (cancelled) return
        if (result.status === 'pending') {
          intervalRef.current = result.intervalSeconds
          timer = setTimeout(() => void tick(), result.intervalSeconds * 1000)
          return
        }
        // Every other status is terminal: the flow is gone server-side, and the page offers a
        // fresh start rather than restarting one by itself.
        setMessage(result.status === 'connected' ? null : result.message)
        setPhase(result.status)
        stop()
        if (result.status === 'connected') await onChanged()
      } catch (err) {
        if (cancelled) return
        setMessage(err instanceof ApiError ? err.detail : 'Could not reach Rocky Surf to check the connection.')
        setPhase('error')
        stop()
      }
    }

    timer = setTimeout(() => void tick(), intervalRef.current * 1000)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [phase, flow, onChanged, stop])

  /** The countdown, which is the only thing that ticks once a second. */
  useEffect(() => {
    if (phase !== 'awaiting') return
    const id = setInterval(() => setRemaining((prev) => Math.max(0, prev - 1)), 1000)
    return () => clearInterval(id)
  }, [phase])

  /**
   * Expiry, as its own state rather than an auto-restart. A misconfigured app would loop against
   * a wall forever without ever saying why, so the operator asks for the next code.
   */
  useEffect(() => {
    if (phase === 'awaiting' && remaining === 0 && flow) {
      setPhase('expired')
      setMessage(EXPIRED_MESSAGE)
      stop()
    }
  }, [phase, remaining, flow, stop])

  async function begin(): Promise<void> {
    setStarting(true)
    setMessage(null)
    try {
      const started = await startGithubConnect()
      intervalRef.current = started.intervalSeconds
      setFlow(started)
      setRemaining(started.expiresInSeconds)
      setCopied(false)
      setPhase('awaiting')
    } catch (err) {
      setMessage(err instanceof ApiError ? err.detail : 'Could not start a GitHub connection.')
      setPhase('error')
    } finally {
      setStarting(false)
    }
  }

  function cancel(): void {
    setPhase('idle')
    setMessage(null)
    stop()
  }

  /* ------------------------------------------------------------------ the truthful line */

  /**
   * What covers everything no scoped entry below matches, in the same register as the repo
   * chips. Rendered whether or not anything is connected, because "no catch-all key" is a fact
   * an operator needs as much as the other one.
   */
  const broadCredential = connected
    ? `Everything else: connected as @${login ?? 'your GitHub account'}`
    : connection?.configFallbackSet
      ? 'Everything else: the token in the configuration file below'
      : 'Everything else: no catch-all key'

  return (
    <div className="settings-entry" data-github-connect>
      <h3>Connect GitHub</h3>
      <p className="field-help" data-broad-credential>
        {broadCredential}
      </p>

      {/* Not hidden when unconfigured — the edit has a destination, so the card names it. */}
      {!configured && connection && (
        <div data-github-setup>
          <p className="hint">
            This installation has no GitHub OAuth App yet, so there is nothing to connect to. Two
            steps, both on github.com:
          </p>
          <ol className="hint">
            <li>
              Register an OAuth App at{' '}
              <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
                github.com/settings/applications/new
              </a>
              , and tick <strong>Enable Device Flow</strong> in its settings. Leave token expiration
              off.
            </li>
            <li>
              Paste its Client ID into <code>github.oauth.clientId</code> in the configuration file,
              and restart. A client ID is public — it is safe in the file and safe to commit.
            </li>
          </ol>
        </div>
      )}

      {connected ? (
        <>
          <p className="settings-value" data-github-connected>
            Connected as @{login ?? 'unknown account'}
          </p>
          <p className="hint">
            {scopes.length > 0
              ? `Granted scopes: ${scopes.join(', ')}.`
              : 'GitHub reported no scopes for this token.'}{' '}
            This token is used for every box you create, and takes effect immediately — no restart.
          </p>
          <div className="settings-entry-actions">
            <button type="button" className="destructive" onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint" data-scope-note>
            {SCOPE_NOTE}
          </p>

          {phase === 'awaiting' && flow ? (
            <div data-github-awaiting>
              <p className="hint">
                Enter this code at{' '}
                <a href={flow.verificationUri} target="_blank" rel="noreferrer">
                  {flow.verificationUri}
                </a>
                :
              </p>
              <p className="settings-value device-code" data-user-code>
                {flow.userCode}
              </p>
              <div className="settings-entry-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(flow.userCode)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false))
                  }}
                >
                  {copied ? 'Copied' : 'Copy code'}
                </button>
                <button type="button" className="btn-secondary" onClick={cancel}>
                  Cancel
                </button>
              </div>
              <p className="hint" role="status">
                Waiting for you to approve this on github.com — {formatRemaining(remaining)} left
                before the code expires.
              </p>
            </div>
          ) : (
            <div className="settings-entry-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={!configured || starting}
                title={configured ? undefined : 'Set github.oauth.clientId first'}
                onClick={() => void begin()}
              >
                {phase === 'expired' ? 'Get a new code' : starting ? 'Starting…' : 'Connect GitHub'}
              </button>
            </div>
          )}

          {/* GitHub's own words, whatever they were. `device_flow_disabled` in particular has to
              arrive as the checkbox to tick rather than as "something went wrong". */}
          {message && phase !== 'awaiting' && (
            <p className={phase === 'error' ? 'error' : 'warning'} data-github-message role="status">
              {message}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** `900` → `15:00`. Seconds alone would be a number nobody reads as a duration. */
function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
