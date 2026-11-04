import type { PluginsApi } from '../../../preload/api/plugin-host-api'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { createRuntimePluginsApi } from '@/runtime/runtime-plugins-api'
import { getSettingsFocusedExecutionHostId } from '../../../shared/execution-host'
import { getPairedWebClientEnvironmentId } from './paired-web-client-host'

type PluginHostState = Parameters<typeof getPairedWebClientEnvironmentId>[0] & {
  activeWorkspaceExecutionHostId?: Parameters<typeof ipcOrRuntimeTargetForHostId>[0]
  settings?: Parameters<typeof getSettingsFocusedExecutionHostId>[0]
}

/** The server whose plugins this window shows: the focused workspace's, else the focused host's. */
export function pluginHostEnvironmentId(state: PluginHostState): string | null {
  const webHost = getPairedWebClientEnvironmentId(state)
  if (webHost) {
    return webHost
  }
  // Why the focused host: a freshly paired desktop has no workspace, and must not show its own plugins.
  const target =
    ipcOrRuntimeTargetForHostId(state.activeWorkspaceExecutionHostId) ??
    ipcOrRuntimeTargetForHostId(getSettingsFocusedExecutionHostId(state.settings))
  return target?.kind === 'environment' ? target.environmentId : null
}

type PluginHostStateSource = {
  getState: () => PluginHostState
  subscribe: (listener: (state: PluginHostState) => void) => () => void
}

// Why injected: editor slices call this, and importing the store here would make a module cycle.
let stateSource: PluginHostStateSource | null = null

export function registerPluginHostStateSource(source: PluginHostStateSource): void {
  stateSource = source
}

function currentEnvironmentId(): string | null {
  return stateSource ? pluginHostEnvironmentId(stateSource.getState()) : null
}

const apisByEnvironment = new Map<string, PluginsApi>()

function runtimePluginsApi(environmentId: string): PluginsApi {
  let api = apisByEnvironment.get(environmentId)
  if (!api) {
    api = createRuntimePluginsApi(environmentId)
    apisByEnvironment.set(environmentId, api)
  }
  return api
}

/** `window.api.plugins`, or its twin on the server that owns the focused workspace. */
export function hostPluginsApi(): PluginsApi | undefined {
  const environmentId = currentEnvironmentId()
  return environmentId ? runtimePluginsApi(environmentId) : window.api?.plugins
}

/** Changes from whichever host is current; moving to another host counts as a change. */
export function onHostPluginsChanged(listener: Parameters<PluginsApi['onChanged']>[0]): () => void {
  let environmentId = currentEnvironmentId()
  let stop = (environmentId ? runtimePluginsApi(environmentId) : window.api?.plugins)?.onChanged(
    listener
  )
  const stopWatching = stateSource?.subscribe((state) => {
    const next = pluginHostEnvironmentId(state)
    if (next === environmentId) {
      return
    }
    environmentId = next
    stop?.()
    stop = (next ? runtimePluginsApi(next) : window.api?.plugins)?.onChanged(listener)
    listener({ contentPacksChanged: false })
  })
  return () => {
    stopWatching?.()
    stop?.()
  }
}
