import process from 'node:process'
import { getAppEnvironment } from '../../shared/app-environment'
import { DesktopPushService } from '../runtime/push/desktop-push-service'
import { resolvePushGatewayOrigin } from '../runtime/push/push-gateway-origin'

type DesktopPushOptions = Parameters<typeof DesktopPushService.create>[0]

export function startOrcadDesktopPush(
  runtime: DesktopPushOptions['runtime'],
  runtimeRpc: DesktopPushOptions['runtimeRpc']
): void {
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
}
