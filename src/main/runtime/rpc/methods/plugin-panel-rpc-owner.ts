import type { RpcContext } from '../core'
import type { PluginService } from '../../../plugins/plugin-service'

export function rpcPanelOwner(context: RpcContext): string {
  // Bind bearer sessions to individual paired connections, even for sibling sockets of one device.
  return `runtime:${context.connectionId ?? context.clientId ?? 'local'}`
}

const panelOwnerClients = new Map<string, string>()

function rpcPanelClient(context: RpcContext): string {
  return context.caller?.kind === 'paired-device' ? context.caller.deviceId : 'local'
}

export function bindRpcPanelOwner(service: PluginService, context: RpcContext): string {
  const ownerKey = rpcPanelOwner(context)
  service.panels.bindOwnerSignal(ownerKey, context.signal)
  if (!panelOwnerClients.has(ownerKey)) {
    panelOwnerClients.set(ownerKey, rpcPanelClient(context))
    context.signal?.addEventListener('abort', () => panelOwnerClients.delete(ownerKey), {
      once: true
    })
  }
  return ownerKey
}

/** Clients stream on their own socket, so a panel's pushes may be read by its device's sibling. */
export function isSamePanelClient(context: RpcContext, ownerKey: string): boolean {
  return panelOwnerClients.get(ownerKey) === rpcPanelClient(context)
}
