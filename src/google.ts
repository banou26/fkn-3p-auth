import type { AttachCookies, CategoryRequest, Frame, WindowFrame } from '@fkn/lib'

import { assertPermissionReasons } from './errors.js'
import type { AuthAdapter, AuthStepContext, CloudCookies } from './types.js'

/** Default hosts covered by Google / YouTube authentication flows. */
export const DEFAULT_GOOGLE_DOMAINS: readonly string[] = ['www.youtube.com', 'accounts.google.com']

/** Default concise `'interaction'` reason shown inside the FKN permission prompt. */
export const DEFAULT_GOOGLE_INTERACTION_REASON = 'Help navigate Google sign-in steps'

/** Controls when passkey fallback assists run during Google sign-in. */
export type GooglePasskeyAssistMode = 'cloud-only' | 'always' | 'off'

/** Controls when rejected-browser ("may not be secure") assists run during Google sign-in. */
export type GoogleRejectedBrowserAssistMode = 'cloud-only' | 'always' | 'off'

/** DOM selectors and severity-0 CSS used by Google passkey fallback assists. */
export type GooglePasskeySelectors = {
  passkeyPrompt: string
  selectionList: string
  tryAnotherWay: string
  passkeyChoiceCss: string
}

/**
 * DOM selectors and severity-0 CSS used to hide and recover from Google's rejected-browser screen.
 * Override `hideCss` and `revealCss` together so the reveal fallback undoes custom hide rules.
 */
export type GoogleRejectedBrowserSelectors = {
  marker: string
  retry: string
  hideCss: string
  revealCss: string
}

/**
 * Default passkey selectors. Empty until they are verified against live `accounts.google.com`
 * challenge pages, which leaves the passkey assist off; pass `selectors` to turn it on.
 */
export const GOOGLE_PASSKEY_SELECTORS: GooglePasskeySelectors = {
  passkeyPrompt: '',
  selectionList: '',
  tryAnotherWay: '',
  passkeyChoiceCss: '',
}

const buildRejectedHideCss = (marker: string, retry: string): string =>
  `body:has(${marker}):has(${retry}) > * { opacity: 0 !important; pointer-events: none !important; }`

const buildRejectedRevealCss = (marker: string, retry: string): string =>
  `html body:has(${marker}):has(${retry}) > * { opacity: 1 !important; pointer-events: auto !important; }`

const DEFAULT_REJECTED_MARKER = 'a[href*="accounts/answer/7675428"]'
const DEFAULT_REJECTED_RETRY = 'a[href*="/restart"]'

/**
 * Default locale-independent selectors and severity-0 CSS for Google's `/v3/signin/rejected`
 * ("This browser or app may not be secure") screen.
 */
export const GOOGLE_REJECTED_BROWSER_SELECTORS: GoogleRejectedBrowserSelectors = {
  marker: DEFAULT_REJECTED_MARKER,
  retry: DEFAULT_REJECTED_RETRY,
  hideCss: buildRejectedHideCss(DEFAULT_REJECTED_MARKER, DEFAULT_REJECTED_RETRY),
  revealCss: buildRejectedRevealCss(DEFAULT_REJECTED_MARKER, DEFAULT_REJECTED_RETRY),
}

/** Options for `createGoogleAuthAdapter` and `youtubeAuthAdapter`. */
export type GoogleAuthAdapterOptions<TSession = void> = {
  id?: string
  entryUrl?: string
  domains?: string[]
  cookies?: AttachCookies | (() => AttachCookies)
  fallbackCookies?: CloudCookies
  window?: { width?: number, height?: number }
  loginLinkSelector?: string
  signedInSelector?: string
  interactionReason?: string
  permissions?: CategoryRequest[] | ((ctx: { cookies: AttachCookies }) => CategoryRequest[])
  assistPasskey?: GooglePasskeyAssistMode
  hidePasskeyChoices?: boolean
  maxTryAnotherWayClicks?: number
  assistRejectedBrowser?: GoogleRejectedBrowserAssistMode
  hideRejectedBrowser?: boolean
  maxRejectedBrowserRetries?: number
  stepCooldownMs?: number
  selectors?: Partial<GooglePasskeySelectors>
  rejectedBrowserSelectors?: Partial<GoogleRejectedBrowserSelectors>
  pollMs?: number
  readTimeoutMs?: number
  gotoTimeoutMs?: number
  isSignedIn?: (frame: Frame, ctx: AuthStepContext) => Promise<boolean>
  extractSession?: (frame: Frame) => Promise<TSession>
}

const DEFAULT_MAX_TRY_ANOTHER_WAY_CLICKS = 2
const DEFAULT_MAX_REJECTED_BROWSER_RETRIES = 2
const DEFAULT_STEP_COOLDOWN_MS = 3_000
const IS_VISIBLE_TIMEOUT_MS = 250
const GOOGLE_ACCOUNTS_ORIGIN = 'https://accounts.google.com'

// An empty origin is unknown (the extension does not report it), so the step runs as it would unscoped.
const isOn = (origin: string, expected: string): boolean => origin === '' || origin === expected

const isAssistEnabled = (
  mode: GooglePasskeyAssistMode | GoogleRejectedBrowserAssistMode,
  ctx: AuthStepContext,
): boolean => mode === 'always' || (mode === 'cloud-only' && ctx.backend !== 'extension')

const normalizeRetryCap = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

// `@fkn/lib`'s `isVisible()` retries to the deadline when zero elements match; probing `count()` first avoids stalling `onTick`.
const isLocatorVisible = async (frame: WindowFrame, selector: string): Promise<boolean> => {
  if (!selector) return false
  const locator = frame.locator(selector)
  if (await locator.count() === 0) return false
  try {
    return await locator.first().isVisible({ timeout: IS_VISIBLE_TIMEOUT_MS })
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return false
    throw error
  }
}

/**
 * Builds an `AuthAdapter` for Google-backed sign-in flows across `@fkn/lib`:
 * - Includes `accounts.google.com` in `domains` by default so popup assists stay inside scope.
 * - Requests `'interaction'` only by default (never `'evaluation'` on `accounts.google.com`).
 * - Clicks `loginLinkSelector` once, only while the window shows the `entryUrl` origin, via a
 *   severity-0 visibility check and locator click.
 * - On `accounts.google.com` only, hides Google's rejected-browser screen via severity-0
 *   `addStyleTag`, clicks `"Try again"` (`a[href*="/restart"]`) with cooldown and retry cap, and
 *   reveals the screen after cooldown if still rejected past the retry budget.
 * - On `accounts.google.com` only, optionally hides passkey rows on `/challenge/selection` via
 *   severity-0 `addStyleTag` and clicks `"Try another way"` on passkey screens with selection guard,
 *   cooldown, and per-window cap when selectors are configured and `assistPasskey` applies.
 * - Where the backend does not report the window's origin (the extension), origin-scoped steps run unscoped.
 */
export const createGoogleAuthAdapter = <TSession = void>(
  options: GoogleAuthAdapterOptions<TSession> = {},
): AuthAdapter<TSession> => {
  const interactionReason = options.interactionReason ?? DEFAULT_GOOGLE_INTERACTION_REASON
  assertPermissionReasons([{ category: 'interaction', reason: interactionReason }])

  const loginLinkSelector = options.loginLinkSelector ?? 'a[href*="ServiceLogin"]'
  const signedInSelector = options.signedInSelector ?? '#avatar-btn'
  const assistPasskey = options.assistPasskey ?? 'cloud-only'
  const hidePasskeyChoices = options.hidePasskeyChoices ?? true
  const maxTryAnotherWayClicks = options.maxTryAnotherWayClicks ?? DEFAULT_MAX_TRY_ANOTHER_WAY_CLICKS
  const assistRejectedBrowser = options.assistRejectedBrowser ?? 'cloud-only'
  const hideRejectedBrowser = options.hideRejectedBrowser ?? true
  const maxRejectedBrowserRetries = normalizeRetryCap(
    options.maxRejectedBrowserRetries,
    DEFAULT_MAX_REJECTED_BROWSER_RETRIES,
  )
  const stepCooldownMs = options.stepCooldownMs ?? DEFAULT_STEP_COOLDOWN_MS
  const selectors: GooglePasskeySelectors = {
    ...GOOGLE_PASSKEY_SELECTORS,
    ...options.selectors,
  }
  const rejectedSelectors: GoogleRejectedBrowserSelectors = {
    ...GOOGLE_REJECTED_BROWSER_SELECTORS,
    ...options.rejectedBrowserSelectors,
  }
  const hasRejectedPair = Boolean(rejectedSelectors.marker && rejectedSelectors.retry)
  const rejectedHideCss = options.rejectedBrowserSelectors?.hideCss !== undefined
    ? options.rejectedBrowserSelectors.hideCss.trim()
    : (hasRejectedPair ? buildRejectedHideCss(rejectedSelectors.marker, rejectedSelectors.retry) : '')
  const rejectedRevealCss = options.rejectedBrowserSelectors?.revealCss !== undefined
    ? options.rejectedBrowserSelectors.revealCss.trim()
    : (hasRejectedPair ? buildRejectedRevealCss(rejectedSelectors.marker, rejectedSelectors.retry) : '')

  const tryAnotherWayClicks = new WeakMap<WindowFrame, number>()
  const rejectedBrowserClicks = new WeakMap<WindowFrame, number>()
  const currentDocGen = new WeakMap<WindowFrame, number>()
  const hiddenDocGen = new WeakMap<WindowFrame, number>()
  const entryUrl = options.entryUrl ?? 'https://www.youtube.com/'
  const entryOrigin = new URL(entryUrl).origin

  return {
    id: options.id ?? 'google',
    entryUrl,
    domains: [...(options.domains ?? DEFAULT_GOOGLE_DOMAINS)],
    cookies: options.cookies ?? 'persistent',
    ...(options.fallbackCookies === undefined ? {} : { fallbackCookies: options.fallbackCookies }),
    ...(options.window === undefined ? {} : { window: options.window }),
    permissions: options.permissions ?? [{ category: 'interaction', reason: interactionReason }],
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
    ...(options.gotoTimeoutMs === undefined ? {} : { gotoTimeoutMs: options.gotoTimeoutMs }),
    onDocument: async (ctx, origin) => {
      const gen = (currentDocGen.get(ctx.frame) ?? 0) + 1
      currentDocGen.set(ctx.frame, gen)
      if (!isOn(origin, GOOGLE_ACCOUNTS_ORIGIN) || ctx.signal.aborted) return

      const styles: string[] = []
      const passkeyCss = isAssistEnabled(assistPasskey, ctx) && hidePasskeyChoices
        ? selectors.passkeyChoiceCss.trim()
        : ''
      if (passkeyCss) styles.push(passkeyCss)

      const shouldHideRejected = isAssistEnabled(assistRejectedBrowser, ctx)
        && hideRejectedBrowser
        && Boolean(rejectedHideCss)
        && maxRejectedBrowserRetries > 0
        && (rejectedBrowserClicks.get(ctx.frame) ?? 0) < maxRejectedBrowserRetries
      if (shouldHideRejected) styles.push(rejectedHideCss)

      if (styles.length === 0) return
      if (shouldHideRejected) hiddenDocGen.set(ctx.frame, gen)
      try {
        await ctx.frame.addStyleTag({ content: styles.join('\n') })
      } catch (error) {
        if (hiddenDocGen.get(ctx.frame) === gen) hiddenDocGen.delete(ctx.frame)
        throw error
      }
    },
    onTick: async (ctx) => {
      if (loginLinkSelector && isOn(ctx.origin, entryOrigin)) {
        if (await isLocatorVisible(ctx.frame, loginLinkSelector)) {
          await ctx.once('click-service-login', async () => {
            await ctx.frame.locator(loginLinkSelector).first().click({ reason: interactionReason })
          })
        }
      }

      if (
        isOn(ctx.origin, GOOGLE_ACCOUNTS_ORIGIN) &&
        isAssistEnabled(assistRejectedBrowser, ctx) &&
        maxRejectedBrowserRetries > 0 &&
        rejectedSelectors.marker &&
        rejectedSelectors.retry
      ) {
        if (
          await isLocatorVisible(ctx.frame, rejectedSelectors.marker) &&
          await isLocatorVisible(ctx.frame, rejectedSelectors.retry)
        ) {
          const clicks = rejectedBrowserClicks.get(ctx.frame) ?? 0
          const gen = currentDocGen.get(ctx.frame) ?? 0
          if (clicks < maxRejectedBrowserRetries) {
            if (hideRejectedBrowser && rejectedHideCss && hiddenDocGen.get(ctx.frame) !== gen) {
              hiddenDocGen.set(ctx.frame, gen)
              try {
                await ctx.frame.addStyleTag({ content: rejectedHideCss })
              } catch (error) {
                if (hiddenDocGen.get(ctx.frame) === gen) hiddenDocGen.delete(ctx.frame)
                throw error
              }
            }
            await ctx.cooldown('google-rejected-browser-retry', stepCooldownMs, async () => {
              const current = rejectedBrowserClicks.get(ctx.frame) ?? 0
              if (current >= maxRejectedBrowserRetries) return
              // Count before clicking so a navigation triggered mid-click still consumes the attempt safely.
              rejectedBrowserClicks.set(ctx.frame, current + 1)
              await ctx.frame.locator(rejectedSelectors.retry).first().click({ reason: interactionReason })
            })
            return
          }
          if (hideRejectedBrowser && rejectedRevealCss && hiddenDocGen.get(ctx.frame) === gen) {
            await ctx.cooldown('google-rejected-browser-retry', stepCooldownMs, async () => {
              if (hiddenDocGen.get(ctx.frame) !== gen) return
              await ctx.frame.addStyleTag({ content: rejectedRevealCss })
              if (hiddenDocGen.get(ctx.frame) === gen) hiddenDocGen.delete(ctx.frame)
            })
          }
          return
        }
      }

      if (
        !isOn(ctx.origin, GOOGLE_ACCOUNTS_ORIGIN) ||
        !isAssistEnabled(assistPasskey, ctx) ||
        !selectors.passkeyPrompt ||
        !selectors.selectionList ||
        !selectors.tryAnotherWay
      ) {
        return
      }
      const clicks = tryAnotherWayClicks.get(ctx.frame) ?? 0
      if (clicks >= maxTryAnotherWayClicks) return

      if (await isLocatorVisible(ctx.frame, selectors.selectionList)) return
      if (!(await isLocatorVisible(ctx.frame, selectors.passkeyPrompt))) return
      if (!(await isLocatorVisible(ctx.frame, selectors.tryAnotherWay))) return

      await ctx.cooldown('google-try-another-way', stepCooldownMs, async () => {
        const current = tryAnotherWayClicks.get(ctx.frame) ?? 0
        if (current >= maxTryAnotherWayClicks) return
        tryAnotherWayClicks.set(ctx.frame, current + 1)
        await ctx.frame.locator(selectors.tryAnotherWay).first().click({ reason: interactionReason })
      })
    },
    isSignedIn: options.isSignedIn
      ?? (async (frame) => await frame.locator(signedInSelector).first().count() > 0),
    ...(options.extractSession === undefined ? {} : { extractSession: options.extractSession }),
  }
}

/** YouTube preset built over `createGoogleAuthAdapter` (`youtube.com` -> `accounts.google.com`). */
export const youtubeAuthAdapter = <TSession = void>(
  options: GoogleAuthAdapterOptions<TSession> = {},
): AuthAdapter<TSession> =>
  createGoogleAuthAdapter({
    id: 'youtube',
    entryUrl: 'https://www.youtube.com/',
    domains: [...DEFAULT_GOOGLE_DOMAINS],
    loginLinkSelector: 'a[href*="ServiceLogin"]',
    signedInSelector: '#avatar-btn',
    ...options,
  })
