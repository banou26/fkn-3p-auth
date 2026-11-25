import type { HiddenFrameHandle } from './types.js'

/**
 * Mounts an off-screen hidden iframe clipped rather than `display: none` so attached FKN pages
 * keep normal layout dimensions while staying invisible and unfocusable.
 */
export const createHiddenFrame = (title = 'FKN Auth'): HiddenFrameHandle => {
  if (typeof document === 'undefined' || !document.body) {
    throw new Error('createHiddenFrame requires a DOM document with document.body')
  }
  const iframe = document.createElement('iframe')
  iframe.title = title
  iframe.tabIndex = -1
  iframe.setAttribute('aria-hidden', 'true')
  iframe.referrerPolicy = 'no-referrer'
  iframe.style.cssText = 'position: fixed; top: 0; left: 0; width: 400px; height: 300px; border: 0; clip-path: inset(100%); pointer-events: none;'
  document.body.appendChild(iframe)
  return {
    iframe,
    remove: () => iframe.remove(),
  }
}
