#!/usr/bin/env node
// Decides whether `version` can be published based on the full npm packument.
// Checking only `/<pkg>/<version>` gives 404 both before first publish and for unpublished tombstones;
// `time` retains every version ever published on the registry.

/**
 * Determine whether `version` should be published, skipped, or refused for a given packument.
 *
 * @param { { versions?: Record<string, unknown>, time?: Record<string, string> } | null } packument
 * @param {string} version
 * @returns {{ action: 'publish' | 'skip' | 'refuse', reason: string }}
 */
export const decide = (packument, version) => {
  if (!packument) {
    return {
      action: 'refuse',
      reason: 'the registry serves no package under this name yet; publish the first version by hand and bind the trusted publisher on npmjs.com first',
    }
  }
  if (packument.versions?.[version]) {
    return { action: 'skip', reason: `${version} is already published` }
  }
  if (packument.time?.[version]) {
    return {
      action: 'refuse',
      reason: `${version} was published on ${packument.time[version]} and unpublished; npm reserves the number forever. Bump the version.`,
    }
  }
  return { action: 'publish', reason: `${version} has never been used` }
}

/**
 * Fetch the full registry packument for `name`, or `null` when the package returns 404.
 *
 * @param {string} name
 * @param {typeof fetch} [fetchImpl]
 */
export const fetchPackument = async (name, fetchImpl = fetch) => {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}. Refusing to guess.`)
  return response.json()
}

if (process.argv[1]?.endsWith('npm-version-gate.mjs')) {
  const [name, version] = process.argv.slice(2)
  if (!name || !version) {
    console.error('usage: npm-version-gate.mjs <package name> <version>')
    process.exit(1)
  }
  const { action, reason } = decide(await fetchPackument(name), version)
  console.error(`${name} ${version}: ${action}, ${reason}`)
  if (action === 'refuse') process.exit(1)
  console.log(`changed=${action === 'publish'}`)
}
