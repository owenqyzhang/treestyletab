/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log,
  configs,
  dumpDebugLogs,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as SidebarConnection from '/common/sidebar-connection.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';

import MetricsData from '/common/MetricsData.js';
import { Tab } from '/common/TreeItem.js';

import * as Background from './background.js';
import './handle-misc.js';
import './handle-moved-tabs.js';
import './handle-new-tabs.js';
import './handle-removed-tabs.js';
import './handle-tab-bunches.js';
import './handle-tab-focus.js';
import './handle-tab-multiselect.js';
import './handle-tree-changes.js';
import './sync-background.js';

log.context = 'BG';

MetricsData.add('index: Loaded');

// In the MV3 service worker there is no DOMContentLoaded; start directly.
if (typeof window == 'undefined')
  Background.init();
else
  window.addEventListener('DOMContentLoaded', Background.init, { once: true });

globalThis.dumpMetricsData = () => {
  return MetricsData.toString();
};
globalThis.dumpLogs = () => {
  return log.logs.join('\n');
};
globalThis.dumpDebugLogs = dumpDebugLogs;

// Compares, per window, Chrome's native tabs, the background's tree and what
// each open sidebar shows. Rows marked "!!" disagree.
// Usage: copy(await dumpTreeState())
globalThis.dumpTreeState = async () => {
  const out = [];
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ['normal'] });
  for (const win of windows) {
    const sidebar = await browser.runtime.sendMessage({
      type:     'treestyletab:debug-dump-sidebar-state',
      windowId: win.id,
    }).catch(_error => null);
    const sidebarById = new Map((sidebar?.tabs || []).map(tab => [tab.id, tab]));
    const tracked = Tab.getAllTabs(win.id);
    const trackedById = new Map(tracked.map(tab => [tab.id, tab]));
    out.push(`===== window ${win.id}: native ${win.tabs.length}, background ${tracked.length}, sidebar ${sidebar ? sidebar.tabs.length : '(closed)'} =====`);
    for (const nativeTab of win.tabs) {
      const tab = trackedById.get(nativeTab.id);
      const row = sidebarById.get(nativeTab.id);
      const problems = [];
      if (!tab)
        problems.push('not tracked');
      else if (tab.index != nativeTab.index)
        problems.push(`bg index ${tab.index}`);
      if (sidebar && !row)
        problems.push('no sidebar row');
      else if (row && tab && row.parent != (tab.$TST.parentId || null))
        problems.push(`sidebar parent ${row.parent}`);
      if (row && row.title != nativeTab.title)
        problems.push(`sidebar title "${row.title}"`);
      out.push(`${problems.length ? '!!' : '  '} ${String(nativeTab.index).padStart(3)} #${nativeTab.id} parent=${tab?.$TST.parentId || '-'}${nativeTab.pinned ? ' pinned' : ''}${nativeTab.discarded ? ' discarded' : ''} ${nativeTab.status} "${nativeTab.title}"${problems.length ? '  <- ' + problems.join('; ') : ''}`);
    }
    const nativeIds = new Set(win.tabs.map(tab => tab.id));
    for (const tab of tracked) {
      if (!nativeIds.has(tab.id))
        out.push(`!! tracked by the background but not native: #${tab.id} "${tab.title}" index ${tab.index}`);
    }
    for (const row of (sidebar?.tabs || [])) {
      if (!nativeIds.has(row.id))
        out.push(`!! shown in the sidebar but not native: #${row.id} "${row.title}" at row ${row.row}`);
    }
    if (sidebar && sidebar.order.join() != win.tabs.map(tab => tab.id).join())
      out.push(`!! sidebar row order differs from native order`);
  }
  return out.join('\n');
};

// Puts back a tree structure saved earlier (the "tree-structure" window
// value, e.g. one recovered from an older copy of the extension's storage)
// and rebuilds the tree from it. Tabs are matched by unique id; tabs that are
// not in the structure keep their own restore info.
// Usage: await restoreTreeStructure(windowId, structure)
globalThis.restoreTreeStructure = async (windowId, structure) => {
  const tabs = Tab.getAllTabs(windowId);
  const aligned = TreeBehavior.alignTreeStructure(structure, tabs.map(tab => tab.$TST.uniqueId?.id));
  if (!aligned?.tabIndices.length)
    throw new Error(aligned ? 'none of the tabs is in the structure' : 'not a structure with unique ids');
  await browser.sessions.setWindowValue(windowId, Constants.kWINDOW_STATE_TREE_STRUCTURE, structure);
  await Background.reload({ all: true, reason: 'restoreTreeStructure' });
  return `restored ${aligned.tabIndices.length}/${tabs.length} tabs; of the structure, ${aligned.droppedIds.length - aligned.movedIds.length} tabs are gone and ${aligned.movedIds.length} were moved; ${aligned.unmatchedTabIndices.length} tabs are not in it`;
};

// for old debugging method
globalThis.log = log;
globalThis.gMetricsData = MetricsData;
globalThis.Tab = Tab;
globalThis.TabsStore = TabsStore;
globalThis.SidebarConnection = SidebarConnection;
globalThis.configs = configs;
