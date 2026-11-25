import type { AttachCookies, AttachWindowOptions, CategoryRequest, WindowFrame } from '@fkn/lib'

import {
  assertPermissionReasons,
  frameWindowRefusalOf,
  isAttachWindowUnsupportedError,
  isExtensionUnsupportedError,
  isFrameWindowBlockedError,
  isFrameWindowRefusedError,
  isTerminalDetachError,
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

const classifyAttachError = <TSession>(error: unknown, client: FknClient): AuthOutcome<TSession> => {
  if (isFrameWindowBlockedError(error)) return { status: 'blocked' }
  if (isExtensionUnsupportedError(error)) {
    return { status: 'unsupported', reason: 'extension-unsupported', error }
  }
  if (isFrameWindowRefusedError(error)) {
    return { status: 'unsupported', reason: 'refused', refusalReason: frameWindowRefusalOf(error), error }
  }
  if (isTerminalDetachError(error, client)) return { status: 'closed' }
  throw error
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

const bounded = <T>(ms: number, signal: AbortSignal, read: () => Promise<T>): Promise<T | undefined> => {
  if (signal.aborted) return Promise.resolve(undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  return Promise.race([
    Promise.resolve().then(read).catch(() => undefined),
    new Promise<undefined>((resolve) => {
      onAbort = () => {
        clearTimeout(timer)
        resolve(undefined)
      }
      timer = setTimeout(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort)
        resolve(undefined)
      }, ms)
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
        return classifyAttachError(fallbackError, client)
      }
    } else {
      return classifyAttachError(error, client)
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
  const cooldownAt = new Map<string, number>()
  const cooldownInFlight = new Set<string>()

  const createStepHelpers = (signal: AbortSignal) => ({
    once: async (stepKey: string, action: () => Promise<void>): Promise<boolean> => {
      if (signal.aborted || onceKeys.has(stepKey)) return false
      onceKeys.add(stepKey)
      await action()
      return true
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
      signal,
      ...helpers,
    }
  }

  try {
    try {
      options.onOpen?.(frame)
    } catch (error) {
      await frame.close().catch(() => {})
      throw error
    }
    if (controller.signal.aborted) {
      return { status: 'closed', ...outcomeTag }
    }

    if (adapter.onDocument) {
      const onDocument = adapter.onDocument
      frame.on(
        'document',
        (event) => {
          if (controller.signal.aborted) return
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
    }

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
      if (controller.signal.aborted || isTerminalDetachError(error, client)) {
        return { status: 'closed', ...outcomeTag }
      }
      const closedNow = await Promise.race([
        frame.closed.then(() => true, () => true),
        Promise.resolve().then(() => false),
      ])
      if (closedNow || controller.signal.aborted) {
        return { status: 'closed', ...outcomeTag }
      }
      await frame.close().catch(() => {})
      throw error
    }

    const readTimeoutMs = adapter.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
    const pollMs = adapter.pollMs ?? DEFAULT_POLL_MS
    const ctx = createContext(controller.signal)

    if (adapter.prepare) {
      const prep = await Promise.race([
        bounded(readTimeoutMs, controller.signal, () => adapter.prepare!(ctx).then(() => true as const)),
        ended,
      ])
      if (prep === 'closed' || controller.signal.aborted) {
        return { status: 'closed', ...outcomeTag }
      }
    }

    for (;;) {
      await sleepAbortable(pollMs, controller.signal)
      if (controller.signal.aborted) return { status: 'closed', ...outcomeTag }

      const signedIn = await Promise.race([
        bounded(readTimeoutMs, controller.signal, () => adapter.isSignedIn(frame, ctx)),
        ended,
      ])
      if (signedIn === 'closed' || controller.signal.aborted) {
        return { status: 'closed', ...outcomeTag }
      }

      if (signedIn === true) {
        let session: TSession | undefined
        if (adapter.extractSession) {
          const extracted = await Promise.race([
            bounded(
              readTimeoutMs,
              controller.signal,
              () => adapter.extractSession!(frame).then((value) => ({ ok: true as const, value })),
            ),
            ended,
          ])
          if (extracted === 'closed' || controller.signal.aborted) {
            return { status: 'closed', ...outcomeTag }
          }
          if (extracted?.ok) session = extracted.value
        }
        await frame.close()
        return session !== undefined
          ? { status: 'authed', ...outcomeTag, session }
          : { status: 'authed', ...outcomeTag }
      }

      if (adapter.onTick) {
        const tick = await Promise.race([
          bounded(readTimeoutMs, controller.signal, () => adapter.onTick!(ctx).then(() => true as const)),
          ended,
        ])
        if (tick === 'closed' || controller.signal.aborted) {
          return { status: 'closed', ...outcomeTag }
        }
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
