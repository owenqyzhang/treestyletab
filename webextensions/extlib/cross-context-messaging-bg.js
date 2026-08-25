/*
 license: The MIT License, Copyright (c) 2026 YUKI 'Piro' Hiroshi
 original:
   https://github.com/piroor/webextensions-lib-cross-context-messaging
*/
'use strict';

import * as Common from './cross-context-messaging-common.js';


const CrossContextMessagingBG = (() => {
  // --- BroadcastChannel Variables ---
  const channel = new BroadcastChannel('cross-context-messaging');
  const tabIdToClientId = new Map();
  const clientIdToTabId = new Map();
  const urlHashCheckRegExp = /^#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

  // --- HashMessaging Variables ---
  const incomingBuffers = new Map();
  const tabState = new Map(); // tabId -> { queue: [], isSending: false, secret: null, initPromise: null }

  // --- Shared Variables ---
  const pendingRequests = new Map();
  const messageHandlers = [];

  // --- BroadcastChannel logic ---
  function checkUrlForClientId(tabId, urlString, windowId) {
    try {
      const url = new URL(urlString);
      const match = url.hash.match(urlHashCheckRegExp);
      if (match) {
        const clientId = match[1];
        const oldData = tabIdToClientId.get(tabId);
        if (oldData) {
          clientIdToTabId.delete(oldData.clientId);
        }
        tabIdToClientId.set(tabId, { clientId, windowId });
        clientIdToTabId.set(clientId, tabId);
      }
    } catch (e) {
    }
  }

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      checkUrlForClientId(tabId, changeInfo.url, tab.windowId);
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    const data = tabIdToClientId.get(tabId);
    if (data) {
      clientIdToTabId.delete(data.clientId);
    }
    tabIdToClientId.delete(tabId);
    tabState.delete(tabId);
  });
  browser.tabs.onAttached.addListener((tabId, attachInfo) => {
    const data = tabIdToClientId.get(tabId);
    if (data) {
      data.windowId = attachInfo.newWindowId;
    }
  });
  browser.tabs.onDetached.addListener((tabId, detachInfo) => {
    const data = tabIdToClientId.get(tabId);
    if (data && data.windowId === detachInfo.oldWindowId) {
      data.windowId = null;
    }
  });
  browser.windows.onRemoved.addListener((windowId) => {
    for (const [tabId, data] of tabIdToClientId.entries()) {
      if (data.windowId === windowId) {
        clientIdToTabId.delete(data.clientId);
        tabIdToClientId.delete(tabId);
      }
    }
  });

  channel.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'NOTIFY_CLIENT_ID' && data.clientId) {
      const tabs = await browser.tabs.query({});
      if (!tabs) return;
      for (const tab of tabs) {
        if (tab.url && !tab.url.startsWith('about:blank')) {
          try {
            const url = new URL(tab.url);
            if (url.hash === '#' + data.clientId) {
              const oldData = tabIdToClientId.get(tab.id);
              if (oldData) {
                clientIdToTabId.delete(oldData.clientId);
              }
              tabIdToClientId.set(tab.id, { clientId: data.clientId, windowId: tab.windowId });
              clientIdToTabId.set(data.clientId, tab.id);
            }
          } catch (e) {
          }
        }
      }
      return;
    }

    if (!data.senderClientId) return;

    if (data.type === 'REQ') {
      const tabId = clientIdToTabId.get(data.senderClientId);
      dispatchRequestBroadcastChannel(tabId, data.senderClientId, data.id, data.message);
    } else if (data.type === 'RES') {
      const resolver = pendingRequests.get(data.id);
      if (resolver) {
        resolver(data.message);
        pendingRequests.delete(data.id);
      }
    }
  });

  async function dispatchRequestBroadcastChannel(tabId, senderClientId, id, message) {
    let responded = false;

    function sendResponse(response) {
      if (responded) return;
      responded = true;
      channel.postMessage({
        targetClientId: senderClientId,
        id: id,
        type: 'RES',
        message: response
      });
    }

    const processMessage = async (tab) => {
      const sender = { tab };
      for (const handler of messageHandlers) {
        const response = handler(message, sender);
        if (response !== undefined) {
          sendResponse(await response);
        }
      }
    };

    if (tabId !== undefined) {
      try {
        const tab = await browser.tabs.get(tabId);
        await processMessage(tab);
      } catch (e) {
        await processMessage(undefined);
      }
    } else {
      await processMessage(undefined);
    }
  }

  // --- HashMessaging logic ---
  function ensureTabState(tabId) {
    if (!tabState.has(tabId)) {
      tabState.set(tabId, { queue: [], isSending: false, secret: null, initPromise: null });
    }
    return tabState.get(tabId);
  }

  function generateId() {
    return crypto.randomUUID();
  }

  function initHash(tabId, force) {
    const state = ensureTabState(tabId);
    if (state.secret && state.initPromise && !force) {
      return state.initPromise;
    }
    state.secret = generateId();
    state.initPromise = new Promise(resolve => {
      function onUpdated(updatedTabId, info, tab) {
        if (updatedTabId !== tabId || !info.url || tab.url.startsWith('about:blank')) return;
        const url = new URL(info.url);
        const h = url.hash.slice(1);
        if (h === `ACK-INIT:${state.secret}`) {
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.get(tabId).then(tab => {
        if (!tab.url || tab.url.startsWith('about:blank')) return;
        const url = new URL(tab.url);
        updateTabHash(tabId, url.origin + url.pathname + url.search, `INIT:${state.secret}`);
      });
    });
    return state.initPromise;
  }

  function updateTabHash(tabId, baseUrl, payload) {
    browser.tabs.update(tabId, {
      url: baseUrl + '#' + payload
    });
  }

  async function sendChunksHash(tabId, type, id, data) {
    const base64 = await Common.compressData(data);
    const chunkSize = Common.MAX_HASH_BYTES - Common.OVERHEAD;
    const chunks = Common.chunkString(base64, chunkSize);
    const total = chunks.length;

    let index = 0;

    return new Promise(async resolve => {
      function onUpdated(updatedTabId, info, tab) {
        if (updatedTabId !== tabId || !info.url || tab.url.startsWith('about:blank')) return;

        const url = new URL(info.url);
        const h = url.hash.slice(1);

        const state = ensureTabState(tabId);
        if (h === `ACK:${state.secret}:${id}:${index - 1}`) {
          if (index < total) {
            sendNext(url.origin + url.pathname + url.search);
          } else {
            browser.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        }
      }

      function sendNext(baseUrl) {
        const state = ensureTabState(tabId);
        const payload =
          `MSG:${state.secret}:${type}:${id}:${index}/${total}:${chunks[index]}`;
        updateTabHash(tabId, baseUrl, payload);
        index++;
      }

      browser.tabs.onUpdated.addListener(onUpdated);

      const tab = await browser.tabs.get(tabId);
      if (!tab.url || tab.url.startsWith('about:blank')) {
        browser.tabs.onUpdated.removeListener(onUpdated);
        resolve();
        return;
      }
      const url = new URL(tab.url);
      const base = url.origin + url.pathname + url.search;
      sendNext(base);
    });
  }

  async function processQueueHash(tabId) {
    const state = ensureTabState(tabId);
    if (state.isSending) return;
    if (state.queue.length === 0) return;

    state.isSending = true;

    if (!state.secret) {
      await initHash(tabId);
    }

    const { message, resolve, reject } = state.queue.shift();
    const id = generateId();

    pendingRequests.set(id, result => {
      resolve(result);
      state.isSending = false;
      processQueueHash(tabId);
    });

    sendChunksHash(tabId, 'REQ', id, message);

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Timeout'));
        state.isSending = false;
        processQueueHash(tabId);
      }
    }, 30000);
  }

  function sendMessageHash(tabId, message) {
    const state = ensureTabState(tabId);
    return new Promise((resolve, reject) => {
      state.queue.push({ message, resolve, reject });
      processQueueHash(tabId);
    });
  }

  function handleIncomingHash(tabId, urlStr) {
    const url = new URL(urlStr);
    const h = url.hash.slice(1);

    if (h === 'REQ-INIT') {
      const extUrl = browser.runtime.getURL('');
      if (urlStr.startsWith(extUrl)) {
        initHash(tabId, true);
      }
      return;
    }

    if (!h.startsWith('MSG:')) return;

    const match = h.match(/^MSG:([^:]+):(REQ|RES):([^:]+):([^:]+):(.+)$/);
    if (!match) return;

    const state = ensureTabState(tabId);
    if (!state.secret || match[1] !== state.secret) return;

    const [, , type, id, seq, data] = match;
    const [indexStr, totalStr] = seq.split('/');
    const index = parseInt(indexStr, 10);
    const total = parseInt(totalStr, 10);

    if (!incomingBuffers.has(id)) {
      incomingBuffers.set(id, new Array(total));
    }

    const buffer = incomingBuffers.get(id);
    buffer[index] = data;

    updateTabHash(tabId, url.origin + url.pathname + url.search,
      `ACK:${state.secret}:${id}:${index}`);

    if (buffer.filter(v => v !== undefined).length === total) {
      const full = buffer.join('');
      incomingBuffers.delete(id);

      Common.decompressData(full).then(message => {
        if (type === 'REQ') {
          dispatchRequestHash(tabId, id, message);
        } else if (type === 'RES') {
          const resolver = pendingRequests.get(id);
          if (resolver) {
            resolver(message);
            pendingRequests.delete(id);
          }
        }
      }).catch(err => {
        console.error('Failed to decompress hash message:', err);
      });
    }
  }

  async function dispatchRequestHash(tabId, id, message) {
    let responded = false;

    function sendResponse(response) {
      if (responded) return;
      responded = true;
      sendChunksHash(tabId, 'RES', id, response);
    }

    const tab = await browser.tabs.get(tabId);
    for (const handler of messageHandlers) {
      const response = handler(message, { tab });
      if (response !== undefined) {
        sendResponse(await response);
      }
    }
  }

  browser.tabs.onUpdated.addListener(async (tabId, info) => {
    const tab = await browser.tabs.get(tabId);
    if (!info.url || tab.url.startsWith('about:blank')) return;
    handleIncomingHash(tabId, info.url);
  });

  // --- Combined Entry Points ---

  async function sendMessageBroadcastChannel(tabId, message) {
    let clientData = tabIdToClientId.get(tabId);
    let clientId = clientData ? clientData.clientId : undefined;

    if (!clientId) {
      channel.postMessage({ type: 'REQ_CLIENT_ID' });

      let attempts = 0;
      while (!tabIdToClientId.has(tabId) && attempts < 20) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }

      clientData = tabIdToClientId.get(tabId);
      clientId = clientData ? clientData.clientId : undefined;
      if (!clientId) {
        throw new Error(`Failed to send message: there is no client for the tab ${tabId}`);
      }
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingRequests.set(id, resolve);
      channel.postMessage({
        targetClientId: clientId,
        id,
        type: 'REQ',
        message
      });

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Timeout'));
        }
      }, 30000);
    });
  }

  async function getBackendForTab(tab) {
    if (tab.incognito ||
      (tab.cookieStoreId &&
        tab.cookieStoreId !== 'firefox-default')) {
      return 'hash';
    }
    return 'broadcast';
  }

  async function prepareTabUrlAndGetBackend(tabId) {
    const tab = await browser.tabs.get(tabId);
    const backend = await getBackendForTab(tab);

    if (tab.url && !tab.url.startsWith('about:blank')) {
      const url = new URL(tab.url);
      const searchParams = new URLSearchParams(url.search);
      let needsUpdate = false;

      if (backend === 'hash') {
        if (searchParams.get('cross-context-messaging-backend') !== 'hash') {
          searchParams.set('cross-context-messaging-backend', 'hash');
          needsUpdate = true;
        }
      } else {
        if (searchParams.has('cross-context-messaging-backend')) {
          searchParams.delete('cross-context-messaging-backend');
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        const search = searchParams.toString();
        const newUrlStr = url.origin + url.pathname + (search ? '?' + search : '') + url.hash;
        await browser.tabs.update(tabId, { url: newUrlStr });

        await new Promise(resolve => {
          function onUpdated(updatedTabId, info) {
            if (updatedTabId === tabId && info.status === 'complete') {
              browser.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          }
          browser.tabs.onUpdated.addListener(onUpdated);
        });
      }
    }
    return backend;
  }

  async function sendMessage(tabId, message) {
    const backend = await prepareTabUrlAndGetBackend(tabId);
    if (backend === 'hash') {
      return sendMessageHash(tabId, message);
    } else {
      return sendMessageBroadcastChannel(tabId, message);
    }
  }

  function onMessage(handler) {
    messageHandlers.push(handler);
  }

  function init(tabId, force) {
    return initHash(tabId, force);
  }

  return { sendMessage, onMessage, init };
})();

export default CrossContextMessagingBG;
