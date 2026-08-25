/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# matchMedia('(prefers-color-scheme: dark)') replacement for the MV3
# service worker, backed by an offscreen document (reason: MATCH_MEDIA).
*/
'use strict';

const COLOR_SCHEME_MESSAGE_TYPE = 'treestyletab:compat-color-scheme';
const CACHE_KEY = 'treestyletab:compat-color-scheme:dark';

let mDarkMode = false;
const mChangeListeners = new Set();
let mStarted = false;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen)
    return;
  try {
    await chrome.offscreen.createDocument({
      url:           '/common/offscreen.html',
      reasons:       ['MATCH_MEDIA'],
      justification: 'Track the system dark mode state for the tab tree UI.',
    });
  }
  catch(_error) {
    // Already exists: fine.
  }
}

function notify() {
  const event = { matches: mDarkMode, media: '(prefers-color-scheme: dark)' };
  for (const listener of mChangeListeners) {
    try {
      listener(event);
    }
    catch(error) {
      console.error('compat-media: change listener failed', error);
    }
  }
}

async function start() {
  if (mStarted)
    return;
  mStarted = true;

  chrome.runtime.onMessage.addListener((message, _sender) => {
    if (message?.type != COLOR_SCHEME_MESSAGE_TYPE)
      return;
    if (mDarkMode != message.dark) {
      mDarkMode = message.dark;
      chrome.storage.session.set({ [CACHE_KEY]: mDarkMode }).catch(_error => {});
      notify();
    }
  });

  const cached = await chrome.storage.session.get(CACHE_KEY).catch(_error => null);
  if (cached && CACHE_KEY in cached)
    mDarkMode = !!cached[CACHE_KEY];

  await ensureOffscreenDocument();
}

// Returns a MediaQueryList-compatible object for
// '(prefers-color-scheme: dark)', usable in the service worker.
export async function getDarkModeMediaQuery() {
  await start();
  return {
    get matches() { return mDarkMode; },
    media: '(prefers-color-scheme: dark)',
    addListener(listener) { mChangeListeners.add(listener); },
    removeListener(listener) { mChangeListeners.delete(listener); },
    addEventListener(_type, listener) { mChangeListeners.add(listener); },
    removeEventListener(_type, listener) { mChangeListeners.delete(listener); },
  };
}
