# @banou/fkn-3p-auth

Shared third-party authentication helpers built on `@fkn/lib`: window sign-in orchestration (`openAuthWindow`), cloud jar sign-out (`signOutFromCloud`), hidden-frame session checks (`verifyHiddenSession`), cross-tab session coordination (`createSessionSync`), and Google / YouTube sign-in helpers (`@banou/fkn-3p-auth/google`).

## Install

```sh
npm install @banou/fkn-3p-auth
```

`@fkn/lib` (`>= 0.9.86`) is an optional peer dependency so callers can load `@fkn/lib` either statically (`stub`) or dynamically after broker startup (`yt-client`) by passing a synchronous client object or getter.

## Core API (`@banou/fkn-3p-auth`)

### `openAuthWindow(adapter, options)`

Call `openAuthWindow` directly inside a user click or key handler so `client.attachFrame({ window })` runs synchronously before any `await`:

```ts
import { openAuthWindow } from '@banou/fkn-3p-auth'
import { attachFrame, isTerminalError } from '@fkn/lib'

const outcome = await openAuthWindow(
  {
    id: 'anilist',
    entryUrl: 'https://anilist.co/login',
    domains: ['anilist.co'],
    permissions: [{ category: 'evaluation', reason: 'Read your AniList session' }],
    isSignedIn: (frame) => frame.evaluate(() => Boolean(document.querySelector('a[href^="/user/"]'))),
  },
  {
    client: { attachFrame, isTerminalError },
  },
)
```

For deferred `@fkn/lib` loaders, pass a getter and `onNotReady`:

```ts
import { openAuthWindow } from '@banou/fkn-3p-auth'
import { youtubeAuthAdapter } from '@banou/fkn-3p-auth/google'

const outcome = await openAuthWindow(youtubeAuthAdapter(), {
  client: () => loadedLib(),
  onNotReady: () => {
    void startPlatform()
  },
})
```

### `signOutFromCloud(options)`

Clears cookies for `domains` on FKN's cloud jar using an off-screen hidden iframe and removes the iframe in `finally`.

```ts
import { signOutFromCloud } from '@banou/fkn-3p-auth'

await signOutFromCloud({
  client,
  domains: ['www.youtube.com', 'accounts.google.com'],
  throwOnError: true,
})
```

### `verifyHiddenSession(options)`

Mounts a hidden `blank` cloud frame at `url`, executes `probe(frame)`, optionally awaits `settle` or `postProbeSettleMs` before removing the iframe so jar cookie writes commit, and returns the probe result without holding persistent state.

### `createSessionSync(options)`

Wraps `BroadcastChannel`, filtered `storage` events (preserving `oldValue` / `newValue`), and active auth popup window tracking (`registerWindow`, `closeOnMessage`, `closeWindows`). Safe in Node/SSR environments where browser globals are absent.

## Google / YouTube (`@banou/fkn-3p-auth/google`)

Provides `createGoogleAuthAdapter` and `youtubeAuthAdapter`:

- Lists `['www.youtube.com', 'accounts.google.com']` in `domains` by default.
- Requests `'interaction'` only (never `'evaluation'` on `accounts.google.com`).
- Clicks `a[href*="ServiceLogin"]` once via severity-0 visibility check plus locator `.click()` instead of `evaluate`.
- Re-applies severity-0 `addStyleTag` CSS and bounded `"Try another way"` clicks (`'cloud-only'` by default) when configured with verified passkey challenge selectors.
