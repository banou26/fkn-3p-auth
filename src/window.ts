import type { AttachCookies, AttachWindowOptions, CategoryRequest, WindowFrame } from '@fkn/lib'

import {
  assertPermissionReasons,
  frameWindowRefusalOf,
  isAttachWindowUnsupportedError,
  isExtensionUnsupportedError,
  isFrameWindowBlockedError,
  isFrameWindowRefusedError,
  timeoutError,
} from './errors.js'
import {
  resolveClient,
  type AuthAdapter,
  type AuthBackend,
  type AuthOutcome,
  type AuthStepContext,
  type ClientSource,
  type CloudCookies,
  type FknClient,
} from './types.js'

const DEFAULT_POLL_MS = 1_000
const DEFAULT_READ_TIMEOUT_MS = 5_000
const DEFAULT_GOTO_TIMEOUT_MS = 30_000

/** Runtime overrides passed to `openAuthWindow`. */
export type OpenAuthWindowOptions = {
  client: ClientSource
  cookies?: AttachCookies | (() => AttachCookies)
  fallbackCookies?: CloudCookies
  onNotReady?: () => void
  onOpen?: (frame: WindowFrame) => void
  signal?: AbortSignal
  now?: () => number
}

const resolveValue = <T>(value: T | (() => T)): T =>
  typeof value === 'function' ? (value as () => T)() : value

const resolvePermissions = (
  permissions: AuthAdapter['permissions'],
  cookies: AttachCookies,
): CategoryRequest[] | undefined => {
  const list = typeof permissions === 'function' ? permissions({ cookies }) : permissions
  if (!list || list.length === 0) return undefined
  assertPermissionReasons(list)
  return [...list]
}

const buildAttachOptions = (
  adapter: Pick<AuthAdapter<unknown>, 'domains' | 'window' | 'permissions'>,
  cookies: AttachCookies,
): AttachWindowOptions => {
  const window = {
    ...(adapter.window?.width === undefined ? {} : { width: adapter.window.width }),
    ...(adapter.window?.height === undefined ? {} : { height: adapter.window.height }),
  }
  const permissions = resolvePermissions(adapter.permissions, cookies)
  return {
    window,
    domains: [...adapter.domains],
    cookies,
    ...(permissions ? { permissions } : {}),
  }
}

const classifyAttachError = <TSession>(error: unknown): AuthOutcome<TSession> => {
  if (isFrameWindowBlockedError(error)) return { status: 'blocked' }
  if (isExtensionUnsupportedError(error)) {
    return { status: 'unsupported', reason: 'extension-unsupported', error }
  }
  if (isFrameWindowRefusedError(error)) {
    return { status: 'unsupported', reason: 'refused', refusalReason: frameWindowRefusalOf(error), error }
  }
  return { status: 'failed', error }
}

const sleepAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

type Settled<T> = { ok: true, value: T } | { ok: false, error: unknown }

// Settles with the step's own result or error, a timeout error past `ms`, or the abort reason.
const bounded = <T>(ms: number, signal: AbortSignal, step: string, read: () => Promise<T>): Promise<Settled<T>> => {
  if (signal.aborted) return Promise.resolve({ ok: false, error: signal.reason })
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  return Promise.race([
    Promise.resolve().then(read).then(
      (value): Settled<T> => ({ ok: true, value }),
      (error: unknown): Settled<T> => ({ ok: false, error }),
    ),
    new Promise<Settled<T>>((resolve) => {
      onAbort = () => resolve({ ok: false, error: signal.reason })
      timer = setTimeout(() => resolve({ ok: false, error: timeoutError(`openAuthWindow: ${step} did not settle within ${ms}ms`) }), ms)
      signal.addEventListener('abort', onAbort, { once: true })
    }),
  ]).finally(() => {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

const runAttachedWindow = async <TSession>(
  adapter: AuthAdapter<TSession>,
  options: OpenAuthWindowOptions,
  client: FknClient,
  initialCookies: AttachCookies,
  fallbackCookies: CloudCookies | undefined,
  attaching: Promise<WindowFrame>,
): Promise<AuthOutcome<TSession>> => {
  let activeCookies = initialCookies
  let frame: WindowFrame
  try {
    frame = await attaching
  } catch (error) {
    if (initialCookies === 'native' && fallbackCookies && isAttachWindowUnsupportedError(error)) {
      activeCookies = fallbackCookies
      try {
        frame = await client.attachFrame(buildAttachOptions(adapter, fallbackCookies))
      } catch (fallbackError) {
        return classifyAttachError(fallbackError)
      }
    } else {
      return classifyAttachError(error)
    }
  }

  const backend: AuthBackend | undefined = frame.backend()
  const outcomeTag = backend === undefined ? {} : { backend }

  if (options.signal?.aborted) {
    await frame.close().catch(() => {})
    return { status: 'closed', ...outcomeTag }
  }

  const controller = new AbortController()
  let activeDocController: AbortController | undefined
  let resolvedEnd = false
  let resolveEnded!: () => void
  const ended = new Promise<'closed'>((resolve) => {
    resolveEnded = () => {
      if (resolvedEnd) return
      resolvedEnd = true
      controller.abort()
      resolve('closed')
    }
  })

  const onExternalAbort = () => {
    resolveEnded()
    void frame.close().catch(() => {})
  }
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  void frame.closed.then(resolveEnded, resolveEnded)

  const now = options.now ?? Date.now
  const onceKeys = new Set<string>()
  const onceInFlight = new Set<string>()
  const cooldownAt = new Map<string, number>()
  const cooldownInFlight = new Set<string>()
  let origin = ''

  const createStepHelpers = (signal: AbortSignal) => ({
    once: async (stepKey: string, action: () => Promise<void>): Promise<boolean> => {
      if (signal.aborted || onceKeys.has(stepKey) || onceInFlight.has(stepKey)) return false
      onceInFlight.add(stepKey)
      try {
        await action()
        onceKeys.add(stepKey)
        return true
      } finally {
        onceInFlight.delete(stepKey)
      }
    },
    cooldown: async (stepKey: string, cooldownMs: number, action: () => Promise<void>): Promise<boolean> => {
      if (signal.aborted || cooldownInFlight.has(stepKey)) return false
      const at = now()
      const last = cooldownAt.get(stepKey)
      if (last !== undefined && at - last < cooldownMs) return false
      cooldownInFlight.add(stepKey)
      cooldownAt.set(stepKey, at)
      try {
        await action()
        return true
      } finally {
        cooldownInFlight.delete(stepKey)
      }
    },
  })

  const createContext = (signal: AbortSignal): AuthStepContext => {
    const helpers = createStepHelpers(signal)
    return {
      frame,
      backend,
      cookies: activeCookies,
      origin,
      signal,
      ...helpers,
    }
  }

  const failed = async (error: unknown): Promise<AuthOutcome<TSession>> => {
    await frame.close().catch(() => {})
    return { status: 'failed', ...outcomeTag, error }
  }

  // A refused consent or a malformed step never succeeds on a later tick; anything else (a read on a host
  // outside `domains`, a timeout, a page mid-navigation) may.
  const isFatalStepError = (error: unknown): boolean =>
    client.isPermissionDenied(error) || client.isLocatorInvalid(error)

  try {
    try {
      options.onOpen?.(frame)
    } catch (error) {
      return await failed(error)
    }
    if (controller.signal.aborted) {
      return { status: 'closed', ...outcomeTag }
    }

    const onDocument = adapter.onDocument
    frame.on(
      'document',
      (event) => {
        if (controller.signal.aborted) return
        origin = event.origin
        if (!onDocument) return
        activeDocController?.abort()
        const docController = new AbortController()
        activeDocController = docController
        const onParentAbort = () => docController.abort()
        controller.signal.addEventListener('abort', onParentAbort, { once: true })
        const docCtx = createContext(docController.signal)
        void Promise.resolve()
          .then(() => {
            if (docController.signal.aborted) return
            return onDocument(docCtx, event.origin)
          })
          .catch(() => {})
          .finally(() => controller.signal.removeEventListener('abort', onParentAbort))
      },
      { signal: controller.signal },
    )

    const gotoTimeoutMs = adapter.gotoTimeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS
    try {
      const nav = await Promise.race([
        frame.goto(adapter.entryUrl, { waitUntil: 'commit', timeout: gotoTimeoutMs }).then(() => 'navigated' as const),
        ended,
      ])
      if (nav === 'closed' || controller.signal.aborted) {
        return { status: 'closed', ...outcomeTag }
      }
    } catch (error) {
      // the window closing settles `closed` before its calls reject, so a closed window is seen here
      const closedNow = await Promise.race([
        frame.closed.then(() => true, () => true),
        Promise.resolve().then(() => false),
      ])
      if (closedNow || controller.signal.aborted) {
        return { status: 'closed', ...outcomeTag }
      }
      return await failed(error)
    }

    const readTimeoutMs = adapter.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
    const pollMs = adapter.pollMs ?? DEFAULT_POLL_MS

    // Runs one adapter step under the read timeout: 'closed' once the window ended, the step's error when
    // it can never succeed, or its result (undefined after a recoverable failure).
    const runStep = async <T>(step: string, read: () => Promise<T>): Promise<'closed' | { fatal: unknown } | Settled<T>> => {
      const settled = await Promise.race([bounded(readTimeoutMs, controller.signal, step, read), ended])
      if (settled === 'closed' || controller.signal.aborted) return 'closed'
      if (!settled.ok && isFatalStepError(settled.error)) return { fatal: settled.error }
      return settled
    }

    if (adapter.prepare) {
      const prepare = adapter.prepare
      const prep = await runStep('prepare', () => prepare(createContext(controller.signal)))
      if (prep === 'closed') return { status: 'closed', ...outcomeTag }
      if ('fatal' in prep) return await failed(prep.fatal)
    }

    for (;;) {
      await sleepAbortable(pollMs, controller.signal)
      if (controller.signal.aborted) return { status: 'closed', ...outcomeTag }

      const ctx = createContext(controller.signal)
      const signedIn = await runStep('isSignedIn', () => adapter.isSignedIn(frame, ctx))
      if (signedIn === 'closed') return { status: 'closed', ...outcomeTag }
      if ('fatal' in signedIn) return await failed(signedIn.fatal)

      if (signedIn.ok && signedIn.value === true) {
        if (!adapter.extractSession) {
          await frame.close()
          return { status: 'authed', ...outcomeTag }
        }
        const extractSession = adapter.extractSession
        const extracted = await Promise.race([
          bounded(readTimeoutMs, controller.signal, 'extractSession', () => extractSession(frame)),
          ended,
        ])
        if (extracted === 'closed' || controller.signal.aborted) {
          return { status: 'closed', ...outcomeTag }
        }
        if (!extracted.ok) return await failed(extracted.error)
        await frame.close()
        return extracted.value !== undefined
          ? { status: 'authed', ...outcomeTag, session: extracted.value }
          : { status: 'authed', ...outcomeTag }
      }

      if (adapter.onTick) {
        const onTick = adapter.onTick
        const tick = await runStep('onTick', () => onTick(ctx))
        if (tick === 'closed') return { status: 'closed', ...outcomeTag }
        if ('fatal' in tick) return await failed(tick.fatal)
      }
    }
  } finally {
    controller.abort()
    activeDocController?.abort()
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Opens an authentication window on `@fkn/lib` synchronously inside the caller's activation turn,
 * navigates to `adapter.entryUrl` at `'commit'`, drives optional document/tick assists, and closes
 * the window once `adapter.isSignedIn` returns `true` so cloud jar cookies commit before resolving.
 */
export const openAuthWindow = <TSession = void>(
  adapter: AuthAdapter<TSession>,
  options: OpenAuthWindowOptions,
): Promise<AuthOutcome<TSession>> => {
  const client = resolveClient(options.client)
  if (!client) {
    options.onNotReady?.()
    return Promise.resolve({ status: 'not-ready' })
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ status: 'closed' })
  }
  const cookies = resolveValue(options.cookies ?? adapter.cookies ?? 'persistent')
  const fallbackCookies = options.fallbackCookies ?? adapter.fallbackCookies
  let attachOptions: AttachWindowOptions
  try {
    attachOptions = buildAttachOptions(adapter, cookies)
  } catch (error) {
    return Promise.reject(error)
  }
  // Call attachFrame before any await so browser user activation is preserved for window.open.
  const attaching = client.attachFrame(attachOptions)
  return runAttachedWindow(adapter, options, client, cookies, fallbackCookies, attaching)
}
