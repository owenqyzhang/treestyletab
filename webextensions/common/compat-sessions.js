/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Emulation of Firefox's browser.sessions.set/get/removeTabValue and
# set/get/removeWindowValue for Chrome. Service worker only; other
# contexts reach this module via runtime messages (see browser-compat.js).
#
# Storage model:
#   - chrome.storage.session: authoritative live map (survives service
#     worker restarts, cleared when the browser exits)
#   - chrome.storage.local: fingerprinted snapshot (tab URLs in index
#     order per window) used to re-associate values with the restored
#     tabs after a full browser restart, which Firefox does natively.
#   - recently closed tabs keep their values in an LRU for a while, so
#     values are re-attached when the user restores a closed tab
#     (Ctrl/Cmd+Shift+T), detected via chrome.sessions.getRecentlyClosed.
*/
'use strict';

const SESSION_STORAGE_KEY = 'treestyletab:compat-sessions:live';
const LOCAL_STORAGE_KEY   = 'treestyletab:compat-sessions:snapshot';
const CLOSED_LRU_SIZE     = 50;
const STARTUP_LEFTOVER_LIFETIME_MSEC = 5 * 60 * 1000;

const mTabValues    = new Map(); // tabId    => { key => value }
const mWindowValues = new Map(); // windowId => { key => value }
const mTabUrls      = new Map(); // tabId    => last known URL
const mClosedTabs   = [];        // [{ url, values, closedAt }]

// Persisted entries not consumed by the startup association; late-restored
// tabs (lazy session restore) are matched against these on creation.
let mStartupLeftovers   = null;
let mStartupTimestamp   = 0;
let mRecentlyClosedSnapshot = [];

let mInitPromise = null;

function tabUrl(tab) {
  return tab.url || tab.pendingUrl || '';
}

// ===================================================================
// Persistence
// ===================================================================
let mSessionWriteTimer = null;
function scheduleSessionWrite() {
  if (mSessionWriteTimer)
    clearTimeout(mSessionWriteTimer);
  mSessionWriteTimer = setTimeout(async () => {
    mSessionWriteTimer = null;
    try {
      await chrome.storage.session.set({
        [SESSION_STORAGE_KEY]: {
          tabs:    Object.fromEntries(mTabValues),
          windows: Object.fromEntries(mWindowValues),
        },
      });
    }
    catch(error) {
      console.error('compat-sessions: failed to write session storage', error);
    }
  }, 200);
}

let mLocalWriteTimer = null;
function scheduleLocalWrite() {
  if (mLocalWriteTimer)
    clearTimeout(mLocalWriteTimer);
  mLocalWriteTimer = setTimeout(async () => {
    mLocalWriteTimer = null;
    try {
      const tabs = await chrome.tabs.query({});
      const windows = new Map();
      for (const tab of tabs) {
        let windowEntry = windows.get(tab.windowId);
        if (!windowEntry) {
          windowEntry = {
            values: mWindowValues.get(tab.windowId) || null,
            tabs:   [],
          };
          windows.set(tab.windowId, windowEntry);
        }
        windowEntry.tabs.push({
          url:    tabUrl(tab),
          values: mTabValues.get(tab.id) || null,
        });
      }
      await chrome.storage.local.set({
        [LOCAL_STORAGE_KEY]: {
          version: 1,
          savedAt: Date.now(),
          windows: Array.from(windows.values()),
        },
      });
    }
    catch(error) {
      console.error('compat-sessions: failed to write local snapshot', error);
    }
  }, 2000);
}

function markDirty() {
  scheduleSessionWrite();
  scheduleLocalWrite();
}

// ===================================================================
// Startup: rehydrate (service worker restart) or re-associate
// (browser restart)
// ===================================================================
async function restoreFromSnapshotOrAssociate() {
  const sessionData = await chrome.storage.session.get(SESSION_STORAGE_KEY).catch(_error => null);
  const live = sessionData && sessionData[SESSION_STORAGE_KEY];
  if (live && (Object.keys(live.tabs || {}).length > 0 ||
               Object.keys(live.windows || {}).length > 0)) {
    // Service worker restart within the same browser session: tab IDs
    // are still valid.
    for (const [id, values] of Object.entries(live.tabs || {})) {
      mTabValues.set(Number(id), values);
    }
    for (const [id, values] of Object.entries(live.windows || {})) {
      mWindowValues.set(Number(id), values);
    }
    return;
  }

  // Full browser restart: associate the local snapshot with restored tabs
  // by matching URL sequences per window.
  const localData = await chrome.storage.local.get(LOCAL_STORAGE_KEY).catch(_error => null);
  const snapshot = localData && localData[LOCAL_STORAGE_KEY];
  if (!snapshot?.windows?.length)
    return;

  const currentTabs = await chrome.tabs.query({});
  const currentWindows = new Map();
  for (const tab of currentTabs) {
    if (!currentWindows.has(tab.windowId))
      currentWindows.set(tab.windowId, []);
    currentWindows.get(tab.windowId).push(tab);
  }
  for (const tabs of currentWindows.values()) {
    tabs.sort((a, b) => a.index - b.index);
  }

  // Score all (current window, persisted window) pairs by shared URL count,
  // then assign greedily.
  const pairs = [];
  for (const [windowId, tabs] of currentWindows.entries()) {
    const urls = tabs.map(tabUrl);
    snapshot.windows.forEach((persisted, index) => {
      const persistedUrls = new Map();
      for (const entry of persisted.tabs) {
        persistedUrls.set(entry.url, (persistedUrls.get(entry.url) || 0) + 1);
      }
      let score = 0;
      for (const url of urls) {
        const count = persistedUrls.get(url) || 0;
        if (count > 0) {
          score++;
          persistedUrls.set(url, count - 1);
        }
      }
      if (score > 0)
        pairs.push({ windowId, persistedIndex: index, score });
    });
  }
  pairs.sort((a, b) => b.score - a.score);

  const assignedWindows   = new Set();
  const assignedPersisted = new Set();
  const consumedEntries   = new Set();
  for (const pair of pairs) {
    if (assignedWindows.has(pair.windowId) ||
        assignedPersisted.has(pair.persistedIndex))
      continue;
    assignedWindows.add(pair.windowId);
    assignedPersisted.add(pair.persistedIndex);

    const persisted = snapshot.windows[pair.persistedIndex];
    if (persisted.values)
      mWindowValues.set(pair.windowId, persisted.values);

    // In-order greedy matching of URL sequences: tolerates tabs
    // inserted/removed between sessions.
    const tabs = currentWindows.get(pair.windowId);
    let persistedCursor = 0;
    for (const tab of tabs) {
      const url = tabUrl(tab);
      for (let lookahead = persistedCursor; lookahead < persisted.tabs.length; lookahead++) {
        if (persisted.tabs[lookahead].url != url)
          continue;
        if (persisted.tabs[lookahead].values)
          mTabValues.set(tab.id, persisted.tabs[lookahead].values);
        consumedEntries.add(persisted.tabs[lookahead]);
        persistedCursor = lookahead + 1;
        break;
      }
    }
  }

  // Keep unconsumed entries around: lazily restored windows/tabs are
  // created later and matched by URL in the onCreated handler.
  mStartupLeftovers = [];
  for (const persisted of snapshot.windows) {
    for (const entry of persisted.tabs) {
      if (entry.values && !consumedEntries.has(entry))
        mStartupLeftovers.push(entry);
    }
  }
  if (mStartupLeftovers.length == 0)
    mStartupLeftovers = null;
  mStartupTimestamp = Date.now();
}

// ===================================================================
// Restore of closed tabs (Ctrl/Cmd+Shift+T)
// ===================================================================
async function updateRecentlyClosedSnapshot() {
  if (!chrome.sessions?.getRecentlyClosed)
    return;
  try {
    const closed = await chrome.sessions.getRecentlyClosed();
    mRecentlyClosedSnapshot = closed
      .filter(session => session.tab)
      .map(session => ({
        sessionId: session.tab.sessionId,
        url:       session.tab.url,
      }));
  }
  catch(_error) {
  }
}

// Case 1: lazily restored startup tabs. Must run synchronously enough
// that TST's getTabValue polling (which starts right at onCreated) sees
// the value on its first reads.
function tryReattachStartupLeftovers(tab) {
  const url = tabUrl(tab);
  if (!url || !mStartupLeftovers ||
      Date.now() - mStartupTimestamp >= STARTUP_LEFTOVER_LIFETIME_MSEC)
    return false;
  const index = mStartupLeftovers.findIndex(entry => entry.url == url);
  if (index < 0)
    return false;
  const [entry] = mStartupLeftovers.splice(index, 1);
  if (mStartupLeftovers.length == 0)
    mStartupLeftovers = null;
  if (!mTabValues.has(tab.id)) {
    mTabValues.set(tab.id, entry.values);
    markDirty();
  }
  return true;
}

async function tryReattachValuesToRestoredTab(tab) {
  const url = tabUrl(tab);
  if (!url)
    return;

  // Case 2: a recently closed tab was restored. Detect it by diffing the
  // recently-closed list: the restored entry disappears from it.
  if (mClosedTabs.length == 0 || !chrome.sessions?.getRecentlyClosed)
    return;
  const before = mRecentlyClosedSnapshot;
  let after = [];
  try {
    const closed = await chrome.sessions.getRecentlyClosed();
    after = closed
      .filter(session => session.tab)
      .map(session => ({
        sessionId: session.tab.sessionId,
        url:       session.tab.url,
      }));
  }
  catch(_error) {
    return;
  }
  const afterIds = new Set(after.map(entry => entry.sessionId));
  const restored = before.filter(entry => !afterIds.has(entry.sessionId));
  mRecentlyClosedSnapshot = after;
  if (!restored.some(entry => entry.url == url))
    return;
  const closedIndex = mClosedTabs.findIndex(closedTab => closedTab.url == url);
  if (closedIndex < 0)
    return;
  const [closedTab] = mClosedTabs.splice(closedIndex, 1);
  if (!mTabValues.has(tab.id)) {
    mTabValues.set(tab.id, closedTab.values);
    markDirty();
  }
}

// ===================================================================
// Event listeners
// ===================================================================
function listen() {
  chrome.tabs.onCreated.addListener(tab => {
    if (tabUrl(tab))
      mTabUrls.set(tab.id, tabUrl(tab));
    if (tryReattachStartupLeftovers(tab))
      return;
    // Delay a little: the recently-closed sessions metadata may not be
    // up to date immediately after a restore.
    setTimeout(() => {
      tryReattachValuesToRestoredTab(tab);
    }, 250);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      mTabUrls.set(tabId, changeInfo.url);
      // Lazily restored tabs may receive their URL only after creation.
      if (!mTabValues.has(tabId))
        tryReattachStartupLeftovers(tab);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId, _removeInfo) => {
    const values = mTabValues.get(tabId);
    if (values) {
      mTabValues.delete(tabId);
      const url = mTabUrls.get(tabId);
      if (url) {
        mClosedTabs.unshift({ url, values, closedAt: Date.now() });
        if (mClosedTabs.length > CLOSED_LRU_SIZE)
          mClosedTabs.length = CLOSED_LRU_SIZE;
      }
      markDirty();
    }
    mTabUrls.delete(tabId);
    setTimeout(updateRecentlyClosedSnapshot, 500);
  });

  chrome.windows.onRemoved.addListener(windowId => {
    if (mWindowValues.delete(windowId))
      markDirty();
  });

  // RPC endpoint for non-service-worker contexts (sidebar, options, ...).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type != 'treestyletab:compat-sessions')
      return false;
    Promise.resolve()
      .then(() => {
        const method = API[message.method];
        if (!method)
          throw new Error(`compat-sessions: unknown method ${message.method}`);
        return method(...message.args);
      })
      .then(
        result => sendResponse(result),
        error => {
          console.error('compat-sessions: RPC failed', message, error);
          sendResponse(undefined);
        }
      );
    return true;
  });
}

// ===================================================================
// Public API (mirrors browser.sessions.*Value)
// ===================================================================
export async function init() {
  if (!mInitPromise) {
    mInitPromise = (async () => {
      listen();
      await restoreFromSnapshotOrAssociate();
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tabUrl(tab))
          mTabUrls.set(tab.id, tabUrl(tab));
      }
      updateRecentlyClosedSnapshot();
      scheduleSessionWrite();
    })().catch(error => {
      console.error('compat-sessions: initialization failed', error);
    });
  }
  return mInitPromise;
}

export async function setTabValue(tabId, key, value) {
  await init();
  let values = mTabValues.get(tabId);
  if (!values) {
    values = {};
    mTabValues.set(tabId, values);
  }
  values[key] = value;
  markDirty();
}

export async function getTabValue(tabId, key) {
  await init();
  const values = mTabValues.get(tabId);
  return values ? values[key] : undefined;
}

export async function removeTabValue(tabId, key) {
  await init();
  const values = mTabValues.get(tabId);
  if (values && key in values) {
    delete values[key];
    if (Object.keys(values).length == 0)
      mTabValues.delete(tabId);
    markDirty();
  }
}

export async function setWindowValue(windowId, key, value) {
  await init();
  let values = mWindowValues.get(windowId);
  if (!values) {
    values = {};
    mWindowValues.set(windowId, values);
  }
  values[key] = value;
  markDirty();
}

export async function getWindowValue(windowId, key) {
  await init();
  const values = mWindowValues.get(windowId);
  return values ? values[key] : undefined;
}

export async function removeWindowValue(windowId, key) {
  await init();
  const values = mWindowValues.get(windowId);
  if (values && key in values) {
    delete values[key];
    if (Object.keys(values).length == 0)
      mWindowValues.delete(windowId);
    markDirty();
  }
}

// Firefox copies session values when a tab is duplicated; Chrome does not.
export async function copyTabValues(sourceTabId, destinationTabId) {
  await init();
  const values = mTabValues.get(sourceTabId);
  if (values) {
    mTabValues.set(destinationTabId, JSON.parse(JSON.stringify(values)));
    markDirty();
  }
}

const API = {
  setTabValue,
  getTabValue,
  removeTabValue,
  setWindowValue,
  getWindowValue,
  removeWindowValue,
  copyTabValues,
};
