import type { CategoryRequest, FrameWindowRefusal } from '@fkn/lib'

import type { FknClient } from './types.js'

/** Maximum character length enforced by `@fkn/lib` on permission reasons. */
export const MAX_PERMISSION_REASON_LENGTH = 100

const KNOWN_REFUSALS: ReadonlySet<unknown> = new Set<FrameWindowRefusal>([
  'jar-unreachable',
  'bad-url',
  'opaque-opener',
])

const errorField = (error: unknown, key: string): unknown =>
  typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined

const errorName = (error: unknown): string | undefined => {
  const name = errorField(error, 'name')
  return typeof name === 'string' ? name : undefined
}

/** Whether `attachFrame({ window })` was blocked by popup blocking or missing user activation. */
export const isFrameWindowBlockedError = (error: unknown): boolean =>
  errorName(error) === 'FrameWindowBlockedError'

/** Whether the cloud popup window refused to attach before loading any site content. */
export const isFrameWindowRefusedError = (error: unknown): boolean =>
  errorName(error) === 'FrameWindowRefusedError'

/** Extracts a typed refusal reason from `FrameWindowRefusedError`, defaulting unknown codes to `'unknown'`. */
export const frameWindowRefusalOf = (error: unknown): FrameWindowRefusal => {
  const reason = errorField(error, 'reason')
  return KNOWN_REFUSALS.has(reason) ? reason as FrameWindowRefusal : 'unknown'
}

/** Whether the extension rejected the call as unsupported or outdated. */
export const isExtensionUnsupportedError = (error: unknown): boolean => {
  const name = errorName(error)
  return name === 'ExtensionOperationUnsupportedError' || name === 'ExtensionOutdatedError'
}

/** Whether window attachment failed specifically because the extension lacks `attachWindow` (ABI < 5 or absent). */
export const isAttachWindowUnsupportedError = (error: unknown): boolean =>
  errorName(error) === 'ExtensionOperationUnsupportedError' && errorField(error, 'operation') === 'attachWindow'

/** Whether an error indicates the attached frame or window already terminated. */
export const isTerminalDetachError = (error: unknown, client?: Pick<FknClient, 'isTerminalError'>): boolean =>
  client?.isTerminalError?.(error) ?? false

/** Validates up front that no permission reason exceeds `@fkn/lib`'s 100-character limit. */
export const assertPermissionReasons = (permissions: readonly CategoryRequest[] | undefined): void => {
  if (!permissions) return
  for (const request of permissions) {
    if (request.reason !== undefined && request.reason.length > MAX_PERMISSION_REASON_LENGTH) {
      throw new TypeError(
        `permission reason must be at most ${MAX_PERMISSION_REASON_LENGTH} characters, not ${request.reason.length}`,
      )
    }
  }
}
