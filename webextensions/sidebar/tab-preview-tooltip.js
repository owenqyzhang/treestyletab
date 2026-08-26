/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs,
  log as internalLogger,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as ContextualIdentities from '/common/contextual-identities.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab, TreeItem } from '/common/TreeItem.js';

import InContentPanelController from '/resources/module/InContentPanelController.js';
import TabPreviewPanel from '/resources/module/TabPreviewPanel.js'; // the IMPL

import * as EventUtils from './event-utils.js';
import * as Sidebar from './sidebar.js';

import { kEVENT_TREE_ITEM_SUBSTANCE_ENTER, kEVENT_TREE_ITEM_SUBSTANCE_LEAVE } from './components/TreeItemSubstanceElement.js';

const CAPTURABLE_URLS_MATCHER         = /^(https?|data):/;
const PREVIEW_WITH_HOST_URLS_MATCHER  = /^(https?|moz-extension|chrome-extension):/;
const PREVIEW_WITH_TITLE_URLS_MATCHER = /^file:/;

// On Chrome the in-content panel is unavailable (it requires
// tabs.executeScript() with a code string, forbidden on MV3), and there is
// no API to capture a non-active tab: the compat shim's captureTab falls
// back to captureVisibleTab which always returns the active tab's contents.
const IS_CHROME = typeof chrome != 'undefined' && !!chrome.sidePanel;

document.addEventListener(kEVENT_TREE_ITEM_SUBSTANCE_ENTER, onTabSubstanceEnter);
document.addEventListener(kEVENT_TREE_ITEM_SUBSTANCE_LEAVE, onTabSubstanceLeave);

function log(...args) {
  internalLogger('sidebar/tab-preview-tooltip', ...args);
}

const hoveringItemIds = new Set();
let mLastHoverItemId = -1;
// tab id whose collapsed-tree (extended) card is currently shown
let mShownExtendedForTabId = null;
// a row entered while an extended card is open: the show is dwell-gated
// so a quick transit toward the card does not replace/close it
let mDeferredEnter = null;
let mDelayedHideOnTabSubstanceLeaveTimer = 0;

// Temporary diagnostics for the hover card lifecycle: a ring buffer of
// events mirrored to storage.local, readable from any extension page via
// browser.storage.local.get('tst-hover-debug'). Remove once stable.
const HOVER_DEBUG_BUILD = 'hover-debug 2026-08-26a';
const mHoverDebugLog = [];
let mHoverDebugFlushTimer = null;
function hoverDebug(...args) {
  mHoverDebugLog.push(`${String(Date.now() % 1000000).padStart(6, '0')} ${args.join(' ')}`);
  if (mHoverDebugLog.length > 100)
    mHoverDebugLog.shift();
  if (mHoverDebugFlushTimer)
    return;
  mHoverDebugFlushTimer = setTimeout(() => {
    mHoverDebugFlushTimer = null;
    browser.storage.local.set({
      'tst-hover-debug': {
        build: HOVER_DEBUG_BUILD,
        at:    Date.now(),
        log:   [...mHoverDebugLog],
      },
    }).catch(_error => {});
  }, 500);
}
hoverDebug('sidebar-loaded');

const mTabPreviewPanel = new TabPreviewPanel(document.querySelector('#tabPreviewRoot'));
const mController = new InContentPanelController({
  type:   TabPreviewPanel.TYPE,
  logger: log,
  shouldLog() {
    return configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug;
  },
  canRenderInSidebar() {
    return IS_CHROME || !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  canRenderInContent() {
    return !IS_CHROME && !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT);
  },
  shouldFallbackToSidebar() {
    return IS_CHROME || !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  canSendPossibleExpiredMessage(message) {
    return (
      message.type != `treestyletab:${TabPreviewPanel.TYPE}:show` ||
      hoveringItemIds.has(message.targetId)
    );
  },
  UIClass:         TabPreviewPanel,
  inSidebarUI:     mTabPreviewPanel,
  initializerCode: `
    const root = document.createElement('div');
    appendClosedContents(root);
    const tabPreviewPanel = new TabPreviewPanel(root);

    let destroy;

    const onMouseMove = event => {
      // event.originalTarget is Firefox-only: on other browsers events from
      // inside the closed shadow root are retargeted to the container host.
      const onPanel = !!(event.originalTarget?.closest?.('.in-content-panel.extended') ||
                         (window.closedContainerType && event.target?.localName == window.closedContainerType));
      if (logging) {
        console.log('mouse move on the content area: ', { onPanel });
      }
      if (onPanel) {
        browser.runtime.sendMessage({
          type: 'treestyletab:${TabPreviewPanel.TYPE}:keep',
          timestamp: Date.now(),
        });
        return;
      }
      if (logging) {
        console.log('=> destroy tab preview container');
      }
      document.documentElement.removeEventListener('mousemove', onMouseMove);
      browser.runtime.sendMessage({
        type: 'treestyletab:${TabPreviewPanel.TYPE}:hide',
        timestamp: Date.now(),
      });
      destroyClosedContents(destroy);
    };
    document.documentElement.addEventListener('mousemove', onMouseMove);

    destroy = createClosedContentsDestructor(tabPreviewPanel, () => {
      window.removeEventListener('mousemove', onMouseMove);
    });

    return tabPreviewPanel;
  `,
});

// chrome.processes is available only on the Dev channel of Chrome with the
// "processes" permission, thus we use it fully optionally: when the API is
// unavailable or any call fails, the memory usage row is simply omitted.
function getTabMemoryUsageMB(tabId) {
  if (typeof chrome == 'undefined' ||
      !chrome.processes?.getProcessIdForTab)
    return Promise.resolve(null);

  return new Promise((resolve, _reject) => {
    try {
      chrome.processes.getProcessIdForTab(tabId, processId => {
        if (chrome.runtime.lastError ||
            typeof processId != 'number') {
          return resolve(null);
        }
        try {
          chrome.processes.getProcessInfo(processId, true, processes => {
            if (chrome.runtime.lastError) {
              return resolve(null);
            }
            const privateMemory = processes?.[processId]?.privateMemory;
            resolve(typeof privateMemory == 'number' && privateMemory > 0 ?
              Math.round(privateMemory / (1024 * 1024)) :
              null);
          });
        }
        catch(_error) {
          resolve(null);
        }
      });
    }
    catch(_error) {
      resolve(null);
    }
  });
}

async function onTabSubstanceEnter(event) {
  const timestamp = Date.now();

  // Universal dwell gate: never show (or replace) a card for a row the
  // pointer merely transits. Without it, a fast sweep queues a card per
  // crossed row (visible as a cascade of delayed cards), and traveling
  // across neighboring rows into an open collapsed-tree card replaces
  // or closes the card before it can be reached.
  if (!event.__tstDwellReplay) {
    const gateRaw = event.target?.raw;
    if (gateRaw) {
      const replacesExtendedCard = (
        mShownExtendedForTabId !== null &&
        mShownExtendedForTabId != gateRaw.id
      );
      const dwellMsec = replacesExtendedCard ? 800 : 100;
      if (mDeferredEnter)
        clearTimeout(mDeferredEnter.timer);
      hoveringItemIds.add(gateRaw.id);
      hoverDebug('enter-gate', gateRaw.id, 'dwell=' + dwellMsec, 'ext=' + mShownExtendedForTabId);
      mDeferredEnter = {
        tabId: gateRaw.id,
        timer: setTimeout(() => {
          mDeferredEnter = null;
          if (!hoveringItemIds.has(gateRaw.id)) {
            hoverDebug('dwell-cancelled-left', gateRaw.id);
            return; // already left: it was just a transit
          }
          // Tab row elements can be rebuilt while the dwell elapses
          // (title/favicon/state updates); a stale detached element would
          // silently produce no card, so re-resolve the live one.
          const liveSubstance = TreeItem.get(gateRaw.id)?.$TST?.element?.substanceElement;
          if (!liveSubstance?.raw) {
            hoverDebug('dwell-stale-element', gateRaw.id);
            return; // the tab is gone
          }
          // Recompute the tooltip state right now: invalidateTooltip()
          // force-resets hasCustomTooltip to false and defers recomputation
          // to the next real mouseover, and a REBUILT row element (tab
          // updates/moves) has no computed state and no pending lazy update
          // at all — either way, without this, collapsed-tree rows get
          // misclassified as plain tabs and the whole extended-card
          // handling stays inert.
          liveSubstance.updateTooltip?.();
          hoverDebug('dwell-replay', gateRaw.id, 'custom=' + liveSubstance.hasCustomTooltip);
          onTabSubstanceEnter({ target: liveSubstance, __tstDwellReplay: true });
        }, dwellMsec),
      };
    }
    return;
  }

  const canCaptureTab = Permissions.isGrantedSync(Permissions.ALL_URLS);
  // The capture permission is only needed for preview images; on Chrome the
  // hover card (title/URL/memory) works without it, like Chrome's native
  // tab hover cards.
  if (!canCaptureTab && !IS_CHROME)
    return;

  const windowId = TabsStore.getCurrentWindowId();
  const activeTab = Tab.getActiveTab(windowId) || (await browser.tabs.query({ active: true, windowId }))[0];

  if (!configs.tabPreviewTooltip ||
      !(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_ANYWHERE)) {
    mController.hideIn(activeTab.id);
    return;
  }

  const substance = event.target;
  const raw       = substance?.raw;

  if (!raw ||
      (raw.type != TreeItem.TYPE_TAB &&
       raw.type != TreeItem.TYPE_GROUP) ||
      document.documentElement.classList.contains(Constants.kTABBAR_STATE_TAB_DRAGGING)) {
    return;
  }

  const active = raw?.id == activeTab.id;
  const url = PREVIEW_WITH_HOST_URLS_MATCHER.test(raw?.url) ? new URL(raw?.url).host :
    PREVIEW_WITH_TITLE_URLS_MATCHER.test(raw?.url) ? null :
      raw?.url;
  const hasCustomTooltip = !!substance.hasCustomTooltip;

  if (raw?.type == TreeItem.TYPE_GROUP &&
      !hasCustomTooltip) {
    return;
  }

  const hasPreview = (
    !IS_CHROME && // Chrome cannot capture non-active tabs, so degrade to the title/URL-only tooltip
    raw?.type == TreeItem.TYPE_TAB &&
    !active &&
    !raw?.discarded &&
    CAPTURABLE_URLS_MATCHER.test(raw?.url) &&
    !hasCustomTooltip
  );
  const previewURL = (
    hasPreview &&
    canCaptureTab &&
    configs.tabPreviewTooltip &&
    (async () => { // We just define a getter function for now, because further operations may contain async operations and we can call this at there for more optimization.
      try {
        return await browser.tabs.captureTab(raw?.id);
      }
      catch(_error) {
      }
      return null;
    })
  ) || null;

  // Simulate the behavior of Chrome's native tab hover card: it shows
  // the memory usage of the hovered tab, except for the active one.
  const promisedMemoryUsageMB = active ? null : getTabMemoryUsageMB(raw.id);

  if (!substance.raw)
    return;

  hoverDebug('enter-show', raw.id, 'custom=' + hasCustomTooltip);
  log(`onTabSubstanceEnter(${raw.id}}) start `, { hasCustomTooltip }, timestamp);

  hoveringItemIds.add(raw.id);
  mLastHoverItemId = raw.id;

  const contextualIdentity = raw.cookieStoreId && raw.cookieStoreId != 'firefox-default' ? ContextualIdentities.get(raw.cookieStoreId) : null;

  const succeeded = await mController.show({
    anchorItem:    raw,
    targetItem:    raw,
    messageParams: {
      hasCustomTooltip,
      ...(hasCustomTooltip ?
        {
          tooltipHtml: substance.appliedTooltipHtml,
        } :
        {
          title: raw.title,
          url,
          contextualIdentity,
        }
      ),
      hasPreview,
      previewURL:           null,
      // This is required to simulate the behavior:
      // show tab preview panel with delay only when the panel is not shown yet.
      waitInitialShowUntil: timestamp + Math.max(configs.tabPreviewTooltipDelayMsec, 0),
    },
    promisedMessageParams: new Promise(async (resolve, _reject) => {
      const promisedPreviewURL = typeof previewURL == 'function' && previewURL();
      const memoryUsageMB = promisedMemoryUsageMB && await promisedMemoryUsageMB.catch(_error => null);
      if (!promisedPreviewURL &&
          typeof memoryUsageMB != 'number') {
        return resolve(null);
      }
      resolve({
        ...(promisedPreviewURL ? { previewURL: await promisedPreviewURL } : {}),
        ...(typeof memoryUsageMB == 'number' ? { memoryUsageMB } : {}),
      });
    }),
    canRenderInSidebar() {
      return !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR) &&
        !(hasCustomTooltip && configs.showCollapsedDescendantsByLegacyTooltipOnSidebar);
    },
    shouldFallbackToSidebar() {
      return !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR) &&
        !(hasCustomTooltip && configs.showCollapsedDescendantsByLegacyTooltipOnSidebar);
    },
  });

  if (!substance.raw) // the tab may be destroyed while capturing tab preview
    return;

  hoverDebug('show-result', raw.id, 'ok=' + succeeded, 'custom=' + hasCustomTooltip);
  if (succeeded) {
    mShownExtendedForTabId = hasCustomTooltip ? raw.id : null;
    // A stale delayed hide from a previous transit must not kill the
    // card we just showed.
    if (mDelayedHideOnTabSubstanceLeaveTimer) {
      clearTimeout(mDelayedHideOnTabSubstanceLeaveTimer);
      mDelayedHideOnTabSubstanceLeaveTimer = 0;
    }
  }

  if (substance.closest('tab-item')?.parentNode &&
      succeeded) {
    substance.invalidateTooltip();
    // invalidateTooltip() leaves hasCustomTooltip force-false until the
    // next real mouseover; recompute immediately so later reads (leave
    // branch decisions, re-hovers) see the true state.
    substance.flushTooltipUpdate();
  }
}
onTabSubstanceEnter = EventUtils.wrapWithErrorHandler(onTabSubstanceEnter);


// Delayed hide for an open collapsed-tree card. At expiry the card is
// kept (and the timer re-armed) while the pointer is inside the card or
// parked on a tab row (the dwell gate will replace the card if the
// pointer stays there); it hides once the pointer settles anywhere else.
function scheduleExtendedCardHide() {
  if (mDelayedHideOnTabSubstanceLeaveTimer)
    clearTimeout(mDelayedHideOnTabSubstanceLeaveTimer);
  hoverDebug('ext-hide-armed', 'ext=' + mShownExtendedForTabId);
  mDelayedHideOnTabSubstanceLeaveTimer = setTimeout(() => {
    mDelayedHideOnTabSubstanceLeaveTimer = 0;
    if (mShownExtendedForTabId === null) {
      hoverDebug('ext-hide-skip-null');
      return; // already replaced or hidden through another path
    }
    if (document.querySelector('.in-content-panel-root.tab-preview-panel.extended .in-content-panel:hover') ||
        mDeferredEnter) {
      hoverDebug('ext-hide-rearm', 'defer=' + (mDeferredEnter?.tabId ?? 'no'));
      scheduleExtendedCardHide();
      return;
    }
    hoverDebug('ext-hide-fire');
    mLastHoverItemId = -1;
    mShownExtendedForTabId = null;
    mController.hide({ timestamp: Date.now() });
  }, configs.showCollapsedDescendantsMouseleaveMaxDelay);
}

async function onTabSubstanceLeave(event) {
  const timestamp = Date.now();
  const substance = event.target;
  const raw       = substance?.raw;
  if (!raw)
    return;

  hoveringItemIds.delete(raw.id);

  // Branch on our own record of the shown card, not on
  // substance.hasCustomTooltip: invalidateTooltip() (called after every
  // show) force-resets that flag to false, which would misroute the
  // origin row's leave into the instant-hide path and kill the card.
  if (substance?.hasCustomTooltip ||
      mShownExtendedForTabId == raw.id) {
    hoverDebug('leave-custom', raw.id);
    scheduleExtendedCardHide();
  }
  else {
    if (mDeferredEnter?.tabId == raw.id) {
      // Transit across this row never showed a card: nothing to hide.
      hoverDebug('leave-transit', raw.id, 'ext=' + mShownExtendedForTabId);
      clearTimeout(mDeferredEnter.timer);
      mDeferredEnter = null;
      if (mShownExtendedForTabId !== null)
        scheduleExtendedCardHide(); // keep the tree card while traveling
      return;
    }
    if (mShownExtendedForTabId !== null &&
        mShownExtendedForTabId != raw.id) {
      hoverDebug('leave-keep-ext', raw.id);
      scheduleExtendedCardHide(); // keep the open collapsed-tree card
      return;
    }
    hoverDebug('leave-hide-simple', raw.id);
    mShownExtendedForTabId = null;
    mController.hide({ targetItem: raw, timestamp });
  }
}
onTabSubstanceLeave = EventUtils.wrapWithErrorHandler(onTabSubstanceLeave);

Sidebar.onReady.addListener(() => {
  const windowId = TabsStore.getCurrentWindowId();
  mTabPreviewPanel.windowId = windowId;
});

function hideOnUserAction(timestamp) {
  hoverDebug('hide-user-action');
  hoveringItemIds.clear();
  mLastHoverItemId = -1;

  mShownExtendedForTabId = null;
  if (mDeferredEnter) {
    clearTimeout(mDeferredEnter.timer);
    mDeferredEnter = null;
  }
  mController.hideInSidebar({ timestamp });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  if (activeTab) {
    mController.hide({ timestamp });
  }
}

let mDelayedHideOnTabbarLeaveTimer = 0;

// Deterministic keep-alive while the pointer is inside the card:
// entering it cancels every pending delayed hide (no timer-phase luck
// involved), leaving it re-arms the delayed hide.
const mPreviewRoot = document.querySelector('#tabPreviewRoot');
mPreviewRoot.addEventListener('pointerenter', () => {
  hoverDebug('card-enter');
  if (mDelayedHideOnTabSubstanceLeaveTimer) {
    clearTimeout(mDelayedHideOnTabSubstanceLeaveTimer);
    mDelayedHideOnTabSubstanceLeaveTimer = 0;
  }
  if (mDelayedHideOnTabbarLeaveTimer) {
    clearTimeout(mDelayedHideOnTabbarLeaveTimer);
    mDelayedHideOnTabbarLeaveTimer = 0;
  }
});
mPreviewRoot.addEventListener('pointerleave', () => {
  hoverDebug('card-leave', 'ext=' + mShownExtendedForTabId);
  if (mShownExtendedForTabId !== null)
    scheduleExtendedCardHide();
});

document.querySelector('#tabbar').addEventListener('mouseleave', event => {
  const timestamp = Date.now();
  log('mouse is left from the tab bar ', timestamp);
  // The card overlays the tab bar but lives outside it in the DOM, so
  // moving the pointer into the card IS a tab bar mouseleave: never
  // treat that as leaving.
  if (event.relatedTarget && mPreviewRoot.contains(event.relatedTarget)) {
    hoverDebug('tabbar-leave-into-card');
    return;
  }
  hoverDebug('tabbar-leave');
  const item = TreeItem.get(mLastHoverItemId);
  const itemElement = item?.$TST?.element;
  // The DOM lookup can fail transiently (row elements are rebuilt on tab
  // updates); while a collapsed-tree card is shown we must always take
  // the grace branch, otherwise entering the card (= leaving the tab
  // bar) would hide it instantly.
  if (itemElement?.substanceElement?.hasCustomTooltip ||
      mShownExtendedForTabId !== null) {
    if (mDelayedHideOnTabbarLeaveTimer) {
      clearTimeout(mDelayedHideOnTabbarLeaveTimer);
    }
    mDelayedHideOnTabbarLeaveTimer = setTimeout(() => {
      mDelayedHideOnTabbarLeaveTimer = 0;
      if (!document.querySelector('.in-content-panel-root.tab-preview-panel.extended .in-content-panel:hover')) {
        hideOnUserAction(timestamp);
      }
    }, configs.showCollapsedDescendantsMouseleaveMaxDelay);
    return;
  }
  else {
    hideOnUserAction(timestamp);
  }
});

document.querySelector('#tabbar').addEventListener('dragover', () => {
  const timestamp = Date.now();
  log('mouse is dragover on the tab bar ', timestamp);
  hideOnUserAction(timestamp);
});

browser.runtime.onMessage.addListener((message, sender) => {
  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  if (!activeTab ||
      sender.tab?.id != activeTab.id) {
    return;
  }
  switch (message?.type) {
    case 'treestyletab:' + TabPreviewPanel.TYPE + ':keep':
      if (mDelayedHideOnTabSubstanceLeaveTimer) {
        clearTimeout(mDelayedHideOnTabSubstanceLeaveTimer);
        mDelayedHideOnTabSubstanceLeaveTimer = 0;
      }
      if (mDelayedHideOnTabbarLeaveTimer) {
        clearTimeout(mDelayedHideOnTabbarLeaveTimer);
        mDelayedHideOnTabbarLeaveTimer = 0;
      }
      break;
  }
});
