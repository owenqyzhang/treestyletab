/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Emulation of Firefox's tab successor machinery
# (tabs.update({successorTabId}) and tabs.moveInSuccession()) for Chrome.
# Service worker only.
#
# When the active tab is closed, Firefox focuses its registered successor.
# Chrome has no such concept: it applies its own heuristics first, then we
# immediately re-focus the recorded successor.
*/
'use strict';

const TAB_ID_NONE = -1;

const mSuccessors = new Map(); // tabId    => successor tabId
const mActiveTabs = new Map(); // windowId => active tabId

let mInitialized = false;

export function init() {
  if (mInitialized)
    return;
  mInitialized = true;

  // Let the compat layer's normalizeTab() attach successorTabId to tab
  // objects, like Firefox does natively.
  globalThis.__treestyletabCompatGetSuccessor = getSuccessor;

  chrome.tabs.query({ active: true }).then(tabs => {
    for (const tab of tabs) {
      if (!mActiveTabs.has(tab.windowId))
        mActiveTabs.set(tab.windowId, tab.id);
    }
  }).catch(_error => {});

  chrome.tabs.onActivated.addListener(activeInfo => {
    mActiveTabs.set(activeInfo.windowId, activeInfo.tabId);
  });

  chrome.windows.onRemoved.addListener(windowId => {
    mActiveTabs.delete(windowId);
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    const successor  = mSuccessors.get(tabId);
    const wasActive  = mActiveTabs.get(removeInfo.windowId) == tabId;
    mSuccessors.delete(tabId);

    // Firefox splices removed tabs out of successor chains.
    for (const [id, successorId] of mSuccessors.entries()) {
      if (successorId == tabId) {
        if (successor === undefined || successor == TAB_ID_NONE)
          mSuccessors.delete(id);
        else
          mSuccessors.set(id, successor);
      }
    }

    if (!wasActive ||
        removeInfo.isWindowClosing ||
        successor === undefined ||
        successor == TAB_ID_NONE)
      return;

    activateSuccessor(successor, removeInfo.windowId);
  });
}

async function activateSuccessor(tabId, windowId, hops = 0) {
  if (hops > 20) // cycle guard
    return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId != windowId)
      return; // successors are only meaningful in the same window
    await chrome.tabs.update(tabId, { active: true });
    mActiveTabs.set(windowId, tabId);
  }
  catch(_error) {
    // The successor is already gone: follow the chain.
    const next = mSuccessors.get(tabId);
    if (next !== undefined && next != TAB_ID_NONE && next != tabId)
      return activateSuccessor(next, windowId, hops + 1);
  }
}

export function setSuccessor(tabId, successorTabId) {
  if (successorTabId === undefined ||
      successorTabId === null ||
      successorTabId == TAB_ID_NONE ||
      successorTabId == tabId)
    mSuccessors.delete(tabId);
  else
    mSuccessors.set(tabId, successorTabId);
  notifySuccessorChanged(tabId);
}

// Firefox fires tabs.onUpdated with changeInfo.successorTabId when the
// successor changes; TST's successor machinery waits for those events.
async function notifySuccessorChanged(tabId) {
  const dispatch = globalThis.__treestyletabCompatDispatchTabUpdated;
  if (!dispatch)
    return;
  try {
    const tab = await chrome.tabs.get(tabId);
    tab.successorTabId = getSuccessor(tabId);
    dispatch(tabId, { successorTabId: tab.successorTabId }, tab);
  }
  catch(_error) {
    // tab is already gone
  }
}

export function getSuccessor(tabId) {
  const successor = mSuccessors.get(tabId);
  return successor === undefined ? TAB_ID_NONE : successor;
}

// Firefox: arranges the given tabs into a successor chain, ending at
// the reference tab. options.insert additionally splices the chain into
// the reference tab's existing chain; approximated here.
export function moveInSuccession(tabIds, referenceTabId = TAB_ID_NONE, options = {}) {
  if (!Array.isArray(tabIds) || tabIds.length == 0)
    return;

  // Remove the moved tabs from any existing chain position (Firefox
  // re-links predecessors to the moved tabs' successors).
  const moved = new Set(tabIds);
  for (const [id, successorId] of mSuccessors.entries()) {
    if (moved.has(id))
      continue;
    if (moved.has(successorId)) {
      let candidate = mSuccessors.get(successorId);
      let hops = 0;
      while (candidate !== undefined && moved.has(candidate) && hops++ < tabIds.length)
        candidate = mSuccessors.get(candidate);
      if (candidate === undefined || moved.has(candidate))
        mSuccessors.delete(id);
      else
        mSuccessors.set(id, candidate);
    }
  }

  let tail = referenceTabId;
  if (options.insert && referenceTabId != TAB_ID_NONE) {
    // Insert the chain between the reference tab and its current successor.
    const referenceSuccessor = mSuccessors.get(referenceTabId);
    setSuccessor(referenceTabId, tabIds[0]);
    tail = referenceSuccessor === undefined ? TAB_ID_NONE : referenceSuccessor;
  }

  for (let index = 0; index < tabIds.length; index++) {
    const next = index + 1 < tabIds.length ? tabIds[index + 1] : tail;
    setSuccessor(tabIds[index], next);
  }
}
