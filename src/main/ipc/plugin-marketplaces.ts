import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PluginService } from '../plugins/plugin-service'
import {
  createPluginMarketplaceOperations,
  type PluginApproveConsent,
  type PluginMarketplaceHandlerServices
} from '../plugins/catalog/plugin-marketplace-operations'

export type {
  PluginApproveConsent,
  PluginMarketplaceHandlerServices
} from '../plugins/catalog/plugin-marketplace-operations'

export function registerPluginMarketplaceHandlers(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices,
  getSettings: () => GlobalSettings,
  approveConsent: PluginApproveConsent
): void {
  const operations = createPluginMarketplaceOperations(
    pluginService,
    services,
    getSettings,
    approveConsent
  )
  ipcMain.handle('plugins:suggestForFileType', (_event, fileType: unknown, purpose: unknown) =>
    operations.suggestForFileType(fileType, purpose)
  )
  ipcMain.handle('plugins:listMarketplaces', () => operations.listMarketplaces())
  ipcMain.handle('plugins:addMarketplace', (_event, args: unknown) =>
    operations.addMarketplace(args)
  )
  ipcMain.handle('plugins:removeMarketplace', (_event, args: unknown) =>
    operations.removeMarketplace(args)
  )
  ipcMain.handle('plugins:refreshMarketplaces', (_event, args: unknown) =>
    operations.refreshMarketplaces(args)
  )
  ipcMain.handle('plugins:listMarketplacePlugins', () => operations.listMarketplacePlugins())
  ipcMain.handle('plugins:previewMarketplacePlugin', (_event, args: unknown) =>
    operations.previewMarketplacePlugin(args)
  )
  ipcMain.handle('plugins:installMarketplacePlugin', (_event, args: unknown) =>
    operations.installMarketplacePlugin(args)
  )
  ipcMain.handle('plugins:previewMarketplaceUpdate', (_event, args: unknown) =>
    operations.previewMarketplaceUpdate(args)
  )
  ipcMain.handle('plugins:getAutoUpdateState', () => operations.getAutoUpdateState())
  ipcMain.handle('plugins:takeUpdateReviewNotices', () => operations.takeUpdateReviewNotices())
  ipcMain.handle('plugins:getInstallCounts', () => operations.getInstallCounts())
  ipcMain.handle('plugins:getRollbackVersion', (_event, args: unknown) =>
    operations.getRollbackVersion(args)
  )
  ipcMain.handle('plugins:rollbackMarketplacePlugin', (_event, args: unknown) =>
    operations.rollbackMarketplacePlugin(args)
  )
}
