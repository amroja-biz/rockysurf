/**
 * Reading a secret from a terminal without putting it anywhere it can be read back
 * (rockysurf-kvkr).
 *
 * The three places a password typed at a CLI normally survives are argv (`ps`), the shell's
 * history file, and the terminal scrollback. A prompt avoids the first two by construction;
 * this avoids the third by echoing nothing at all — not even asterisks, which leak the length.
 *
 * The prompt itself goes to STDERR, because stdout is `rockysurf create`'s machine-readable
 * channel (`name=$(rockysurf create ...)`) and a prompt written there would be captured as data.
 */

export type SecretPrompt = (label: string) => Promise<string>

const ENTER = ['\r', '\n']
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const BACKSPACE = ['\u007f', '\b']

export class SecretPromptCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'SecretPromptCancelled'
  }
}

/**
 * A prompt bound to this process's terminal, or `undefined` when there is not one.
 *
 * Returning `undefined` rather than a function that fails later is what lets the caller say
 * something useful — "nothing is reading a terminal here, set the environment variable" — at
 * the moment it matters, and it keeps the tests off `process.stdin` entirely: `commands.ts`
 * never consults `process.stdin.isTTY`, it only ever uses the prompt it was handed.
 */
export function ttySecretPrompt(): SecretPrompt | undefined {
  const input = process.stdin
  if (!input.isTTY || typeof input.setRawMode !== 'function') return undefined
  return (label) => readSecret(label)
}

function readSecret(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    process.stderr.write(label)

    // Raw mode is what suppresses the echo; it also suppresses SIGINT, so ^C is handled below
    // by hand rather than left to kill a process that has the terminal in a modified state.
    const wasRaw = input.isRaw
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')

    let value = ''

    const finish = (error?: Error) => {
      input.off('data', onData)
      input.setRawMode(Boolean(wasRaw))
      input.pause()
      // The newline the terminal did not print for us, so the next line starts at column 0.
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (ENTER.includes(char)) return finish()
        if (char === CTRL_C || (char === CTRL_D && value === '')) return finish(new SecretPromptCancelled())
        if (char === CTRL_D) continue
        if (BACKSPACE.includes(char)) {
          value = value.slice(0, -1)
          continue
        }
        // Any other control character (arrow keys arrive as escape sequences) is dropped
        // rather than stored: it cannot be part of a password anyone can retype.
        if (char >= ' ') value += char
      }
    }

    input.on('data', onData)
  })
}
