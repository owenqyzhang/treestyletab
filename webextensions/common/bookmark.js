/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import * as PlaceHolderParser from '/extlib/placeholder-parser.js';

import {
  log as internalLogger,
  configs,
  notify,
  wait,
  sha1sum,
  isLinux,
} from './common.js';
import * as ApiTabs from './api-tabs.js';
import * as TreeBehavior from './tree-behavior.js';
import * as Constants from './constants.js';
import * as ContextualIdentities from './contextual-identities.js';
import * as Dialog from './dialog.js';
import * as Permissions from './permissions.js';
import * as UserOperationBlocker from './user-operation-blocker.js';

import { Tab } from '/common/TreeItem.js';

import BookmarkTabs from '/resources/dialog/BookmarkTabs.js';
import BookmarkTabsDialog from '/resources/dialog/BookmarkTabsDialog.js';

function log(...args) {
  internalLogger('common/bookmarks', ...args);
}

let mCreatingCount = 0;

export const getItemById = BookmarkTabsDialog.getItemById.bind(BookmarkTabsDialog);
export const initFolderChooser = BookmarkTabsDialog.initFolderChooser.bind(BookmarkTabsDialog);
export const FOLDER_CHOOSER_STYLE = BookmarkTabsDialog.FOLDER_CHOOSER_STYLE;

export async function bookmarkTab(tab, { parentId, showDialog } = {}) {
  try {
    if (!(await Permissions.isGranted(Permissions.BOOKMARKS)))
      throw new Error('not permitted');
  }
  catch(_error) {
    notify({
      title:   browser.i18n.getMessage('bookmark_notification_notPermitted_title'),
      message: browser.i18n.getMessage(`bookmark_notification_notPermitted_message${isLinux() ? '_linux' : ''}`),
      url:     browser.runtime.getURL('options/options.html#bookmarksPermissionSection')
    });
    return null;
  }
  const parent = (
    (await getItemById(parentId || configs.defaultBookmarkParentId)) ||
    (await getItemById(configs.$default.defaultBookmarkParentId))
  );

  let title = tab.title;
  let url   = tab.url;
  if (!parentId)
    parentId = parent?.id;
  if (showDialog) {
    const windowId = tab.windowId;
    const dialogParams = {
      inline: Constants.IS_SIDEBAR,
      tabId:  tab.id,
      values: {
        title,
        url,
        parentId,
      },
    };
    let result;
    if (dialogParams.inline) {
      try {
        UserOperationBlocker.blockIn(windowId, { throbber: false });
        result = await BookmarkTabs.show(dialogParams);
      }
      catch(_error) {
        result = { buttonIndex: -1 };
      }
      finally {
        UserOperationBlocker.unblockIn(windowId, { throbber: false });
      }
    }
    else {
      result = await Dialog.show({
        ownerWindow: await browser.windows.get(windowId),
        params:      dialogParams,
        controller:  BookmarkTabs,
      });
    }
    if (result.buttonIndex != 0)
      return null;
    title    = result.values.title;
    url      = result.values.url;
    parentId = result.values.parentId;
  }

  mCreatingCount++;
  const item = await browser.bookmarks.create({
    parentId, title, url
  }).catch(ApiTabs.createErrorHandler());
  wait(150).then(() => {
    mCreatingCount--;
  });
  return item;
}

export async function bookmarkTabs(tabs, { parentId, index, showDialog, title } = {}) {
  try {
    if (!(await Permissions.isGranted(Permissions.BOOKMARKS)))
      throw new Error('not permitted');
  }
  catch(_error) {
    notify({
      title:   browser.i18n.getMessage('bookmark_notification_notPermitted_title'),
      message: browser.i18n.getMessage('bookmark_notification_notPermitted_message'),
      url:     browser.runtime.getURL('options/options.html#bookmarksPermissionSection')
    });
    return null;
  }
  const now = new Date();
  const year = String(now.getFullYear());
  if (!title)
    title = PlaceHolderParser.process(configs.bookmarkTreeFolderName, (name, _rawArgs, ...args) => {
      switch (name.toLowerCase()) {
        case 'any':
          for (const arg of args) {
            if (!!arg)
              return arg;
          }
          return '';

        case 'title':
          return tabs[0].title;

        case 'group':
          return tabs[0].isGroupTab ? tabs[0].title : '';

        case 'url':
          return tabs[0].url;

        case 'short_year':
        case 'shortyear':
          return year.slice(-2);

        case 'full_year':
        case 'fullyear':
        case 'year':
          return year;

        case 'month':
          return String(now.getMonth() + 1).padStart(2, '0');

        case 'date':
          return String(now.getDate()).padStart(2, '0');

        case 'hour':
        case 'hours':
          return String(now.getHours()).padStart(2, '0');

        case 'min':
        case 'minute':
        case 'minutes':
          return String(now.getMinutes()).padStart(2, '0');

        case 'sec':
        case 'second':
        case 'seconds':
          return String(now.getSeconds()).padStart(2, '0');

        case 'msec':
        case 'millisecond':
        case 'milliseconds':
          return String(now.getSeconds()).padStart(3, '0');
      }
    });
  const folderParams = {
    // no "type: 'folder'": it is Firefox-only and Chrome rejects it;
    // creating without "url" produces a folder on both browsers.
    title
  };
  let parent;
  if (parentId) {
    parent = await getItemById(parentId);
    if (index !== undefined)
      folderParams.index = index;
  }
  else {
    parent = await getItemById(configs.defaultBookmarkParentId);
  }
  if (!parent)
    parent = await getItemById(configs.$default.defaultBookmarkParentId);
  if (parent)
    folderParams.parentId = parent.id;

  if (showDialog) {
    const windowId = tabs[0].windowId;
    const dialogParams = {
      inline: Constants.IS_SIDEBAR,
      values: folderParams,
    };
    let result;
    if (dialogParams.inline) {
      try {
        UserOperationBlocker.blockIn(windowId, { throbber: false });
        result = await BookmarkTabs.show(dialogParams);
      }
      catch(_error) {
        result = { buttonIndex: -1 };
      }
      finally {
        UserOperationBlocker.unblockIn(windowId, { throbber: false });
      }
    }
    else {
      result = await Dialog.show({
        ownerWindow: await browser.windows.get(windowId),
        params:      dialogParams,
        controller:  BookmarkTabs,
      });
    }
    if (result.buttonIndex != 0)
      return null;
    folderParams.title    = result.values.title;
    folderParams.parentId = result.values.parentId;
  }

  const toBeCreatedCount = tabs.length + 1;
  mCreatingCount += toBeCreatedCount;

  const titles = getTitlesWithTreeStructure(tabs);
  const folder = await browser.bookmarks.create(folderParams).catch(ApiTabs.createErrorHandler());
  for (let i = 0, maxi = tabs.length; i < maxi; i++) {
    await browser.bookmarks.create({
      parentId: folder.id,
      index:    i,
      title:    titles[i],
      url:      tabs[i].url
    }).catch(ApiTabs.createErrorSuppressor());
  }

  wait(150).then(() => {
    mCreatingCount -= toBeCreatedCount;
  });

  return folder;
}

function getTitlesWithTreeStructure(tabs) {
  const minLevel = Math.min(...tabs.map(tab => parseInt(tab.$TST.getAttribute(Constants.kLEVEL) || '0')));
  const titles = [];
  for (const tab of tabs) {
    const title = tab.title;
    const level = parseInt(tab.$TST.getAttribute(Constants.kLEVEL) || '0') - minLevel;
    const prefix = '>'.repeat(level);
    if (prefix)
      titles.push(`${prefix} ${title}`);
    else
      titles.push(title.replace(/^>+ /, '')); // if the page title has marker-like prefix, we need to remove it.
  }
  return titles;
}

let mCreatedBookmarks = [];
let mIsTracking = false;

async function onBookmarksCreated(id, bookmark) {
  if (!mIsTracking)
    return;

  log('onBookmarksCreated ', { id, bookmark });

  if (mCreatingCount > 0)
    return;

  mCreatedBookmarks.push(bookmark);
  reserveToGroupCreatedBookmarks();
}

function reserveToGroupCreatedBookmarks() {
  if (reserveToGroupCreatedBookmarks.reserved)
    clearTimeout(reserveToGroupCreatedBookmarks.reserved);
  reserveToGroupCreatedBookmarks.reserved = setTimeout(() => {
    reserveToGroupCreatedBookmarks.reserved = null;
    tryGroupCreatedBookmarks();
  }, 250);
}
reserveToGroupCreatedBookmarks.reserved = null;
reserveToGroupCreatedBookmarks.retryCount = 0;

async function tryGroupCreatedBookmarks() {
  log('tryGroupCreatedBookmarks ', mCreatedBookmarks);

  if (!configs.autoCreateFolderForBookmarksFromTree) {
    log(' => autoCreateFolderForBookmarksFromTree is false');
    return;
  }

  const lastDraggedTabs = configs.lastDraggedTabs;
  if (lastDraggedTabs &&
      lastDraggedTabs.tabIds.length > mCreatedBookmarks.length) {
    if (reserveToGroupCreatedBookmarks.retryCount++ < 10) {
      return reserveToGroupCreatedBookmarks();
    }
    else {
      reserveToGroupCreatedBookmarks.retryCount = 0;
      mCreatedBookmarks = [];
      configs.lastDraggedTabs = null;
      log(' => timeout');
      return;
    }
  }
  reserveToGroupCreatedBookmarks.retryCount = 0;

  const bookmarks = mCreatedBookmarks;
  mCreatedBookmarks = [];
  if (lastDraggedTabs) {
    // accept only bookmarks from dragged tabs
    const digest = await sha1sum(bookmarks.map(tab => tab.url).join('\n'));
    configs.lastDraggedTabs = null;
    if (digest != lastDraggedTabs.urlsDigest) {
      log(' => digest mismatched ', { digest, last: lastDraggedTabs.urlsDigest });
      return;
    }
  }

  if (bookmarks.length < 2) {
    log(' => ignore single bookmark');
    return;
  }

  {
    // Do nothing if multiple bookmarks are created under
    // multiple parent folders by sync.
    const parentIds = new Set();
    for (const bookmark of bookmarks) {
      parentIds.add(bookmark.parentId);
    }
    log('parentIds: ', parentIds);
    if (parentIds.size > 1) {
      log(' => ignore bookmarks created under multiple folders');
      return;
    }
  }

  const tabs = lastDraggedTabs ?
    lastDraggedTabs.tabIds.map(id => Tab.get(id)) :
    (await Promise.all(bookmarks.map(async bookmark => {
      const tabs = await browser.tabs.query({ url: bookmark.url });
      if (tabs.length == 0)
        return null;
      const tab = tabs.find(tab => tab.highlighted) || tabs[0];
      return Tab.get(tab);
    }))).filter(tab => !!tab);
  log('tabs: ', tabs);
  if (tabs.length != bookmarks.length) {
    log(' => ignore bookmarks created from non-tab sources');
    return;
  }

  const treeStructure = TreeBehavior.getTreeStructureFromTabs(tabs);
  log('treeStructure: ', treeStructure);
  const topLevelTabsCount = treeStructure.filter(item => item.parent < 0).length;
  if (topLevelTabsCount == treeStructure.length) {
    log(' => no need to group bookmarks from dragged flat tabs');
    return;
  }

  let titles = getTitlesWithTreeStructure(tabs);
  if (tabs[0].$TST.isGroupTab &&
      titles.filter(title => !/^>/.test(title)).length == 1) {
    log('delete needless bookmark for a group tab');
    browser.bookmarks.remove(bookmarks[0].id);
    tabs.shift();
    bookmarks.shift();
    titles = getTitlesWithTreeStructure(tabs);
  }
  log('titles: ', titles);

  log('save tree structure to bookmarks');
  for (let i = 0, maxi = bookmarks.length; i < maxi; i++) {
    const title = titles[i];
    if (title == tabs[i].title)
      continue;
    browser.bookmarks.update(bookmarks[i].id, { title });
  }

  log('ready to group bookmarks under a folder');

  const parentId = bookmarks[0].parentId;
  {
    // Do nothing if all bookmarks are created under a new
    // blank folder.
    const allChildren = await browser.bookmarks.getChildren(parentId);
    log('allChildren.length vs bookmarks.length: ', allChildren.length, bookmarks.length);
    if (allChildren.length == bookmarks.length) {
      log(' => no need to create folder for bookmarks under a new blank folder');
      return;
    }
  }

  log('create a folder for grouping');
  mCreatingCount++;
  const folder = await browser.bookmarks.create({
    title: bookmarks[0].title,
    index: bookmarks[0].index,
    parentId
  }).catch(ApiTabs.createErrorHandler());
  wait(150).then(() => {
    mCreatingCount--;
  });

  log('move into a folder');
  let movedCount = 0;
  for (const bookmark of bookmarks) {
    await browser.bookmarks.move(bookmark.id, {
      parentId: folder.id,
      index:    movedCount++
    });
  }
}

if (Constants.IS_BACKGROUND &&
    browser.bookmarks &&
    browser.bookmarks.onCreated) { // already granted
  browser.bookmarks.onCreated.addListener(onBookmarksCreated);
  mIsTracking = true;
}

export async function startTracking() {
  if (!mIsTracking ||
      !Constants.IS_BACKGROUND)
    return;

  mIsTracking = true;
  const granted = await Permissions.isGranted(Permissions.BOOKMARKS);
  if (granted && !browser.bookmarks.onCreated.hasListener(onBookmarksCreated))
    browser.bookmarks.onCreated.addListener(onBookmarksCreated);
}


export const BOOKMARK_TITLE_DESCENDANT_MATCHER = /^(>+) /;

export async function getTreeStructureFromBookmarkFolder(folderOrId) {
  const items = folderOrId.children || await browser.bookmarks.getChildren(folderOrId.id || folderOrId);
  return getTreeStructureFromBookmarks(items.filter(item => item.type == 'bookmark' || (!item.type && item.url))); // Chrome bookmark nodes have no "type"
}

export function getTreeStructureFromBookmarks(items) {
  const lastItemIndicesWithLevel = new Map();
  let lastMaxLevel = 0;
  return items.reduce((result, item, index) => {
    const { cookieStoreId, url } = ContextualIdentities.getIdFromBookmark(item);
    if (cookieStoreId) {
      item.cookieStoreId = cookieStoreId;
      if (url)
        item.url = url;
    }

    let level = 0;
    if (lastItemIndicesWithLevel.size > 0 &&
        item.title.match(BOOKMARK_TITLE_DESCENDANT_MATCHER)) {
      level = RegExp.$1.length;
      if (level - lastMaxLevel > 1) {
        level = lastMaxLevel + 1;
      }
      else {
        while (lastMaxLevel > level) {
          lastItemIndicesWithLevel.delete(lastMaxLevel--);
        }
      }
      lastItemIndicesWithLevel.set(level, index);
      lastMaxLevel = level;
      result.push(lastItemIndicesWithLevel.get(level - 1) - lastItemIndicesWithLevel.get(0));
      item.title = item.title.replace(BOOKMARK_TITLE_DESCENDANT_MATCHER, '')
    }
    else {
      result.push(-1);
      lastItemIndicesWithLevel.clear();
      lastItemIndicesWithLevel.set(0, index);
    }
    return result;
  }, []);
}


