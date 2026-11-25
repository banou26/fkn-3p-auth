import type { FknClient } from '../src'

import { describe, expect, it, vi } from 'vite-plus/test'

import { signOutFromCloud } from '../src'

const fakes = ({
  clear = async () => {},
  refuse,
}: { clear?: () => Promise<void>, refuse?: Error } = {}) => {
  const iframe = { kind: 'hidden iframe' } as unknown as HTMLIFrameElement
  const remove = vi.fn()
  const mountHiddenFrame = vi.fn(() => ({ iframe, remove }))
  const clearCookies = vi.fn(clear)
  const attachFrame = vi.fn(async () => {
    if (refuse) throw refuse
    return { clearCookies }
  })
  return {
    iframe,
    remove,
    mountHiddenFrame,
    clearCookies,
    attachFrame,
    client: { attachFrame } as unknown as FknClient,
  }
}

describe('signOutFromCloud', () => {
  it('attaches on persistent jar, clears cookies for the given domains, and removes the iframe', async () => {
    const { iframe, remove, mountHiddenFrame, clearCookies, attachFrame, client } = fakes()

    const result = await signOutFromCloud({
      client,
      domains: ['www.youtube.com', 'accounts.google.com'],
      mountHiddenFrame,
      title: 'Custom sign out',
    })

    expect(result).toEqual({ cleared: true })
    expect(mountHiddenFrame).toHaveBeenCalledWith('Custom sign out')
    expect(attachFrame).toHaveBeenCalledWith({
      iframe,
      domains: ['www.youtube.com', 'accounts.google.com'],
      cookies: 'persistent',
    })
    expect(clearCookies).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('returns structured failure outcomes and still cleans up the iframe when throwOnError is false', async () => {
    expect(await signOutFromCloud({ client: () => undefined, domains: ['anilist.co'] })).toEqual({
      cleared: false,
      reason: 'not-ready',
    })

    const missingDom = new Error('DOM unavailable')
    expect(
      await signOutFromCloud({
        client: fakes().client,
        domains: ['anilist.co'],
        mountHiddenFrame: () => { throw missingDom },
      }),
    ).toEqual({
      cleared: false,
      reason: 'failed',
      error: missingDom,
    })

    const runtimeThrowFlag = false as boolean
    const dynamicRes = await signOutFromCloud({
      client: fakes().client,
      domains: ['anilist.co'],
      mountHiddenFrame: fakes().mountHiddenFrame,
      throwOnError: runtimeThrowFlag,
    })
    expect(dynamicRes).toEqual({ cleared: true })

    const extUnsupported = Object.assign(new Error('unsupported'), {
      name: 'ExtensionOperationUnsupportedError',
      operation: 'cookies',
    })
    const ext = fakes({ refuse: extUnsupported })
    expect(
      await signOutFromCloud({
        client: ext.client,
        domains: ['anilist.co'],
        mountHiddenFrame: ext.mountHiddenFrame,
      }),
    ).toEqual({
      cleared: false,
      reason: 'extension-unsupported',
      error: extUnsupported,
    })
    expect(ext.remove).toHaveBeenCalledTimes(1)

    const timeout = new Error('render proxy did not answer')
    const failed = fakes({ clear: async () => { throw timeout } })
    expect(
      await signOutFromCloud({
        client: failed.client,
        domains: ['myanimelist.net'],
        mountHiddenFrame: failed.mountHiddenFrame,
      }),
    ).toEqual({
      cleared: false,
      reason: 'failed',
      error: timeout,
    })
    expect(failed.remove).toHaveBeenCalledTimes(1)
  })

  it('throws and removes the iframe when throwOnError is true', async () => {
    const failed = fakes({ clear: async () => { throw new Error('clear failed') } })
    await expect(
      signOutFromCloud({
        client: failed.client,
        domains: ['app.trakt.tv'],
        mountHiddenFrame: failed.mountHiddenFrame,
        throwOnError: true,
      }),
    ).rejects.toThrow('clear failed')
    expect(failed.remove).toHaveBeenCalledTimes(1)

    await expect(
      signOutFromCloud({
        client: () => undefined,
        domains: ['app.trakt.tv'],
        throwOnError: true,
      }),
    ).rejects.toThrow('not loaded')
  })
})
