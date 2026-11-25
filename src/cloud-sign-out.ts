import { isExtensionUnsupportedError } from './errors.js'
import { createHiddenFrame } from './hidden-frame.js'
import { resolveClient, type ClientSource, type CloudCookies, type MountHiddenFrame } from './types.js'

/** Base options shared across `signOutFromCloud` overloads. */
export type SignOutOptions = {
  client: ClientSource
  domains: string[]
  cookies?: CloudCookies
  mountHiddenFrame?: MountHiddenFrame
  title?: string
}

/** Structured outcome returned when `throwOnError` is omitted or `false`. */
export type SignOutResult =
  | { cleared: true }
  | { cleared: false, reason: 'not-ready' | 'extension-unsupported' | 'failed', error?: unknown }

/**
 * Removes cookies for `domains` from FKN's cloud jar using a temporary off-screen iframe.
 * Rejects on error when `throwOnError: true`, or returns a structured outcome otherwise.
 */
export async function signOutFromCloud(options: SignOutOptions & { throwOnError: true }): Promise<void>
export async function signOutFromCloud(options: SignOutOptions & { throwOnError?: false }): Promise<SignOutResult>
export async function signOutFromCloud(options: SignOutOptions & { throwOnError?: boolean }): Promise<SignOutResult | void>
export async function signOutFromCloud(
  {
    client: clientSource,
    domains,
    cookies = 'persistent',
    mountHiddenFrame = createHiddenFrame,
    title = 'Sign out',
    throwOnError = false,
  }: SignOutOptions & { throwOnError?: boolean },
): Promise<SignOutResult | void> {
  const client = resolveClient(clientSource)
  if (!client) {
    if (throwOnError) throw new Error('signOutFromCloud: @fkn/lib client is not loaded')
    return { cleared: false, reason: 'not-ready' }
  }
  let remove: (() => void) | undefined
  try {
    const mounted = mountHiddenFrame(title)
    remove = mounted.remove
    const frame = await client.attachFrame({ iframe: mounted.iframe, domains: [...domains], cookies })
    await frame.clearCookies()
    if (!throwOnError) return { cleared: true }
  } catch (error) {
    if (throwOnError) throw error
    if (isExtensionUnsupportedError(error)) {
      return { cleared: false, reason: 'extension-unsupported', error }
    }
    return { cleared: false, reason: 'failed', error }
  } finally {
    remove?.()
  }
}
