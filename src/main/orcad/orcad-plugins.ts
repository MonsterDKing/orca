// Host plugins on the Node server: workers, hooks, events and the plugins.* RPC, with no windows.
import { getAppEnvironment } from '../../shared/app-environment'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/approval/plugin-consent-state'
import { pluginHostVersion } from '../../shared/plugins/installation/plugin-host-version'
import type { agentHookServer } from '../agent-hooks/server'
import type { Store } from '../persistence/loading-store/store'
import { PluginKillListService } from '../plugins/catalog/plugin-kill-list-service'
import { PluginMarketplaceInstaller } from '../plugins/catalog/plugin-marketplace-installer'
import { PluginMarketplaceService } from '../plugins/catalog/plugin-marketplace-service'
import { PluginImageCache } from '../plugins/plugin-image-cache'
import { projectPluginAgentStatusChangedPayload } from '../plugins/plugin-agent-status-event'
import { getPluginsDataDir } from '../plugins/plugin-discovery'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import {
  bindPluginRuntime,
  createPluginAgentStatusForwarder,
  emitPluginWorktreeLifecycle,
  watchPluginWorkspaceContext
} from '../plugins/plugin-runtime-binding'
import { PluginService } from '../plugins/plugin-service'
import { PluginStatusBarState } from '../plugins/status-bar/plugin-status-bar-state'
import { resolvePluginHostEntryPath } from '../plugins/workers/plugin-host-process'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { setPluginServiceForRpc } from '../runtime/rpc/methods/plugins'
import { setPluginClientServicesForRpc } from '../runtime/rpc/methods/plugins-client'
import { join } from 'node:path'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/** A plugin failure must leave the server running, so nothing here rejects past startup. */
export async function startOrcadPlugins(
  runtime: OrcaRuntimeService,
  store: Store,
  hookServer: typeof agentHookServer,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): Promise<void> {
  const environment = getAppEnvironment()
  const userDataPath = environment.getPath('userData')
  const isEnabled = (): boolean => store.getSettings().pluginSystemEnabled === true

  const killList = new PluginKillListService({ pluginsDataDir: getPluginsDataDir(userDataPath) })
  await killList.initialize().catch((error: unknown) => {
    console.warn('[orcad-plugins] failed to read the plugin safety list:', error)
  })

  const service = new PluginService({
    userDataPath,
    hostVersion: pluginHostVersion(environment.getVersion()),
    isPluginSystemEnabled: isEnabled,
    getDisabledPlugins: () => normalizePluginIdList(store.getSettings().disabledPlugins),
    getPluginConsents: () => normalizePluginConsents(store.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(store.getSettings().devPluginPaths),
    getPluginKillListEntry: (pluginKey) => killList.find(pluginKey),
    hostEntryPath: resolvePluginHostEntryPath(environment.getAppPath(), false),
    statusBar: new PluginStatusBarState()
  })
  // Reverse order: stop delivering events, then refuse RPC, then stop the workers.
  registerCleanup(() => service.dispose())
  registerCleanup(() => setPluginServiceForRpc(null))

  killList.onChanged(() => {
    void service
      .reconcileActivationState()
      .catch((error: unknown) =>
        console.warn('[orcad-plugins] failed to apply a safety-list refresh:', error)
      )
  })
  const refreshKillList = (): void => {
    void killList
      .refresh()
      .catch((error: unknown) =>
        console.warn('[orcad-plugins] failed to refresh the safety list:', error)
      )
  }
  registerCleanup(
    store.onSettingsChanged((updates) => {
      if (updates.pluginSystemEnabled !== undefined) {
        killList.syncPeriodicRefresh(updates.pluginSystemEnabled === true)
        if (updates.pluginSystemEnabled === true) {
          refreshKillList()
        }
      }
      if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
        void service
          .refresh()
          .catch((error: unknown) =>
            console.warn('[orcad-plugins] failed to apply a settings change:', error)
          )
      }
    })
  )

  const delegate = bindPluginRuntime(service, runtime, hookServer)
  setPluginServiceForRpc(service, {
    applyConsent: (request) => applyPluginConsent({ store, pluginService: service, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store, pluginService: service, pluginKey, enabled }),
    setPluginSystemEnabled: (pluginSystemEnabled) =>
      store.updateSettings({ pluginSystemEnabled }, { notifyListeners: true }),
    setDevPluginPaths: (devPluginPaths) =>
      store.updateSettings({ devPluginPaths }, { notifyListeners: true })
  })

  const pluginsDataDir = getPluginsDataDir(userDataPath)
  const imageCache = new PluginImageCache(join(pluginsDataDir, 'image-cache'))
  const hostVersion = pluginHostVersion(environment.getVersion())
  const marketplace = new PluginMarketplaceService({
    imageCache,
    pluginsDataDir,
    getKillListEntry: (pluginKey) => killList.find(pluginKey),
    hostVersion
  })
  setPluginClientServicesForRpc({
    store,
    marketplace: {
      marketplace,
      installer: new PluginMarketplaceInstaller({
        marketplace,
        userDataPath,
        hostVersion,
        blockedPluginReason: (pluginKey) => killList.reason(pluginKey),
        imageCache
      })
    }
  })
  registerCleanup(() => setPluginClientServicesForRpc(null))

  // Discovery only; workers and panel reads wait for an explicit trigger.
  void service
    .initialize()
    .catch((error: unknown) =>
      console.warn('[orcad-plugins] failed to initialize the plugin service:', error)
    )
  if (isEnabled()) {
    refreshKillList()
    killList.syncPeriodicRefresh(true)
  }

  const forwardAgentStatus = createPluginAgentStatusForwarder(delegate, service)
  registerCleanup(
    hookServer.subscribeEnrichedStatus((enriched) => {
      const payload = projectPluginAgentStatusChangedPayload(enriched)
      if (payload) {
        forwardAgentStatus(payload, enriched.terminalHandle)
      }
    })
  )
  registerCleanup(
    watchPluginWorkspaceContext({
      delegate,
      events: service,
      onSessionWritten: (listener) => store.onWorkspaceSessionWritten(listener)
    })
  )
  registerCleanup(
    runtime.onWorktreeLifecycle((event) => emitPluginWorktreeLifecycle(service, event))
  )
}
