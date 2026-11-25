export { openAuthWindow, type OpenAuthWindowOptions } from './window.js'
export { signOutFromCloud, type SignOutOptions, type SignOutResult } from './cloud-sign-out.js'
export { verifyHiddenSession, type VerifyHiddenSessionOptions } from './hidden-session.js'
export {
  createSessionSync,
  type ChannelLike,
  type SessionLifecycleEvent,
  type SessionSync,
  type SessionSyncOptions,
  type StorageChange,
  type StorageEventTarget,
} from './session-sync.js'
export type {
  AuthAdapter,
  AuthBackend,
  AuthOutcome,
  AuthStepContext,
  ClientSource,
  CloudCookies,
  FknClient,
  HiddenFrameHandle,
  MountHiddenFrame,
} from './types.js'
