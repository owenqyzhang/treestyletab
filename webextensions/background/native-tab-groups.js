/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  wait,
  configs,
  shouldApplyAnimation,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';

import { Tab, TabGroup, TreeItem } from '/common/TreeItem.js';

import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/native-tab-groups', ...args);
}

export const internallyMovingNativeTabGroups = new Map();

// Chrome reports group changes right away. The timeout only keeps a change
// that never comes (a failed API call, or a tab TST believed to be in another
// group) from blocking a drag & drop, and the sidebar with it, forever.
const GROUP_CHANGE_TIMEOUT = 3000;

function recordGroupFailure(detail) {
  log(detail);
  globalThis.__treestyletabBreadcrumb?.('groups', detail); // eslint-disable-line no-underscore-dangle
}

export async function addTabsToGroup(tabs, groupIdOrProperties) {
  const initialGroupId = typeof groupIdOrProperties == 'number' ? groupIdOrProperties : null;
  const groupId = await addTabsToGroupInternal(tabs, groupIdOrProperties);
  const created = groupId != initialGroupId;
  return { groupId, created };
}
async function addTabsToGroupInternal(tabs, groupIdOrProperties) {
  let groupId = typeof groupIdOrProperties == 'number' ? groupIdOrProperties : null;
  //tabs = SplitView.populateTabs(tabs);
  const tabsToGrouped = tabs.filter(tab => tab.groupId != groupId);
  if (tabsToGrouped.length == 0) {
    return groupId;
  }

  log('addTabsToGroupInternal ', tabsToGrouped, groupId, groupIdOrProperties);

  const pinnedTabs = tabsToGrouped.filter(tab => tab.pinned);
  if (pinnedTabs.length > 0) {
    await Promise.all(
      pinnedTabs.map(
        tab => browser.tabs.update(tab.id, { pinned: false })
          .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError))
      )
    );
  }

  const windowId = tabsToGrouped[0].windowId;
  const structure = TreeBehavior.getTreeStructureFromTabs(tabsToGrouped);

  await Tree.detachTabsFromTree(tabsToGrouped, {
    fromParent: true,
    partial:    true,
  });

  const { promisedGrouped, finish } = waitUntilGrouped(tabsToGrouped, {
    groupId,
    windowId,
  });
  log('addTabsToGroupInternal: group tabs!');
  try {
    await browser.tabs.group({
      tabIds: tabsToGrouped.map(tab => tab.id),
      // "groupId: null" must not be sent: Chrome rejects null for the optional integer.
      ...(groupId ? { groupId } : {
        createProperties: {
          windowId, // We must specify the window ID explicitly, otherwise tabs moved across windows may be reverted and grouped in the old window!
        },
      })
    });
  }
  catch(error) {
    finish();
    recordGroupFailure(`failed to group tabs ${tabsToGrouped.map(tab => tab.id)} into ${groupId}: ${error}`);
    throw error;
  }
  let group = await promisedGrouped;
  if (!group) { // the change was not reported in time: ask Chrome
    const actualGroupId = (await browser.tabs.get(tabsToGrouped[0].id).catch(_error => null))?.groupId;
    group = actualGroupId > -1 && TabGroup.get(actualGroupId);
    if (!group)
      throw new Error(`addTabsToGroupInternal: tabs ${tabsToGrouped.map(tab => tab.id)} were not grouped`);
  }
  groupId = group.id;
  log('addTabsToGroupInternal: => ', group);

  for (const tab of tabsToGrouped) {
    TabsStore.addNativelyGroupedTab(tab, group.windowId);
  }

  if (groupIdOrProperties &&
      typeof groupIdOrProperties == 'object') {
    log('addTabsToGroupInternal: applying group properties');
    const updateProperties = {};
    if ('title' in groupIdOrProperties) {
      updateProperties.title = groupIdOrProperties.title;
    }
    if ('color' in groupIdOrProperties) {
      updateProperties.color = groupIdOrProperties.color;
    }
    if ('collapsed' in groupIdOrProperties) {
      updateProperties.collapsed = groupIdOrProperties.collapsed;
    }
    await browser.tabGroups.update(groupId, updateProperties);
  }

  finish();

  await rejectGroupFromTree(group);

  log('addTabsToGroupInternal: applying tree structure');
  await Tree.applyTreeStructureToTabs(tabsToGrouped, structure, {
    broadcast: true
  });

  return groupId;
}

export async function rejectGroupFromTree(group) {
  if (!group) {
    return;
  }
  group = TabGroup.get(group.id);
  if (!group?.$TST) {
    log('rejectGroupFromTree: failed to reject untracked group');
    return;
  }

  const firstMember = group.$TST.firstMember;
  const lastMember  = group.$TST.lastMember;
  const prevTab = firstMember?.$TST.previousTab;
  const nextTab = lastMember?.$TST.nextTab;
  const rootTab = prevTab?.$TST.rootTab;
  if (!prevTab ||
      !nextTab ||
      prevTab.groupId != nextTab.groupId ||
      prevTab.groupId != -1 ||
      rootTab != nextTab.$TST.rootTab) {
    log('rejectGroupFromTree: no need to reject from tree');
    return;
  }

  log('rejectGroupFromTree ', group.id);
  await Tree.detachTabsFromTree(group.$TST.members, {
    fromParent: true,
    partial:    true,
  });

  // The group is in a middle of a tree. We need to move the new group away from the tree.
  const lastDescendant = rootTab.$TST.lastDescendant;
  if (firstMember.index - rootTab.index <= lastDescendant.index - lastMember.index) { // move above the tree
    log('rejectGroupFromTree: move ', group.id, ' before ', rootTab.id);
    await moveGroupBefore(group, rootTab);
  }
  else { // move below the tree
    log('rejectGroupFromTree: move ', group.id, ' after ', lastDescendant.id);
    await moveGroupAfter(group, lastDescendant);
  }
}

function waitUntilGrouped(tabs, { groupId, windowId } = {}) {
  const toBeGroupedIds = tabs.map(tab => tab.id);
  const win = TabsStore.windows.get(windowId || tabs[0].windowId);

  for (const tab of tabs) {
    win.internallyMovingTabsForUpdatedNativeTabGroups.add(tab.id);
    win.trackInternalMoving(tab.id, -1);
  }

  let onUpdated = null;
  let onGroupCreated = null;
  const { promisedMoved, finish: finishMoved } = waitUntilMoved(tabs, win.id)
  const promisedGrouped = new Promise((resolve, _reject) => {
    if (!groupId) {
      onGroupCreated = group => {
        groupId = group.id;
        browser.tabGroups.onCreated.removeListener(onGroupCreated);
      };
      browser.tabGroups.onCreated.addListener(onGroupCreated);
    }
    const toBeGroupedIdsSet = new Set(toBeGroupedIds);
    onUpdated = (tabId, changeInfo, _tab) => {
      if (changeInfo.groupId == groupId) {
        toBeGroupedIdsSet.delete(tabId);
        win.internallyMovingTabsForUpdatedNativeTabGroups.delete(tabId);
      }
      if (toBeGroupedIdsSet.size == 0) {
        resolve(changeInfo.groupId);
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated, { properties: ['groupId'] });
  });

  // Also used when the grouping fails: everything registered above must go,
  // otherwise the next native move or group change of these tabs would be
  // taken as TST's own and ignored.
  const finish = () => {
    if (finish.done) {
      return;
    }
    browser.tabs.onUpdated.removeListener(onUpdated);
    if (onGroupCreated)
      browser.tabGroups.onCreated.removeListener(onGroupCreated);
    for (const tab of tabs) {
      win.clearInternalMoving(tab.id);
      win.internallyMovingTabsForUpdatedNativeTabGroups.delete(tab.id);
    }
    finishMoved();
    finish.done = true;
  };

  return {
    promisedGrouped: Promise.all([
      Promise.race([
        promisedGrouped,
        wait(GROUP_CHANGE_TIMEOUT).then(() => {
          if (!finish.done)
            recordGroupFailure(`timed out waiting for tabs ${toBeGroupedIds} to be grouped into ${groupId}`);
          return groupId;
        }),
      ]),
      Promise.race([
        promisedMoved,
        wait(configs.nativeTabGroupModificationDetectionTimeoutAfterTabMove),
      ]),
    ]).then(([groupId]) => {
      finish();
      return TabGroup.get(groupId);
    }),
    finish,
  };
}

export async function removeTabsFromGroup(tabs) {
  const tabsToBeUngrouped = tabs.filter(tab => tab.groupId != -1);
  if (tabsToBeUngrouped.length == 0) {
    return;
  }
  const win = TabsStore.windows.get(tabs[0].windowId);
  // Mark only the tabs which will be ungrouped: marks on the others would
  // never be cleared, and their next native move would be ignored.
  for (const tab of tabsToBeUngrouped) {
    win.internallyMovingTabsForUpdatedNativeTabGroups.add(tab.id);
    win.trackInternalMoving(tab.id, -1);
  }
  const toBeUngroupedIds = tabsToBeUngrouped.map(tab => tab.id);
  let onUpdated = null;
  let resolveUngrouped;
  const promisedUngrouped = new Promise((resolve, _reject) => {
    resolveUngrouped = resolve;
    const toBeUngroupedIdsSet = new Set(toBeUngroupedIds);
    onUpdated = (tabId, changeInfo, _tab) => {
      if (changeInfo.groupId == -1) {
        toBeUngroupedIdsSet.delete(tabId);
        win.internallyMovingTabsForUpdatedNativeTabGroups.delete(tabId);
      }
      if (toBeUngroupedIdsSet.size == 0) {
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated, { properties: ['groupId'] });
  });
  let done = false;
  await Promise.race([
    Promise.all([
      promisedUngrouped,
      // Chrome also moves a tab ungrouped in the middle of its group to the
      // nearest edge, and reports that move only after the new groupId. The
      // call completes after both: wait for it, or our next move of the tab
      // would be overwritten by this one.
      browser.tabs.ungroup(toBeUngroupedIds).catch(error => {
        recordGroupFailure(`failed to ungroup tabs ${toBeUngroupedIds}: ${error}`);
        resolveUngrouped();
      }),
    ]),
    wait(GROUP_CHANGE_TIMEOUT).then(() => {
      if (!done)
        recordGroupFailure(`timed out waiting for tabs ${toBeUngroupedIds} to be ungrouped`);
    }),
  ]);
  done = true;
  for (const tab of tabsToBeUngrouped) {
    win.clearInternalMoving(tab.id);
    win.internallyMovingTabsForUpdatedNativeTabGroups.delete(tab.id);
    TabsStore.removeNativelyGroupedTab(tab, win.id);
  }
  browser.tabs.onUpdated.removeListener(onUpdated);
}

export async function matchTabsGrouped(tabs, groupIdOrCreateParams) {
  if (groupIdOrCreateParams == -1) {
    await removeTabsFromGroup(tabs);
  }
  else {
    await addTabsToGroup(tabs, groupIdOrCreateParams);
  }
}

export async function moveGroupToNewWindow({ groupId, windowId, duplicate, left, top }) {
  log('moveGroupToNewWindow: ', groupId, windowId);
  const group     = TabGroup.get(groupId);
  const members   = group.$TST.members;
  const movedTabs = await Tree.openNewWindowFromTabs(members, { duplicate, left, top });
  await addTabsToGroupInternal(movedTabs, {
    title: group.title,
    color: group.color,
  });
}

export async function moveGroupBefore(group, insertBefore) {
  log('moveGroupBefore: ', group, insertBefore);
  const beforeCount = internallyMovingNativeTabGroups.get(group.id) || 0;
  internallyMovingNativeTabGroups.set(group.id, beforeCount + 1);

  const { promisedMoved, finish } = waitUntilMoved(group, insertBefore.windowId);

  if (insertBefore.type == TreeItem.TYPE_GROUP) {
    insertBefore = insertBefore.$TST.firstMember;
  }

  const members = group.$TST.members;
  const firstMember = group.$TST.firstMember;
  const delta = insertBefore.windowId == group.windowId && insertBefore.index > firstMember.index ? members.length : 0;
  const index = insertBefore.index - delta;
  log('moveGroupBefore: move to ', index, { delta, insertBeforeIndex: insertBefore.index });
  await browser.tabGroups.move(group.id, {
    index,
    windowId: insertBefore.windowId,
  });

  await Promise.race([
    promisedMoved,
    wait(configs.nativeTabGroupModificationDetectionTimeoutAfterTabMove).then(() => {
      if (finish.done) {
        return;
      }
    }),
  ]);
  finish();

  const afterCount = internallyMovingNativeTabGroups.get(group.id) || 0;
  if (afterCount <= 1) {
    internallyMovingNativeTabGroups.delete(group.id);
  }
  else {
    internallyMovingNativeTabGroups.set(group.id, afterCount - 1);
  }
  log('moveGroupBefore: finish');
}

export async function moveGroupAfter(group, insertAfter) {
  log('moveGroupAfter: ', group, insertAfter);
  const beforeCount = internallyMovingNativeTabGroups.get(group.id) || 0;
  internallyMovingNativeTabGroups.set(group.id, beforeCount + 1);

  const { promisedMoved, finish } = waitUntilMoved(group, insertAfter.windowId);

  if (insertAfter.type == TreeItem.TYPE_GROUP) {
    if (insertAfter.collapsed) {
      insertAfter = insertAfter.$TST.lastMember;
    }
    else {
      return moveGroupBefore(group, insertAfter.$TST.firstMember);
    }
  }

  const members = group.$TST.members;
  const firstMember = group.$TST.firstMember;
  const delta = insertAfter.windowId == group.windowId && insertAfter.index > firstMember.index ? members.length : 0;
  const index = insertAfter.index + 1 - delta;
  log('moveGroupAfter: move to ', index, { delta, insertAfterIndex: insertAfter.index });
  await browser.tabGroups.move(group.id, {
    index,
    windowId: insertAfter.windowId,
  });

  await Promise.race([
    promisedMoved,
    wait(configs.nativeTabGroupModificationDetectionTimeoutAfterTabMove).then(() => {
      if (finish.done) {
        return;
      }
    }),
  ]);
  finish();

  const afterCount = internallyMovingNativeTabGroups.get(group.id) || 0;
  if (afterCount <= 1) {
    internallyMovingNativeTabGroups.delete(group.id);
  }
  else {
    internallyMovingNativeTabGroups.set(group.id, afterCount - 1);
  }
  log('moveGroupAfter: finish');
}

export function waitUntilMoved(groupOrMembers, destinationWindowId) {
  const members = Array.isArray(groupOrMembers) ?
    groupOrMembers :
    groupOrMembers.$TST.members;
  const win = TabsStore.windows.get(destinationWindowId || members[0].windowId);
  const toBeMovedTabs = new Set();
  for (const tab of members) {
    toBeMovedTabs.add(tab.id);
    win.trackInternalMoving(tab.id, -1);
  }
  let onTabMoved;
  const promisedMoved = new Promise((resolve, _reject) => {
    onTabMoved = (tabId, _moveInfo) => {
      if (toBeMovedTabs.has(tabId)) {
        toBeMovedTabs.delete(tabId);
      }
      if (toBeMovedTabs.size == 0) {
        log('waitUntilMoved: all members have been moved');
        resolve();
      }
    };
    browser.tabs.onMoved.addListener(onTabMoved);
  });
  const finish = () => {
    if (finish.done) {
      return;
    }
    browser.tabs.onMoved.removeListener(onTabMoved);
    for (const tab of members) {
      win.clearInternalMoving(tab.id);
    }
    finish.done = true;
  };
  return {
    promisedMoved: promisedMoved.then(finish),
    finish,
  };
}


function reserveToMaintainTreeForGroup(groupId, options = {}) {
  let timer = reserveToMaintainTreeForGroup.delayed.get(groupId);
  if (timer)
    clearTimeout(timer);
  if (options.justNow || !shouldApplyAnimation()) {
    const group = TabGroup.get(groupId);
    rejectGroupFromTree(group);
  }
  timer = setTimeout(() => {
    reserveToMaintainTreeForGroup.delayed.delete(groupId);
    const group = TabGroup.get(groupId);
    rejectGroupFromTree(group);
  }, configs.nativeTabGroupModificationDetectionTimeoutAfterTabMove);
  reserveToMaintainTreeForGroup.delayed.set(groupId, timer);
}
reserveToMaintainTreeForGroup.delayed = new Map();

export async function startToMaintainTree() {
  // fixup mismatched tree structure and tab groups constructed while TST is disabled
  const groups = await browser.tabGroups.query({});
  for (const group of groups) {
    await rejectGroupFromTree(TabGroup.get(group.id));
  }

  // after all we start tracking of dynamic changes of tab groups

  browser.tabGroups.onMoved.addListener(group => {
    group = TabGroup.get(group.id);
    if (!group) {
      return;
    }
    log('detected tab group move: ', group);
    const internalMoveCount = internallyMovingNativeTabGroups.get(group.id);
    if (internalMoveCount) {
      log(' => ignore internal move ', internalMoveCount);
      return;
    }
    reserveToMaintainTreeForGroup(group.id);
  });

  Tab.onNativeGroupModified.addListener(tab => {
    const win = TabsStore.windows.get(tab.windowId);
    if (win.internallyMovingTabsForUpdatedNativeTabGroups.has(tab.id)) {
      return;
    }
    reserveToMaintainTreeForGroup(tab.groupId);
  });
}

Tree.onSubtreeCollapsedStateChanged.addListener((tab, { collapsed }) => {
  if (collapsed ||
      !tab.groupId ||
      tab.groupId == -1 ||
      !configs.expandNativeTabGroupByMemberTreeExpansion)
    return;

  browser.tabGroups.update(tab.groupId, { collapsed: false });
});
