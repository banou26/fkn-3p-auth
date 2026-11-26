import type { CategoryRequest, Frame } from '@fkn/lib'

import { assertPermissionReasons, timeoutError } from './errors.js'
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
  /** Deadline for the whole check, attach through settle; past it the call rejects with a `TimeoutError` and the iframe is removed. Defaults to 30,000 ms. */
  timeoutMs?: number
  /** Ends the check early: the call rejects with the signal's reason and the iframe is removed. */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000

const waitMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const withDeadline = <T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => fail(signal!.reason)
    const timer = setTimeout(() => fail(timeoutError(`verifyHiddenSession: did not finish within ${ms}ms`)), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then((value) => {
      cleanup()
      resolve(value)
    }, fail)
  })

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
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}: VerifyHiddenSessionOptions<T>): Promise<T> => {
  assertPermissionReasons(permissions)
  const client = resolveClient(clientSource)
  if (!client) {
    throw new Error('verifyHiddenSession: @fkn/lib client is not loaded')
  }
  signal?.throwIfAborted()
  const { iframe, remove } = mountHiddenFrame(title)
  const check = async (): Promise<T> => {
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
  }
  try {
    return await withDeadline(check(), timeoutMs, signal)
  } finally {
    remove()
  }
}
