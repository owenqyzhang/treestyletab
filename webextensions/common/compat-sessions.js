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
#   - chrome.storage.local: fingerprinted snapshot (tab ids and URLs in
#     index order per window) used to re-associate values with the tabs
#     after a full browser restart, which Firefox does natively, and after
#     the extension is reloaded or updated, which clears storage.session.
#   - recently closed tabs keep their values in an LRU for a while, so
#     values are re-attached when the user restores a closed tab
#     (Ctrl/Cmd+Shift+T), detected via chrome.sessions.getRecentlyClosed.
#   - Chrome can swap a tab's contents in place and give the tab a new id
#     (tabs.onReplaced; e.g. Memory Saver discards on builds where the
#     WebContentsDiscard feature is off). Firefox ids never change, so the
#     values follow the tab to its new id, and calls that still use the old
#     id are redirected.
*/
'use strict';

import { isRightAfterReloadForStaleCode } from './stale-code.js';

// Constants.kPERSISTENT_ID. Not imported: browser-compat.js imports this
// module, so its imports are evaluated before the browser facade exists, and
// constants.js calls browser.* at the top level.
const PERSISTENT_ID_KEY = 'data-persistent-id';

// TST's group tabs are pages of this extension. Chrome closes them when it
// unloads the extension (reload, update, disable) and does not bring them
// back, while their trees are still saved; after a browser restart Chrome
// restores them by itself.
const GROUP_TAB_URL = chrome.runtime.getURL('resources/group-tab.html');

const SESSION_STORAGE_KEY = 'treestyletab:compat-sessions:live';
const LOCAL_STORAGE_KEY   = 'treestyletab:compat-sessions:snapshot';
const CLOSED_LRU_SIZE     = 50;
const STARTUP_LEFTOVER_LIFETIME_MSEC = 5 * 60 * 1000;
const REPLACED_ID_ALIASES_SIZE = 1000;

const mTabValues    = new Map(); // tabId    => { key => value }
const mWindowValues = new Map(); // windowId => { key => value }
const mTabUrls      = new Map(); // tabId    => last known URL
const mClosedTabs   = [];        // [{ url, values, closedAt }]

// Tab ids are never reused within a browser session, so an old => new
// alias stays valid for the whole session.
const mReplacedTabIds = new Map(); // removed tabId => added tabId
// Replacements reported before the persisted values were loaded; applied
// right after loading, before any API call can observe the values.
const mPendingReplacements = [];
let mValuesLoaded = false;

// Persisted entries not consumed by the startup association; late-restored
// tabs (lazy session restore) are matched against these on creation.
let mStartupLeftovers   = null;
let mStartupTimestamp   = 0;
let mRecentlyClosedSnapshot = [];

let mInitPromise = null;

function tabUrl(tab) {
  return tab.url || tab.pendingUrl || '';
}

function breadcrumb(detail) {
  globalThis.__treestyletabBreadcrumb?.('sessions', detail); // eslint-disable-line no-underscore-dangle
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

// Changes can come in a steady stream (e.g. a page updating its URL every
// second): write at least every LOCAL_WRITE_MAX_DELAY.
const LOCAL_WRITE_DELAY     = 2000;
const LOCAL_WRITE_MAX_DELAY = 10000;
let mLocalWriteTimer = null;
let mLocalWriteFirstRequestedAt = 0;
function scheduleLocalWrite() {
  const now = Date.now();
  if (!mLocalWriteTimer)
    mLocalWriteFirstRequestedAt = now;
  else if (now - mLocalWriteFirstRequestedAt < LOCAL_WRITE_MAX_DELAY - LOCAL_WRITE_DELAY)
    clearTimeout(mLocalWriteTimer);
  else
    return; // a write is due soon anyway
  mLocalWriteTimer = setTimeout(writeLocalSnapshot, LOCAL_WRITE_DELAY);
}

async function writeLocalSnapshot() {
  clearTimeout(mLocalWriteTimer);
  mLocalWriteTimer = null;
  try {
    const tabs = await chrome.tabs.query({});
    const windows = new Map();
    for (const tab of tabs) {
      let windowEntry = windows.get(tab.windowId);
      if (!windowEntry) {
        windowEntry = {
          id:     tab.windowId,
          values: mWindowValues.get(tab.windowId) || null,
          tabs:   [],
        };
        windows.set(tab.windowId, windowEntry);
      }
      windowEntry.tabs.push({
        id:      tab.id,
        url:     tabUrl(tab),
        groupId: tab.groupId ?? -1,
        values:  mTabValues.get(tab.id) || null,
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
    breadcrumb(`restored the values of ${mTabValues.size} tabs from storage.session`);
    return;
  }

  // Browser restart, or the extension was reloaded or updated: associate the
  // local snapshot with the tabs.
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

  const assignedWindows   = new Set();
  const assignedPersisted = new Set();
  const consumedEntries   = new Set();
  const sameSessionWindows = [];
  const urlMatchedWindows  = [];
  const associatedTabIds   = new Set();
  const sameSessionEntries = new Set(); // persisted.tabs of windows in this browser session

  // Reloading or updating the extension clears storage.session but keeps the
  // browser session, so tab and window ids are still valid. Matching by id
  // also keeps the values of tabs that navigated after the snapshot was
  // written, which the URL matching below would lose or give to another tab.
  // Older Chrome versions could reuse ids after a browser restart, so a window
  // is matched by id only when its id-matched tabs mostly also have their old
  // URLs or positions (not counting the tabs closed since, e.g. by the unload).
  const liveTabsById = new Map(currentTabs.map(tab => [tab.id, tab]));
  snapshot.windows.forEach((persisted, persistedIndex) => {
    const tabs = currentWindows.get(persisted.id);
    if (!tabs)
      return;
    const entriesWithLiveTab = [];
    let goneCount = 0;
    let inWindowCount = 0;
    let confirmedCount = 0;
    persisted.tabs.forEach((entry, index) => {
      const tab = liveTabsById.get(entry.id);
      if (!tab) {
        goneCount++;
        return;
      }
      entriesWithLiveTab.push(entry);
      if (tab.windowId != persisted.id) { // moved to another window
        goneCount++;
        return;
      }
      inWindowCount++;
      if (tabUrl(tab) == entry.url ||
          tab.index == index - goneCount)
        confirmedCount++;
    });
    if (confirmedCount == 0 ||
        confirmedCount * 2 < inWindowCount)
      return;
    assignedWindows.add(persisted.id);
    assignedPersisted.add(persistedIndex);
    if (persisted.values)
      mWindowValues.set(persisted.id, persisted.values);
    const tabIdOfEntry = new Map();
    for (const entry of entriesWithLiveTab) {
      if (entry.values)
        mTabValues.set(entry.id, entry.values);
      consumedEntries.add(entry);
      tabIdOfEntry.set(entry, entry.id);
      associatedTabIds.add(entry.id);
    }
    // Tabs opened or given new ids (tabs.onReplaced) after the snapshot was
    // written.
    const matchedTabIds = new Set(entriesWithLiveTab.map(entry => entry.id));
    associateTabsByUrl(
      tabs.filter(tab => !matchedTabIds.has(tab.id)),
      persisted.tabs.filter(entry => !consumedEntries.has(entry)),
      consumedEntries,
      tabIdOfEntry
    );
    sameSessionWindows.push({ windowId: persisted.id, entries: persisted.tabs, tabIdOfEntry });
    sameSessionEntries.add(persisted.tabs);
    breadcrumb(`window ${persisted.id}: associated ${entriesWithLiveTab.length} tabs by id and ${tabIdOfEntry.size - entriesWithLiveTab.length} by URL, of ${tabs.length} tabs (snapshot of ${persisted.tabs.length})`);
  });
  for (const { windowId, entries, tabIdOfEntry } of sameSessionWindows) {
    const reopened = await reopenClosedGroupTabs(windowId, entries, tabIdOfEntry, consumedEntries);
    if (reopened > 0)
      breadcrumb(`window ${windowId}: reopened ${reopened} group tabs closed with the extension`);
  }

  // Score all (current window, persisted window) pairs by shared URL count,
  // then assign greedily.
  const pairs = [];
  for (const [windowId, tabs] of currentWindows.entries()) {
    if (assignedWindows.has(windowId))
      continue;
    const urls = tabs.map(tabUrl);
    snapshot.windows.forEach((persisted, index) => {
      if (assignedPersisted.has(index))
        return;
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

  for (const pair of pairs) {
    if (assignedWindows.has(pair.windowId) ||
        assignedPersisted.has(pair.persistedIndex))
      continue;
    assignedWindows.add(pair.windowId);
    assignedPersisted.add(pair.persistedIndex);

    const persisted = snapshot.windows[pair.persistedIndex];
    if (persisted.values)
      mWindowValues.set(pair.windowId, persisted.values);

    // not the tabs moved here from a window associated by id
    const tabs = currentWindows.get(pair.windowId).filter(tab => !associatedTabIds.has(tab.id));
    const tabIdOfEntry = new Map();
    associateTabsByUrl(tabs, persisted.tabs, consumedEntries, tabIdOfEntry);
    urlMatchedWindows.push({ windowId: pair.windowId, entries: persisted.tabs, tabIdOfEntry });
    breadcrumb(`window ${pair.windowId}: associated ${tabIdOfEntry.size} tabs by URL, of ${tabs.length} tabs (snapshot of ${persisted.tabs.length})`);
  }
  // The reload installing an update reads a snapshot written by the outdated
  // code, without the ids that tell the browser session is the same.
  if (urlMatchedWindows.length > 0 &&
      await isRightAfterReloadForStaleCode()) {
    for (const { windowId, entries, tabIdOfEntry } of urlMatchedWindows) {
      sameSessionEntries.add(entries);
      const reopened = await reopenClosedGroupTabs(windowId, entries, tabIdOfEntry, consumedEntries);
      if (reopened > 0)
        breadcrumb(`window ${windowId}: reopened ${reopened} group tabs closed with the extension (reloaded for stale code)`);
    }
  }

  // Keep unconsumed entries around: lazily restored windows/tabs are
  // created later and matched by URL in the onCreated handler.
  // Within the same browser session nothing restores tabs lazily, and a tab
  // opened later would only take the place of a closed one.
  mStartupLeftovers = [];
  for (const persisted of snapshot.windows) {
    if (sameSessionEntries.has(persisted.tabs))
      continue;
    for (const entry of persisted.tabs) {
      if (entry.values && !consumedEntries.has(entry))
        mStartupLeftovers.push(entry);
    }
  }
  if (mStartupLeftovers.length == 0)
    mStartupLeftovers = null;
  mStartupTimestamp = Date.now();
}

// Matches the URL sequences in order, by their longest common subsequence:
// tolerates tabs opened, closed or navigated since the snapshot was written.
// (Taking the next entry with the same URL instead lets a tab that navigated
// to the URL of a later tab skip all the entries in between.)
const MAX_ALIGNED_CELLS = 4 * 1000 * 1000;
function associateTabsByUrl(tabs, entries, consumedEntries, tabIdOfEntry = null) {
  const urls = tabs.map(tabUrl);
  const associate = (tabIndex, entryIndex) => {
    const entry = entries[entryIndex];
    if (entry.values)
      mTabValues.set(tabs[tabIndex].id, entry.values);
    consumedEntries.add(entry);
    tabIdOfEntry?.set(entry, tabs[tabIndex].id);
  };

  // Unchanged ends need no search.
  let first = 0;
  while (first < urls.length &&
         first < entries.length &&
         urls[first] == entries[first].url) {
    associate(first, first);
    first++;
  }
  let tabsEnd    = urls.length;
  let entriesEnd = entries.length;
  while (tabsEnd > first &&
         entriesEnd > first &&
         urls[tabsEnd - 1] == entries[entriesEnd - 1].url) {
    associate(--tabsEnd, --entriesEnd);
  }

  const rows    = tabsEnd - first;
  const columns = entriesEnd - first + 1;
  if ((rows + 1) * columns > MAX_ALIGNED_CELLS) {
    // Too large to align: the next entry with the same URL.
    let cursor = first;
    for (let i = first; i < tabsEnd; i++) {
      for (let j = cursor; j < entriesEnd; j++) {
        if (entries[j].url != urls[i])
          continue;
        associate(i, j);
        cursor = j + 1;
        break;
      }
    }
    return;
  }
  // lengths[r * columns + c]: the LCS length of the rest from (r, c)
  const lengths = new Uint32Array((rows + 1) * columns);
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = columns - 2; c >= 0; c--) {
      lengths[r * columns + c] = urls[first + r] == entries[first + c].url ?
        lengths[(r + 1) * columns + c + 1] + 1 :
        Math.max(lengths[(r + 1) * columns + c], lengths[r * columns + c + 1]);
    }
  }
  let r = 0;
  let c = 0;
  while (r < rows && c < columns - 1) {
    if (urls[first + r] == entries[first + c].url) {
      associate(first + r, first + c);
      r++;
      c++;
    }
    else if (lengths[(r + 1) * columns + c] >= lengths[r * columns + c + 1]) {
      r++;
    }
    else {
      c++;
    }
  }
}

// Opens the group tabs the unloaded extension took with it again where they
// were, before TST restores its tree from the values.
async function reopenClosedGroupTabs(windowId, entries, tabIdOfEntry, consumedEntries) {
  let reopened = 0;
  for (const [index, entry] of entries.entries()) {
    if (consumedEntries.has(entry) ||
        !entry.values?.[PERSISTENT_ID_KEY] ||
        !entry.url?.startsWith(GROUP_TAB_URL))
      continue;
    try {
      // Before the tab that followed it.
      let nextTab = null;
      for (const next of entries.slice(index + 1)) {
        const tab = tabIdOfEntry.has(next) && await chrome.tabs.get(tabIdOfEntry.get(next)).catch(_error => null);
        if (tab?.windowId == windowId) {
          nextTab = tab;
          break;
        }
      }
      const tab = await chrome.tabs.create({
        windowId,
        url:    entry.url,
        active: false,
        ...(nextTab ? { index: nextTab.index } : {}),
      });
      mTabValues.set(tab.id, entry.values);
      mTabUrls.set(tab.id, entry.url);
      consumedEntries.add(entry);
      tabIdOfEntry.set(entry, tab.id);
      reopened++;
      // Opened at the edge of its native tab group, it is outside the group.
      if (entry.groupId > -1 &&
          tab.groupId != entry.groupId &&
          (await chrome.tabGroups.get(entry.groupId).catch(_error => null))?.windowId == windowId)
        await chrome.tabs.group({ groupId: entry.groupId, tabIds: [tab.id] }).catch(_error => {});
    }
    catch(error) {
      console.error('compat-sessions: failed to reopen a group tab', entry.url, error);
    }
  }
  return reopened;
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
  // The tab may have been replaced while we were waiting.
  const tabId = resolveTabId(tab.id);
  if (!mTabValues.has(tabId)) {
    mTabValues.set(tabId, closedTab.values);
    markDirty();
  }
}

// ===================================================================
// Tab id replacement (tabs.onReplaced)
// ===================================================================
function resolveTabId(tabId) {
  // Follow chains (a tab can be replaced more than once); bounded in case
  // of a corrupted map.
  for (let hops = 0; hops < 20 && mReplacedTabIds.has(tabId); hops++) {
    tabId = mReplacedTabIds.get(tabId);
  }
  return tabId;
}

// TST's unique-id value is { id, tabId } and a tabId that is not a live tab
// marks the tab as restored or duplicated. Writes and copies made with the
// old id (before or after the replacement) must not leave a dead id there.
function normalizeValue(key, value) {
  if (key == PERSISTENT_ID_KEY &&
      value?.tabId &&
      mReplacedTabIds.has(value.tabId))
    return { ...value, tabId: resolveTabId(value.tabId) };
  return value;
}

function onTabReplaced(addedTabId, removedTabId) {
  mReplacedTabIds.set(removedTabId, addedTabId);
  if (mReplacedTabIds.size > REPLACED_ID_ALIASES_SIZE)
    mReplacedTabIds.delete(mReplacedTabIds.keys().next().value);
  if (mValuesLoaded)
    migrateTabValues(addedTabId, removedTabId);
  else
    mPendingReplacements.push([addedTabId, removedTabId]);
}

function migrateTabValues(addedTabId, removedTabId) {
  const values = mTabValues.get(removedTabId);
  if (values) {
    // Anything already written under the new id is newer: let it win.
    const existing = mTabValues.get(addedTabId);
    mTabValues.set(addedTabId, existing ? { ...values, ...existing } : values);
    mTabValues.delete(removedTabId);
  }
  // TST stores { id, tabId } and treats a mismatching tabId as a sign of a
  // duplicated or restored tab; keep it pointing at the live id.
  const migrated = mTabValues.get(addedTabId);
  const persistentId = migrated?.[PERSISTENT_ID_KEY];
  if (persistentId?.tabId == removedTabId)
    migrated[PERSISTENT_ID_KEY] = { ...persistentId, tabId: addedTabId };

  const url = mTabUrls.get(removedTabId);
  if (url) {
    if (!mTabUrls.has(addedTabId))
      mTabUrls.set(addedTabId, url);
    mTabUrls.delete(removedTabId);
  }
  if (values)
    markDirty();
}

function applyPendingReplacements() {
  mValuesLoaded = true;
  for (const [addedTabId, removedTabId] of mPendingReplacements.splice(0)) {
    migrateTabValues(addedTabId, removedTabId);
  }
}

// ===================================================================
// Event listeners
// ===================================================================
const API = {
  setTabValue,
  getTabValue,
  removeTabValue,
  setWindowValue,
  getWindowValue,
  removeWindowValue,
  copyTabValues,
  flush,
};

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
      else // a browser restart matches tabs by URL
        scheduleLocalWrite();
    }
  });

  chrome.tabs.onReplaced.addListener(onTabReplaced);

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
      await restoreFromSnapshotOrAssociate().catch(error => {
        console.error('compat-sessions: failed to restore values', error);
      });
      applyPendingReplacements();
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
  tabId = resolveTabId(tabId);
  let values = mTabValues.get(tabId);
  if (!values) {
    values = {};
    mTabValues.set(tabId, values);
  }
  values[key] = normalizeValue(key, value);
  markDirty();
}

export async function getTabValue(tabId, key) {
  await init();
  tabId = resolveTabId(tabId);
  const values = mTabValues.get(tabId);
  return values ? normalizeValue(key, values[key]) : undefined;
}

export async function removeTabValue(tabId, key) {
  await init();
  tabId = resolveTabId(tabId);
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

// Saves the values for the next start now, e.g. before the extension is
// reloaded: the reload clears storage.session.
export async function flush() {
  await init();
  await writeLocalSnapshot();
  return true;
}

// Firefox copies session values when a tab is duplicated; Chrome does not.
export async function copyTabValues(sourceTabId, destinationTabId) {
  await init();
  sourceTabId = resolveTabId(sourceTabId);
  destinationTabId = resolveTabId(destinationTabId);
  const values = mTabValues.get(sourceTabId);
  if (values) {
    mTabValues.set(destinationTabId, JSON.parse(JSON.stringify(values)));
    markDirty();
  }
}

