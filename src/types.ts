import type {
  AttachCookies,
  attachFrame,
  CategoryRequest,
  Frame,
  FrameWindowRefusal,
  WindowFrame,
} from '@fkn/lib'

/** The backend serving an FKN frame attachment. */
export type AuthBackend = 'cloud' | 'extension'

/** Cloud-backed cookie jar modes supported by `attachFrame`. */
export type CloudCookies = 'persistent' | 'ephemeral'

/** Minimal `@fkn/lib` client interface accepted synchronously by auth helpers. */
export type FknClient = {
  attachFrame: typeof attachFrame
  isTerminalError?: (error: unknown) => boolean
}

/** Static client object or synchronous getter returning the client once loaded. */
export type ClientSource = FknClient | (() => FknClient | undefined)

/** Mounted hidden iframe handle returned by `MountHiddenFrame`. */
export type HiddenFrameHandle = {
  iframe: HTMLIFrameElement
  remove: () => void
}

/** Factory creating a hidden off-screen iframe for cloud cookie/session calls. */
export type MountHiddenFrame = (title?: string) => HiddenFrameHandle

/** Result of an interactive authentication popup flow driven by `openAuthWindow`. */
export type AuthOutcome<TSession = void> =
  | { status: 'authed', backend?: AuthBackend, session?: TSession }
  | { status: 'closed', backend?: AuthBackend }
  | { status: 'blocked' }
  | { status: 'not-ready' }
  | {
      status: 'unsupported'
      reason: 'extension-unsupported' | 'refused'
      refusalReason?: FrameWindowRefusal
      error: unknown
    }

/** Step helpers passed to adapter lifecycle callbacks (`prepare`, `onDocument`, `onTick`, `isSignedIn`). */
export type AuthStepContext = {
  frame: WindowFrame
  backend: AuthBackend | undefined
  cookies: AttachCookies
  signal: AbortSignal
  once: (stepKey: string, action: () => Promise<void>) => Promise<boolean>
  cooldown: (stepKey: string, cooldownMs: number, action: () => Promise<void>) => Promise<boolean>
}

/** Site-specific configuration and lifecycle hooks for `openAuthWindow`. */
export type AuthAdapter<TSession = void> = {
  id: string
  entryUrl: string
  domains: string[]
  cookies?: AttachCookies | (() => AttachCookies)
  fallbackCookies?: CloudCookies
  window?: { width?: number, height?: number }
  permissions?: CategoryRequest[] | ((ctx: { cookies: AttachCookies }) => CategoryRequest[])
  pollMs?: number
  readTimeoutMs?: number
  gotoTimeoutMs?: number
  prepare?: (ctx: AuthStepContext) => Promise<void>
  onDocument?: (ctx: AuthStepContext, origin: string) => Promise<void>
  onTick?: (ctx: AuthStepContext) => Promise<void>
  isSignedIn: (frame: Frame, ctx: AuthStepContext) => Promise<boolean>
  extractSession?: (frame: Frame) => Promise<TSession>
}

/** Resolves a synchronous `FknClient` instance or returns `undefined` when not ready. */
export const resolveClient = (source: ClientSource): FknClient | undefined =>
  typeof source === 'function' ? source() : source
