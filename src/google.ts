import type { AttachCookies, CategoryRequest, Frame, WindowFrame } from '@fkn/lib'

import { assertPermissionReasons } from './errors.js'
import type { AuthAdapter, AuthStepContext, CloudCookies } from './types.js'

/** Default hosts covered by Google / YouTube authentication flows. */
export const DEFAULT_GOOGLE_DOMAINS: readonly string[] = ['www.youtube.com', 'accounts.google.com']

/** Default concise `'interaction'` reason shown inside the FKN permission prompt. */
export const DEFAULT_GOOGLE_INTERACTION_REASON = 'Help navigate Google sign-in steps'

/** Controls when passkey fallback assists run during Google sign-in. */
export type GooglePasskeyAssistMode = 'cloud-only' | 'always' | 'off'

/** DOM selectors and severity-0 CSS used by Google passkey fallback assists. */
export type GooglePasskeySelectors = {
  passkeyPrompt: string
  selectionList: string
  tryAnotherWay: string
  passkeyChoiceCss: string
}

/**
 * Default passkey selectors. Kept empty until live Checklist items 1 and 4 capture verified
 * `accounts.google.com` DOM attributes across `/v3/signin/challenge/sk/webauthn`,
 * `/v3/signin/challenge/sk/error`, and `/v3/signin/challenge/selection`.
 */
export const GOOGLE_PASSKEY_SELECTORS: GooglePasskeySelectors = {
  passkeyPrompt: '',
  selectionList: '',
  tryAnotherWay: '',
  passkeyChoiceCss: '',
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
  stepCooldownMs?: number
  selectors?: Partial<GooglePasskeySelectors>
  pollMs?: number
  readTimeoutMs?: number
  gotoTimeoutMs?: number
  isSignedIn?: (frame: Frame, ctx: AuthStepContext) => Promise<boolean>
  extractSession?: (frame: Frame) => Promise<TSession>
}

const DEFAULT_MAX_TRY_ANOTHER_WAY_CLICKS = 2
const DEFAULT_STEP_COOLDOWN_MS = 3_000

/**
 * Builds an `AuthAdapter` for Google-backed sign-in flows across `@fkn/lib`:
 * - Includes `accounts.google.com` in `domains` by default so popup assists stay inside scope.
 * - Requests `'interaction'` only by default (never `'evaluation'` on `accounts.google.com`).
 * - Clicks `loginLinkSelector` once via severity-0 visibility check and locator click.
 * - Optionally hides passkey rows on `/challenge/selection` via severity-0 `addStyleTag` and clicks
 *   `"Try another way"` on passkey screens with selection guard, cooldown, and per-window cap when
 *   selectors are configured and `assistPasskey` applies.
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
  const stepCooldownMs = options.stepCooldownMs ?? DEFAULT_STEP_COOLDOWN_MS
  const selectors: GooglePasskeySelectors = {
    ...GOOGLE_PASSKEY_SELECTORS,
    ...options.selectors,
  }

  const tryAnotherWayClicks = new WeakMap<WindowFrame, number>()

  const passkeyAssistEnabled = (ctx: AuthStepContext): boolean =>
    assistPasskey === 'always' || (assistPasskey === 'cloud-only' && ctx.backend !== 'extension')

  const applyPasskeyCss = async (ctx: AuthStepContext): Promise<void> => {
    if (!passkeyAssistEnabled(ctx) || !hidePasskeyChoices || ctx.signal.aborted) return
    const css = selectors.passkeyChoiceCss.trim()
    if (!css) return
    await ctx.frame.addStyleTag({ content: css })
  }

  return {
    id: options.id ?? 'google',
    entryUrl: options.entryUrl ?? 'https://www.youtube.com/',
    domains: [...(options.domains ?? DEFAULT_GOOGLE_DOMAINS)],
    cookies: options.cookies ?? 'persistent',
    ...(options.fallbackCookies === undefined ? {} : { fallbackCookies: options.fallbackCookies }),
    ...(options.window === undefined ? {} : { window: options.window }),
    permissions: options.permissions ?? [{ category: 'interaction', reason: interactionReason }],
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
    ...(options.gotoTimeoutMs === undefined ? {} : { gotoTimeoutMs: options.gotoTimeoutMs }),
    prepare: applyPasskeyCss,
    onDocument: async (ctx) => {
      await applyPasskeyCss(ctx)
    },
    onTick: async (ctx) => {
      if (loginLinkSelector) {
        if (await ctx.frame.locator(loginLinkSelector).first().isVisible()) {
          await ctx.once('click-service-login', async () => {
            await ctx.frame.locator(loginLinkSelector).first().click({ reason: interactionReason })
          })
        }
      }

      if (
        !passkeyAssistEnabled(ctx) ||
        !selectors.passkeyPrompt ||
        !selectors.selectionList ||
        !selectors.tryAnotherWay
      ) {
        return
      }
      const clicks = tryAnotherWayClicks.get(ctx.frame) ?? 0
      if (clicks >= maxTryAnotherWayClicks) return

      if (await ctx.frame.locator(selectors.selectionList).first().isVisible()) return
      if (!(await ctx.frame.locator(selectors.passkeyPrompt).first().isVisible())) return
      if (!(await ctx.frame.locator(selectors.tryAnotherWay).first().isVisible())) return

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
