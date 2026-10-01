/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Persistent crash/diagnostics recorder for the MV3 service worker.
#
# The service worker console is wiped when Chrome kills and restarts the
# worker, so crashes that happen during tab moves (and the sequence of
# events that led to a corrupted tree) are lost before they can be read.
# This module keeps an in-memory ring buffer of global errors, unhandled
# rejections, and native tab-event breadcrumbs, and mirrors it to
# storage.local so it survives a restart.
#
# Read it from the service worker console (or any extension page):
#   dumpCrashLog()                       // pretty prints the buffer
#   browser.storage.local.get('tst-crash-log')  // raw
*/
'use strict';

/* eslint-disable no-underscore-dangle */ // intentional globalThis markers

const STORAGE_KEY = 'tst-crash-log';
// Entries of a worker that hit an error before it could read the previous
// log (see flushNow()); merged by the next worker.
const PENDING_STORAGE_KEY = 'tst-crash-log-pending';
// At browser startup the read of the previous log has been seen taking tens
// of seconds; do not hold back persistence that long.
const PRIOR_LOAD_TIMEOUT = 5000;
const MAX_ENTRIES = 300;

const mBuffer = [];
let mFlushTimer = null;
let mStartedAt = Date.now();
// Until the previous worker's log has been read, a flush would overwrite
// it with only this worker's entries.
let mPriorLoaded = false;
let mPendingStored = false;

function nowTag() {
  // milliseconds since this worker instance started, for ordering
  return `+${String(Date.now() - mStartedAt).padStart(6, ' ')}ms`;
}

function record(kind, detail) {
  mBuffer.push(`${nowTag()} [${kind}] ${detail}`);
  if (mBuffer.length > MAX_ENTRIES)
    mBuffer.shift();
  scheduleFlush();
}

function scheduleFlush() {
  if (mFlushTimer)
    return;
  mFlushTimer = setTimeout(flush, 250);
}

async function flush() {
  mFlushTimer = null;
  if (!mPriorLoaded) {
    scheduleFlush();
    return;
  }
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        workerStartedAt: mStartedAt,
        updatedAt:       Date.now(),
        entries:         [...mBuffer],
      },
    });
    if (mPendingStored) { // now part of the main log
      mPendingStored = false;
      chrome.storage.local.remove(PENDING_STORAGE_KEY).catch(() => {});
    }
  }
  catch(_error) {
    // storage may be momentarily unavailable; the next event re-schedules
  }
}

// Flush synchronously-ish on the way down, so the last error before a
// worker teardown is not lost in the debounce window.
function flushNow() {
  if (mFlushTimer) {
    clearTimeout(mFlushTimer);
    mFlushTimer = null;
  }
  if (!mPriorLoaded) {
    // The main log cannot be written yet, and a worker that fails while it
    // is being registered dies before the read completes: keep the entries
    // aside right away.
    mPendingStored = true;
    chrome.storage.local.set({
      [PENDING_STORAGE_KEY]: {
        workerStartedAt: mStartedAt,
        entries:         [...mBuffer],
      },
    }).catch(() => {});
  }
  flush();
}

function describeError(error) {
  if (!error)
    return 'unknown';
  if (error.stack)
    return String(error.stack).split('\n').slice(0, 4).join(' | ');
  return String(error.message || error);
}

export function init() {
  if (globalThis.__treestyletabCrashRecorderInstalled)
    return;
  globalThis.__treestyletabCrashRecorderInstalled = true;
  mStartedAt = Date.now();

  // Load the previous worker's buffer so history spans restarts (bounded).
  // A worker woken by an event records entries before this read resolves,
  // so merge instead of only carrying over into an empty buffer.
  const startedLabel = `service worker started at ${new Date(mStartedAt).toISOString()}`;
  const markPriorLoaded = () => {
    if (mPriorLoaded)
      return;
    mPriorLoaded = true;
    record('worker', startedLabel);
  };
  // Storage operations run in order, so even if the read resolves after the
  // timeout below (and after a flush), it returns the previous log.
  chrome.storage.local.get([STORAGE_KEY, PENDING_STORAGE_KEY]).then(stored => {
    const prior = stored?.[STORAGE_KEY]?.entries;
    const carried = Array.isArray(prior) ? prior.slice(-MAX_ENTRIES / 2) : [];
    const pending = stored?.[PENDING_STORAGE_KEY];
    const orphaned = (pending?.workerStartedAt != mStartedAt && Array.isArray(pending?.entries)) ? pending.entries.slice(-MAX_ENTRIES / 2) : [];
    if (orphaned.length > 0) {
      mPendingStored = true; // remove it with the next main write
      carried.push(`----- a worker died before saving its log; its entries: -----`, ...orphaned);
    }
    if (carried.length > 0) {
      mBuffer.unshift(...carried, `----- worker restarted (previous worker above, timestamps restart) -----`);
      while (mBuffer.length > MAX_ENTRIES) {
        mBuffer.shift();
      }
      scheduleFlush(); // the timeout may already have let this worker's entries overwrite it
    }
  }).catch(() => {}).then(markPriorLoaded);
  setTimeout(markPriorLoaded, PRIOR_LOAD_TIMEOUT);

  const onError = event => {
    record('ERROR', `${event.message || ''} @ ${event.filename || ''}:${event.lineno || ''} ${describeError(event.error)}`);
    flushNow();
  };
  const onRejection = event => {
    record('REJECT', describeError(event.reason));
    flushNow();
  };
  // Register both the addEventListener and property forms: depending on
  // the exact Chrome build / whether an inspector is attached, one or the
  // other is the form that actually fires.
  globalThis.addEventListener('error', onError);
  globalThis.addEventListener('unhandledrejection', onRejection);
  globalThis.onerror = (message, source, lineno, _colno, error) =>
    onError({ message, filename: source, lineno, error });
  globalThis.onunhandledrejection = onRejection;

  // Native tab-event breadcrumbs: the sequence of moves/attaches around a
  // corruption or crash is what pinpoints the offending operation.
  try {
    chrome.tabs.onMoved.addListener((tabId, info) => record('onMoved', `tab ${tabId} ${info.fromIndex}->${info.toIndex} win ${info.windowId}`));
    chrome.tabs.onAttached.addListener((tabId, info) => record('onAttached', `tab ${tabId} -> win ${info.newWindowId} @${info.newPosition}`));
    chrome.tabs.onDetached.addListener((tabId, info) => record('onDetached', `tab ${tabId} from win ${info.oldWindowId} @${info.oldPosition}`));
    chrome.tabs.onCreated.addListener(tab => record('onCreated', `tab ${tab.id} @${tab.index} win ${tab.windowId} opener ${tab.openerTabId ?? '-'}`));
    chrome.tabs.onRemoved.addListener((tabId, info) => record('onRemoved', `tab ${tabId} win ${info.windowId} windowClosing ${info.isWindowClosing}`));
    // Chrome swaps a tab's contents in place and changes its id without
    // onCreated/onRemoved (e.g. Memory Saver discards on some builds).
    chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => record('onReplaced', `tab ${removedTabId} -> ${addedTabId}`));
    chrome.tabs.onActivated.addListener(info => record('onActivated', `tab ${info.tabId} win ${info.windowId}`));
  }
  catch(error) {
    record('recorder', `failed to attach tab breadcrumbs: ${describeError(error)}`);
  }

  // A manual breadcrumb API for higher-level code (tree ops).
  globalThis.__treestyletabBreadcrumb = (label, detail) => record(label, detail);

  globalThis.dumpCrashLog = () => {
    const text = mBuffer.join('\n');
    console.log(text);
    return text;
  };
}

// Self-initialize on import so the recorder is armed before the rest of
// the background (which imports this module first) registers anything.
// Only the service worker imports this file.
init();
