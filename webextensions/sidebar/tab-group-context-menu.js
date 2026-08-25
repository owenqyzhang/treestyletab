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
import * as Sync from '/common/sync.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab } from '/common/TreeItem.js';

import InContentPanelController from '/resources/module/InContentPanelController.js';
import TabGroupMenuPanel from '/resources/module/TabGroupMenuPanel.js'; // the IMPL

function log(...args) {
  internalLogger('sidebar/tab-group-context-menu', ...args);
}

// The in-content panel requires tabs.executeScript() with a code string,
// which is unavailable on Chrome (MV3), so we always render in the sidebar there.
const IS_CHROME = typeof chrome != 'undefined' && !!chrome.sidePanel;

const TAB_GROUP_MENU_LABELS = Object.fromEntries(`
  tabGroupMenu_tab_group_editor_title_create
  tabGroupMenu_tab_group_editor_title_edit
  tabGroupMenu_tab_group_editor_name_label
  tabGroupMenu_tab_group_editor_name_field_placeholder
  tabGroupMenu_tab_group_editor_cancel_label
  tabGroupMenu_tab_group_editor_cancel_accesskey
  tabGroupMenu_tab_group_editor_color_selector_aria_label
  tabGroupMenu_tab_group_editor_color_selector2_blue
  tabGroupMenu_tab_group_editor_color_selector2_blue_title
  tabGroupMenu_tab_group_editor_color_selector2_purple
  tabGroupMenu_tab_group_editor_color_selector2_purple_title
  tabGroupMenu_tab_group_editor_color_selector2_cyan
  tabGroupMenu_tab_group_editor_color_selector2_cyan_title
  tabGroupMenu_tab_group_editor_color_selector2_orange
  tabGroupMenu_tab_group_editor_color_selector2_orange_title
  tabGroupMenu_tab_group_editor_color_selector2_yellow
  tabGroupMenu_tab_group_editor_color_selector2_yellow_title
  tabGroupMenu_tab_group_editor_color_selector2_pink
  tabGroupMenu_tab_group_editor_color_selector2_pink_title
  tabGroupMenu_tab_group_editor_color_selector2_green
  tabGroupMenu_tab_group_editor_color_selector2_green_title
  tabGroupMenu_tab_group_editor_color_selector2_gray
  tabGroupMenu_tab_group_editor_color_selector2_gray_title
  tabGroupMenu_tab_group_editor_color_selector2_red
  tabGroupMenu_tab_group_editor_color_selector2_red_title
  tabGroupMenu_tab_group_editor_action_new_tab_label
  tabGroupMenu_tab_group_editor_action_new_window_label
  tabGroupMenu_tab_group_editor_action_copy_link_label
  tabGroupMenu_tab_group_editor_action_copy_links_label
  tabGroupMenu_tab_group_editor_action_save_label
  tabGroupMenu_tab_group_editor_action_ungroup_label
  tabGroupMenu_tab_group_editor_action_delete_label
  tabGroupMenu_tab_group_editor_done_label
  tabGroupMenu_tab_group_editor_done_accesskey
`.trim().split(/\s+/).map(key => [key.replace(/-/g, '_'), browser.i18n.getMessage(key)]));
const TAB_GROUP_MENU_LABELS_CODE = JSON.stringify(TAB_GROUP_MENU_LABELS);

const mTabGroupMenuPanel = new TabGroupMenuPanel(document.querySelector('#tabGroupContextMenuRoot'), TAB_GROUP_MENU_LABELS);
const mController = new InContentPanelController({
  type:   TabGroupMenuPanel.TYPE,
  logger: log,
  shouldLog() {
    return configs.logFor['sidebar/tab-group-context-menu'] && configs.debug;
  },
  canRenderInSidebar() {
    return IS_CHROME || !!(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  canRenderInContent() {
    return !IS_CHROME && !!(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT);
  },
  shouldFallbackToSidebar() {
    return IS_CHROME || !!(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  UIClass:         TabGroupMenuPanel,
  inSidebarUI:     mTabGroupMenuPanel,
  initializerCode: `
    const root = document.createElement('div');
    appendClosedContents(root);
    const tabGroupMenuPanel = new TabGroupMenuPanel(root, ${TAB_GROUP_MENU_LABELS_CODE});

    let destroy;

    const onMouseDown = event => {
      if (event.target?.closest(window.closedContainerType)) {
        return;
      }
      if (logging)
        console.log('mouse down on out of tab group menu panel, destroy tab group menu container');
      browser.runtime.sendMessage({
        type: 'treestyletab:${TabGroupMenuPanel.TYPE}:hide',
        timestamp: Date.now(),
      });
      destroyClosedContents(destroy);
    };
    document.documentElement.addEventListener('mousedown', onMouseDown, { captuer: true });

    destroy = createClosedContentsDestructor(tabGroupMenuPanel, () => {
      document.documentElement.removeEventListener('mousedown', onMouseDown, { captuer: true });
    });

    return tabGroupMenuPanel;
  `,
});

export async function show(group, creating = false) {
  if (!group?.id) {
    return;
  }

  if (!mTabGroupMenuPanel.windowId) {
    const windowId = TabsStore.getCurrentWindowId();
    mTabGroupMenuPanel.windowId = windowId;
  }

  const sendableTabs = group.$TST.members.filter(Sync.isSendableTab);

  mController.show({
    anchorItem:    group,
    targetItem:    group,
    messageParams: {
      groupTitle:     group.title,
      groupColor:     group.color,
      creating:       !!creating,
      tabsToBeCopied: sendableTabs.map(tab => ({ url: tab.url, title: tab.title })),
    },
  });
}

document.querySelector('#tabbar').addEventListener('mousedown', event => {
  if (event.target?.closest('#tabGroupContextMenuRoot')) {
    return;
  }

  const timestamp = Date.now();
  mController.sendInSidebarMessage({
    type: `treestyletab:${TabGroupMenuPanel.TYPE}:hide`,
    timestamp,
  });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  if (activeTab) {
    mController.sendMessage(activeTab.id, {
      type: `treestyletab:${TabGroupMenuPanel.TYPE}:hide-if-shown`,
      timestamp,
    });
  }
}, { capture: true });
