import type { WindowFrame } from '@fkn/lib'

import { isLocatorInvalid, isLocatorUnsupported, isPermissionDenied, LOCATOR_INVALID } from '@fkn/lib'
import { describe, expect, it, vi } from 'vite-plus/test'

import { openAuthWindow, type FknClient } from '../src'
import {
  createGoogleAuthAdapter,
  DEFAULT_GOOGLE_DOMAINS,
  DEFAULT_GOOGLE_INTERACTION_REASON,
  GOOGLE_PASSKEY_SELECTORS,
  GOOGLE_REJECTED_BROWSER_SELECTORS,
  youtubeAuthAdapter,
} from '../src/google'

const clientWith = (attachFrame: unknown): FknClient =>
  ({ attachFrame, isLocatorInvalid, isLocatorUnsupported, isPermissionDenied }) as unknown as FknClient

type FakePageState = {
  visible: Set<string>
  avatarCount: number
}

type FakeWindowOptions = {
  backend?: 'cloud' | 'extension'
  strictIsVisible?: boolean
}

const fakeGoogleWindow = (backendOrOptions: 'cloud' | 'extension' | FakeWindowOptions = 'cloud') => {
  const { backend = 'cloud', strictIsVisible = false } = typeof backendOrOptions === 'string'
    ? { backend: backendOrOptions }
    : backendOrOptions
  const page: FakePageState = {
    visible: new Set(['a[href*="ServiceLogin"]']),
    avatarCount: 0,
  }
  const docListeners = new Set<(event: { type: 'document', origin: string }) => void>()
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const clicks: { selector: string, reason?: string }[] = []
  const styles: { content?: string }[] = []
  const evaluate = vi.fn(async () => undefined)
  const addStyleTag = vi.fn(async (opts: { content?: string }) => { styles.push(opts) })
  const close = vi.fn(async () => { resolveClosed() })
  const goto = vi.fn(async () => {})
  const isVisibleCalls: string[] = []
  const timeoutSelectors = new Set<string>()
  const fatalErrorSelectors = new Map<string, Error>()

  const makeLocator = (selector: string) => ({
    first: () => makeLocator(selector),
    isVisible: async () => {
      isVisibleCalls.push(selector)
      const fatal = fatalErrorSelectors.get(selector)
      if (fatal) throw fatal
      if (timeoutSelectors.has(selector)) {
        throw Object.assign(new Error('No elements found'), { name: 'TimeoutError' })
      }
      if (strictIsVisible && !page.visible.has(selector)) {
        throw Object.assign(new Error('No elements found'), { name: 'TimeoutError' })
      }
      return page.visible.has(selector)
    },
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
    isVisibleCalls,
    timeoutSelectors,
    fatalErrorSelectors,
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
    expect(win.addStyleTag).toHaveBeenCalledWith({
      content: `${passkeyCss}\n${GOOGLE_REJECTED_BROWSER_SELECTORS.hideCss}`,
    })
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

  it('exports default locale-independent rejected-browser selectors and hides then auto-clicks Try again on accounts.google.com', async () => {
    expect(GOOGLE_REJECTED_BROWSER_SELECTORS).toEqual({
      marker: 'a[href*="accounts/answer/7675428"]',
      retry: 'a[href*="/restart"]',
      hideCss: 'body:has(a[href*="accounts/answer/7675428"]):has(a[href*="/restart"]) > * { opacity: 0 !important; pointer-events: none !important; }',
      revealCss: 'html body:has(a[href*="accounts/answer/7675428"]):has(a[href*="/restart"]) > * { opacity: 1 !important; pointer-events: auto !important; }',
    })

    const win = fakeGoogleWindow('cloud')
    const adapter = youtubeAuthAdapter({ pollMs: 1, stepCooldownMs: 50 })
    const run = openAuthWindow(adapter, {
      client: clientWith(vi.fn(async () => win.frame)),
      now: () => 1_000,
    })

    await vi.waitFor(() => expect(win.clicks).toHaveLength(1))
    win.emitDocument('https://www.youtube.com')
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(win.addStyleTag).not.toHaveBeenCalled()

    // Arrival on accounts.google.com pre-injects rejected-browser hiding CSS; SPA transition needs no extra addStyleTag.
    win.page.visible.clear()
    win.emitDocument('https://accounts.google.com')
    await vi.waitFor(() => expect(win.addStyleTag).toHaveBeenCalledTimes(1))
    expect(win.styles).toEqual([{ content: GOOGLE_REJECTED_BROWSER_SELECTORS.hideCss }])

    // Transition to /v3/signin/rejected within the same document clicks Try again without duplicating addStyleTag.
    win.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    win.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)
    await vi.waitFor(() => expect(win.clicks).toHaveLength(2))
    expect(win.clicks[1]).toEqual({
      selector: GOOGLE_REJECTED_BROWSER_SELECTORS.retry,
      reason: DEFAULT_GOOGLE_INTERACTION_REASON,
    })
    expect(win.addStyleTag).toHaveBeenCalledTimes(1)

    win.page.avatarCount = 1
    expect(await run).toEqual({ status: 'authed', backend: 'cloud' })
  })

  it('honors rejected-browser retry cap, reveals after cooldown, and isolates per-window fallback state', async () => {
    const adapter = youtubeAuthAdapter({
      pollMs: 1,
      stepCooldownMs: 100,
      maxRejectedBrowserRetries: 2,
    })

    const win = fakeGoogleWindow('cloud')
    let clock = 1_000
    win.goto.mockImplementation(async () => {
      win.emitDocument('https://accounts.google.com')
    })
    const run = openAuthWindow(adapter, {
      client: clientWith(vi.fn(async () => win.frame)),
      now: () => clock,
    })

    // Already hidden on initial accounts.google.com document (gen 1); simulate rejected screen.
    win.page.visible.clear()
    win.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    win.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)

    // Retry 1
    await vi.waitFor(() => expect(win.clicks).toHaveLength(1))
    expect(win.addStyleTag).toHaveBeenCalledTimes(1)

    // Within cooldown: no second click yet.
    clock += 50
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(win.clicks).toHaveLength(1)

    // Retry 2 after cooldown.
    clock += 60
    await vi.waitFor(() => expect(win.clicks).toHaveLength(2))

    // Immediately after retry 2 (still within cooldown): must NOT reveal yet while restart navigation settles.
    clock += 20
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(win.styles.filter((s) => s.content === GOOGLE_REJECTED_BROWSER_SELECTORS.revealCss)).toHaveLength(0)

    // Past cooldown on the same hidden document: reveals ONCE and never re-adds revealCss or clicks again.
    clock += 100
    await vi.waitFor(() => expect(win.styles.at(-1)?.content).toBe(GOOGLE_REJECTED_BROWSER_SELECTORS.revealCss))
    expect(win.addStyleTag).toHaveBeenCalledTimes(2)
    clock += 500
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(win.addStyleTag).toHaveBeenCalledTimes(2)
    expect(win.clicks).toHaveLength(2)

    // A new accounts.google.com document after retry budget exhaustion skips hideCss.
    win.emitDocument('https://accounts.google.com')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(win.addStyleTag).toHaveBeenCalledTimes(2)

    win.page.avatarCount = 1
    expect(await run).toEqual({ status: 'authed', backend: 'cloud' })

    // Second window reusing the same adapter receives a fresh retry budget and hides via tick fallback if onDocument didn't precede.
    const win2 = fakeGoogleWindow('cloud')
    win2.page.visible.clear()
    win2.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    win2.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)
    const run2 = openAuthWindow(adapter, {
      client: clientWith(vi.fn(async () => win2.frame)),
      now: () => 5_000,
    })
    await vi.waitFor(() => expect(win2.clicks).toHaveLength(1))
    expect(win2.styles).toEqual([{ content: GOOGLE_REJECTED_BROWSER_SELECTORS.hideCss }])
    win2.page.avatarCount = 1
    expect(await run2).toEqual({ status: 'authed', backend: 'cloud' })
  })

  it('respects dead-end guards, assistRejectedBrowser modes, hideRejectedBrowser, normalized retry caps, and custom selectors', async () => {
    // Marker visible without retry link: dead-end rejected screen keeps hiding off via :has(retry) and does not click.
    const deadEnd = fakeGoogleWindow('cloud')
    deadEnd.goto.mockImplementation(async () => {
      deadEnd.emitDocument('https://accounts.google.com')
    })
    deadEnd.page.visible.clear()
    deadEnd.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    const deadEndRun = openAuthWindow(youtubeAuthAdapter({ pollMs: 1 }), {
      client: clientWith(vi.fn(async () => deadEnd.frame)),
    })
    await vi.waitFor(() => expect(deadEnd.addStyleTag).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(deadEnd.clicks).toHaveLength(0)
    deadEnd.page.avatarCount = 1
    expect(await deadEndRun).toEqual({ status: 'authed', backend: 'cloud' })

    // hideRejectedBrowser: false retries without injecting hideCss or revealCss.
    const noHide = fakeGoogleWindow('cloud')
    let noHideClock = 1_000
    noHide.page.visible.clear()
    noHide.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    noHide.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)
    const noHideRun = openAuthWindow(
      createGoogleAuthAdapter({ pollMs: 1, stepCooldownMs: 50, maxRejectedBrowserRetries: 1, hideRejectedBrowser: false }),
      { client: clientWith(vi.fn(async () => noHide.frame)), now: () => noHideClock },
    )
    await vi.waitFor(() => expect(noHide.clicks).toHaveLength(1))
    noHideClock += 100
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(noHide.addStyleTag).not.toHaveBeenCalled()
    noHide.page.avatarCount = 1
    expect(await noHideRun).toEqual({ status: 'authed', backend: 'cloud' })

    // Default assistRejectedBrowser ('cloud-only') and 'off' skip extension/cloud, while 'always' runs on extension.
    for (const [backend, assistRejectedBrowser, origin, expectActive] of [
      ['extension', undefined, '', false],
      ['cloud', 'off', 'https://accounts.google.com', false],
      ['extension', 'always', '', true],
    ] as const) {
      const modeWin = fakeGoogleWindow(backend)
      modeWin.goto.mockImplementation(async () => {
        modeWin.emitDocument(origin)
      })
      modeWin.page.visible.clear()
      modeWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
      modeWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)
      const modeRun = openAuthWindow(
        createGoogleAuthAdapter({
          pollMs: 1,
          ...(assistRejectedBrowser === undefined ? {} : { assistRejectedBrowser }),
        }),
        { client: clientWith(vi.fn(async () => modeWin.frame)), now: () => 1_000 },
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (expectActive) {
        await vi.waitFor(() => expect(modeWin.clicks).toHaveLength(1))
        expect(modeWin.addStyleTag).toHaveBeenCalledTimes(1)
      } else {
        expect(modeWin.addStyleTag).not.toHaveBeenCalled()
        expect(modeWin.clicks).toHaveLength(0)
      }
      modeWin.page.avatarCount = 1
      expect(await modeRun).toEqual({ status: 'authed', backend })
    }

    // Retry caps 0, -1, NaN, and Infinity disable rejected-browser hiding and retries; 1.5 floors to 1 retry.
    for (const badCap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const capWin = fakeGoogleWindow('cloud')
      capWin.goto.mockImplementation(async () => {
        capWin.emitDocument('https://accounts.google.com')
      })
      capWin.page.visible.clear()
      capWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
      capWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)
      const capRun = openAuthWindow(
        createGoogleAuthAdapter({ pollMs: 1, maxRejectedBrowserRetries: badCap }),
        { client: clientWith(vi.fn(async () => capWin.frame)) },
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(capWin.addStyleTag).not.toHaveBeenCalled()
      expect(capWin.clicks).toHaveLength(0)
      capWin.page.avatarCount = 1
      expect(await capRun).toEqual({ status: 'authed', backend: 'cloud' })
    }

    const flooredWin = fakeGoogleWindow('cloud')
    let flooredClock = 1_000
    flooredWin.goto.mockImplementation(async () => {
      flooredWin.emitDocument('https://accounts.google.com')
    })
    flooredWin.page.visible.clear()
    flooredWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    flooredWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)
    const flooredRun = openAuthWindow(
      createGoogleAuthAdapter({ pollMs: 1, stepCooldownMs: 50, maxRejectedBrowserRetries: 1.5 }),
      { client: clientWith(vi.fn(async () => flooredWin.frame)), now: () => flooredClock },
    )
    await vi.waitFor(() => expect(flooredWin.clicks).toHaveLength(1))
    flooredClock += 100
    await vi.waitFor(() => expect(flooredWin.styles.at(-1)?.content).toBe(GOOGLE_REJECTED_BROWSER_SELECTORS.revealCss))
    expect(flooredWin.clicks).toHaveLength(1)
    flooredWin.page.avatarCount = 1
    expect(await flooredRun).toEqual({ status: 'authed', backend: 'cloud' })

    // Custom marker + retry derive matching hideCss/revealCss; explicit '' override disables CSS.
    const custom = fakeGoogleWindow('cloud')
    let customClock = 1_000
    custom.goto.mockImplementation(async () => {
      custom.emitDocument('https://accounts.google.com')
    })
    custom.page.visible.clear()
    custom.page.visible.add('a.help-custom')
    custom.page.visible.add('a.retry-custom')
    const customRun = openAuthWindow(
      createGoogleAuthAdapter({
        pollMs: 1,
        stepCooldownMs: 50,
        maxRejectedBrowserRetries: 1,
        rejectedBrowserSelectors: { marker: 'a.help-custom', retry: 'a.retry-custom' },
      }),
      { client: clientWith(vi.fn(async () => custom.frame)), now: () => customClock },
    )
    await vi.waitFor(() => expect(custom.clicks).toEqual([{
      selector: 'a.retry-custom',
      reason: DEFAULT_GOOGLE_INTERACTION_REASON,
    }]))
    expect(custom.styles[0]?.content).toBe(
      'body:has(a.help-custom):has(a.retry-custom) > * { opacity: 0 !important; pointer-events: none !important; }',
    )
    customClock += 100
    await vi.waitFor(() => expect(custom.styles[1]?.content).toBe(
      'html body:has(a.help-custom):has(a.retry-custom) > * { opacity: 1 !important; pointer-events: auto !important; }',
    ))
    custom.page.avatarCount = 1
    expect(await customRun).toEqual({ status: 'authed', backend: 'cloud' })

    // Explicit empty hideCss / revealCss disables CSS injection while keeping retries active.
    const blankCss = fakeGoogleWindow('cloud')
    blankCss.goto.mockImplementation(async () => {
      blankCss.emitDocument('https://accounts.google.com')
    })
    blankCss.page.visible.clear()
    blankCss.page.visible.add('a.help-custom')
    blankCss.page.visible.add('a.retry-custom')
    const blankCssRun = openAuthWindow(
      createGoogleAuthAdapter({
        pollMs: 1,
        maxRejectedBrowserRetries: 1,
        rejectedBrowserSelectors: { marker: 'a.help-custom', retry: 'a.retry-custom', hideCss: '', revealCss: '' },
      }),
      { client: clientWith(vi.fn(async () => blankCss.frame)) },
    )
    await vi.waitFor(() => expect(blankCss.clicks).toEqual([{
      selector: 'a.retry-custom',
      reason: DEFAULT_GOOGLE_INTERACTION_REASON,
    }]))
    expect(blankCss.addStyleTag).not.toHaveBeenCalled()
    blankCss.page.avatarCount = 1
    expect(await blankCssRun).toEqual({ status: 'authed', backend: 'cloud' })
  })

  it('probes count before strict isVisible, survives TimeoutError in the same tick, and propagates fatal errors', async () => {
    const strictWin = fakeGoogleWindow({ backend: 'cloud', strictIsVisible: true })
    strictWin.page.visible.clear()
    strictWin.goto.mockImplementation(async () => {
      strictWin.emitDocument('https://accounts.google.com')
    })
    const adapter = createGoogleAuthAdapter({
      pollMs: 1,
      stepCooldownMs: 50,
      selectors: {
        passkeyPrompt: '.passkey-prompt',
        selectionList: '.challenge-selection',
        tryAnotherWay: 'button.try-another',
      },
    })
    const run = openAuthWindow(adapter, {
      client: clientWith(vi.fn(async () => strictWin.frame)),
      now: () => 1_000,
    })

    // Clean identifier screen must settle via count() without invoking strict isVisible().
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(strictWin.isVisibleCalls).toEqual([])

    // Persistent TimeoutError on marker.isVisible() must resolve false so passkey fallback still clicks in the same tick.
    strictWin.timeoutSelectors.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    strictWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    strictWin.page.visible.add('.passkey-prompt')
    strictWin.page.visible.add('button.try-another')
    await vi.waitFor(() => expect(strictWin.clicks).toEqual([{
      selector: 'button.try-another',
      reason: DEFAULT_GOOGLE_INTERACTION_REASON,
    }]))

    strictWin.page.avatarCount = 1
    expect(await run).toEqual({ status: 'authed', backend: 'cloud' })

    // Fatal locator errors in isLocatorVisible and in onTick's fallback addStyleTag fail the window immediately.
    const fatalLocatorErr = Object.assign(new Error('invalid selector'), { name: LOCATOR_INVALID })
    const fatalLocatorWin = fakeGoogleWindow('cloud')
    fatalLocatorWin.page.visible.clear()
    fatalLocatorWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    fatalLocatorWin.fatalErrorSelectors.set(GOOGLE_REJECTED_BROWSER_SELECTORS.marker, fatalLocatorErr)
    expect(await openAuthWindow(youtubeAuthAdapter({ pollMs: 1 }), {
      client: clientWith(vi.fn(async () => fatalLocatorWin.frame)),
    })).toEqual({ status: 'failed', backend: 'cloud', error: fatalLocatorErr })

    const fatalStyleErr = Object.assign(new Error('invalid style'), { name: LOCATOR_INVALID })
    const fatalStyleWin = fakeGoogleWindow('cloud')
    fatalStyleWin.page.visible.clear()
    fatalStyleWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.marker)
    fatalStyleWin.page.visible.add(GOOGLE_REJECTED_BROWSER_SELECTORS.retry)
    fatalStyleWin.addStyleTag.mockRejectedValueOnce(fatalStyleErr)
    expect(await openAuthWindow(youtubeAuthAdapter({ pollMs: 1 }), {
      client: clientWith(vi.fn(async () => fatalStyleWin.frame)),
    })).toEqual({ status: 'failed', backend: 'cloud', error: fatalStyleErr })
    expect(fatalStyleWin.clicks).toHaveLength(0)
  })
})
