import { describe, expect, it, vi } from 'vite-plus/test'

import { decide, fetchPackument } from '../scripts/npm-version-gate.mjs'

describe('npm-version-gate', () => {
  it('refuses initial 404 packuments, skips existing versions, refuses tombstones, and publishes new versions', () => {
    expect(decide(null, '0.1.0')).toMatchObject({ action: 'refuse' })

    expect(
      decide(
        {
          versions: { '0.1.0': {} },
          time: { '0.1.0': '2026-11-25T00:00:00.000Z' },
        },
        '0.1.0',
      ),
    ).toMatchObject({ action: 'skip' })

    expect(
      decide(
        {
          versions: { '0.1.0': {} },
          time: {
            '0.1.0': '2026-11-25T00:00:00.000Z',
            '0.1.1': '2026-11-25T01:00:00.000Z',
          },
        },
        '0.1.1',
      ),
    ).toMatchObject({ action: 'refuse' })

    expect(
      decide(
        {
          versions: { '0.1.0': {} },
          time: { '0.1.0': '2026-11-25T00:00:00.000Z' },
        },
        '0.1.1',
      ),
    ).toMatchObject({ action: 'publish' })
  })

  it('fetches packuments and handles 404 and non-OK statuses', async () => {
    const notFound = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(fetchPackument('@banou/fkn-3p-auth', notFound as unknown as typeof fetch)).resolves.toBeNull()
    expect(notFound).toHaveBeenCalledWith('https://registry.npmjs.org/%40banou%2Ffkn-3p-auth')

    const ok = vi.fn(async () => new Response(JSON.stringify({ versions: { '0.1.0': {} } }), { status: 200 }))
    await expect(fetchPackument('@banou/fkn-3p-auth', ok as unknown as typeof fetch)).resolves.toEqual({
      versions: { '0.1.0': {} },
    })

    const serverErr = vi.fn(async () => new Response(null, { status: 503 }))
    await expect(fetchPackument('@banou/fkn-3p-auth', serverErr as unknown as typeof fetch)).rejects.toThrow('503')
  })
})
