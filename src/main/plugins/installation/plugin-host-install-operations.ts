import { z } from 'zod'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN,
  type PluginLockfile
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import type { Store } from '../../persistence/loading-store/store'
import { isBundledPluginKey } from '../plugin-bundled-bootstrap'
import { listPluginsForClients } from '../plugin-client-list'
import { getPluginsDataDir, getUserPluginsDir } from '../plugin-discovery'
import { clearRemovedPluginSettings } from '../plugin-removal-settings'
import type { PluginService } from '../plugin-service'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from './plugin-install'

const installArgsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-path'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('git'),
    url: z.string().trim().min(1).refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
    // Why: installs must stay reproducible even when callers bypass renderer validation.
    ref: z.string().trim().min(1),
    /** The commit the dialog showed; install fails if the ref moved since. */
    expectedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN).optional()
  })
])

const removeArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export function parsePluginInstallArgs(args: unknown): z.infer<typeof installArgsSchema> {
  return installArgsSchema.parse(args)
}

export function canRemoveInstalledPlugin(
  pluginService: PluginService,
  pluginKey: string,
  lock?: PluginLockfile
): boolean {
  return (
    lock?.plugins[pluginKey]?.source.kind !== 'bundled' &&
    pluginService.getDiscovered().some((plugin) => plugin.pluginKey === pluginKey && !plugin.isDev)
  )
}

export async function installPluginOnHost(pluginService: PluginService, args: unknown) {
  await pluginService.whenReady()
  const parsed = parsePluginInstallArgs(args)
  const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
  const hostVersion = pluginService.options.hostVersion
  const blockedPluginReason = (pluginKey: string): string | null =>
    pluginService.options.getPluginKillListEntry?.(pluginKey)?.reason ?? null
  const result =
    parsed.kind === 'local-path'
      ? await installPluginFromLocalPath({
          pluginsDir,
          sourcePath: parsed.path,
          hostVersion,
          blockedPluginReason
        })
      : await installPluginFromGit({
          pluginsDir,
          url: parsed.url,
          ref: parsed.ref,
          ...(parsed.expectedCommit ? { expectedCommit: parsed.expectedCommit } : {}),
          hostVersion,
          blockedPluginReason
        })
  if (result.ok) {
    await pluginService.refresh()
  }
  return result
}

export async function removePluginFromHost(
  pluginService: PluginService,
  store: Store,
  args: unknown,
  /** Desktop only: guests keep per-plugin browser storage; a server has none. */
  clearFrameStorage?: (pluginKey: string) => Promise<void>
) {
  await pluginService.whenReady()
  const parsed = removeArgsSchema.parse(args)
  const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
  const lock = await readPluginLockfile(pluginsDir)
  if (!canRemoveInstalledPlugin(pluginService, parsed.pluginKey, lock)) {
    throw new Error(`cannot remove protected or non-installed plugin ${parsed.pluginKey}`)
  }
  // Why: Orca republishes a copy it ships on the next launch; it must come back off, not on.
  const { bundledPluginRoot } = pluginService.options
  const shipped =
    bundledPluginRoot !== undefined &&
    (await isBundledPluginKey(bundledPluginRoot, parsed.pluginKey))
  await pluginService.removePlugin(parsed.pluginKey, () =>
    removeInstalledPlugin({
      pluginsDir,
      pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
      pluginKey: parsed.pluginKey,
      // Why before deletion: a crash mid-delete must not leave an approved half-removed plugin.
      beforeRemove: () =>
        clearRemovedPluginSettings(store, parsed.pluginKey, { keepDisabled: shipped })
    })
  )
  await clearFrameStorage?.(parsed.pluginKey)
  await pluginService.refresh()
  return listPluginsForClients(pluginService)
}
