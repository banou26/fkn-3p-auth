import type { Frame } from '@fkn/lib'

import { describe, expect, it, vi } from 'vite-plus/test'

import { verifyHiddenSession, type FknClient } from '../src'

describe('verifyHiddenSession', () => {
  it('runs probe on a blank cloud frame, settles before removing the iframe, and returns probe result', async () => {
    const events: string[] = []
    const iframe = { kind: 'hidden iframe' } as unknown as HTMLIFrameElement
    const remove = vi.fn(() => { events.push('remove') })
    const attachFrame = vi.fn(async () => ({ evaluate: vi.fn() }) as unknown as Frame)

    const state = await verifyHiddenSession({
      client: { attachFrame } as unknown as FknClient,
      url: 'https://www.crunchyroll.com/',
      permissions: [{ category: 'evaluation', reason: 'Check sign-in' }],
      mountHiddenFrame: () => ({ iframe, remove }),
      probe: async () => {
        events.push('probe')
        return 'signed-in' as const
      },
      shouldSettle: (value) => value === 'signed-in',
      settle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        events.push('settled')
      },
    })

    expect(state).toBe('signed-in')
    expect(attachFrame).toHaveBeenCalledWith({
      iframe,
      blank: { url: 'https://www.crunchyroll.com/' },
      cookies: 'persistent',
      permissions: [{ category: 'evaluation', reason: 'Check sign-in' }],
    })
    expect(events).toEqual(['probe', 'settled', 'remove'])
  })

  it('waits postProbeSettleMs before removing the hidden iframe when custom settle is omitted', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const iframe = { kind: 'hidden iframe' } as unknown as HTMLIFrameElement
      const remove = vi.fn(() => { events.push('remove') })

      const run = verifyHiddenSession({
        client: { attachFrame: vi.fn(async () => ({}) as Frame) } as unknown as FknClient,
        url: 'https://www.crunchyroll.com/',
        mountHiddenFrame: () => ({ iframe, remove }),
        postProbeSettleMs: 500,
        probe: async () => {
          events.push('probe')
          return true
        },
      })

      await vi.advanceTimersByTimeAsync(250)
      expect(events).toEqual(['probe'])
      expect(remove).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(250)
      expect(await run).toBe(true)
      expect(events).toEqual(['probe', 'remove'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips settling when shouldSettle returns false and cleans up when probe throws', async () => {
    const iframe = { kind: 'hidden iframe' } as unknown as HTMLIFrameElement
    const remove = vi.fn()
    const settle = vi.fn(async () => {})

    const res = await verifyHiddenSession({
      client: { attachFrame: vi.fn(async () => ({}) as Frame) } as unknown as FknClient,
      url: 'https://www.crunchyroll.com/',
      mountHiddenFrame: () => ({ iframe, remove }),
      probe: async () => 'signed-out' as const,
      shouldSettle: () => false,
      settle,
    })

    expect(res).toBe('signed-out')
    expect(settle).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(1)

    const removeOnErr = vi.fn()
    await expect(
      verifyHiddenSession({
        client: { attachFrame: vi.fn(async () => ({}) as Frame) } as unknown as FknClient,
        url: 'https://www.crunchyroll.com/',
        mountHiddenFrame: () => ({ iframe, remove: removeOnErr }),
        probe: async () => { throw new Error('probe failed') },
        settle,
      }),
    ).rejects.toThrow('probe failed')
    expect(settle).not.toHaveBeenCalled()
    expect(removeOnErr).toHaveBeenCalledTimes(1)
  })

  it('validates permission reasons up front before mounting or attaching', async () => {
    const mount = vi.fn()
    await expect(
      verifyHiddenSession({
        client: { attachFrame: vi.fn() } as unknown as FknClient,
        url: 'https://www.crunchyroll.com/',
        permissions: [{ category: 'evaluation', reason: 'x'.repeat(101) }],
        mountHiddenFrame: mount,
        probe: async () => true,
      }),
    ).rejects.toThrow(TypeError)
    expect(mount).not.toHaveBeenCalled()
  })
  it('removes the iframe and rejects when the probe or settle stalls past the deadline or the signal aborts', async () => {
    const mount = () => {
      const remove = vi.fn()
      return { remove, mountHiddenFrame: () => ({ iframe: {} as HTMLIFrameElement, remove }) }
    }
    const client = { attachFrame: vi.fn(async () => ({}) as Frame) } as unknown as FknClient

    const stalledProbe = mount()
    const probeError = await verifyHiddenSession({
      client,
      url: 'https://www.crunchyroll.com/',
      mountHiddenFrame: stalledProbe.mountHiddenFrame,
      timeoutMs: 20,
      probe: () => new Promise<boolean>(() => {}),
    }).catch((error: unknown) => error)
    expect((probeError as Error).name).toBe('TimeoutError')
    expect(stalledProbe.remove).toHaveBeenCalledTimes(1)

    const stalledSettle = mount()
    const controller = new AbortController()
    const run = verifyHiddenSession({
      client,
      url: 'https://www.crunchyroll.com/',
      mountHiddenFrame: stalledSettle.mountHiddenFrame,
      signal: controller.signal,
      probe: async () => true,
      settle: () => new Promise<void>(() => {}),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new Error('page left'))
    await expect(run).rejects.toThrow('page left')
    expect(stalledSettle.remove).toHaveBeenCalledTimes(1)

    const aborted = mount()
    await expect(verifyHiddenSession({
      client,
      url: 'https://www.crunchyroll.com/',
      mountHiddenFrame: aborted.mountHiddenFrame,
      signal: AbortSignal.abort(new Error('already gone')),
      probe: async () => true,
    })).rejects.toThrow('already gone')
    expect(aborted.remove).not.toHaveBeenCalled()
  })
  it('stops after the step the deadline interrupted, and clears the settle wait on abort', async () => {
    const client = { attachFrame: vi.fn(async () => ({}) as Frame) } as unknown as FknClient
    const settle = vi.fn(async () => {})
    const late = await verifyHiddenSession({
      client,
      url: 'https://www.crunchyroll.com/',
      mountHiddenFrame: () => ({ iframe: {} as HTMLIFrameElement, remove: () => {} }),
      timeoutMs: 20,
      probe: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40)),
      settle,
    }).catch((error: unknown) => error)
    expect((late as Error).name).toBe('TimeoutError')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(settle).not.toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const run = verifyHiddenSession({
        client,
        url: 'https://www.crunchyroll.com/',
        mountHiddenFrame: () => ({ iframe: {} as HTMLIFrameElement, remove: () => {} }),
        signal: controller.signal,
        postProbeSettleMs: 10_000,
        probe: async () => true,
      })
      run.catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      controller.abort(new Error('page left'))
      await expect(run).rejects.toThrow('page left')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
