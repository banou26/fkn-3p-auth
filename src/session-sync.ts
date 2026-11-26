import type { WindowFrame } from '@fkn/lib'

/** Cross-tab `localStorage` change forwarded by `createSessionSync`; `key` is `null` when another tab cleared the storage. */
export type StorageChange = {
  key: string | null
  oldValue: string | null
  newValue: string | null
}

/** Structural `BroadcastChannel` subset so callers and tests stay mock-free. */
export type ChannelLike<TMessage = unknown> = {
  postMessage: (message: TMessage) => void
  addEventListener: (type: 'message', listener: (event: { data: TMessage }) => void) => void
  removeEventListener?: (type: 'message', listener: (event: { data: TMessage }) => void) => void
  close?: () => void
}

/** Structural `EventTarget` subset for cross-tab `storage` events. */
export type StorageEventTarget = {
  addEventListener: (type: 'storage', listener: (event: StorageEvent) => void) => void
  removeEventListener?: (type: 'storage', listener: (event: StorageEvent) => void) => void
}

/** Configuration for `createSessionSync`. */
export type SessionSyncOptions<TMessage = unknown> = {
  channelName: string
  storageKeys?: readonly string[]
  closeOnMessage?: (message: TMessage) => boolean
  onMessage?: (message: TMessage) => void
  onStorage?: (change: StorageChange) => void
  broadcastChannel?: (name: string) => ChannelLike<TMessage>
  storageTarget?: StorageEventTarget
}

/** Cross-tab session coordination handle returned by `createSessionSync`. */
export type SessionSync<TMessage = unknown> = {
  post: (message: TMessage) => void
  onMessage: (listener: (message: TMessage) => void) => () => void
  onStorage: (listener: (change: StorageChange) => void) => () => void
  registerWindow: (frame: Pick<WindowFrame, 'close' | 'closed'>) => () => void
  closeWindows: () => Promise<void>
  dispose: () => void
}

const defaultChannel = <TMessage>(name: string): ChannelLike<TMessage> | undefined =>
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) as ChannelLike<TMessage> : undefined

const defaultStorageTarget = (): StorageEventTarget | undefined =>
  typeof globalThis.addEventListener === 'function' ? globalThis as unknown as StorageEventTarget : undefined

/**
 * Coordinates auth state across browser tabs via `BroadcastChannel`, filtered `storage` events
 * (preserving `oldValue`/`newValue` diffs and storage ordering), and active popup tracking.
 * Safe in Node/SSR environments where `BroadcastChannel` or `window` events do not exist.
 */
export const createSessionSync = <TMessage = unknown>(
  options: SessionSyncOptions<TMessage>,
): SessionSync<TMessage> => {
  let disposed = false
  const messageListeners = new Set<(message: TMessage) => void>()
  const storageListeners = new Set<(change: StorageChange) => void>()
  const activeWindows = new Set<Pick<WindowFrame, 'close' | 'closed'>>()
  const watchedKeys = options.storageKeys ? new Set(options.storageKeys) : undefined

  if (options.onMessage) messageListeners.add(options.onMessage)
  if (options.onStorage) storageListeners.add(options.onStorage)

  const closeWindows = async (): Promise<void> => {
    const frames = [...activeWindows]
    activeWindows.clear()
    await Promise.allSettled(frames.map((frame) => frame.close()))
  }

  const channel = options.broadcastChannel
    ? options.broadcastChannel(options.channelName)
    : defaultChannel<TMessage>(options.channelName)

  const handleChannelMessage = (event: { data: TMessage }) => {
    if (disposed) return
    if (options.closeOnMessage?.(event.data)) void closeWindows()
    for (const listener of messageListeners) listener(event.data)
  }
  channel?.addEventListener('message', handleChannelMessage)

  const storageTarget = options.storageTarget ?? defaultStorageTarget()
  const handleStorageEvent = (event: StorageEvent) => {
    if (disposed) return
    if (event.key !== null && watchedKeys && !watchedKeys.has(event.key)) return
    const change: StorageChange = {
      key: event.key,
      oldValue: event.oldValue,
      newValue: event.newValue,
    }
    for (const listener of storageListeners) listener(change)
  }
  storageTarget?.addEventListener('storage', handleStorageEvent)

  return {
    post: (message) => {
      if (disposed) return
      channel?.postMessage(message)
    },
    onMessage: (listener) => {
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    },
    onStorage: (listener) => {
      storageListeners.add(listener)
      return () => {
        storageListeners.delete(listener)
      }
    },
    registerWindow: (frame) => {
      if (disposed) return () => {}
      activeWindows.add(frame)
      const unregister = () => {
        activeWindows.delete(frame)
      }
      void frame.closed.then(unregister, unregister)
      return unregister
    },
    closeWindows,
    dispose: () => {
      if (disposed) return
      disposed = true
      channel?.removeEventListener?.('message', handleChannelMessage)
      channel?.close?.()
      storageTarget?.removeEventListener?.('storage', handleStorageEvent)
      messageListeners.clear()
      storageListeners.clear()
      activeWindows.clear()
    },
  }
}
