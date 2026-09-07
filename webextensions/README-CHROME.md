# Tree Style Tab — Chrome port

This branch (`chrome-port`) adapts Tree Style Tab (a Firefox extension) to
Google Chrome as a Manifest V3 extension. The Firefox original lives on the
default branch; `manifest.firefox.json` preserves the original manifest.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this `webextensions/` directory
4. Click the Tree Style Tab toolbar button (or press the shortcut assigned at
   `chrome://extensions/shortcuts`) to open the tab tree in the side panel

## Architecture of the port

- **Manifest V3**: `sidebar_action` → `side_panel`, persistent background page
  → module service worker (`background/service-worker.js`), `browser_action` →
  `action`, PNG icons rasterized from the SVG sources.
- **`common/browser-compat.js`** is imported first by every entry point and
  installs a `browser` global facade over `chrome` that emulates the
  Firefox-only APIs TST depends on:
  - `sessions.set/get/removeTabValue` + window values →
    `common/compat-sessions.js`: values live in `chrome.storage.session`
    (survives service-worker restarts) and a URL-fingerprinted snapshot in
    `chrome.storage.local` re-associates them with restored tabs after a full
    browser restart. Tab duplication copies values; restoring a recently
    closed tab re-attaches its values.
  - Successor tabs (`tabs.moveInSuccession`, `tabs.update({successorTabId})`)
    → `common/compat-successor.js`: when the active tab closes, the recorded
    successor is focused (Chrome briefly focuses its own pick first).
  - `menus` → `contextMenus` with per-service-worker-start re-registration;
    items for unsupported contexts (`tab`, `bookmark`) become virtual and are
    served by TST's own in-sidebar context menu.
  - Stubs: `theme`, `contextualIdentities` (no containers on Chrome),
    `browserSettings`; mappings: `sidebarAction` → `sidePanel`,
    `search.search` → `search.query`, `getBrowserInfo`.
  - Promise-returning `runtime.onMessage` listeners are bridged to Chrome's
    `sendResponse` protocol; Firefox-only parameters and the `tabs.onUpdated`
    filter argument are stripped/emulated; tab objects are normalized
    (`cookieStoreId`, `hidden`, `successorTabId`, `pendingUrl`→`url`).
- **Dark mode in the service worker**: `common/compat-media.js` + an offscreen
  document (there is no `matchMedia` in a service worker).
- **Service worker keepalive**: a 20 s `getPlatformInfo` interval + a 30 s
  alarm approximate Firefox's persistent background page; state also
  rehydrates from `storage.session` after a restart.
- Icon coloring uses TST's built-in `simulateSVGContextFill` mode (Firefox's
  `-moz-context-properties`/`context-fill` does not exist in Chrome).

## Known limitations on Chrome

- **Containers**: Firefox contextual identities do not exist; container
  features are hidden/no-ops. Chrome native **tab groups** are supported.
- **Tab hiding** (`tabs.hide/show`) does not exist; the "hide tabs" features
  are no-ops.
- **Native context menu on the tab strip**: Chrome extensions cannot add
  items to the native tab context menu or override menus
  (`menus.overrideContext`); the sidebar always uses TST's emulated menu.
- **In-content panels** (tab preview tooltips / tab group menu rendered
  inside the web page) are disabled; TST falls back to sidebar-rendered UI.
- **Tab previews** of background tabs (`tabs.captureTab`) cannot be captured.
- **Keyboard shortcuts** cannot be edited inside TST's options page; use
  `chrome://extensions/shortcuts`. Chrome allows at most 4 pre-assigned keys
  (the four tree-navigation shortcuts keep their Firefox defaults).
- **Session restore matching** after a full browser restart is heuristic
  (per-window URL-sequence fingerprints). Trees are restored reliably in
  common cases; exotic cases (many identical URLs shuffled across windows)
  may re-attach values to the wrong duplicate.
- `ext+treestyletab:` protocol links (bookmarked group tabs) are not
  registered on Chrome; group tabs use plain `chrome-extension://` URLs.
- Firefox theme integration (`browser.theme`) is stubbed; the sidebar uses
  its default light/dark styling.

## Syncing with upstream

The repo tracks `piroor/treestyletab` as the `upstream` remote. To pull
their changes under the port:

    git sync-upstream

(a repo-local alias: fetches upstream, fast-forwards `trunk`, pushes it to
the fork, and rebases `chrome-port` onto it). On conflicts, resolve and
`git rebase --continue`. Afterwards re-verify (reload the unpacked
extension; re-run `node tools/inline-mask-images.mjs` if upstream added
masked icons) and `git push --force-with-lease origin chrome-port`.

## Development

- Toolchain: Node.js >= 20 (`brew install node`), then `npm install --save-dev`
  in this directory. Everything else the build needs (`zip`, `jq`) ships with
  macOS / Homebrew.
- Build the Chrome package: **`make chrome`** → `treestyletab-chrome.zip`.
  It runs `inline_masks` then `lint`, and packages only the runtime
  directories. Load unpacked from `webextensions/` for development; the zip is
  for distribution.
- **Do not run `make xpi` (or `make install_extlib`) on this branch.** `xpi`
  regenerates `extlib/` from the submodules, which would discard the Chrome
  patches vendored here. `make chrome` deliberately skips that step.
- `extlib/` is vendored on this branch (the port patches those files).
- Static checks: `make lint` (eslint + jsonlint), currently clean. It runs
  eslint with `--max-warnings=0`, so **warnings fail the build** — nearly every
  rule here is configured as `warn` rather than `error`, and without that flag
  lint exits 0 no matter how many are reported. `make chrome` depends on
  `lint`, so a style regression blocks the package too. `make format` applies
  the auto-fixable ones.
- Masked icons: `make inline_masks` (or `node tools/inline-mask-images.mjs`).
  Idempotent; prints `total: 0` when everything is already inlined. Re-run
  after adding or changing any masked icon.
- Smoke/functional tests used during the port drive Chrome for Testing via
  puppeteer (`installExtension` + `--enable-unsafe-extension-debugging`,
  launched with `ignoreDefaultArgs: ['--disable-extensions']`). On a machine
  with no Chrome, any Chromium browser works as the target via
  `puppeteer-core` + `executablePath` (Vivaldi has been used successfully).
  Note that Chrome for Testing does *not* pre-define the `browser` global, so
  it cannot reproduce the class of bug fixed in `browser-compat.js`; a real
  Chrome/Chromium build is required for that.
