/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirm from '/extlib/RichConfirm.js';
import CrossContextMessaging from '/extlib/cross-context-messaging-bg.js';

import {
  log,
  configs
} from '/common/common.js';
import * as SidebarConnection from '/common/sidebar-connection.js';
import * as TabsStore from '/common/tabs-store.js';

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

// Expose for common/tst-api.js and common/tabs-internal-operation.js:
// dynamic import() is disallowed in the MV3 service worker, and this
// module must only load in the background. Read at init() time, so
// assigning after the imports is safe.
globalThis.__treestyletabCrossContextMessaging = CrossContextMessaging; // eslint-disable-line no-underscore-dangle

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

RichConfirm.init(browser.runtime.getURL('/extlib/RichConfirmDialog.html'));

// for old debugging method
globalThis.log = log;
globalThis.gMetricsData = MetricsData;
globalThis.Tab = Tab;
globalThis.TabsStore = TabsStore;
globalThis.SidebarConnection = SidebarConnection;
globalThis.configs = configs;
