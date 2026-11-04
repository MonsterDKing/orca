import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storageMocks = vi.hoisted(() => ({
  available: true,
  backend: 'gnome_libsecret',
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => {
    const text = value.toString('utf8')
    if (!text.startsWith('encrypted:')) {
      throw new Error('wrong key or corrupt ciphertext')
    }
    return text.slice('encrypted:'.length)
  })
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => storageMocks.available,
    encryptString: storageMocks.encryptString,
    decryptString: storageMocks.decryptString,
    getSelectedStorageBackend: () => storageMocks.backend
  }
}))

import { PluginSecretsStore, pluginSecretsProtection } from './plugin-secrets-store'
import { ElectronSecretStore } from '../host/electron-secret-store'
import { setSecretStore } from '../../shared/secret-store'

const roots: string[] = []
const originalPlatform = process.platform

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-secrets-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  setSecretStore(new ElectronSecretStore())
  storageMocks.available = true
  storageMocks.backend = 'gnome_libsecret'
  storageMocks.encryptString.mockImplementation((value) =>
    Buffer.from(`encrypted:${value}`, 'utf8')
  )
  storageMocks.decryptString.mockImplementation((value) => {
    const text = value.toString('utf8')
    if (!text.startsWith('encrypted:')) {
      throw new Error('wrong key or corrupt ciphertext')
    }
    return text.slice('encrypted:'.length)
  })
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginSecretsStore', () => {
  it('fails closed without OS encryption and writes no plaintext file', async () => {
    const root = await tempRoot()
    storageMocks.available = false
    const store = new PluginSecretsStore(root, 'acme.demo')

    expect(store.set('token', 'plaintext')).toMatchObject({ ok: false })
    expect(store.get('token')).toMatchObject({ ok: true, value: null })
    await expect(readFile(join(root, 'acme.demo', 'secrets.json.enc'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('on a host without Electron', () => {
  const sealed = (gap: string | null, encryptString: (value: string) => Buffer) => ({
    isEncryptionAvailable: () => true,
    encryptString,
    decryptString: (cipher: Buffer) => cipher.toString('utf8').slice('sealed:'.length),
    describeProtectionGap: () => gap
  })

  it('seals through the injected store and reports a gap as not OS-protected', async () => {
    setSecretStore(sealed('key is not host-bound', (value) => Buffer.from(`sealed:${value}`)))
    const store = new PluginSecretsStore(await tempRoot(), 'acme.demo')
    expect(store.set('token', 'abc')).toEqual({ ok: true, value: true })
    expect(store.get('token')).toEqual({ ok: true, value: 'abc' })
    expect(pluginSecretsProtection().level).toBe('unavailable')
  })

  it('refuses to store a secret when sealing throws', async () => {
    setSecretStore(
      sealed(null, () => {
        throw new Error('orcad_secret_store_not_prepared')
      })
    )
    const store = new PluginSecretsStore(await tempRoot(), 'acme.demo')
    expect(store.set('token', 'abc').ok).toBe(false)
    expect(store.get('token')).toEqual({ ok: true, value: null })
  })
})
