import { defineMethod, defineStreamingMethod } from '../core'
import type { RpcContext } from '../core'
import {
  PluginHostOperationParams,
  PluginKeyParams,
  PluginPanelPushParams,
  PluginReadCustomEditorEntryParams,
  PluginResolveGitSourceParams,
  PluginSetSettingParams,
  PluginSuggestForFileTypeParams
} from '../../../../shared/rpc-contract/plugins-params'
import { applyPluginConsent } from '../../../plugins/plugin-enablement'
import {
  createPluginMarketplaceOperations,
  type PluginMarketplaceHandlerServices
} from '../../../plugins/catalog/plugin-marketplace-operations'
import { readInstalledPluginManifest } from '../../../plugins/plugin-client-list'
import {
  readPluginDeclaredSettings,
  writePluginDeclaredSetting
} from '../../../plugins/plugin-declared-settings'
import {
  installPluginOnHost,
  removePluginFromHost
} from '../../../plugins/installation/plugin-host-install-operations'
import { resolvePluginGitSource } from '../../../plugins/installation/plugin-git-ref-resolution'
import { readPluginPanelImage } from '../../../plugins/panels/plugin-panel-image'
import { handlePluginPanelStateRequest } from '../../../plugins/panels/plugin-panel-state'
import { getPluginsDataDir } from '../../../plugins/plugin-discovery'
import type { PluginService } from '../../../plugins/plugin-service'
import type { Store } from '../../../persistence/loading-store/store'
import { bindRpcPanelOwner, isSamePanelClient, rpcPanelOwner } from './plugin-panel-rpc-owner'
import { requirePluginService } from './plugins'

/** What a client on another machine needs from this host's plugins, beyond the CLI's methods. */

type PluginClientServices = {
  store: Store
  marketplace?: PluginMarketplaceHandlerServices
}

let clientServices: PluginClientServices | null = null

export function setPluginClientServicesForRpc(next: PluginClientServices | null): void {
  clientServices = next
}

function requireClientServices(): PluginClientServices {
  if (!clientServices) {
    throw new Error('Managing plugins is not available on this runtime')
  }
  return clientServices
}

function marketplaceOperations(service: PluginService) {
  const { store, marketplace } = requireClientServices()
  if (!marketplace) {
    throw new Error('Plugin catalogs are not available on this runtime')
  }
  return createPluginMarketplaceOperations(
    service,
    marketplace,
    () => store.getSettings(),
    (pluginKey, reviewedFingerprint) =>
      applyPluginConsent({
        store,
        pluginService: service,
        pluginKey,
        reviewedFingerprint,
        decision: 'approve'
      })
  )
}

let subscriptionSeq = 0

/** Runs `start` until the connection closes or the service asks to stop. */
async function streamUntilClosed(
  context: RpcContext,
  name: string,
  emit: (result: unknown) => void,
  start: () => () => void
): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = start()
    const subscriptionId = `${name}-${context.connectionId ?? 'inproc'}-${++subscriptionSeq}`
    context.runtime.registerSubscriptionCleanup(
      subscriptionId,
      () => {
        stop()
        emit({ type: 'end' })
        resolve()
      },
      context.connectionId
    )
    emit({ type: 'ready', subscriptionId })
  })
}

const declaredSettingsHost = (service: PluginService) => ({
  findValidPlugin: (pluginKey: string) => service.findValidPlugin(pluginKey),
  userDataPath: service.options.userDataPath,
  dataChanged: (pluginKey: string, key: string) =>
    service.panelBridge.dataChanged(pluginKey, 'settings', key)
})

const CATALOG_READS = [
  'listMarketplaces',
  'listMarketplacePlugins',
  'previewMarketplacePlugin',
  'previewMarketplaceUpdate',
  'getRollbackVersion'
] as const

const CATALOG_WRITES = [
  'addMarketplace',
  'removeMarketplace',
  'refreshMarketplaces',
  'installMarketplacePlugin',
  'rollbackMarketplacePlugin'
] as const

export const PLUGIN_CLIENT_METHODS = [
  defineStreamingMethod({
    name: 'plugins.subscribeChanges',
    permission: 'workspace',
    params: null,
    handler: async (_params, context, emit) => {
      const service = requirePluginService()
      await streamUntilClosed(context, 'plugins-changes', emit, () =>
        service.onChanged((event) => emit({ type: 'changed', event }))
      )
    }
  }),
  defineStreamingMethod({
    name: 'plugins.subscribePanelPush',
    permission: 'workspace',
    params: PluginPanelPushParams,
    handler: async (params, context, emit) => {
      const service = requirePluginService()
      await service.whenReady()
      // Read-only, so a sibling socket may read it; another device's token still resolves to null.
      const session = service.panels.sessionCaller(
        (ownerKey) => isSamePanelClient(context, ownerKey),
        params.sessionToken
      )
      if (!session) {
        emit({ type: 'end' })
        return
      }
      await streamUntilClosed(context, 'plugins-panel-push', emit, () =>
        service.panelBridge.open(session.caller, session.pluginKey, (push) =>
          emit({ type: 'push', push })
        )
      )
    }
  }),
  defineStreamingMethod({
    name: 'plugins.subscribeStatusBar',
    permission: 'workspace',
    params: null,
    handler: async (_params, context, emit) => {
      const { statusBar } = requirePluginService().options
      await streamUntilClosed(
        context,
        'plugins-status-bar',
        emit,
        () =>
          statusBar?.onChanged((overrides) => emit({ type: 'changed', overrides })) ?? (() => {})
      )
    }
  }),
  defineMethod({
    name: 'plugins.statusBarState',
    permission: 'workspace',
    params: null,
    handler: () => requirePluginService().options.statusBar?.snapshot() ?? {}
  }),
  defineMethod({
    name: 'plugins.readCustomEditorEntry',
    permission: 'workspace',
    params: PluginReadCustomEditorEntryParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const ownerKey = bindRpcPanelOwner(service, context)
      return service.panels.openCustomEditor(ownerKey, params.pluginKey, params.editorId)
    }
  }),
  defineMethod({
    name: 'plugins.panelState',
    permission: 'workspace',
    params: PluginHostOperationParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const owner = rpcPanelOwner(context)
      return handlePluginPanelStateRequest(
        {
          pluginsDataDir: getPluginsDataDir(service.options.userDataPath),
          resolveComponentsPanel: (token) => service.panels.componentsPanelPlugin(owner, token)
        },
        params.args
      )
    }
  }),
  defineMethod({
    name: 'plugins.panelImage',
    permission: 'workspace',
    params: PluginHostOperationParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      const owner = rpcPanelOwner(context)
      const image = await readPluginPanelImage(
        { resolveComponentsPanelRoot: (token) => service.panels.componentsPanelRoot(owner, token) },
        params.args
      )
      return image
        ? {
            contentType: image.contentType,
            base64: Buffer.from(image.bytes).toString('base64')
          }
        : null
    }
  }),
  defineMethod({
    name: 'plugins.getInstalledManifest',
    permission: 'workspace',
    params: PluginKeyParams,
    handler: async (params) => readInstalledPluginManifest(requirePluginService(), params.pluginKey)
  }),
  defineMethod({
    name: 'plugins.getSettings',
    permission: 'workspace',
    params: PluginKeyParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return readPluginDeclaredSettings(declaredSettingsHost(service), params.pluginKey)
    }
  }),
  defineMethod({
    name: 'plugins.setSetting',
    permission: 'host-admin',
    params: PluginSetSettingParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return writePluginDeclaredSetting(
        declaredSettingsHost(service),
        params.pluginKey,
        params.key,
        params.value
      )
    }
  }),
  defineMethod({
    name: 'plugins.resolveGitSource',
    permission: 'host-admin',
    params: PluginResolveGitSourceParams,
    handler: (params) => resolvePluginGitSource(params)
  }),
  defineMethod({
    // Installing grants nothing: code stays inert until plugins.consent or plugins.setEnabled.
    name: 'plugins.install',
    permission: 'host-admin',
    params: PluginHostOperationParams,
    handler: (params) => installPluginOnHost(requirePluginService(), params.args)
  }),
  defineMethod({
    name: 'plugins.remove',
    permission: 'host-admin',
    params: PluginHostOperationParams,
    handler: (params) =>
      removePluginFromHost(requirePluginService(), requireClientServices().store, params.args)
  }),
  defineMethod({
    name: 'plugins.suggestForFileType',
    permission: 'workspace',
    params: PluginSuggestForFileTypeParams,
    handler: (params) =>
      marketplaceOperations(requirePluginService()).suggestForFileType(
        params.fileType,
        params.purpose
      )
  }),
  ...CATALOG_READS.map((operation) =>
    defineMethod({
      name: `plugins.${operation}`,
      permission: 'workspace',
      params: PluginHostOperationParams,
      handler: (params: { args?: unknown }) =>
        marketplaceOperations(requirePluginService())[operation](params.args)
    })
  ),
  ...CATALOG_WRITES.map((operation) =>
    defineMethod({
      name: `plugins.${operation}`,
      permission: 'host-admin',
      params: PluginHostOperationParams,
      handler: (params: { args?: unknown }) =>
        marketplaceOperations(requirePluginService())[operation](params.args)
    })
  )
]
