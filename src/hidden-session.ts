import type { CategoryRequest, Frame } from '@fkn/lib'

import { assertPermissionReasons, timeoutError } from './errors.js'
import { createHiddenFrame } from './hidden-frame.js'
import { clampDelay } from './timers.js'
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

// Resolves after `ms`, or rejects with the signal's reason and clears its timer when the signal aborts first.
const waitMs = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, clampDelay(ms))
    signal.addEventListener('abort', onAbort, { once: true })
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
  // one signal for the caller's abort and the deadline: the check stops after whichever step was running
  const stop = new AbortController()
  const onAbort = () => stop.abort(signal!.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(
    () => stop.abort(timeoutError(`verifyHiddenSession: did not finish within ${timeoutMs}ms`)),
    clampDelay(timeoutMs),
  )
  const stopped = new Promise<never>((_, reject) => {
    stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true })
  })
  const { iframe, remove } = mountHiddenFrame(title)
  const step = async <R>(work: Promise<R>): Promise<R> => {
    const value = await work
    stop.signal.throwIfAborted()
    return value
  }
  const check = async (): Promise<T> => {
    const resolvedPermissions = permissions?.length ? [...permissions] : undefined
    const frame = await step(client.attachFrame({
      iframe,
      blank: { url },
      cookies,
      ...(resolvedPermissions ? { permissions: resolvedPermissions } : {}),
    }))
    const result = await step(probe(frame))
    const needsSettle = shouldSettle ? shouldSettle(result) : true
    if (needsSettle) {
      if (settle) await step(settle(result))
      else if (postProbeSettleMs !== undefined && postProbeSettleMs > 0) await waitMs(postProbeSettleMs, stop.signal)
    }
    return result
  }
  const running = check()
  running.catch(() => {})
  stopped.catch(() => {})
  try {
    return await Promise.race([running, stopped])
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', onAbort)
    stop.abort()
    remove()
  }
}
