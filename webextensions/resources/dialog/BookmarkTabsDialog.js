/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirmDialog from '/extlib/RichConfirmDialog.js';

import {
  sanitizeForHTMLText,
  isRTL,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';

class BookmarkTabsDialog extends RichConfirmDialog {
  constructor(params) {
    super(params);

    this.BASE_ID = BookmarkTabsDialog.BASE_ID;

    this.params.buttons = [
      browser.i18n.getMessage('bookmarkDialog_accept'),
      browser.i18n.getMessage('bookmarkDialog_cancel'),
    ];
    this.params.type  = 'dialog'; // for popup
    this.params.title = browser.i18n.getMessage(params.tabId ? 'bookmarkDialog_dialogTitle_single' : 'bookmarkDialog_dialogTitle_multiple'); // for popup
  }

  async onShown(container) {
    if (this.params.simulation)
      return;

    container.classList.add('bookmark-dialog');
    const [defaultItem, rootItems] = await Promise.all([
      browser.runtime.sendMessage({ type: 'treestyletab:get-bookmark-item-by-id', id: this.params.values.parentId }),
      browser.runtime.sendMessage({ type: 'treestyletab:get-bookmark-child-items' })
    ]);
    BookmarkTabsDialog.initFolderChooser({
      defaultItem,
      rootItems,
      container,
      inline: this.params.inline,
      isRTL:  isRTL(),
    });
    container.querySelector('[name="title"]').select();
  }

  static get BASE_ID() {
    return this.$BASE_ID ||= `dialog-${Date.now()}-${parseInt(Math.random() * 65000)}:`;
  }

  generateStyleDefinitions() {
    const definitions = super.generateStyleDefinitions();
    return `
      ${definitions}

      .itemContainer {
        align-items: stretch;
        display: flex;
        flex-direction: column;
        margin-block: 0.2em;
        margin-inline: 0;
        text-align: start;
      }
      .itemContainer.last {
        flex-grow: 1;
        flex-shrink: 1;
      }

      .itemContainer > label {
        display: flex;
        margin-block-end: 0.2em;
        white-space: nowrap;
      }

      .itemContainer > input[type="text"] {
        display: flex;
      }
      .itemContainer.dialog > input[type="text"] {
        min-width: 30em;
      }

      ${BookmarkTabsDialog.FOLDER_CHOOSER_STYLE}
    `.trim();
  }

  async updateContent() {
    const inlineClass = this.params.inline ? 'inline' : 'dialog';
    const urlField = this.params.tabId ? `
      <div class="itemContainer ${inlineClass}">
        <label for="url"
               accesskey=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_url_accessKey')))}>
          <span accesskey=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_url_accessKey')))}
               >${sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_url'))}</span>
        </label>
        <input id="url"
               type="text"
               name="url">
      </div>
    `.trim() : '';
    this.content.insertAdjacentHTML('beforeend', `
      <div class="itemContainer ${inlineClass}">
        <label for="title"
               accesskey=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_title_accessKey')))}>
          <span accesskey=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_title_accessKey')))}
               >${sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_title'))}</span>
        </label>
        <input id="title"
               type="text"
               name="title">
      </div>
      ${urlField}
      <div class="itemContainer last ${inlineClass}">
        <div class="itemContainer">
          <label for="parentId"
                 accesskey=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_parentId_accessKey')))}>
            <span accesskey=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_parentId_accessKey')))}
                 >${sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_parentId'))}</span>
          </label>
          <span class="parentIdChooserMiniContainer">
            <select id="parentId"
                    name="parentId"
                    class="parentIdChooserMini"></select>
            <button class="showAllFolders"
                    data-no-accept-by-enter="true"
                    title=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_showAllFolders_tooltip')))}></button>
          </span>
        </div>
        <div class="itemContainer parentIdChooserFullContainer">
          <div class="parentIdChooserFullTreeContainer"
               tabindex="0"
               data-no-accept-by-enter="true">
            <ul class="parentIdChooserFull"></ul>
          </div>
          <span>
            <button class="newFolder"
                    accesskey=${JSON.stringify(sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_newFolder_accessKey')))}
                    data-no-accept-by-enter="true"
                   >${sanitizeForHTMLText(browser.i18n.getMessage('bookmarkDialog_newFolder'))}</button>
          </span>
        </div>
      </div>
    `.trim());
    for (const element of this.content.querySelectorAll('[accesskey]')) {
      this.updateAccessKey(element);
    }
  }

  static async getItemById(id) {
    if (!id)
      return null;
    try {
      if (browser.bookmarks) {
        const items = await browser.bookmarks.get(id).catch(ApiTabs.createErrorHandler());
        if (items.length > 0)
          return items[0];
      }
      // in-popup case with no permission
      return browser.runtime.sendMessage({ type: 'treestyletab:get-bookmark-item-by-id', id });
    }
    catch(_error) {
    }
    return null;
  }

  // This large method has to contain everything required to simulate the folder
  // chooser in the bookmark creation dialog.
  static async initFolderChooser({ rootItems, defaultItem, defaultValue, container, inline, isRTL } = {}) {
    const miniList = container.querySelector('select.parentIdChooserMini');
    const fullList = container.querySelector('ul.parentIdChooserFull');
    const fullListFocusibleContainer = container.querySelector('.parentIdChooserFullTreeContainer');
    const fullContainer = container.querySelector('.parentIdChooserFullContainer');
    const expandeFullListButton = container.querySelector('.showAllFolders');
    const newFolderButton = container.querySelector('.newFolder');

    const BASE_ID = `folderChooser-${Date.now()}-${parseInt(Math.random() * 65000)}:`;

    const ensureItemVisible = item => {
      const itemRect = item.querySelector('label').getBoundingClientRect();
      const containerRect = fullListFocusibleContainer.getBoundingClientRect();
      if (itemRect.top < containerRect.top) {
        fullListFocusibleContainer.scrollBy(0, itemRect.top - containerRect.top - (itemRect.height / 2));
      }
      else if (itemRect.bottom > containerRect.bottom) {
        fullListFocusibleContainer.scrollBy(0, itemRect.bottom - containerRect.bottom + (itemRect.height / 2));
      }
    };

    const cancelEvent = event => {
      event.stopImmediatePropagation();
      event.preventDefault();
    };

    //==========================================================================
    // Initialize mini chooser
    //==========================================================================
    for (const rootItem of rootItems) {
      const item = miniList.appendChild(document.createElement('option'));
      item.textContent = rootItem.title;
      item.value = rootItem.id;
    }

    miniList.appendChild(document.createElement('hr'));
    const expanderOption = miniList.appendChild(document.createElement('option'));
    expanderOption.textContent = browser.i18n.getMessage('bookmarkDialog_showAllFolders_label');
    expanderOption.setAttribute('value', `${BASE_ID}expandChooser`);

    miniList.appendChild(document.createElement('hr'));
    const lastChosenOption = miniList.appendChild(document.createElement('option'));

    let lastChosenItem = defaultItem ||
      defaultValue && await this.getItemById(defaultValue) ||
      null;
    const getLastChosenItem = () => {
      return lastChosenItem || miniList.firstChild.$item || null;
    };

    const updateLastChosenOption = () => {
      if (lastChosenItem) {
        lastChosenOption.value       = lastChosenItem?.id;
        lastChosenOption.textContent = lastChosenItem?.title;
        lastChosenOption.style.display = '';
      }
      else {
        lastChosenOption.style.display = 'none';
      }
      miniList.value = getLastChosenItem()?.id;
    };
    updateLastChosenOption();

    let expanded = false;
    let fullChooserHeight = 0;
    const toggleFullChooser = async () => {
      expanded = !expanded;
      fullContainer.classList.toggle('expanded', expanded);
      expandeFullListButton.classList.toggle('expanded', expanded);
      if (!inline) {
        const fullContainerStyle = window.getComputedStyle(fullContainer, null);
        fullChooserHeight = Math.max(
          fullChooserHeight,
          Math.ceil(fullContainer.offsetHeight
            + parseFloat(fullContainerStyle.getPropertyValue('margin-block-start'))
            + parseFloat(fullContainerStyle.getPropertyValue('margin-block-end'))),
          150
        );
        await browser.runtime.sendMessage({
          type:   'treestyletab:resize-bookmark-dialog-by',
          width:  0,
          height: expanded ? fullChooserHeight : -fullChooserHeight,
        });
      }
      if (lastChosenItem) {
        const item = fullList.querySelector(`li[data-id="${lastChosenItem?.id}"]`);
        if (item)
          ensureItemVisible(item);
      }
    };

    //==========================================================================
    // Initialize expander
    //==========================================================================
    const getElementTarget = event => {
      return event.target.nodeType == Node.ELEMENT_NODE ?
        event.target :
        event.target.parentNode;;
    };

    //==========================================================================
    // Initialize full chooser
    //==========================================================================
    fullList.level = 0;

    const exitAllEditings = () => {
      for (const item of fullList.querySelectorAll('li.editing')) {
        item.$exitTitleEdit();
      }
    };

    const getTargetItem = event => {
      const elementTarget = getElementTarget(event);
      return elementTarget?.closest('li');
    };

    const focusToItem = item => {
      if (!item)
        return;

      exitAllEditings();

      for (const oldFocused of fullListFocusibleContainer.querySelectorAll('.focused')) {
        if (oldFocused == item)
          continue;
        oldFocused.classList.remove('focused');
      }
      item.classList.add('focused');
      lastChosenItem = item.$item;

      ensureItemVisible(item);
      updateLastChosenOption();
    };

    const toggleItemExpanded = item => {
      if (!item)
        return;

      item.classList.toggle('expanded');
      if (item.classList.contains('expanded'))
        item.$completeFolderItem();

      focusToItem(item);
    };

    const expandOrDigIn = (event, focusedItem) => {
      if (!focusedItem.classList.contains('expanded')) {
        focusedItem.classList.add('expanded');
        focusedItem.$completeFolderItem();
      }
      else {
        const firstChild = focusedItem.querySelector('li');
        if (firstChild)
          focusToItem(firstChild);
      }
    };
    const collapseOrDigOut = (event, focusedItem) => {
      if (focusedItem.classList.contains('expanded')) {
        focusedItem.classList.remove('expanded');
      }
      else {
        const nearestAncestor = focusedItem.parentNode.closest('li');
        if (nearestAncestor)
          focusToItem(nearestAncestor);
      }
    };

    const createNewSubFolder = async () => {
      const folder = await browser.runtime.sendMessage({
        type:     'treestyletab:create-new-bookmark-folder',
        parentId: getLastChosenItem()?.id,
      });
      const parentItem = fullList.querySelector(`li[data-id="${folder.parentId}"]`);
      if (!parentItem)
        return;
      parentItem.$invalidate();
      parentItem.classList.add('expanded');
      await parentItem.$completeFolderItem();
      const folderItem = parentItem.querySelector(`li[data-id="${folder.id}"]`);
      if (!folderItem)
        return;

      focusToItem(folderItem);
      folderItem.$enterTitleEdit();
    };

    const generateFolderItem = (folder, level) => {
      const item = document.createElement('li');
      item.$item = folder;
      item.setAttribute('data-id', folder.id);
      const title = folder.title || browser.i18n.getMessage('bookmarkFolderChooser_blank');
      const label = item.appendChild(document.createElement('label'));
      label.setAttribute('style', `padding-inline-start: calc(1.25em * ${level} + 0.25em);`);
      label.setAttribute('title', title);
      const twisty = label.appendChild(document.createElement('span'));
      twisty.setAttribute('class', 'twisty');
      const text = label.appendChild(document.createElement('div'));
      text.setAttribute('class', 'label-text');
      text.textContent = title;
      return item;
    };

    const buildItems = async (items, container) => {
      const createdItems = [];
      for (const item of items) {
        if (item.type == 'bookmark' &&
            /^place:parent=([^&]+)$/.test(item.url)) { // alias for special folders
          const realItem = await browser.runtime.sendMessage({
            type: 'treestyletab:get-bookmark-item-by-id',
            id:   RegExp.$1
          });
          item.id    = realItem.id;
          item.type  = realItem.type;
          item.title = realItem.title;
        }
        if (item.type != 'folder')
          continue;

        if (container.querySelector(`li[data-id="${item.id}"]`))
          continue;

        const folderItem = generateFolderItem(item, container.level);
        container.insertBefore(folderItem, 'index' in item ? container.childNodes[item.index] : null);
        createdItems.push(folderItem);
        folderItem.$completeFolderItem = async () => {
          if (!item.$fetched) {
            item.$fetched = true;
            item.children = (await browser.runtime.sendMessage({
              type: 'treestyletab:get-bookmark-child-items',
              id:   item.id
            })).filter(item => item?.type == 'folder');
          }
          folderItem.classList.toggle('noChild', !item.children || item.children.length == 0);
          if (item.children &&
              item.children.length > 0) {
            let subFolderContainer = folderItem.querySelector('ul');;
            if (!subFolderContainer) {
              subFolderContainer = folderItem.appendChild(document.createElement('ul'));
              subFolderContainer.level = container.level + 1;
            }
            await buildItems(item.children, subFolderContainer);
          }
          return folderItem;
        };
        folderItem.$invalidate = () => {
          item.$fetched = false;
        };
        let titleField;
        folderItem.$enterTitleEdit = async () => {
          exitAllEditings();
          if (!titleField) {
            const label = folderItem.querySelector('label');
            folderItem.classList.add('editing');
            titleField = label.appendChild(document.createElement('input'));
            titleField.setAttribute('type', 'text');
            label.appendChild(titleField);
            titleField.value = item.title || browser.i18n.getMessage('bookmarkFolderChooser_blank');
          }
          titleField.focus();
          titleField.select();
        };
        folderItem.$exitTitleEdit = async () => {
          if (!titleField)
            return;
          browser.runtime.sendMessage({
            type:  'treestyletab:update-bookmark-folder',
            id:    item.id,
            title: titleField.value,
          });
          item.title =
             folderItem.querySelector('.label-text').textContent = titleField.value;
          folderItem.querySelector('label').setAttribute('title', titleField.value);
          if (lastChosenItem?.id == item.id)
            lastChosenItem.title = item.title;
          titleField.parentNode.removeChild(titleField);
          titleField = null;
          folderItem.classList.remove('editing');
          updateLastChosenOption();
        };
      }
      return createdItems;
    };

    const topLevelItems = await buildItems(rootItems, fullList);

    // Expand deeply nested tree until the chosen folder
    let itemToBeFocused = topLevelItems.length > 0 && topLevelItems[0];
    if (lastChosenItem) {
      const ancestorIds = await browser.runtime.sendMessage({
        type: 'treestyletab:get-bookmark-ancestor-ids',
        id:   lastChosenItem.id,
      });
      for (const id of [...ancestorIds.reverse(), lastChosenItem.id]) {
        if (id == 'root________')
          continue;

        const item = fullList.querySelector(`li[data-id="${id}"]`);
        if (!item)
          break;

        itemToBeFocused = item;
        item.classList.add('expanded');
        await item.$completeFolderItem();
      }
    }
    if (itemToBeFocused)
      itemToBeFocused.classList.add('focused');


    //==========================================================================
    // UI events handling
    //==========================================================================
    container.addEventListener('focus', event => {
      if (!getElementTarget(event)?.closest('input[type="text"], .parentIdChooserFullTreeContainer'))
        exitAllEditings();
    }, { capture: true });
    container.addEventListener('blur', event => {
      if (getElementTarget(event)?.closest('input[type="text"]')) {
        const editingItem = fullList.querySelector('li.editing');
        if (editingItem)
          editingItem.$exitTitleEdit();
      }
    }, { capture: true });

    miniList.addEventListener('change', () => {
      if (miniList.value == `${BASE_ID}expandChooser`) {
        if (!fullContainer.classList.contains('expanded'))
          toggleFullChooser();
        miniList.value = getLastChosenItem()?.id;
        return;
      }

      const fullListItem = fullList.querySelector(`li[data-id="${miniList.value}"]`);
      if (fullListItem)
        focusToItem(fullListItem);
    });

    expandeFullListButton.addEventListener('click', event => {
      if (event.button != 0)
        return;
      toggleFullChooser();
    });
    expandeFullListButton.addEventListener('keydown', event => {
      const elementTarget = getElementTarget(event);
      if (elementTarget != expandeFullListButton)
        return;

      switch (event.key) {
        case 'Enter':
          cancelEvent(event);
        case 'Space':
          toggleFullChooser();
          break;

        default:
          break;
      }
    }, { capture: true });

    fullListFocusibleContainer.addEventListener('dblclick', event => {
      if (event.button != 0)
        return;
      if (getElementTarget(event)?.closest('.twisty'))
        return;
      const item = getTargetItem(event);
      if (item)
        item.$enterTitleEdit();
    });
    fullListFocusibleContainer.addEventListener('click', event => {
      if (event.button != 0)
        return;
      const target = getElementTarget(event);
      if (target?.closest('.twisty')) {
        toggleItemExpanded(getTargetItem(event));
      }
      else if (!target?.closest('input[type="text"]')) {
        focusToItem(getTargetItem(event));
      }
    });
    fullListFocusibleContainer.addEventListener('keydown', event => {
      if (getElementTarget(event)?.closest('input[type="text"]') &&
          event.key != 'Enter')
        return;

      const focusibleItems = [...fullList.querySelectorAll('li:not(li:not(.expanded) li)')];
      const focusedItem = fullList.querySelector('li.focused');
      const index = focusedItem ? focusibleItems.indexOf(focusedItem) : -1;
      switch (event.key) {
        case 'Enter':
          cancelEvent(event);
          if (focusedItem?.matches('.editing'))
            focusedItem.$exitTitleEdit();
          toggleItemExpanded(focusedItem);
          break;

        case 'ArrowUp': {
          cancelEvent(event);
          const toBeFocused = focusibleItems[(index == 0 ? focusibleItems.length : index) - 1];
          focusToItem(toBeFocused);
        }; break;

        case 'ArrowDown': {
          cancelEvent(event);
          const toBeFocused = focusibleItems[index == focusibleItems.length - 1 ? 0 : index + 1];
          focusToItem(toBeFocused);
        }; break;

        case 'ArrowRight':
          cancelEvent(event);
          if (isRTL)
            collapseOrDigOut(event, focusedItem);
          else
            expandOrDigIn(event, focusedItem);
          break;

        case 'ArrowLeft':
          cancelEvent(event);
          if (isRTL)
            expandOrDigIn(event, focusedItem);
          else
            collapseOrDigOut(event, focusedItem);
          break;

        case 'PageUp': {
          cancelEvent(event);
          const toBeFocusedIndex = Math.min(focusibleItems.length - 1, Math.max(0, index - Math.floor(fullListFocusibleContainer.offsetHeight / focusedItem.offsetHeight) + 1));
          const toBeFocused = focusibleItems[toBeFocusedIndex];
          focusToItem(toBeFocused);
        }; break;

        case 'PageDown': {
          cancelEvent(event);
          const toBeFocusedIndex = Math.min(focusibleItems.length - 1, Math.max(0, index + Math.floor(fullListFocusibleContainer.offsetHeight / focusedItem.offsetHeight) - 1));
          const toBeFocused = focusibleItems[toBeFocusedIndex];
          focusToItem(toBeFocused);
        }; break;

        case 'Home':
          cancelEvent(event);
          focusToItem(focusibleItems[0]);
          break;

        case 'End':
          cancelEvent(event);
          focusToItem(focusibleItems[focusibleItems.length - 1]);
          break;
      }
    }, { capture: true });

    newFolderButton.addEventListener('click', event => {
      if (event.button != 0)
        return;
      createNewSubFolder();
    });
    newFolderButton.addEventListener('keydown', event => {
      const elementTarget = getElementTarget(event);
      if (elementTarget != newFolderButton)
        return;

      switch (event.key) {
        case 'Enter':
          cancelEvent(event);
        case 'Space':
          createNewSubFolder();
          break;

        default:
          break;
      }
    }, { capture: true });
  }
};

// The base URL of style declarations embedded into a popup become an unprivileged URL,
// and it is different from the URL of this file and the base URL of this addon.
// Thus we need to load images with their complete URL.
BookmarkTabsDialog.FOLDER_CHOOSER_STYLE = `
  .parentIdChooserMiniContainer,
  .parentIdChooserFullContainer {
    --icon-size: 16px;
  }

  .parentIdChooserMiniContainer {
    display: flex;
    flex-direction: row;
  }
  .parentIdChooserMini {
    display: flex;
    flex-grow: 1;
    margin-inline-end: 0.2em;
    max-width: calc(100% - 2em /* width of the showAllFolders button */ - 0.2em);
  }

  .showAllFolders {
    display: flex;
    flex-grow: 0;
    width: 2em;
  }

  .showAllFolders::before {
    -moz-context-properties: fill;
    background: currentColor;
    content: "";
    display: inline-block;
    fill: currentColor;
    height: var(--icon-size);
    line-height: 1;
    mask: url("${browser.runtime.getURL('/sidebar/styles/icons/ArrowheadDown.svg')}") no-repeat center / 60%;
    max-height: var(--icon-size);
    max-width: var(--icon-size);
    transform-origin: 50% 50%;
    width: var(--icon-size);
  }
  .showAllFolders.expanded::before {
    transform: rotatez(180deg);
  }

  .parentIdChooserFullContainer {
    flex-direction: column;
    flex-grow: 1;
    flex-shrink: 1;
  }
  .parentIdChooserFullContainer:not(.expanded) {
    display: none;
  }

  .parentIdChooserFullContainer ul {
    list-style: none;
    margin-block: 0;
    margin-inline: 0;
    padding-block: 0;
    padding-inline: 0;
  }

  .parentIdChooserFullContainer ul.parentIdChooserFull {
    max-height: 0;
    overflow: visible;
  }

  .parentIdChooserFullContainer li:not(.expanded) > ul {
    display: none;
  }

  .parentIdChooserFullTreeContainer {
    border: 1px solid;
    margin-block: 0.5em;
    margin-inline: 0;
    min-height: 10em;
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    flex-shrink: 1;
    overflow-y: auto;
  }

  .parentIdChooserFull li {
    list-style: none;
    margin-block: 0;
    margin-inline: 0;
    padding-block: 0;
    padding-inline: 0;
  }

  .parentIdChooserFull li > label {
    padding-block: 0.25em;
    padding-inline: 0.25em;
    white-space: nowrap;
    display: flex;
    user-select: none;
  }
  .parentIdChooserFull li > label:hover {
    background: rgba(0, 0, 0, 0.15);
  }

  .parentIdChooserFull .twisty {
    height: 1em;
    width: 1em;
  }
  .parentIdChooserFull li.noChild .twisty {
    visibility: hidden;
  }
  .parentIdChooserFull li > label > .twisty {
    order: 1;
  }
  .parentIdChooserFull li > label > .twisty::before {
    -moz-context-properties: fill;
    background: currentColor;
    content: "";
    display: inline-block;
    height: 1em;
    line-height: 1;
    mask: url("${browser.runtime.getURL('/sidebar/styles/icons/ArrowheadDown.svg')}") no-repeat center / 60%;
    max-height: 1em;
    max-width: 1em;
    transform-origin: 50% 50%;
    transform: rotatez(-90deg);
    width: 1em;;
  }
  .rtl .parentIdChooserFull li > label > .twisty::before {
    transform: rotatez(90deg);
  }
  .parentIdChooserFull li.expanded > label > .twisty::before {
    transform: rotatez(0deg);
  }

  .parentIdChooserFull li.focused > label {
    color: highlightText;
    background: highlight;
    outline: 1px dotted;
  }
  .parentIdChooserFull li.chosen > label > .twisty::before {
    background: highlightText;
  }

  .parentIdChooserFull li > label::before {
    -moz-context-properties: fill;
    background: currentColor;
    content: "";
    display: inline-block;
    height: var(--icon-size);
    line-height: 1;
    mask: url("${browser.runtime.getURL('/resources/icons/folder-16.svg')}") no-repeat center / 60%;
    max-height: var(--icon-size);
    max-width: var(--icon-size);
    order: 2;
    width: var(--icon-size);
  }

  .parentIdChooserFull li > label > * {
    order: 3;
  }

  .parentIdChooserFull li > label > .label-text {
    overflow: hidden;
    text-overflow: ellipsis
  }

  li.editing > label > .label-text {
    display: none;
  }

  li.editing > label > input[type="text"] {
    display: flex;
    flex-grow: 1;
  }
`;

// Guarded: this module may be imported by the MV3 service worker.
if (typeof window != 'undefined') {
window.BookmarkTabsDialog = BookmarkTabsDialog;
window.RICH_CONFIRM_DIALOG_CLASS_NAME = 'BookmarkTabsDialog';
}

if (Constants.IS_BACKGROUND) {
  // Dialog loaded in a popup cannot call privileged APIs, so the background script proxies such operations.
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message ||
        typeof message != 'object')
      return;

    switch (message.type) {
      case 'treestyletab:get-bookmark-item-by-id':
        return BookmarkTabsDialog.getItemById(message.id);

      case 'treestyletab:get-bookmark-child-items':
        return browser.bookmarks.getChildren(message.id || 'root________').catch(ApiTabs.createErrorHandler());

      case 'treestyletab:get-bookmark-ancestor-ids':
        return (async () => {
          const ancestorIds = [];
          let item;
          let lastId = message.id;
          do {
            item = await BookmarkTabsDialog.getItemById(lastId);
            if (!item)
              break;
            ancestorIds.push(lastId = item.parentId);
          } while (lastId != 'root________');
          return ancestorIds;
        })();

      case 'treestyletab:create-new-bookmark-folder':
        return (async () => {
          const folder = await browser.bookmarks.create({
            type:     'folder',
            title:    browser.i18n.getMessage('bookmarkDialog_newFolder_defaultTitle'),
            parentId: message.parentId,
            ...(typeof message.index == 'number' ? { index: message.index } : {}),
          }).catch(ApiTabs.createErrorHandler());
          return folder;
        })();

      case 'treestyletab:update-bookmark-folder':
        return browser.bookmarks.update(message.id, {
          title: message.title,
        }).catch(ApiTabs.createErrorHandler());

      case 'treestyletab:resize-bookmark-dialog-by':
        return (async () => {
          const win = await browser.windows.get(sender.tab.windowId);
          return browser.windows.update(win.id, {
            width:  win.width + (message.width || 0),
            height: win.height + (message.height || 0),
          });
        })();
    }
  });
}

export default BookmarkTabsDialog;
