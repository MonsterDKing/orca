import {
  installCatalogReleaseWithApproval,
  readPreviewAccessGrowth
} from './plugin-update-approval'
import { z } from 'zod'
import { PLUGIN_COMMIT_PATTERN } from '../../../shared/plugins/installation/plugin-install-lockfile'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import { pluginMarketplaceGitSourceSchema } from '../../../shared/plugins/catalog/plugin-marketplace'
import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import type { PluginMarketplaceService } from './plugin-marketplace-service'
import { PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN } from './plugin-marketplace-store'
import type { PluginService } from '../plugin-service'
import type { PluginAutoUpdater } from './plugin-auto-updater'
import type { PluginInstallStatsService } from './plugin-install-stats-service'
import type { PluginUpdateReviewNotices } from './plugin-update-review-notices'
import type {
  PluginAutoUpdateState,
  PluginUpdateReviewNotice
} from '../../../shared/plugins/catalog/plugin-update-policy'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { pluginFileTypeSchema } from '../../../shared/plugins/contributions/plugin-file-type'
import { findPluginFileTypeSuggestion } from './plugin-file-type-suggestion'

export type PluginMarketplaceHandlerServices = {
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
  autoUpdater?: Pick<PluginAutoUpdater, 'getState'>
  reviewNotices?: Pick<PluginUpdateReviewNotices, 'take'>
  installStats?: Pick<PluginInstallStatsService, 'getInstallCounts'>
}

/** The consent write path (applyPluginConsent), bound to the store by the caller. */
export type PluginApproveConsent = (pluginKey: string, reviewedFingerprint: string) => Promise<void>

const sourceIdSchema = z.string().regex(PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN)
const removeMarketplaceSchema = z.strictObject({ sourceId: sourceIdSchema })
const refreshMarketplaceSchema = z.strictObject({ sourceId: sourceIdSchema.optional() })
const marketplacePluginSchema = z.strictObject({
  marketplaceSourceId: sourceIdSchema,
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
const installMarketplacePluginSchema = marketplacePluginSchema.extend({
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  /** Ask main to approve in the same step if the installed plugin is content only. */
  enableIfData: z.literal(true).optional(),
  /** The preview's consentFingerprint: one-click approves only these exact bytes. */
  expectedFingerprint: z.string().min(1).max(256).optional(),
  /** The page was opened from an `orca://plugins/...` link; only labels install telemetry. */
  fromInstallLink: z.literal(true).optional()
})
const installedPluginSchema = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

/** Catalog actions a client can ask of this host, over IPC on the desktop and RPC on a server. */
export function createPluginMarketplaceOperations(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices,
  getSettings: () => GlobalSettings,
  approveConsent: PluginApproveConsent
) {
  // Startup defers the official seed; a marketplace view must not wait for that timer.
  const ensureOfficialSeed = (): void => {
    if (getSettings().pluginSystemEnabled === true) {
      void services.marketplace.seedOfficialSource().catch(() => undefined)
      void services.marketplace.seedCommunitySource().catch(() => undefined)
    }
  }
  return {
    // Why cached only: this runs on every file open, which must never wait on a catalog fetch.
    suggestForFileType: async (fileType: unknown, purpose: unknown) => {
      const parsed = pluginFileTypeSchema.safeParse(fileType)
      if (!parsed.success) {
        return null
      }
      return findPluginFileTypeSuggestion({
        fileType: parsed.data,
        purpose: purpose === 'editor' ? 'editor' : 'open',
        settings: getSettings(),
        listings: await services.marketplace.listCachedPlugins(),
        installed: pluginService.getDiscovered()
      })
    },
    listMarketplaces: () => {
      ensureOfficialSeed()
      return services.marketplace.listSources()
    },
    addMarketplace: async (args: unknown) => {
      const source = pluginMarketplaceGitSourceSchema.parse(args)
      return services.marketplace.addSource(source)
    },
    removeMarketplace: async (args: unknown) => {
      const { sourceId } = removeMarketplaceSchema.parse(args)
      await services.marketplace.removeSource(sourceId)
      return services.marketplace.listSources()
    },
    refreshMarketplaces: async (args: unknown) => {
      const { sourceId } = refreshMarketplaceSchema.parse(args ?? {})
      return sourceId
        ? [await services.marketplace.refreshSource(sourceId)]
        : services.marketplace.refreshAll()
    },
    listMarketplacePlugins: () => {
      ensureOfficialSeed()
      return services.marketplace.listPlugins()
    },
    previewMarketplacePlugin: async (args: unknown) => {
      const parsed = marketplacePluginSchema.parse(args)
      return services.installer.preview(parsed.marketplaceSourceId, parsed.pluginKey)
    },
    installMarketplacePlugin: async (args: unknown) => {
      const { enableIfData, expectedFingerprint, fromInstallLink, ...identity } =
        installMarketplacePluginSchema.parse(args)
      return installCatalogReleaseWithApproval({
        pluginKey: identity.pluginKey,
        pluginService,
        install: () =>
          services.installer.install(identity, {
            trigger: fromInstallLink ? 'deep_link' : 'catalog'
          }),
        approve: approveConsent,
        ...(enableIfData ? { enableIfData: { expectedFingerprint } } : {})
      })
    },
    previewMarketplaceUpdate: async (args: unknown) => {
      const { pluginKey } = installedPluginSchema.parse(args)
      const preview = await services.installer.previewInstalledUpdate(pluginKey)
      const installed = pluginService.findValidPlugin(pluginKey)
      if (!installed) {
        return preview
      }
      return { ...preview, accessGrowth: await readPreviewAccessGrowth(installed, preview) }
    },
    getAutoUpdateState: (): PluginAutoUpdateState =>
      services.autoUpdater?.getState() ?? { updated: {}, needsReview: {} },
    takeUpdateReviewNotices: (): Promise<PluginUpdateReviewNotice[]> =>
      services.reviewNotices?.take() ?? Promise.resolve([]),
    // Why never rejects: counts are decoration; a failure just hides them.
    getInstallCounts: (): Promise<Record<string, number>> =>
      services.installStats?.getInstallCounts().catch(() => ({})) ?? Promise.resolve({}),
    getRollbackVersion: (args: unknown) => {
      const { pluginKey } = installedPluginSchema.parse(args)
      return services.installer.rollbackVersion(pluginKey)
    },
    rollbackMarketplacePlugin: async (args: unknown) => {
      const { pluginKey } = installedPluginSchema.parse(args)
      await pluginService.deactivatePlugin(pluginKey)
      const result = await services.installer.rollback(pluginKey)
      if (result.ok) {
        await pluginService.refresh()
      }
      return result
    }
  }
}
