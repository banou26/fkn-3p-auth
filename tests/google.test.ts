import type { WindowFrame } from '@fkn/lib'

import { isLocatorInvalid, isPermissionDenied } from '@fkn/lib'
import { describe, expect, it, vi } from 'vite-plus/test'

import { openAuthWindow, type FknClient } from '../src'
import {
  createGoogleAuthAdapter,
  DEFAULT_GOOGLE_DOMAINS,
  DEFAULT_GOOGLE_INTERACTION_REASON,
  GOOGLE_PASSKEY_SELECTORS,
  youtubeAuthAdapter,
} from '../src/google'

const clientWith = (attachFrame: unknown): FknClient =>
  ({ attachFrame, isLocatorInvalid, isPermissionDenied }) as unknown as FknClient

type FakePageState = {
  visible: Set<string>
  avatarCount: number
}

const fakeGoogleWindow = (backend: 'cloud' | 'extension' = 'cloud') => {
  const page: FakePageState = {
    visible: new Set(['a[href*="ServiceLogin"]']),
    avatarCount: 0,
  }
  const docListeners = new Set<(event: { type: 'document', origin: string }) => void>()
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const clicks: { selector: string, reason?: string }[] = []
  const styles: unknown[] = []
  const evaluate = vi.fn(async () => undefined)
  const addStyleTag = vi.fn(async (opts: unknown) => { styles.push(opts) })
  const close = vi.fn(async () => { resolveClosed() })
  const goto = vi.fn(async () => {})

  const makeLocator = (selector: string) => ({
    first: () => makeLocator(selector),
    isVisible: async () => page.visible.has(selector),
    count: async () => (selector === '#avatar-btn' ? page.avatarCount : page.visible.has(selector) ? 1 : 0),
    click: vi.fn(async (opts?: { reason?: string }) => {
      clicks.push({ selector, ...(opts?.reason ? { reason: opts.reason } : {}) })
    }),
  })

  const frame = {
    backend: () => backend,
    goto,
    url: () => '',
    close,
    closed,
    evaluate,
    addStyleTag,
    locator: (selector: string) => makeLocator(selector),
    on: vi.fn((type: string, listener: (event: { type: 'document', origin: string }) => void, opts?: { signal?: AbortSignal }) => {
      if (type !== 'document' || opts?.signal?.aborted) return
      docListeners.add(listener)
      opts?.signal?.addEventListener('abort', () => { docListeners.delete(listener) }, { once: true })
    }),
    off: vi.fn((type: string, listener: (event: { type: 'document', origin: string }) => void) => {
      if (type === 'document') docListeners.delete(listener)
    }),
  } as unknown as WindowFrame

  return {
    frame,
    goto,
    page,
    clicks,
    styles,
    evaluate,
    addStyleTag,
    emitDocument: (origin: string) => {
      for (const listener of docListeners) listener({ type: 'document', origin })
    },
  }
}

describe('Google auth adapter', () => {
  it('uses interaction-only permissions, includes accounts.google.com, clicks ServiceLogin without evaluate, and finishes on avatar', async () => {
    const win = fakeGoogleWindow('cloud')
    const attachFrame = vi.fn(async () => win.frame)
    const onTickSpy = vi.fn()
    const base = youtubeAuthAdapter({ pollMs: 1, readTimeoutMs: 50 })
    const adapter = {
      ...base,
      onTick: async (ctx: Parameters<NonNullable<typeof base.onTick>>[0]) => {
        onTickSpy()
        await base.onTick?.(ctx)
      },
    }

    const run = openAuthWindow(adapter, { client: clientWith(attachFrame) })

    expect(attachFrame).toHaveBeenCalledWith({
      window: {},
      domains: [...DEFAULT_GOOGLE_DOMAINS],
      cookies: 'persistent',
      permissions: [{ category: 'interaction', reason: DEFAULT_GOOGLE_INTERACTION_REASON }],
    })

    await vi.waitFor(() => expect(win.clicks.length).toBe(1))
    expect(win.clicks).toEqual([{ selector: 'a[href*="ServiceLogin"]', reason: DEFAULT_GOOGLE_INTERACTION_REASON }])
    expect(win.evaluate).not.toHaveBeenCalled()

    // Ensure another tick on Google login does not re-click or require evaluation.
    win.page.visible.clear()
    await vi.waitFor(() => expect(onTickSpy.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(win.clicks).toHaveLength(1)

    win.page.avatarCount = 1
    expect(await run).toEqual({ status: 'authed', backend: 'cloud' })
    expect(win.styles).toEqual([])
  })

  it('keeps default passkey selectors empty until live capture and validates interactionReason length', () => {
    expect(GOOGLE_PASSKEY_SELECTORS).toEqual({
      passkeyPrompt: '',
      selectionList: '',
      tryAnotherWay: '',
      passkeyChoiceCss: '',
    })
    expect(() => createGoogleAuthAdapter({ interactionReason: 'r'.repeat(101) })).toThrow(TypeError)
  })

  it('guards against clicking Try another way on the selection screen, honors cooldown/cap, and isolates per-window counts', async () => {
    const passkeyCss = '[data-challengetype="39"] { display: none; }'
    const adapter = createGoogleAuthAdapter({
      pollMs: 1,
      stepCooldownMs: 100,
      maxTryAnotherWayClicks: 2,
      selectors: {
        passkeyPrompt: '.passkey-prompt',
        selectionList: '.challenge-selection',
        tryAnotherWay: 'button.try-another',
        passkeyChoiceCss: passkeyCss,
      },
    })

    const win = fakeGoogleWindow('cloud')
    let clock = 1_000
    const run = openAuthWindow(adapter, {
      client: clientWith(vi.fn(async () => win.frame)),
      now: () => clock,
    })

    // ServiceLogin is clicked on the entry page; the passkey CSS waits for an accounts.google.com document.
    await vi.waitFor(() => expect(win.clicks).toHaveLength(1))
    expect(win.addStyleTag).not.toHaveBeenCalled()

    // Arrival on /challenge/selection applies CSS via onDocument; selectionList must block Try another way click.
    win.page.visible.clear()
    win.page.visible.add('.passkey-prompt')
    win.page.visible.add('.challenge-selection')
    win.page.visible.add('button.try-another')
    win.emitDocument('https://accounts.google.com')
    await vi.waitFor(() => expect(win.addStyleTag).toHaveBeenCalledTimes(1))
    expect(win.addStyleTag).toHaveBeenCalledWith({ content: passkeyCss })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(win.clicks).toHaveLength(1)

    // Leave selection screen -> clicks Try another way once, respects cooldown, then allows second click up to cap 2.
    win.page.visible.delete('.challenge-selection')
    await vi.waitFor(() => expect(win.clicks).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(win.clicks).toHaveLength(2)

    clock += 150
    await vi.waitFor(() => expect(win.clicks).toHaveLength(3))

    clock += 500
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(win.clicks).toHaveLength(3)

    win.page.avatarCount = 1
    expect(await run).toEqual({ status: 'authed', backend: 'cloud' })

    // Reusing the same adapter for a second window starts a fresh click budget via WeakMap.
    const win2 = fakeGoogleWindow('cloud')
    win2.page.visible.clear()
    win2.page.visible.add('.passkey-prompt')
    win2.page.visible.add('button.try-another')
    const run2 = openAuthWindow(adapter, {
      client: clientWith(vi.fn(async () => win2.frame)),
      now: () => 5_000,
    })
    await vi.waitFor(() => expect(win2.clicks).toHaveLength(1))
    win2.page.avatarCount = 1
    expect(await run2).toEqual({ status: 'authed', backend: 'cloud' })
  })

  it('skips passkey assists on extension backend when cloud-only, and runs them when assistPasskey is always', async () => {
    const selectors = {
      passkeyPrompt: '.passkey-prompt',
      selectionList: '.challenge-selection',
      tryAnotherWay: 'button.try-another',
      passkeyChoiceCss: '.passkey-choice { display: none; }',
    }

    const extWin = fakeGoogleWindow('extension')
    extWin.page.visible.clear()
    extWin.page.visible.add('.passkey-prompt')
    extWin.page.visible.add('button.try-another')

    const cloudOnlyAdapter = createGoogleAuthAdapter({
      pollMs: 1,
      cookies: 'native',
      assistPasskey: 'cloud-only',
      selectors,
    })
    const extRun = openAuthWindow(cloudOnlyAdapter, {
      client: clientWith(vi.fn(async () => extWin.frame)),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(extWin.addStyleTag).not.toHaveBeenCalled()
    expect(extWin.clicks).toHaveLength(0)
    extWin.page.avatarCount = 1
    expect(await extRun).toEqual({ status: 'authed', backend: 'extension' })

    const alwaysWin = fakeGoogleWindow('extension')
    alwaysWin.page.visible.clear()
    alwaysWin.page.visible.add('.passkey-prompt')
    alwaysWin.page.visible.add('button.try-another')
    const alwaysAdapter = createGoogleAuthAdapter({
      pollMs: 1,
      cookies: 'native',
      assistPasskey: 'always',
      selectors,
    })
    const alwaysRun = openAuthWindow(alwaysAdapter, {
      client: clientWith(vi.fn(async () => alwaysWin.frame)),
    })
    await vi.waitFor(() => expect(alwaysWin.clicks).toHaveLength(1))
    // the extension reports no origin, so its documents arrive with ''
    alwaysWin.emitDocument('')
    await vi.waitFor(() => expect(alwaysWin.addStyleTag).toHaveBeenCalledTimes(1))
    alwaysWin.page.avatarCount = 1
    expect(await alwaysRun).toEqual({ status: 'authed', backend: 'extension' })
  })

  it('clicks ServiceLogin only on the entry origin and applies passkey CSS only on accounts.google.com', async () => {
    const passkeyCss = '.passkey-choice { display: none; }'
    const adapter = youtubeAuthAdapter({ pollMs: 1, selectors: { passkeyChoiceCss: passkeyCss } })

    const onAccounts = fakeGoogleWindow('cloud')
    // the entry page redirects straight to accounts.google.com, as for a signed-out session
    onAccounts.goto.mockImplementation(async () => {
      onAccounts.emitDocument('https://accounts.google.com')
    })
    const run = openAuthWindow(adapter, { client: clientWith(vi.fn(async () => onAccounts.frame)) })
    await vi.waitFor(() => expect(onAccounts.addStyleTag).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onAccounts.clicks).toHaveLength(0)

    onAccounts.emitDocument('https://www.youtube.com')
    await vi.waitFor(() => expect(onAccounts.clicks).toHaveLength(1))
    expect(onAccounts.addStyleTag).toHaveBeenCalledTimes(1)
    onAccounts.page.avatarCount = 1
    expect(await run).toEqual({ status: 'authed', backend: 'cloud' })
  })

  it('does not click Try another way when selectionList selector is omitted', async () => {
    const win = fakeGoogleWindow('cloud')
    win.page.visible.clear()
    win.page.visible.add('.passkey-prompt')
    win.page.visible.add('button.try-another')

    const partialAdapter = createGoogleAuthAdapter({
      pollMs: 1,
      selectors: {
        passkeyPrompt: '.passkey-prompt',
        tryAnotherWay: 'button.try-another',
      },
    })
    const run = openAuthWindow(partialAdapter, {
      client: clientWith(vi.fn(async () => win.frame)),
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(win.clicks).toHaveLength(0)
    win.page.avatarCount = 1
    expect(await run).toEqual({ status: 'authed', backend: 'cloud' })
  })
})
