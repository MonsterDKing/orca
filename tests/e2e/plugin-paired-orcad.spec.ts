// A desktop paired to a plain-Node orcad shows that server's plugin: its panel, worker and pushes.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchPairedElectronClient } from './helpers/paired-electron-client'

const ORCAD_DIR = path.join(process.cwd(), 'out', 'orcad')
const CLI_ENTRY = path.join(ORCAD_DIR, 'out', 'cli', 'index.js')

const PANEL_HTML = `<!doctype html>
<html><body>
<h1 id="answer">waiting</h1><p id="pushed">none</p>
<script>
  orca.plugin.on('probe.tick', ({ value }) => { document.getElementById('pushed').textContent = value })
  orca.plugin.request('probe.echo', { value: 'from-panel' }).then(
    ({ value, pid }) => { document.getElementById('answer').textContent = value + ':' + pid },
    (error) => { document.getElementById('answer').textContent = 'failed: ' + error.message }
  )
</script>
</body></html>`

const WORKER = `export default async function activate(orca) {
  orca.panels.handle('probe.echo', async ({ value }) => {
    setTimeout(() => orca.panels.post('probe.tick', { value: 'pushed-by-worker' }), 200)
    return { value: 'server-' + value, pid: process.pid }
  })
}`

const MANIFEST = {
  manifestVersion: 2,
  execution: 'trusted-worker',
  id: 'orcad-probe',
  name: 'Orcad Probe',
  version: '1.0.0',
  engines: { orca: '>=1.4.246' },
  pluginApi: 1,
  main: 'main.mjs',
  contributes: {
    panels: [{ id: 'probe', title: 'Orcad Probe', icon: 'plug', entry: 'panel.html' }]
  }
}

function findOrcadNode(): string {
  const runtimes = path.join(process.cwd(), 'out', 'runtimes')
  const [runtime] = readdirSync(runtimes)
  return path.join(runtimes, runtime, 'bin', 'node')
}

type Orcad = { pairingUrl: string; env: NodeJS.ProcessEnv; child: ChildProcess; root: string }

async function startOrcad(): Promise<Orcad> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ocp-'))
  const home = path.join(root, 'home')
  mkdirSync(home)
  const userData = path.join(root, 'd')
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Inherited terminal identity would aim the CLI at the runtime this suite runs under.
    if (!key.startsWith('ORCA_') && key !== 'ELECTRON_RUN_AS_NODE') {
      env[key] = value
    }
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    ORCA_USER_DATA: userData,
    ORCA_USER_DATA_PATH: userData
  })
  const child = spawn(
    findOrcadNode(),
    [
      path.join(ORCAD_DIR, 'orcad-server.js'),
      '--json',
      '--bind',
      '127.0.0.1',
      '--port',
      '0',
      '--pairing-address',
      '127.0.0.1'
    ],
    { env, stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const pairingUrl = await new Promise<string>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      for (const line of output.split('\n')) {
        if (line.startsWith('{')) {
          const parsed: { pairing?: { url?: string } } = JSON.parse(line)
          const url = parsed.pairing?.url
          if (url) {
            resolve(url)
          }
        }
      }
    })
    child.once('exit', (code) => reject(new Error(`orcad exited early with ${code}`)))
  })
  return { pairingUrl, env, child, root }
}

// The CLI prints its JSON failure on stdout and exits non-zero.
function cliFailureStdout(error: unknown): string {
  if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
    return error.stdout
  }
  throw error
}

function orcaCli<TResult>(orcad: Orcad, args: string[]): TResult {
  const run = (): string => {
    try {
      return execFileSync(findOrcadNode(), [CLI_ENTRY, ...args, '--json'], {
        env: orcad.env,
        encoding: 'utf8'
      })
    } catch (error) {
      return cliFailureStdout(error)
    }
  }
  return JSON.parse(run())
}

test.skip(!existsSync(path.join(ORCAD_DIR, 'orcad-server.js')), 'needs pnpm build:orcad')

test('a paired desktop runs the panel and worker of the orcad it reaches', async ({
  testRepoPath: _repo
}, testInfo) => {
  // Starts its own orcad and a paired Electron client before the first panel loads.
  test.setTimeout(180_000)
  const orcad = await startOrcad()
  const pluginDir = path.join(orcad.root, 'plugin')
  mkdirSync(pluginDir)
  writeFileSync(path.join(pluginDir, 'orca-plugin.json'), JSON.stringify(MANIFEST))
  writeFileSync(path.join(pluginDir, 'panel.html'), PANEL_HTML)
  writeFileSync(path.join(pluginDir, 'main.mjs'), WORKER)

  const refused = orcaCli<{ error?: { data?: { approvalFingerprint?: string } } }>(orcad, [
    'plugin',
    'dev',
    'load',
    '--dir',
    pluginDir
  ])
  const fingerprint = refused.error?.data?.approvalFingerprint
  if (!fingerprint) {
    throw new Error(`expected approval_required, got ${JSON.stringify(refused)}`)
  }
  const loaded = orcaCli<{ ok: boolean }>(orcad, [
    'plugin',
    'dev',
    'load',
    '--dir',
    pluginDir,
    '--approve',
    fingerprint
  ])
  expect(loaded.ok).toBe(true)

  const client = await launchPairedElectronClient(
    { pairingUrl: orcad.pairingUrl },
    testInfo,
    'plugin-client'
  )
  try {
    const { page } = client
    await page.evaluate(() => {
      const state = window.__store?.getState()
      if (state && !state.rightSidebarOpen) {
        state.toggleRightSidebar()
      }
    })
    const panelButton = page.getByRole('button', { name: 'Orcad Probe', exact: true })
    await expect(panelButton).toBeVisible({ timeout: 30_000 })
    await panelButton.click()

    const panel = page.frameLocator('iframe[title="Orcad Probe"]')
    await expect(panel.locator('#answer')).toHaveText(/^server-from-panel:\d+$/, {
      timeout: 30_000
    })
    await expect(panel.locator('#pushed')).toHaveText('pushed-by-worker', { timeout: 15_000 })

    // The worker is the server's process, not one on this desktop.
    const answer = await panel.locator('#answer').textContent()
    const workerPid = Number(answer?.split(':')[1])
    const serverWorkers = execFileSync('pgrep', ['-P', String(orcad.child.pid)], {
      encoding: 'utf8'
    })
    expect(serverWorkers.split('\n').map(Number)).toContain(workerPid)
  } finally {
    await client.dispose()
    const exited = new Promise((resolve) => orcad.child.once('exit', resolve))
    orcad.child.kill('SIGTERM')
    await exited
    rmSync(orcad.root, { recursive: true, force: true })
  }
})
