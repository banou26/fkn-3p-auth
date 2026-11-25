import type { CategoryRequest, Frame } from '@fkn/lib'

import { assertPermissionReasons } from './errors.js'
import { createHiddenFrame } from './hidden-frame.js'
import { resolveClient, type ClientSource, type CloudCookies, type MountHiddenFrame } from './types.js'

/** Configuration for probing session state inside an off-screen cloud `blank` frame. */
export type VerifyHiddenSessionOptions<T> = {
  client: ClientSource
  url: string
  cookies?: CloudCookies
  permissions?: CategoryRequest[]
  probe: (frame: Frame) => Promise<T>
  postProbeSettleMs?: number
  shouldSettle?: (result: T) => boolean
  settle?: (result: T) => Promise<void>
  mountHiddenFrame?: MountHiddenFrame
  title?: string
}

const waitMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mounts an off-screen hidden `blank` cloud frame at `url`, executes `probe(frame)` without holding
 * internal state, optionally settles BEFORE removing the iframe so jar cookie updates commit, and
 * returns the probe result to caller memory.
 */
export const verifyHiddenSession = async <T>({
  client: clientSource,
  url,
  cookies = 'persistent',
  permissions,
  probe,
  postProbeSettleMs,
  shouldSettle,
  settle,
  mountHiddenFrame = createHiddenFrame,
  title = 'Session check',
}: VerifyHiddenSessionOptions<T>): Promise<T> => {
  assertPermissionReasons(permissions)
  const client = resolveClient(clientSource)
  if (!client) {
    throw new Error('verifyHiddenSession: @fkn/lib client is not loaded')
  }
  const { iframe, remove } = mountHiddenFrame(title)
  try {
    const resolvedPermissions = permissions?.length ? [...permissions] : undefined
    const frame = await client.attachFrame({
      iframe,
      blank: { url },
      cookies,
      ...(resolvedPermissions ? { permissions: resolvedPermissions } : {}),
    })
    const result = await probe(frame)
    const needsSettle = shouldSettle ? shouldSettle(result) : true
    if (needsSettle) {
      if (settle) await settle(result)
      else if (postProbeSettleMs !== undefined && postProbeSettleMs > 0) await waitMs(postProbeSettleMs)
    }
    return result
  } finally {
    remove()
  }
}
