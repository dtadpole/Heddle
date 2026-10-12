/**
 * The platform's own folder chooser, opened by the **server**.
 *
 * A browser cannot do this job, and it is worth saying why rather than shipping something that looks
 * like it does: the page runs sandboxed, so a file input gives relative paths only, and
 * `showDirectoryPicker` gives an opaque handle — neither carries the absolute path a mount needs. The
 * harness, unlike the page, runs on the machine the folder is on, so the dialog belongs here. This is
 * what DSH does too (`dsh-host-directory-picker-native`: `osascript` on macOS, Zenity with a KDialog
 * fallback on Linux, a native dialog on Windows), and the contract below is deliberately the same one:
 * a chosen path, `cancelled`, or `unavailable` with a reason a person can act on.
 *
 * Nothing here is a shell string. Every command is a fixed argv, so a path can never be read as an
 * instruction — the picker's *output* is data, and it is validated as an absolute path before it is
 * handed back.
 */

/** What the picker concluded. A cancel is an answer, not a failure. */
export type PickerOutcome =
  | { readonly kind: 'picked'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** One command's result, as the picker needs to read it. */
export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** How the picker reaches the platform; injectable so the decision can be judged without a dialog. */
export interface PickerHooks {
  readonly platform?: NodeJS.Platform
  readonly run?: (command: string, args: readonly string[]) => Promise<CommandResult>
}

/** A picker that never answers would pin the request forever; this is the bound. */
export const PICK_TIMEOUT_MS = 10 * 60 * 1000

const PROMPT = 'Select Workspace Directory'

/** One absolute path, with the trailing separator macOS returns removed. */
function asPath(stdout: string): string | undefined {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmed)) return undefined
  return trimmed.length > 1 ? trimmed.replace(/[/\\]+$/, '') || trimmed : trimmed
}

/** Whether a failed command is the person saying no rather than the host saying it cannot. */
function looksCancelled(result: CommandResult): boolean {
  return result.code === 1 || /(?:user cancel|User canceled|-128)/i.test(result.stderr)
}

async function runWithDefault(command: string, args: readonly string[]): Promise<CommandResult> {
  const { spawn } = await import('node:child_process')
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), PICK_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      // A missing command is reported as a missing command, which is what `unavailable` is for.
      resolve({ stdout: '', stderr: `${(error as Error).message}`, code: 127 })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}

/**
 * Ask the platform for a folder.
 *
 * A cancel on any platform is `cancelled`; a host with no usable dialog is `unavailable` with the
 * sentence that says what to install, so the page can offer to type a path instead of looking broken.
 */
export async function pickFolder(hooks: PickerHooks = {}): Promise<PickerOutcome> {
  const platform = hooks.platform ?? process.platform
  const run = hooks.run ?? runWithDefault

  if (platform === 'darwin') {
    const result = await run('osascript', [
      '-e',
      `set selectedFolder to choose folder with prompt "${PROMPT}"`,
      '-e',
      'POSIX path of selectedFolder',
    ])
    if (result.code !== 0) return looksCancelled(result) ? { kind: 'cancelled' } : unavailable(result)
    const path = asPath(result.stdout)
    return path === undefined ? { kind: 'cancelled' } : { kind: 'picked', path }
  }

  if (platform === 'linux') {
    const zenity = await run('zenity', ['--file-selection', '--directory', `--title=${PROMPT}`])
    if (zenity.code === 0) {
      const path = asPath(zenity.stdout)
      if (path !== undefined) return { kind: 'picked', path }
    } else if (!missingCommand(zenity)) {
      return looksCancelled(zenity) ? { kind: 'cancelled' } : unavailable(zenity)
    }
    const kdialog = await run('kdialog', ['--getexistingdirectory', '.', '--title', PROMPT])
    if (kdialog.code === 0) {
      const path = asPath(kdialog.stdout)
      if (path !== undefined) return { kind: 'picked', path }
    }
    if (missingCommand(kdialog)) {
      return { kind: 'unavailable', reason: 'no supported native directory picker found; install zenity or kdialog, or type the path' }
    }
    return looksCancelled(kdialog) ? { kind: 'cancelled' } : unavailable(kdialog)
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog`,
      `$dialog.Description = '${PROMPT}'`,
      `if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }`,
    ].join('; ')
    const result = await run('powershell', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script])
    if (result.code !== 0) return missingCommand(result) ? unavailable(result) : looksCancelled(result) ? { kind: 'cancelled' } : unavailable(result)
    const path = asPath(result.stdout)
    return path === undefined ? { kind: 'cancelled' } : { kind: 'picked', path }
  }

  return { kind: 'unavailable', reason: `no native directory picker is known for ${platform}; type the path instead` }
}

function missingCommand(result: CommandResult): boolean {
  return result.code === 127 || /ENOENT|not found|no such file/i.test(result.stderr)
}

function unavailable(result: CommandResult): PickerOutcome {
  const reason = result.stderr.trim().split('\n').slice(-1)[0] ?? ''
  return {
    kind: 'unavailable',
    reason: reason.length > 0 ? `the directory picker failed: ${reason}` : 'the directory picker failed',
  }
}
