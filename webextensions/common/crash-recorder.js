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
const MAX_ENTRIES = 300;

const mBuffer = [];
let mFlushTimer = null;
let mStartedAt = Date.now();

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
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        workerStartedAt: mStartedAt,
        updatedAt:       Date.now(),
        entries:         [...mBuffer],
      },
    });
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

  // Load any prior buffer so history spans restarts (bounded).
  chrome.storage.local.get(STORAGE_KEY).then(stored => {
    const prior = stored?.[STORAGE_KEY]?.entries;
    if (Array.isArray(prior) && prior.length && mBuffer.length == 0) {
      const carried = prior.slice(-MAX_ENTRIES / 2);
      mBuffer.unshift(`----- worker restarted (previous session above) -----`, ...[]);
      mBuffer.unshift(...carried);
    }
    record('worker', 'service worker started');
  }).catch(() => record('worker', 'service worker started'));

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
