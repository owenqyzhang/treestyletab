/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Chrome keeps running an unpacked extension's service worker from its own
# copy of the scripts until the extension is reloaded: restarting the
# browser does not refresh it while the manifest version stays the same.
# Extension pages (the sidebar) always load the files on disk, so after the
# code changes the two halves can silently disagree for weeks. Both sides
# compare build ids (common/build-id.js) and reload the extension when the
# service worker is outdated. Chrome only.
*/
'use strict';

import { BUILD_ID } from './build-id.js';

export { BUILD_ID };

const GUARD_STORAGE_KEY = 'tst-stale-code-reload';
// A reload that does not help (or two contexts noticing the same mismatch)
// must not turn into a reload loop.
const GUARD_PERIOD = 10 * 60 * 1000;
// common/compat-sessions.js saves the tabs' values for the next start 2 s
// after the last change, in this storage.local key.
const SESSIONS_SNAPSHOT_KEY      = 'treestyletab:compat-sessions:snapshot';
const SESSIONS_SAVE_MAX_WAIT     = 10000;
const SESSIONS_RESPONSE_TIMEOUT  = 3000;

// fetch() always reads the extension's files on disk, unlike the module
// graph of a service worker started from Chrome's stored copy.
export async function readBuildIdOnDisk() {
  const response = await fetch(chrome.runtime.getURL('common/build-id.js'), { cache: 'no-store' });
  return (await response.text()).match(/BUILD_ID\s*=\s*'([^']*)'/)?.[1] || null;
}

// Returns whether the extension is being reloaded.
export async function reloadForStaleCode({ running, disk, reason }) {
  const guard = (await chrome.storage.local.get(GUARD_STORAGE_KEY))[GUARD_STORAGE_KEY];
  if (guard?.running == running &&
      guard?.disk == disk &&
      Date.now() - guard.at < GUARD_PERIOD) {
    console.error(`TST: still running build ${running} after reloading the extension for build ${disk}; not reloading again`);
    return false;
  }
  console.warn(`TST: running build ${running} but the files on disk are build ${disk} (${reason}); reloading the extension`);
  globalThis.__treestyletabBreadcrumb?.('stale', `running build ${running}, disk build ${disk}: ${reason}; reloading the extension`); // eslint-disable-line no-underscore-dangle
  if (typeof window != 'undefined')
    await saveSessionsInServiceWorker();
  // Only now: the page can be closed while waiting, and then it reloads
  // nothing.
  await chrome.storage.local.set({ [GUARD_STORAGE_KEY]: { running, disk, reason, at: Date.now() } });
  chrome.runtime.reload();
  return true;
}

// Whether this start follows a reload for stale code, which closed the
// extension's own tabs within the same browser session.
const RECENT_RELOAD_PERIOD = 60 * 1000;
export async function isRightAfterReloadForStaleCode() {
  const guard = (await chrome.storage.local.get(GUARD_STORAGE_KEY).catch(_error => null))?.[GUARD_STORAGE_KEY];
  return guard?.disk == BUILD_ID && Date.now() - guard.at < RECENT_RELOAD_PERIOD;
}

// The reload clears the service worker's live values, and the tabs get them
// back from its last saved copy (common/compat-sessions.js), which can be
// older than the tabs' URLs and positions.
async function saveSessionsInServiceWorker() {
  const request = method => Promise.race([
    chrome.runtime.sendMessage({ type: 'treestyletab:compat-sessions', ...method }),
    new Promise(resolve => setTimeout(resolve, SESSIONS_RESPONSE_TIMEOUT)),
  ]).catch(_error => undefined);
  if (await request({ method: 'flush', args: [] }) === true)
    return;
  // An outdated service worker cannot flush, but any change to a value makes
  // it save the current ones a while later.
  const requestedAt = Date.now();
  await request({ method: 'setWindowValue', args: [chrome.windows.WINDOW_ID_NONE, 'reload-requested-at', requestedAt] });
  while (Date.now() - requestedAt < SESSIONS_SAVE_MAX_WAIT) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const snapshot = (await chrome.storage.local.get(SESSIONS_SNAPSHOT_KEY).catch(_error => null))?.[SESSIONS_SNAPSHOT_KEY];
    if (snapshot?.savedAt >= requestedAt)
      return;
  }
}
