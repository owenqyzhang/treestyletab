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
  await chrome.storage.local.set({ [GUARD_STORAGE_KEY]: { running, disk, reason, at: Date.now() } });
  chrome.runtime.reload();
  return true;
}
