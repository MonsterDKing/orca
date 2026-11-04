import type { PluginsApi } from '../../../preload/api/plugin-host-api'
import { PLUGIN_APPROVAL_REQUIRED_CODE } from '../../../shared/plugins/approval/plugin-cli-approval'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'

const CATALOG_TIMEOUT_MS = 120_000

type PluginStreamEvent = { type: string; [field: string]: unknown }
type PluginChangedEvent = Parameters<Parameters<PluginsApi['onChanged']>[0]>[0]
type PluginStatusOverrides = Parameters<
  Parameters<NonNullable<PluginsApi['onStatusBarChanged']>>[0]
>[0]
type PluginChangesStreamEvent = { type: 'ready' } | { type: 'changed'; event: PluginChangedEvent }
type PluginStatusBarStreamEvent =
  | { type: 'ready' }
  | { type: 'changed'; overrides: PluginStatusOverrides }

function isStreamEvent<TEvent>(value: unknown): value is TEvent {
  return typeof value === 'object' && value !== null && 'type' in value
}

/** Opens one streaming method, reopening after a dropped socket until stopped. */
export function subscribePluginStream<TEvent = PluginStreamEvent>(
  environmentId: string,
  method: string,
  params: unknown,
  onEvent: (event: TEvent) => void
): () => void {
  let stopped = false
  let unsubscribe: (() => void) | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const open = (): void => {
    if (stopped) {
      return
    }
    const reopen = (): void => {
      unsubscribe = null
      if (!stopped) {
        retry = setTimeout(open, 2_000)
      }
    }
    void subscribeRuntimeEnvironment(
      { selector: environmentId, method, params, timeoutMs: 15_000 },
      {
        onResponse: (response) => {
          if (stopped) {
            return
          }
          if (response.ok === false) {
            reopen()
          } else if (isStreamEvent<TEvent>(response.result)) {
            onEvent(response.result)
          }
        },
        onError: reopen,
        onClose: reopen
      }
    )
      .then((subscription) => {
        if (stopped) {
          subscription.unsubscribe()
        } else {
          unsubscribe = () => subscription.unsubscribe()
        }
      })
      .catch(reopen)
  }
  open()
  return () => {
    stopped = true
    if (retry) {
      clearTimeout(retry)
    }
    unsubscribe?.()
  }
}

function approvalFingerprintFrom(error: unknown): string | null {
  if (!(error instanceof RuntimeRpcCallError) || error.code !== PLUGIN_APPROVAL_REQUIRED_CODE) {
    return null
  }
  const data = error.response.error.data
  const fingerprint =
    typeof data === 'object' && data !== null && 'approvalFingerprint' in data
      ? data.approvalFingerprint
      : null
  return typeof fingerprint === 'string' ? fingerprint : null
}

/**
 * The same `window.api.plugins` shape, answered by the Orca server that owns the workspace, so
 * plugins run next to the code they act on. A person reviewed the grant in Orca's dialog before
 * these run, so the host's `approval_required` is answered here; a stale one still refuses.
 */
export function createRuntimePluginsApi(environmentId: string): PluginsApi {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId }
  const call = <T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> =>
    callRuntimeRpc<T>(target, method, params, timeoutMs ? { timeoutMs } : {})
  const operation = <T>(name: string, args?: unknown, timeoutMs?: number): Promise<T> =>
    call<T>(`plugins.${name}`, { args }, timeoutMs)
  const withApproval = async <T>(run: (approvalFingerprint?: string) => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      const fingerprint = approvalFingerprintFrom(error)
      if (fingerprint === null) {
        throw error
      }
      return run(fingerprint)
    }
  }
  return {
    list: () => call('plugins.list'),
    // Themes, languages and syntaxes paint this window, so they stay with this machine's plugins.
    listLanguagePacks: () => window.api.plugins.listLanguagePacks(),
    listThemes: () => window.api.plugins.listThemes(),
    listTerminalThemes: () => window.api.plugins.listTerminalThemes(),
    listIconThemes: () => window.api.plugins.listIconThemes(),
    loadIconTheme: (id) => window.api.plugins.loadIconTheme(id),
    listSyntaxes: () => window.api.plugins.listSyntaxes(),
    loadSyntax: (id) => window.api.plugins.loadSyntax(id),
    consent: (args) =>
      withApproval((approvalFingerprint) =>
        call('plugins.consent', {
          ...args,
          ...(approvalFingerprint ? { approvalFingerprint } : {})
        })
      ),
    setEnabled: (args) =>
      withApproval((approvalFingerprint) =>
        call('plugins.setEnabled', {
          ...args,
          ...(approvalFingerprint ? { approvalFingerprint } : {})
        })
      ),
    readPanelEntry: ({ pluginKey, panelId }) =>
      call('plugins.readPanelEntry', { pluginKey, panelId }),
    readCustomEditorEntry: ({ pluginKey, editorId }) =>
      call('plugins.readCustomEditorEntry', { pluginKey, editorId }),
    invokeCommand: (args) => call('plugins.invokeCommand', args),
    panelAction: async (args) =>
      (
        await call<{ outcome: Awaited<ReturnType<PluginsApi['panelAction']>> }>(
          'plugins.panelAction',
          args
        )
      ).outcome,
    panelState: (args) => operation('panelState', args),
    panelImage: async (args) => {
      const image = await operation<{ contentType: string; base64: string } | null>(
        'panelImage',
        args
      )
      return image
        ? {
            contentType: image.contentType,
            bytes: Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0))
          }
        : null
    },
    subscribePanelPush: (sessionToken, listener) =>
      subscribePluginStream(
        environmentId,
        'plugins.subscribePanelPush',
        { sessionToken },
        (event) => {
          if (event.type === 'push') {
            listener(event.push)
          }
        }
      ),
    getSettings: (args) => call('plugins.getSettings', args),
    setSetting: (args) => call('plugins.setSetting', args),
    resolveGitSource: (args) => call('plugins.resolveGitSource', args),
    install: (source) => operation('install', source, CATALOG_TIMEOUT_MS),
    listMarketplaces: () => operation('listMarketplaces'),
    addMarketplace: (source) => operation('addMarketplace', source, CATALOG_TIMEOUT_MS),
    removeMarketplace: (args) => operation('removeMarketplace', args),
    refreshMarketplaces: (args) => operation('refreshMarketplaces', args, CATALOG_TIMEOUT_MS),
    listMarketplacePlugins: () => operation('listMarketplacePlugins'),
    suggestForFileType: (fileType, purpose) =>
      call('plugins.suggestForFileType', { fileType, purpose }),
    previewMarketplacePlugin: (args) =>
      operation('previewMarketplacePlugin', args, CATALOG_TIMEOUT_MS),
    installMarketplacePlugin: (preview) =>
      operation('installMarketplacePlugin', preview, CATALOG_TIMEOUT_MS),
    previewMarketplaceUpdate: (args) =>
      operation('previewMarketplaceUpdate', args, CATALOG_TIMEOUT_MS),
    rollbackMarketplacePlugin: (args) =>
      operation('rollbackMarketplacePlugin', args, CATALOG_TIMEOUT_MS),
    getRollbackVersion: (args) => operation('getRollbackVersion', args),
    getInstalledManifest: (args) => call('plugins.getInstalledManifest', args),
    remove: (args) => operation('remove', args),
    getLogs: async ({ pluginKey }) =>
      (
        await call<{ lines: Awaited<ReturnType<PluginsApi['getLogs']>> }>('plugins.getLogs', {
          pluginKey
        })
      ).lines,
    refresh: () => call('plugins.refresh'),
    onChanged: (callback) => {
      let connected = false
      return subscribePluginStream<PluginChangesStreamEvent>(
        environmentId,
        'plugins.subscribeChanges',
        undefined,
        (event) => {
          if (event.type === 'changed') {
            callback(event.event)
          } else if (event.type === 'ready') {
            // A reconnect ended this client's panel sessions, so panels must read a new entry.
            if (connected) {
              callback({ contentPacksChanged: false })
            }
            connected = true
          }
        }
      )
    },
    // Update bookkeeping and install counts stay desktop-owned until a server runs the updater.
    getAutoUpdateState: () => window.api.plugins.getAutoUpdateState(),
    takeUpdateReviewNotices: () => window.api.plugins.takeUpdateReviewNotices(),
    getInstallCounts: () => window.api.plugins.getInstallCounts(),
    onInstallCountsChanged: (callback) => window.api.plugins.onInstallCountsChanged(callback),
    onAutoUpdateChanged: (callback) => window.api.plugins.onAutoUpdateChanged(callback),
    statusBarState: () => call('plugins.statusBarState'),
    onStatusBarChanged: (callback) =>
      subscribePluginStream<PluginStatusBarStreamEvent>(
        environmentId,
        'plugins.subscribeStatusBar',
        undefined,
        (event) => {
          if (event.type === 'changed') {
            callback(event.overrides)
          }
        }
      )
  }
}
