/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  log as internalLogger,
  mapAndFilterUniq,
  configs
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TSTAPI from '/common/tst-api.js';

function log(...args) {
  internalLogger('sidebar/background-connection', ...args);
}

export const onMessage = new EventListenerManager();

let mConnectionPort = null;
let mHeartbeatTimer = null;
let mReconnectAttempts = 0;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MSEC = 250;

export function connect() {
  if (mConnectionPort)
    return;
  const type = /windowId=([1-9][0-9]*)/i.test(window.location.search) ? 'unknown' : 'sidebar';
  mConnectionPort = browser.runtime.connect({
    name: `${Constants.kCOMMAND_REQUEST_CONNECT_PREFIX}${TabsStore.getCurrentWindowId()}:${type}`
  });
  mConnectionPort.onMessage.addListener(onConnectionMessage);
  mConnectionPort.onDisconnect.addListener(onConnectionDisconnect);
  if (mHeartbeatTimer)
    clearInterval(mHeartbeatTimer);
  mHeartbeatTimer = setInterval(() => {
    sendMessage({
      type: Constants.kCONNECTION_HEARTBEAT
    });
  }, configs.heartbeatInterval);
  if (mReservedMessages.length > 0)
    reserveToFlushMessages();
}

function onConnectionDisconnect() {
  mConnectionPort = null;
  if (mHeartbeatTimer) {
    clearInterval(mHeartbeatTimer);
    mHeartbeatTimer = null;
  }
  // On Chrome the MV3 background service worker can be suspended/restarted
  // at any time, and that disconnects all ports. Thus we should try to
  // reconnect silently instead of reloading the whole sidebar, and reload
  // only when reconnection keeps failing.
  if (mReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log(`Disconnected accidentally and failed to reconnect ${mReconnectAttempts} times: reload myself.`);
    window.location.reload();
    return;
  }
  mReconnectAttempts++;
  log(`Disconnected accidentally: try to reconnect. (attempt ${mReconnectAttempts})`);
  setTimeout(() => {
    try {
      connect();
    }
    catch(error) {
      log('Failed to reconnect: ', error);
      onConnectionDisconnect();
    }
  }, RECONNECT_BASE_DELAY_MSEC * mReconnectAttempts);
}

let mPromisedStartedResolver;
let mPromisedStarted = new Promise((resolve, _reject) => {
  mPromisedStartedResolver = resolve;
});

export function start() {
  if (!mPromisedStartedResolver)
    return;
  mPromisedStartedResolver();
  mPromisedStartedResolver = undefined;
  mPromisedStarted = undefined;
}

const counts = {};

let mReservedMessages = [];
let mOnFrame;

export function sendMessage(message) {
  if (configs.loggingConnectionMessages) {
    counts[message.type] = counts[message.type] || 0;
    counts[message.type]++;
  }
  // We should not send messages immediately, instead we should throttle
  // it and bulk-send multiple messages, for better user experience.
  // Sending too many messages in one event loop may block everything
  // and makes Firefox like frozen.
  //
  // Heartbeats, however, are the one exception. They run constantly, even
  // in an idle browser. Consequently, they should be computationally cheap.
  // Moreover, they run in a predictable pattern with plenty of time in between
  // so we can be fairly certain they won't cause the UI to freeze.
  //
  // Processing an individual heartbeat message in the general batch message
  // flow is inefficient, boxing the single message into an array and using
  // iterators to process the list unnecessarily.
  if (message.type == Constants.kCONNECTION_HEARTBEAT) {
    if (mConnectionPort)
      mConnectionPort.postMessage(message);
    return;
  }

  mReservedMessages.push(message);
  reserveToFlushMessages();
}

function reserveToFlushMessages() {
  if (mOnFrame)
    return;
  mOnFrame = () => {
    mOnFrame = null;
    if (!mConnectionPort) // disconnected: flushed again after reconnection
      return;
    const messages = mReservedMessages;
    mReservedMessages = [];
    mConnectionPort.postMessage(messages);
    if (configs.debug) {
      const types = mapAndFilterUniq(messages,
                                     message => message.type || undefined).join(', ');
      log(`${messages.length} messages sent (${types}):`, messages);
    }
  };
  // Because sidebar is always visible, we may not need to avoid using
  // window.requestAnimationFrame.
  window.requestAnimationFrame(mOnFrame);
}

async function onConnectionMessage(message) {
  mReconnectAttempts = 0; // the connection is working: forget failures
  if (Array.isArray(message)) {
    for (const oneMessage of message) {
      onConnectionMessage(oneMessage);
    }
    return;
  }

  switch (message.type) {
    case 'echo': // for testing
      mConnectionPort.postMessage(message);
      break;

    case 'external':
      TSTAPI.onMessageExternal.dispatch(message.message, message.sender);
      break;

    default:
      if (mPromisedStarted)
        await mPromisedStarted;
      onMessage.dispatch(message);
      break;
  }
}


// Mechanism to apply only most recently notified message.
// See also: https://github.com/piroor/treestyletab/issues/2568#issuecomment-657188062

const mBufferedMessages = new Map();

export function handleBufferedMessage(message, key) {
  const bufferKey = `${message.type}:${key}`;
  const hasLastMessage = mBufferedMessages.has(bufferKey);
  mBufferedMessages.set(bufferKey, message);
  return hasLastMessage;
}

export function fetchBufferedMessage(type, key) {
  const bufferKey = `${type}:${key}`;
  const message = mBufferedMessages.get(bufferKey);
  mBufferedMessages.delete(bufferKey);
  return message;
}

export function clearBufferedMessagesForKey(key) {
  for (const bufferKey of mBufferedMessages.keys()) {
    if (bufferKey.endsWith(`:${key}`))
      mBufferedMessages.delete(bufferKey);
  }
}


//===================================================================
// Logging
//===================================================================

browser.runtime.onMessage.addListener((message, _sender) => {
  if (!message ||
      typeof message != 'object' ||
      message.type != Constants.kCOMMAND_REQUEST_CONNECTION_MESSAGE_LOGS)
    return;

  browser.runtime.sendMessage({
    type:     Constants.kCOMMAND_RESPONSE_CONNECTION_MESSAGE_LOGS,
    logs:     JSON.parse(JSON.stringify(counts)),
    windowId: TabsStore.getCurrentWindowId()
  });
});
