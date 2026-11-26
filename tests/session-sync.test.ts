import type { WindowFrame } from '@fkn/lib'

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  createSessionSync,
  type ChannelLike,
  type StorageChange,
  type StorageEventTarget,
} from '../src'

type Listener = (event: { data: unknown }) => void

const createHub = () => {
  const channels = new Set<{ name: string, listeners: Set<Listener> }>()
  return <TMessage = unknown>(name: string): ChannelLike<TMessage> => {
    const entry = { name, listeners: new Set<Listener>() }
    channels.add(entry)
    return {
      postMessage: (data) => {
        for (const target of channels) {
          if (target === entry || target.name !== name) continue
          for (const listener of target.listeners) listener({ data })
        }
      },
      addEventListener: (_type, listener) => {
        entry.listeners.add(listener as Listener)
      },
      removeEventListener: (_type, listener) => {
        entry.listeners.delete(listener as Listener)
      },
      close: () => {
        channels.delete(entry)
      },
    }
  }
}

const createStorageTarget = () => {
  const listeners = new Set<(event: StorageEvent) => void>()
  return {
    target: {
      addEventListener: (_type, listener) => { listeners.add(listener) },
      removeEventListener: (_type, listener) => { listeners.delete(listener) },
    } satisfies StorageEventTarget,
    emit: (key: string | null, oldValue: string | null, newValue: string | null) => {
      for (const listener of listeners) {
        listener({ key, oldValue, newValue } as unknown as StorageEvent)
      }
    },
    size: () => listeners.size,
  }
}

describe('createSessionSync', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('delivers messages across tabs, filters storage keys with oldValue/newValue, and disposes cleanly', () => {
    const broadcastChannel = createHub()
    const storage = createStorageTarget()
    const tabAMessages: unknown[] = []
    const tabAChanges: StorageChange[] = []

    const tabA = createSessionSync<string>({
      channelName: 'stub.sessions',
      storageKeys: ['stub.sessions', 'stub.site-status'],
      onMessage: (msg) => tabAMessages.push(msg),
      onStorage: (change) => tabAChanges.push(change),
      broadcastChannel,
      storageTarget: storage.target,
    })
    const tabB = createSessionSync<string>({
      channelName: 'stub.sessions',
      broadcastChannel,
      storageTarget: storage.target,
    })

    tabB.post('anilist')
    tabB.post('signed-in')
    expect(tabAMessages).toEqual(['anilist', 'signed-in'])

    storage.emit('unrelated', null, '1')
    storage.emit('stub.site-status', '{"mal":{"state":"signed-out"}}', '{"mal":{"state":"signed-in"}}')
    // another tab's localStorage.clear(): one event, every value null, watched keys or not
    storage.emit(null, null, null)
    expect(tabAChanges).toEqual([
      {
        key: 'stub.site-status',
        oldValue: '{"mal":{"state":"signed-out"}}',
        newValue: '{"mal":{"state":"signed-in"}}',
      },
      { key: null, oldValue: null, newValue: null },
    ])

    tabA.dispose()
    tabB.post('trakt')
    expect(tabAMessages).toEqual(['anilist', 'signed-in'])
    expect(storage.size()).toBe(1)
    tabB.dispose()
    expect(storage.size()).toBe(0)
  })

  it('closes registered open windows on matching closeOnMessage and ignores already-closed frames', async () => {
    const broadcastChannel = createHub()
    let endOpen!: () => void
    const openFrame = {
      close: vi.fn(async () => { endOpen() }),
      closed: new Promise<void>((resolve) => { endOpen = resolve }),
    } as unknown as Pick<WindowFrame, 'close' | 'closed'>

    let endAlreadyClosed!: () => void
    const closingFrame = {
      close: vi.fn(async () => {}),
      closed: new Promise<void>((resolve) => { endAlreadyClosed = resolve }),
    } as unknown as Pick<WindowFrame, 'close' | 'closed'>

    const tabA = createSessionSync<string>({
      channelName: 'yt-client-signed-in',
      closeOnMessage: (msg) => msg === 'signed-in',
      broadcastChannel,
    })
    const tabB = createSessionSync<string>({
      channelName: 'yt-client-signed-in',
      broadcastChannel,
    })

    tabA.registerWindow(openFrame)
    tabA.registerWindow(closingFrame)
    endAlreadyClosed()
    await Promise.resolve()

    tabB.post('signed-in')
    await vi.waitFor(() => expect(openFrame.close).toHaveBeenCalledTimes(1))
    expect(closingFrame.close).not.toHaveBeenCalled()

    tabA.dispose()
    tabB.dispose()
  })

  it('works safely when BroadcastChannel and window storage events are absent', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('addEventListener', undefined)

    const sync = createSessionSync({ channelName: 'ssr-test' })
    sync.post('hello')
    await expect(sync.closeWindows()).resolves.toBeUndefined()
    sync.dispose()
  })
})
