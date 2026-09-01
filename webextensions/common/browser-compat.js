/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Chrome compatibility layer for Tree Style Tab.
# This module MUST be the first import of every entry point (service
# worker, sidebar, options, group tab, dialogs). It installs a `browser`
# global that delegates to `chrome` while emulating or stubbing the
# Firefox-only APIs TST depends on:
#   - sessions.set/get/removeTabValue + WindowValue (see compat-sessions.js)
#   - tabs successor handling: moveInSuccession / update({successorTabId})
#   - menus -> contextMenus (unsupported contexts registered virtually)
#   - theme / contextualIdentities / browserSettings stubs
#   - sidebarAction -> sidePanel
#   - browserAction -> action
#   - search.search -> search.query
#   - Promise-returning runtime.onMessage listeners (Chrome needs
#     sendResponse + `return true`)
#   - stripping Firefox-only parameters and event filters
*/
'use strict';

// Dynamic import() is disallowed in service workers, so these are static.
// Both modules are side-effect free at import time; their init() is only
// called from the service worker below.
import * as CompatSessions from '/common/compat-sessions.js';
import * as CompatSuccessor from '/common/compat-successor.js';

export const IS_SERVICE_WORKER = typeof document == 'undefined' && typeof window == 'undefined';

const NATIVE = (() => {
  if (typeof chrome != 'undefined' && chrome?.runtime?.id)
    return chrome;
  // Firefox: nothing to do, the native `browser` is complete.
  return null;
})();

export const IS_CHROME = !!(NATIVE && !NATIVE.sidebarAction && NATIVE.sidePanel);

function inertEvent() {
  return {
    addListener() {},
    removeListener() {},
    hasListener() { return false; },
  };
}

// ===================================================================
// Event wrapper: supports listener transformation and client-side
// filtering (Chrome throws on Firefox's extra filter argument).
// ===================================================================
function wrapEvent(getEvent, { transformListener, onRemoved } = {}) {
  const wrappedListeners = new WeakMap();
  return {
    addListener(listener, ...extraArgs) {
      const event = getEvent();
      if (!event)
        return;
      let wrapped = listener;
      if (transformListener)
        wrapped = transformListener(listener, ...extraArgs) || listener;
      wrappedListeners.set(listener, wrapped);
      event.addListener(wrapped);
    },
    removeListener(listener) {
      const event = getEvent();
      if (!event)
        return;
      const wrapped = wrappedListeners.get(listener) || listener;
      event.removeListener(wrapped);
      if (onRemoved)
        onRemoved(wrapped);
      wrappedListeners.delete(listener);
    },
    hasListener(listener) {
      const event = getEvent();
      if (!event)
        return false;
      const wrapped = wrappedListeners.get(listener) || listener;
      return event.hasListener(wrapped);
    },
  };
}

// Firefox allows onMessage listeners to return a Promise as the reply.
// Chrome requires sendResponse() + returning `true`. This transform
// bridges the difference (same behavior as Mozilla's webextension-polyfill).
function promiseReturningListener(listener) {
  return (message, sender, sendResponse) => {
    let result;
    try {
      result = listener(message, sender, sendResponse);
    }
    catch(error) {
      console.error('browser-compat: error in onMessage listener', error);
      return false;
    }
    if (result && typeof result.then == 'function') {
      result.then(
        response => {
          try { sendResponse(response); } catch(_error) { /* channel already closed */ }
        },
        error => {
          console.error('browser-compat: async onMessage listener failed', error);
          try { sendResponse(undefined); } catch(_error) { /* channel already closed */ }
        }
      );
      return true;
    }
    return result === true; // the listener may respond via sendResponse itself
  };
}

// Firefox's tabs.onUpdated accepts an extra filter argument.
function filteredTabsOnUpdatedListener(listener, filter) {
  if (!filter)
    return listener;
  const properties = filter.properties && new Set(filter.properties);
  return (tabId, changeInfo, tab) => {
    if (filter.tabId !== undefined && tabId != filter.tabId)
      return;
    if (filter.windowId !== undefined && tab?.windowId != filter.windowId)
      return;
    if (properties) {
      // Chrome reports favIconUrl/title/etc. the same way; groupId maps 1:1.
      const changed = Object.keys(changeInfo);
      if (!changed.some(property => properties.has(property)))
        return;
    }
    listener(tabId, changeInfo, tab);
  };
}

// ===================================================================
// Firefox-only parameter stripping
// ===================================================================
const TAB_CREATE_UNSUPPORTED = new Set([
  'cookieStoreId',
  'discarded',
  'hidden',
  'muted',
  'openInReaderMode',
  'successorTabId',
  'title',
]);
const TAB_UPDATE_UNSUPPORTED = new Set([
  'hidden',
  'loadReplace',
  'successorTabId',
]);
const TAB_QUERY_UNSUPPORTED = new Set([
  'attention',
  'camera',
  'cookieStoreId',
  'hidden',
  'isArticle',
  'microphone',
  'openerTabId',
  'screen',
]);
const WINDOW_CREATE_UNSUPPORTED = new Set([
  'allowScriptsToClose',
  'cookieStoreId',
  'titlePreface',
]);

function stripUnsupported(params, unsupportedKeys) {
  if (!params || typeof params != 'object')
    return { cleaned: params, removed: null };
  let removed = null;
  let cleaned = params;
  for (const key of Object.keys(params)) {
    if (!unsupportedKeys.has(key))
      continue;
    if (cleaned === params)
      cleaned = { ...params };
    removed = removed || {};
    removed[key] = cleaned[key];
    delete cleaned[key];
  }
  return { cleaned, removed };
}

const DEFAULT_COOKIE_STORE_ID = 'firefox-default';
const PRIVATE_COOKIE_STORE_ID = 'firefox-private';

export function normalizeTab(tab) {
  if (!tab || typeof tab != 'object')
    return tab;
  if (!('cookieStoreId' in tab))
    tab.cookieStoreId = tab.incognito ? PRIVATE_COOKIE_STORE_ID : DEFAULT_COOKIE_STORE_ID;
  if (!('hidden' in tab))
    tab.hidden = false;
  if (!('attention' in tab))
    tab.attention = false;
  if (!('sharingState' in tab))
    tab.sharingState = { camera: false, microphone: false, screen: null };
  if (!('successorTabId' in tab)) {
    const getSuccessor = globalThis.__treestyletabCompatGetSuccessor;
    tab.successorTabId = getSuccessor ? getSuccessor(tab.id) : -1;
  }
  // Chrome may only know the destination URL as pendingUrl while loading.
  if (!tab.url && tab.pendingUrl)
    tab.url = tab.pendingUrl;
  return tab;
}

function normalizeTabs(tabs) {
  if (Array.isArray(tabs))
    tabs.forEach(normalizeTab);
  else
    normalizeTab(tabs);
  return tabs;
}

// ===================================================================
// Namespace facade helper
// ===================================================================
function facade(getSource, overrides = {}) {
  const boundCache = new Map();
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target)
        return target[prop];
      const source = getSource();
      if (!source)
        return undefined;
      const value = source[prop];
      if (typeof value == 'function') {
        let bound = boundCache.get(prop);
        if (!bound) {
          bound = value.bind(source);
          boundCache.set(prop, bound);
        }
        return bound;
      }
      return value;
    },
    has(target, prop) {
      if (prop in target)
        return true;
      const source = getSource();
      return !!source && prop in source;
    },
  });
}

// ===================================================================
// Build the compat `browser`
// ===================================================================
function buildCompatBrowser(chrome) {
  const compat = {};

  // ----- runtime -----------------------------------------------------
  compat.runtime = facade(() => chrome.runtime, {
    getBrowserInfo: async () => {
      const match = navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/);
      return {
        name:    'Chrome',
        vendor:  'Google',
        version: match ? match[1] : '0',
        buildID: '',
      };
    },
    onMessage: wrapEvent(() => chrome.runtime.onMessage, {
      transformListener: promiseReturningListener,
    }),
    onMessageExternal: wrapEvent(() => chrome.runtime.onMessageExternal, {
      transformListener: promiseReturningListener,
    }),
  });

  // ----- tabs --------------------------------------------------------
  // Synthesize Firefox's activeInfo.previousTabId (Chrome omits it).
  // The recorder listener below is registered before any TST listener
  // (the compat layer is always the first import), so by the time user
  // listeners run, mPreviousActiveTabs holds the correct previous tab.
  const mCurrentActiveTabs  = new Map(); // windowId => tabId
  const mPreviousActiveTabs = new Map(); // windowId => tabId
  chrome.tabs.onActivated.addListener(activeInfo => {
    mPreviousActiveTabs.set(activeInfo.windowId, mCurrentActiveTabs.get(activeInfo.windowId));
    mCurrentActiveTabs.set(activeInfo.windowId, activeInfo.tabId);
  });
  chrome.tabs.query({ active: true }).then(tabs => {
    for (const tab of tabs) {
      if (!mCurrentActiveTabs.has(tab.windowId))
        mCurrentActiveTabs.set(tab.windowId, tab.id);
    }
  }).catch(_error => {});

  // Registry of raw onUpdated listeners so the successor emulation can
  // dispatch synthetic onUpdated({successorTabId}) events, which TST's
  // successor machinery waits for.
  const mOnUpdatedRawListeners = new Set();
  globalThis.__treestyletabCompatDispatchTabUpdated = (tabId, changeInfo, tab) => {
    for (const listener of mOnUpdatedRawListeners) {
      try {
        listener(tabId, changeInfo, tab);
      }
      catch(error) {
        console.error('browser-compat: synthetic onUpdated listener failed', error);
      }
    }
  };

  compat.tabs = facade(() => chrome.tabs, {
    async create(params) {
      const { cleaned, removed } = stripUnsupported(params, TAB_CREATE_UNSUPPORTED);
      const tab = normalizeTab(await chrome.tabs.create(cleaned));
      if (removed?.discarded && tab?.id) {
        // Best effort: Chrome cannot create a tab as discarded, discard it
        // right after creation instead.
        setTimeout(() => {
          chrome.tabs.discard(tab.id).catch(_error => {});
        }, 150);
      }
      if (removed?.muted && tab?.id)
        chrome.tabs.update(tab.id, { muted: true }).catch(_error => {});
      return tab;
    },
    async update(tabId, params) {
      if (typeof tabId == 'object' && !params) {
        params = tabId;
        tabId  = undefined;
      }
      const { cleaned, removed } = stripUnsupported(params, TAB_UPDATE_UNSUPPORTED);
      if (removed && 'successorTabId' in removed && IS_SERVICE_WORKER)
        CompatSuccessor.setSuccessor(tabId, removed.successorTabId);
      if (Object.keys(cleaned).length == 0)
        return normalizeTab(await chrome.tabs.get(tabId));
      const tab = tabId === undefined ?
        await chrome.tabs.update(cleaned) :
        await chrome.tabs.update(tabId, cleaned);
      return normalizeTab(tab);
    },
    async query(params) {
      const { cleaned } = stripUnsupported(params, TAB_QUERY_UNSUPPORTED);
      return normalizeTabs(await chrome.tabs.query(cleaned));
    },
    async get(tabId) {
      return normalizeTab(await chrome.tabs.get(tabId));
    },
    async getCurrent() {
      return normalizeTab(await chrome.tabs.getCurrent());
    },
    async duplicate(tabId, params) {
      const tab = normalizeTab(await (params === undefined ?
        chrome.tabs.duplicate(tabId) :
        chrome.tabs.duplicate(tabId, params)));
      if (IS_SERVICE_WORKER && tab?.id)
        await CompatSessions.copyTabValues(tabId, tab.id);
      return tab;
    },
    // Firefox-only APIs
    async hide(_tabIds) { return []; },
    async show(_tabIds) { return []; },
    async warmup(_tabIds) {},
    async toggleReaderMode(_tabId) {},
    async moveInSuccession(tabIds, tabId, options = {}) {
      if (!IS_SERVICE_WORKER)
        return;
      CompatSuccessor.moveInSuccession(tabIds, tabId, options);
    },
    async captureTab(tabId, options = {}) {
      // Chrome can only capture the visible tab of a window.
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active)
        throw new Error('browser-compat: cannot capture a background tab on Chrome');
      return chrome.tabs.captureVisibleTab(tab.windowId, {
        format:  options.format || 'png',
        quality: options.quality,
      });
    },
    async highlight(highlightInfo = {}) {
      const sanitized = { ...highlightInfo };
      delete sanitized.populate; // Firefox-only, Chrome rejects unknown properties
      return chrome.tabs.highlight(sanitized);
    },
    async discard(tabIds) {
      // Firefox accepts an array of tab ids, Chrome only a single id.
      if (Array.isArray(tabIds))
        return Promise.all(tabIds.map(id => chrome.tabs.discard(id).catch(_error => null)));
      return chrome.tabs.discard(tabIds);
    },
    onCreated: wrapEvent(() => chrome.tabs.onCreated, {
      transformListener: listener => tab => listener(normalizeTab(tab)),
    }),
    onActivated: wrapEvent(() => chrome.tabs.onActivated, {
      transformListener: listener => activeInfo => listener({
        ...activeInfo,
        previousTabId: activeInfo.previousTabId ?? mPreviousActiveTabs.get(activeInfo.windowId),
      }),
    }),
    onUpdated: wrapEvent(() => chrome.tabs.onUpdated, {
      transformListener: (listener, filter) => {
        const filtered = filteredTabsOnUpdatedListener(listener, filter);
        const wrapped = (tabId, changeInfo, tab) => filtered(tabId, changeInfo, normalizeTab(tab));
        mOnUpdatedRawListeners.add(wrapped);
        return wrapped;
      },
      onRemoved: wrapped => mOnUpdatedRawListeners.delete(wrapped),
    }),
  });

  // ----- windows -----------------------------------------------------
  compat.windows = facade(() => chrome.windows, {
    async create(params) {
      const { cleaned } = stripUnsupported(params, WINDOW_CREATE_UNSUPPORTED);
      return chrome.windows.create(cleaned);
    },
  });

  // ----- sessions ----------------------------------------------------
  // set/get/removeTabValue + WindowValue are emulated; the rest
  // (getRecentlyClosed, restore, MAX_SESSION_RESULTS) pass through.
  const sessionsRPC = (method, ...args) => {
    if (IS_SERVICE_WORKER)
      return CompatSessions[method](...args); // eslint-disable-line import/namespace
    return chrome.runtime.sendMessage({
      type: 'treestyletab:compat-sessions',
      method,
      args,
    });
  };
  compat.sessions = facade(() => chrome.sessions, {
    setTabValue:       (tabId, key, value) => sessionsRPC('setTabValue', tabId, key, value),
    getTabValue:       (tabId, key) => sessionsRPC('getTabValue', tabId, key),
    removeTabValue:    (tabId, key) => sessionsRPC('removeTabValue', tabId, key),
    setWindowValue:    (windowId, key, value) => sessionsRPC('setWindowValue', windowId, key, value),
    getWindowValue:    (windowId, key) => sessionsRPC('getWindowValue', windowId, key),
    removeWindowValue: (windowId, key) => sessionsRPC('removeWindowValue', windowId, key),
  });

  // ----- menus -> contextMenus --------------------------------------
  // Chrome has no "tab"/"tools_menu"/"bookmark" contexts and no per-item
  // icons. Items usable only in unsupported contexts are registered
  // virtually (TST's own fake context menu in the sidebar renders them).
  const SUPPORTED_CONTEXTS = new Set([
    'all', 'page', 'frame', 'selection', 'link', 'editable',
    'image', 'video', 'audio', 'action', 'browser_action', 'page_action',
  ]);
  const virtualMenuItems = new Map();
  function sanitizeMenuCreateParams(params) {
    const sanitized = { ...params };
    delete sanitized.icons;
    delete sanitized.viewTypes;
    delete sanitized.command;
    if (sanitized.contexts) {
      // Firefox's "tab" context has no Chrome equivalent; register such
      // items as "page" items scoped to the sidebar document instead, so
      // they appear (nested under the extension name) in the browser's
      // native context menu on the sidebar. They only become reachable
      // when the sidebar lets the native menu through
      // (configs.useNativeContextMenu); otherwise the sidebar suppresses
      // the native menu and these registrations stay invisible.
      const hadTabContext = sanitized.contexts.includes('tab');
      const contexts = Array.from(new Set(sanitized.contexts
        .map(context =>
          context == 'browser_action' ? 'action' :
            context == 'tab' ? 'page' :
              context)))
        .filter(context => SUPPORTED_CONTEXTS.has(context));
      if (contexts.length == 0)
        return null;
      sanitized.contexts = contexts;
      if (hadTabContext && !sanitized.documentUrlPatterns)
        sanitized.documentUrlPatterns = [chrome.runtime.getURL('sidebar/') + '*'];
    }
    return sanitized;
  }
  const menusOnClickedListeners = new Set();
  // Chrome keeps registered context menu items across service worker
  // restarts, but TST re-creates all of its items on every start; wipe
  // the registry once per service worker life, and serialize all menu
  // operations behind that cleanup to keep parent-before-child ordering.
  let menusReady = null;
  function menusQueue(operation) {
    if (!menusReady)
      menusReady = IS_SERVICE_WORKER ?
        chrome.contextMenus.removeAll().catch(_error => {}) :
        Promise.resolve();
    const result = menusReady.then(operation);
    menusReady = result.catch(_error => {});
    return result;
  }
  compat.menus = {
    ACTION_MENU_TOP_LEVEL_LIMIT: 6,
    create(params, callback) {
      const sanitized = sanitizeMenuCreateParams(params);
      if (!sanitized) {
        const id = params.id || `virtual-menu-${virtualMenuItems.size}`;
        virtualMenuItems.set(id, params);
        if (callback)
          callback();
        return id;
      }
      menusQueue(() => new Promise(resolve => {
        try {
          chrome.contextMenus.create(sanitized, () => {
            void chrome.runtime.lastError; // consume
            if (callback)
              callback();
            resolve();
          });
        }
        catch(error) {
          console.error('browser-compat: menus.create failed', error, params);
          resolve();
        }
      }));
      return params.id;
    },
    async update(id, params) {
      if (virtualMenuItems.has(id)) {
        virtualMenuItems.set(id, { ...virtualMenuItems.get(id), ...params });
        return;
      }
      const sanitized = { ...params };
      delete sanitized.icons;
      delete sanitized.viewTypes;
      if (sanitized.contexts) {
        const filtered = sanitizeMenuCreateParams({ contexts: sanitized.contexts });
        if (!filtered) {
          delete sanitized.contexts;
        }
        else {
          sanitized.contexts = filtered.contexts;
        }
      }
      return menusQueue(() => chrome.contextMenus.update(id, sanitized)).catch(_error => {});
    },
    async remove(id) {
      if (virtualMenuItems.delete(id))
        return;
      return menusQueue(() => chrome.contextMenus.remove(id)).catch(_error => {});
    },
    async removeAll() {
      virtualMenuItems.clear();
      return menusQueue(() => chrome.contextMenus.removeAll());
    },
    async refresh() {},
    overrideContext(_options) {}, // Firefox-only; TST falls back to its fake menu
    onClicked: {
      addListener(listener) {
        menusOnClickedListeners.add(listener);
        chrome.contextMenus.onClicked.addListener(listener);
      },
      removeListener(listener) {
        menusOnClickedListeners.delete(listener);
        chrome.contextMenus.onClicked.removeListener(listener);
      },
      hasListener(listener) {
        return menusOnClickedListeners.has(listener);
      },
      // TST's fake context menu dispatches clicks through this hook.
      dispatch(info, tab) {
        for (const listener of menusOnClickedListeners) {
          try {
            listener(info, tab);
          }
          catch(error) {
            console.error('browser-compat: menus.onClicked listener failed', error);
          }
        }
      },
    },
    onShown:  inertEvent(),
    onHidden: inertEvent(),
  };

  // ----- theme -------------------------------------------------------
  compat.theme = {
    getCurrent: async (_windowId) => ({ colors: null, images: null, properties: null }),
    onUpdated:  inertEvent(),
  };

  // ----- contextualIdentities ---------------------------------------
  compat.contextualIdentities = {
    query:  async (_details) => [],
    get:    async (_cookieStoreId) => null,
    create: async (_details) => { throw new Error('contextualIdentities is not available on Chrome'); },
    remove: async (_cookieStoreId) => { throw new Error('contextualIdentities is not available on Chrome'); },
    update: async (_cookieStoreId, _details) => { throw new Error('contextualIdentities is not available on Chrome'); },
    onCreated: inertEvent(),
    onRemoved: inertEvent(),
    onUpdated: inertEvent(),
  };

  // ----- browserSettings ----------------------------------------------
  const inertSetting = {
    get:   async (_details) => ({ value: undefined, levelOfControl: 'not_controllable' }),
    set:   async (_details) => false,
    clear: async (_details) => false,
  };
  compat.browserSettings = new Proxy({}, {
    get: (_target, _prop) => inertSetting,
    has: () => true,
  });

  // ----- browserAction -> action --------------------------------------
  compat.browserAction = facade(() => chrome.action);
  compat.action        = facade(() => chrome.action);

  // ----- sidebarAction -> sidePanel ------------------------------------
  async function getSidePanelContexts(windowId) {
    if (!chrome.runtime.getContexts)
      return [];
    const filter = { contextTypes: ['SIDE_PANEL'] };
    if (windowId !== undefined && windowId !== null && windowId >= 0)
      filter.windowIds = [windowId];
    return chrome.runtime.getContexts(filter).catch(_error => []);
  }
  compat.sidebarAction = {
    async open(options = {}) {
      const windowId = options.windowId ?? (await chrome.windows.getLastFocused()).id;
      return chrome.sidePanel.open({ windowId });
    },
    async close(options = {}) {
      // Chrome has no sidePanel.close(); the panel page closes itself.
      chrome.runtime.sendMessage({
        type:     'treestyletab:compat-close-side-panel',
        windowId: options.windowId ?? null,
      }).catch(_error => {});
    },
    async toggle(options = {}) {
      const windowId = options.windowId ?? (await chrome.windows.getLastFocused()).id;
      const contexts = await getSidePanelContexts(windowId);
      if (contexts.length > 0)
        return compat.sidebarAction.close({ windowId });
      return compat.sidebarAction.open({ windowId });
    },
    async isOpen(options = {}) {
      const contexts = await getSidePanelContexts(options.windowId);
      return contexts.length > 0;
    },
    async setPanel(options = {}) {
      // Firefox: sidebarAction.setPanel({panel: url}); Chrome equivalent
      // is sidePanel.setOptions({path}). TST uses this to pass style
      // parameters to the sidebar page via the query string.
      let path = options.panel;
      if (!path)
        return chrome.sidePanel.setOptions({ path: 'sidebar/sidebar.html' });
      try {
        const url = new URL(path, chrome.runtime.getURL('/'));
        path = url.pathname + url.search;
      }
      catch(_error) {
      }
      return chrome.sidePanel.setOptions({ path });
    },
    async setTitle(_options) {},
    async getTitle(_options) { return ''; },
    async setIcon(_options) {},
  };

  // ----- search --------------------------------------------------------
  compat.search = {
    async get() { return []; },
    async search(params = {}) {
      const query = { text: params.query };
      if (params.tabId !== undefined && params.tabId !== null)
        query.tabId = params.tabId;
      else
        query.disposition = 'NEW_TAB';
      return chrome.search.query(query);
    },
    async query(params) {
      return chrome.search.query(params);
    },
  };

  // ----- commands -------------------------------------------------------
  compat.commands = facade(() => chrome.commands, {
    async update(_details) {}, // Chrome: only via chrome://extensions/shortcuts
    async reset(_name) {},
  });

  // ----- permissions ----------------------------------------------------
  const FIREFOX_ONLY_PERMISSIONS = new Set([
    'browserSettings',
    'contextualIdentities',
    'menus',
    'menus.overrideContext',
    'sessions',
    'tabHide',
    'theme',
  ]);
  function sanitizePermissions(permissions) {
    if (!permissions?.permissions)
      return { sanitized: permissions, hadFirefoxOnly: false };
    const filtered = permissions.permissions.filter(permission => !FIREFOX_ONLY_PERMISSIONS.has(permission));
    return {
      sanitized: { ...permissions, permissions: filtered },
      hadFirefoxOnly: filtered.length != permissions.permissions.length,
      onlyFirefox: filtered.length == 0 && (!permissions.origins || permissions.origins.length == 0),
    };
  }
  compat.permissions = facade(() => chrome.permissions, {
    async request(permissions) {
      const { sanitized, onlyFirefox } = sanitizePermissions(permissions);
      if (onlyFirefox)
        return false;
      return chrome.permissions.request(sanitized);
    },
    async contains(permissions) {
      const { sanitized, onlyFirefox } = sanitizePermissions(permissions);
      if (onlyFirefox)
        return false;
      return chrome.permissions.contains(sanitized);
    },
    async remove(permissions) {
      const { sanitized, onlyFirefox } = sanitizePermissions(permissions);
      if (onlyFirefox)
        return false;
      return chrome.permissions.remove(sanitized);
    },
  });

  // ----- bookmarks -------------------------------------------------------
  // Optional permission: preserve `browser.bookmarks` truthiness checks by
  // returning undefined when the permission is missing. Chrome rejects the
  // Firefox-only `type` property of create().
  let bookmarksFacade = null;
  Object.defineProperty(compat, 'bookmarks', {
    get: () => {
      if (!chrome.bookmarks)
        return undefined;
      if (!bookmarksFacade)
        bookmarksFacade = facade(() => chrome.bookmarks, {
          async create(details = {}) {
            const sanitized = { ...details };
            delete sanitized.type; // folders are created by omitting `url` on Chrome
            return chrome.bookmarks.create(sanitized);
          },
        });
      return bookmarksFacade;
    },
    enumerable: true,
    configurable: true,
  });

  // ----- plain passthrough namespaces -----------------------------------
  for (const name of [
    'alarms',
    'contextMenus',
    'cookies',
    'extension',
    'i18n',
    'management',
    'notifications',
    'offscreen',
    'scripting',
    'sidePanel',
    'storage',
    'tabGroups',
  ]) {
    Object.defineProperty(compat, name, {
      get: () => chrome[name],
      enumerable: true,
      configurable: true,
    });
  }

  return compat;
}

// ===================================================================
// Install
// ===================================================================
if (IS_CHROME) {
  const compatBrowser = buildCompatBrowser(NATIVE);

  // Chrome installs its own `browser` alias binding LAZILY: on a slow cold
  // start (browser reboot with a large session) that installation can land
  // AFTER this module evaluated and silently replace our facade with the
  // bare `chrome` alias, which breaks every emulated API (sessions.*Value,
  // parameter stripping, ...). Prefer a non-configurable accessor that
  // swallows any later overwrite; when that is impossible, fall back to a
  // plain property plus self-healing from our internal event listeners
  // below (they are registered before any TST listener, so a clobbered
  // global is restored before TST code can observe it).
  const ensureCompatBrowserGlobal = () => {
    if (globalThis.browser === compatBrowser)
      return;
    try {
      Object.defineProperty(globalThis, 'browser', {
        get() { return compatBrowser; },
        set(_value) { /* swallow Chrome's late alias installation */ },
        configurable: false,
      });
    }
    catch(_error) {
      try {
        globalThis.browser = compatBrowser;
      }
      catch(error) {
        console.error('browser-compat: failed to install the compat browser global', error);
      }
    }
  };
  ensureCompatBrowserGlobal();
  globalThis.__treestyletabEnsureCompatBrowser = ensureCompatBrowserGlobal;
  // Self-healing choke points: these native listeners run before all TST
  // listeners (this module is always evaluated first).
  NATIVE.tabs.onCreated.addListener(ensureCompatBrowserGlobal);
  NATIVE.tabs.onActivated.addListener(ensureCompatBrowserGlobal);
  NATIVE.tabs.onUpdated.addListener(ensureCompatBrowserGlobal);
  NATIVE.tabs.onRemoved.addListener(ensureCompatBrowserGlobal);
  NATIVE.runtime.onMessage.addListener(() => { ensureCompatBrowserGlobal(); });
  NATIVE.runtime.onConnect.addListener(ensureCompatBrowserGlobal);

  if (IS_SERVICE_WORKER) {
    // Let Chrome itself toggle the side panel on toolbar button clicks:
    // this works natively even while the service worker is asleep or
    // still initializing, and avoids the user-gesture pitfalls of
    // calling sidePanel.open() after awaited API calls.
    NATIVE.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(error => console.error('browser-compat: failed to set side panel behavior', error));

    // Initialize emulation modules early: sessions values must be
    // restored before TST polls them, and the successor/keepalive
    // machinery must be armed on every service worker start.
    CompatSessions.init();
    CompatSuccessor.init();

    // Keep the service worker alive: TST keeps all tree state in memory
    // and re-initialization is expensive, so emulate Firefox's persistent
    // background page as closely as possible.
    setInterval(() => {
      ensureCompatBrowserGlobal();
      NATIVE.runtime.getPlatformInfo().catch(_error => {});
    }, 20 * 1000);
    if (NATIVE.alarms) {
      NATIVE.alarms.create('treestyletab:compat-keepalive', { periodInMinutes: 0.5 });
      NATIVE.alarms.onAlarm.addListener(_alarm => { /* just waking up is enough */ });
    }
  }
  else {
    // Side panel pages close themselves on request (sidebarAction.close()).
    NATIVE.runtime.onMessage.addListener((message, _sender) => {
      if (message?.type != 'treestyletab:compat-close-side-panel')
        return;
      const url = new URL(window.location.href);
      if (!url.pathname.startsWith('/sidebar/'))
        return;
      NATIVE.windows.getCurrent().then(win => {
        if (message.windowId === null || message.windowId == win.id)
          window.close();
      });
    });
  }
}

export const isChrome = () => IS_CHROME;
