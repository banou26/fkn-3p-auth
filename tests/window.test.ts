import type { AttachCookies, CategoryRequest, WindowFrame } from '@fkn/lib'

import {
  ExtensionOperationUnsupportedError,
  ExtensionOutdatedError,
  FrameWindowBlockedError,
  FrameWindowRefusedError,
  isLocatorInvalid,
  isPermissionDenied,
  LOCATOR_DENIED,
  LOCATOR_INVALID,
  LOCATOR_UNSUPPORTED,
  PERMISSION_DENIED,
} from '@fkn/lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { openAuthWindow, type AuthAdapter, type AuthStepContext, type FknClient } from '../src'

const clientWith = (attachFrame: unknown): FknClient =>
  ({ attachFrame, isLocatorInvalid, isPermissionDenied }) as unknown as FknClient

// @fkn/lib's locator and consent errors are plain Errors told apart by name, which is all its guards read
const libError = (name: string, message = name) => Object.assign(new Error(message), { name })

type FakeWindowControl = {
  frame: WindowFrame
  close: ReturnType<typeof vi.fn>
  goto: ReturnType<typeof vi.fn>
  end: () => void
  emitDocument: (origin: string) => void
  documentListenerCount: () => number
  events: string[]
}

const fakeWindow = ({
  backend = 'cloud',
  commitMs = 0,
  gotoImpl,
  isVisibleImpl,
}: {
  backend?: 'cloud' | 'extension' | undefined
  commitMs?: number
  gotoImpl?: (url: string, options?: unknown) => Promise<void>
  isVisibleImpl?: (selector: string) => Promise<boolean>
} = {}): FakeWindowControl => {
  const events: string[] = []
  const docListeners = new Set<(event: { type: 'document', origin: string }) => void>()
  let resolveClosed!: () => void
  let isClosed = false
  const closed = new Promise<void>((resolve) => {
    resolveClosed = () => {
      if (isClosed) return
      isClosed = true
      resolve()
    }
  })

  const close = vi.fn(async () => {
    if (commitMs > 0) await new Promise((resolve) => setTimeout(resolve, commitMs))
    events.push('closed-after-commit')
    resolveClosed()
  })

  const goto = vi.fn(async (url: string, options?: unknown) => {
    events.push(`goto:${url}`)
    if (gotoImpl) await gotoImpl(url, options)
  })

  const makeLocator = (selector: string) => ({
    first: () => makeLocator(selector),
    isVisible: async () => (isVisibleImpl ? isVisibleImpl(selector) : false),
    count: async () => ((isVisibleImpl && (await isVisibleImpl(selector))) ? 1 : 0),
    click: vi.fn(async () => {}),
  })

  const frame = {
    backend: () => backend,
    goto,
    url: () => '',
    close,
    closed,
    addStyleTag: vi.fn(async () => {}),
    evaluate: vi.fn(async () => undefined),
    locator: (selector: string) => makeLocator(selector),
    on: vi.fn((type: string, listener: (event: { type: 'document', origin: string }) => void, opts?: { signal?: AbortSignal }) => {
      if (type !== 'document' || opts?.signal?.aborted) return
      docListeners.add(listener)
      opts?.signal?.addEventListener('abort', () => {
        docListeners.delete(listener)
      }, { once: true })
    }),
    off: vi.fn((type: string, listener: (event: { type: 'document', origin: string }) => void) => {
      if (type === 'document') docListeners.delete(listener)
    }),
  } as unknown as WindowFrame

  return {
    frame,
    close,
    goto,
    end: resolveClosed,
    emitDocument: (origin: string) => {
      for (const listener of docListeners) listener({ type: 'document', origin })
    },
    documentListenerCount: () => docListeners.size,
    events,
  }
}

const baseAdapter = <TSession = void>(
  overrides: Partial<AuthAdapter<TSession>> = {},
): AuthAdapter<TSession> => ({
  id: 'site',
  entryUrl: 'https://example.test/login',
  domains: ['example.test'],
  pollMs: 1,
  readTimeoutMs: 50,
  isSignedIn: async () => false,
  ...overrides,
})

describe('openAuthWindow', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('calls attachFrame synchronously before returning or awaiting anything', () => {
    const attachFrame = vi.fn(() => new Promise<WindowFrame>(() => {}))
    const client = clientWith(attachFrame)

    void openAuthWindow(baseAdapter({ domains: ['www.youtube.com', 'accounts.google.com'] }), { client })

    expect(attachFrame).toHaveBeenCalledTimes(1)
    expect(attachFrame).toHaveBeenCalledWith({
      window: {},
      domains: ['www.youtube.com', 'accounts.google.com'],
      cookies: 'persistent',
    })
  })

  it('returns not-ready and invokes onNotReady when client getter yields undefined', async () => {
    const onNotReady = vi.fn()
    const outcome = await openAuthWindow(baseAdapter(), {
      client: () => undefined,
      onNotReady,
    })

    expect(outcome).toEqual({ status: 'not-ready' })
    expect(onNotReady).toHaveBeenCalledTimes(1)
  })

  it('returns closed immediately without attaching when signal is already aborted', async () => {
    const attachFrame = vi.fn()
    const controller = new AbortController()
    controller.abort()

    const outcome = await openAuthWindow(baseAdapter(), {
      client: clientWith(attachFrame),
      signal: controller.signal,
    })

    expect(outcome).toEqual({ status: 'closed' })
    expect(attachFrame).not.toHaveBeenCalled()
  })

  it('forwards partial window dimensions and rejects permission reasons over 100 chars up front', async () => {
    const attachFrame = vi.fn(() => new Promise<WindowFrame>(() => {}))
    const client = clientWith(attachFrame)

    void openAuthWindow(baseAdapter({ window: { width: 1080 } }), { client })
    expect(attachFrame).toHaveBeenLastCalledWith({
      window: { width: 1080 },
      domains: ['example.test'],
      cookies: 'persistent',
    })

    const tooLong: CategoryRequest[] = [{ category: 'interaction', reason: 'x'.repeat(101) }]
    await expect(openAuthWindow(baseAdapter({ permissions: tooLong }), { client })).rejects.toThrow(TypeError)
    expect(attachFrame).toHaveBeenCalledTimes(1)
  })

  it('maps attach errors, and reports terminal locator errors as failed rather than closed', async () => {
    const mkClient = (err: Error) => clientWith(vi.fn(async () => { throw err }))

    expect(await openAuthWindow(baseAdapter(), { client: mkClient(new FrameWindowBlockedError()) })).toEqual({ status: 'blocked' })

    const refusedKnown = new FrameWindowRefusedError('jar-unreachable')
    expect(await openAuthWindow(baseAdapter(), { client: mkClient(refusedKnown) })).toEqual({
      status: 'unsupported',
      reason: 'refused',
      refusalReason: 'jar-unreachable',
      error: refusedKnown,
    })

    const refusedUnknown = new FrameWindowRefusedError('future-code')
    expect(await openAuthWindow(baseAdapter(), { client: mkClient(refusedUnknown) })).toEqual({
      status: 'unsupported',
      reason: 'refused',
      refusalReason: 'unknown',
      error: refusedUnknown,
    })

    const unsupported = new ExtensionOperationUnsupportedError('attachWindow', 4)
    expect(await openAuthWindow(baseAdapter(), { client: mkClient(unsupported) })).toEqual({
      status: 'unsupported',
      reason: 'extension-unsupported',
      error: unsupported,
    })

    const outdated = new ExtensionOutdatedError(3, 5)
    expect(await openAuthWindow(baseAdapter(), { client: mkClient(outdated) })).toEqual({
      status: 'unsupported',
      reason: 'extension-unsupported',
      error: outdated,
    })

    for (const name of [LOCATOR_DENIED, LOCATOR_UNSUPPORTED, LOCATOR_INVALID, PERMISSION_DENIED]) {
      const error = libError(name)
      expect(await openAuthWindow(baseAdapter(), { client: mkClient(error) })).toEqual({ status: 'failed', error })
    }

    const unexpected = new Error('unexpected failure')
    expect(await openAuthWindow(baseAdapter(), { client: mkClient(unexpected) })).toEqual({ status: 'failed', error: unexpected })
  })

  it('reports a goto a gate refused as failed while the window is still open', async () => {
    const denied = libError(LOCATOR_DENIED, 'goto: this host is not allowed')
    const win = fakeWindow({ gotoImpl: async () => { throw denied } })
    expect(await openAuthWindow(baseAdapter(), { client: clientWith(vi.fn(async () => win.frame)) })).toEqual({
      status: 'failed',
      backend: 'cloud',
      error: denied,
    })
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('reports a failed or stalled extractSession as failed, never authed', async () => {
    const extractError = new Error('token missing')
    const rejecting = fakeWindow()
    expect(await openAuthWindow(
      baseAdapter<string>({ isSignedIn: async () => true, extractSession: async () => { throw extractError } }),
      { client: clientWith(vi.fn(async () => rejecting.frame)) },
    )).toEqual({ status: 'failed', backend: 'cloud', error: extractError })
    expect(rejecting.close).toHaveBeenCalledTimes(1)

    const stalled = fakeWindow()
    const outcome = await openAuthWindow(
      baseAdapter<string>({ readTimeoutMs: 20, isSignedIn: async () => true, extractSession: () => new Promise<string>(() => {}) }),
      { client: clientWith(vi.fn(async () => stalled.frame)) },
    )
    expect(outcome.status).toBe('failed')
    expect((outcome as { error: Error }).error.name).toBe('TimeoutError')
    expect(stalled.close).toHaveBeenCalledTimes(1)
  })

  it('latches once only after its action succeeds', async () => {
    const win = fakeWindow()
    let attempts = 0
    let ticks = 0
    const outcome = await openAuthWindow(
      baseAdapter({
        onTick: async (ctx) => {
          ticks += 1
          await ctx.once('click', async () => {
            attempts += 1
            if (attempts === 1) throw new Error('element detached')
          })
        },
        isSignedIn: async () => ticks >= 4,
      }),
      { client: clientWith(vi.fn(async () => win.frame)) },
    )
    expect(outcome).toEqual({ status: 'authed', backend: 'cloud' })
    expect(attempts).toBe(2)
  })

  it('ends as failed on a step error that cannot recover, and keeps polling through one that can', async () => {
    const refusal = libError(PERMISSION_DENIED, 'Permission denied: interaction on example.test')
    const refused = fakeWindow()
    expect(await openAuthWindow(
      baseAdapter({ isSignedIn: async () => { throw refusal } }),
      { client: clientWith(vi.fn(async () => refused.frame)) },
    )).toEqual({ status: 'failed', backend: 'cloud', error: refusal })

    const invalid = libError(LOCATOR_INVALID, 'click: selector must be a string')
    const broken = fakeWindow()
    expect(await openAuthWindow(
      baseAdapter({ onTick: async () => { throw invalid } }),
      { client: clientWith(vi.fn(async () => broken.frame)) },
    )).toEqual({ status: 'failed', backend: 'cloud', error: invalid })

    let reads = 0
    const offHost = fakeWindow()
    expect(await openAuthWindow(
      baseAdapter({
        isSignedIn: async () => {
          reads += 1
          if (reads < 3) throw libError(LOCATOR_DENIED, 'count: the window is on a host outside domains')
          return true
        },
      }),
      { client: clientWith(vi.fn(async () => offHost.frame)) },
    )).toEqual({ status: 'authed', backend: 'cloud' })
  })

  it('passes the latest document origin to each step', async () => {
    const win = fakeWindow()
    const seen: string[] = []
    let ticks = 0
    await openAuthWindow(
      baseAdapter({
        onTick: async (ctx) => {
          ticks += 1
          seen.push(ctx.origin)
          if (ticks === 1) win.emitDocument('https://accounts.google.com')
        },
        isSignedIn: async () => ticks >= 2,
      }),
      { client: clientWith(vi.fn(async () => win.frame)) },
    )
    expect(seen).toEqual(['', 'https://accounts.google.com'])
  })

  it('falls back in the same click from native to fallbackCookies only on attachWindow refusal', async () => {
    const win = fakeWindow({ backend: 'cloud' })
    const attachFrame = vi.fn(async (opts: { cookies?: AttachCookies }) => {
      if (opts.cookies === 'native') {
        throw new ExtensionOperationUnsupportedError('attachWindow', 4)
      }
      return win.frame
    })
    const seenPerms: AttachCookies[] = []

    const outcome = await openAuthWindow(
      baseAdapter({
        cookies: 'native',
        fallbackCookies: 'persistent',
        permissions: ({ cookies }) => {
          seenPerms.push(cookies)
          return [{ category: 'interaction', reason: `mode:${cookies}` }]
        },
        isSignedIn: async () => true,
      }),
      { client: clientWith(attachFrame) },
    )

    expect(outcome).toEqual({ status: 'authed', backend: 'cloud' })
    expect(seenPerms).toEqual(['native', 'persistent'])
    expect(attachFrame).toHaveBeenCalledTimes(2)

    // No cross-jar fallback when fallbackCookies is omitted.
    const noFallbackAttach = vi.fn(async () => {
      throw new ExtensionOperationUnsupportedError('attachWindow', 4)
    })
    const noFallbackOutcome = await openAuthWindow(
      baseAdapter({ cookies: 'native' }),
      { client: clientWith(noFallbackAttach) },
    )
    expect(noFallbackOutcome.status).toBe('unsupported')
    expect(noFallbackAttach).toHaveBeenCalledTimes(1)

    // Non-attachWindow operation refusal does not trigger fallbackCookies.
    const otherOpAttach = vi.fn(async () => {
      throw new ExtensionOperationUnsupportedError('cookies', 4)
    })
    const otherOpOutcome = await openAuthWindow(
      baseAdapter({ cookies: 'native', fallbackCookies: 'persistent' }),
      { client: clientWith(otherOpAttach) },
    )
    expect(otherOpOutcome.status).toBe('unsupported')
    expect(otherOpAttach).toHaveBeenCalledTimes(1)
  })

  it('navigates at commit, closes and reports goto failures as failed, and awaits close() commit before authed', async () => {
    const navigationError = new Error('navigation failed')
    const failing = fakeWindow({
      gotoImpl: async () => { throw navigationError },
    })
    expect(
      await openAuthWindow(baseAdapter(), {
        client: clientWith(vi.fn(async () => failing.frame)),
      }),
    ).toEqual({ status: 'failed', backend: 'cloud', error: navigationError })
    expect(failing.close).toHaveBeenCalledTimes(1)

    let polls = 0
    const slowClose = fakeWindow({ commitMs: 25 })
    const outcome = await openAuthWindow<{ tokenPresent: boolean }>(
      baseAdapter<{ tokenPresent: boolean }>({
        gotoTimeoutMs: 12_000,
        isSignedIn: async () => {
          polls += 1
          if (polls === 1) throw new Error('transient redirect reject')
          return polls >= 3
        },
        extractSession: async () => {
          slowClose.events.push('extracted')
          return { tokenPresent: true }
        },
      }),
      { client: clientWith(vi.fn(async () => slowClose.frame)) },
    )

    expect(slowClose.goto).toHaveBeenCalledWith('https://example.test/login', { waitUntil: 'commit', timeout: 12_000 })
    expect(outcome).toEqual({ status: 'authed', backend: 'cloud', session: { tokenPresent: true } })
    expect(slowClose.events).toEqual(['goto:https://example.test/login', 'extracted', 'closed-after-commit'])
  })

  it('bounds stalled isSignedIn checks and ends immediately when the window closes or signal aborts', async () => {
    const win = fakeWindow()
    const neverEndingRead = new Promise<boolean>(() => {})
    const promise = openAuthWindow(
      baseAdapter({
        pollMs: 1,
        readTimeoutMs: 20,
        isSignedIn: () => neverEndingRead,
      }),
      { client: clientWith(vi.fn(async () => win.frame)) },
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    win.end()
    expect(await promise).toEqual({ status: 'closed', backend: 'cloud' })

    const controller = new AbortController()
    const win2 = fakeWindow()
    const abortedPromise = openAuthWindow(
      baseAdapter({ pollMs: 50 }),
      {
        client: clientWith(vi.fn(async () => win2.frame)),
        signal: controller.signal,
      },
    )
    await vi.waitFor(() => expect(win2.goto).toHaveBeenCalled())
    controller.abort()
    expect(await abortedPromise).toEqual({ status: 'closed', backend: 'cloud' })
    expect(win2.close).toHaveBeenCalledTimes(1)
  })

  it('tracks once and cooldown step helpers and aborts superseded onDocument work', async () => {
    const win = fakeWindow()
    let clock = 1_000
    let ticks = 0
    let onceCalls = 0
    let cooldownCalls = 0
    const docSignals: { origin: string, abortedOnNext: boolean }[] = []
    let prevDocCtx: AuthStepContext | undefined

    const outcome = await openAuthWindow(
      baseAdapter({
        pollMs: 1,
        onDocument: async (ctx, origin) => {
          if (prevDocCtx) {
            docSignals.push({ origin, abortedOnNext: prevDocCtx.signal.aborted })
          }
          prevDocCtx = ctx
          if (origin === 'https://accounts.google.com') {
            throw new Error('non-fatal document listener error')
          }
        },
        onTick: async (ctx) => {
          ticks += 1
          await ctx.once('click-login', async () => {
            onceCalls += 1
          })
          if (ticks === 1) {
            win.emitDocument('https://www.youtube.com')
            await Promise.resolve()
          }
          if (ticks === 2) {
            win.emitDocument('https://accounts.google.com')
            await Promise.resolve()
          }
          await ctx.cooldown('step', 100, async () => {
            cooldownCalls += 1
          })
          if (ticks === 1) clock += 50
          if (ticks === 2) clock += 60
        },
        isSignedIn: async () => ticks >= 4,
      }),
      {
        client: clientWith(vi.fn(async () => win.frame)),
        now: () => clock,
      },
    )

    expect(outcome).toEqual({ status: 'authed', backend: 'cloud' })
    expect(onceCalls).toBe(1)
    expect(cooldownCalls).toBe(2)
    expect(docSignals).toEqual([{ origin: 'https://accounts.google.com', abortedOnNext: true }])
    expect(prevDocCtx?.signal.aborted).toBe(true)
    expect(win.documentListenerCount()).toBe(0)
  })

  it('clears bounded read timers immediately when the window closes before timeout', async () => {
    vi.useFakeTimers()
    const win = fakeWindow()
    const run = openAuthWindow(
      baseAdapter({
        pollMs: 10,
        readTimeoutMs: 4_000,
        isSignedIn: () => new Promise<boolean>(() => {}),
      }),
      { client: clientWith(vi.fn(async () => win.frame)) },
    )

    await vi.advanceTimersByTimeAsync(15)
    expect(vi.getTimerCount()).toBe(1)

    win.end()
    expect(await run).toEqual({ status: 'closed', backend: 'cloud' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns closed when goto rejects right as frame.closed settles, and reports a throwing onOpen as failed', async () => {
    const closingWin = fakeWindow({
      gotoImpl: async () => {
        queueMicrotask(() => closingWin.end())
        throw new Error('detached during goto')
      },
    })
    expect(
      await openAuthWindow(baseAdapter(), {
        client: clientWith(vi.fn(async () => closingWin.frame)),
      }),
    ).toEqual({ status: 'closed', backend: 'cloud' })
    expect(closingWin.close).not.toHaveBeenCalled()

    const onOpenWin = fakeWindow()
    const onOpenError = new Error('onOpen blew up')
    expect(
      await openAuthWindow(baseAdapter(), {
        client: clientWith(vi.fn(async () => onOpenWin.frame)),
        onOpen: () => {
          throw onOpenError
        },
      }),
    ).toEqual({ status: 'failed', backend: 'cloud', error: onOpenError })
    expect(onOpenWin.close).toHaveBeenCalledTimes(1)
  })
})
