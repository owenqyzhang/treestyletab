/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

import {
  configs,
  sanitizeForHTMLText,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab, TreeItem } from '/common/TreeItem.js';

import TabFavIconHelper from '/extlib/TabFavIconHelper.js';

import { kTAB_TWISTY_ELEMENT_NAME } from './TabTwistyElement.js';
import { kTAB_FAVICON_ELEMENT_NAME } from './TabFaviconElement.js';
import { kTREE_ITEM_LABEL_ELEMENT_NAME } from './TreeItemLabelElement.js';
import { kTAB_COUNTER_ELEMENT_NAME } from './TabCounterElement.js';
import { kTAB_SOUND_BUTTON_ELEMENT_NAME } from './TabSoundButtonElement.js';
import { kTAB_CLOSE_BOX_ELEMENT_NAME } from './TabCloseBoxElement.js';

export const kTREE_ITEM_SUBSTANCE_ELEMENT_NAME = 'tab-item-substance';

// On Chrome the hover card works without any capture permission
// (title/URL/memory only), like Chrome's native tab hover cards.
const IS_CHROME = typeof chrome != 'undefined' && !!chrome.sidePanel;

export const kEVENT_TREE_ITEM_SUBSTANCE_ENTER = 'tab-item-substance-enter';
export const kEVENT_TREE_ITEM_SUBSTANCE_LEAVE = 'tab-item-substance-leave';

export const TabInvalidationTarget = Object.freeze({
  Twisty:      1 << 0,
  SoundButton: 1 << 1,
  CloseBox:    1 << 2,
  Tooltip:     1 << 3,
  Overflow:    1 << 4,
  All:         1 << 0 | 1 << 1 | 1 << 2 | 1 << 3 | 1 << 4,
});

export const TabUpdateTarget = Object.freeze({
  Counter:                1 << 0,
  Overflow:               1 << 1,
  DescendantsHighlighted: 1 << 2,
  CollapseExpandState:    1 << 3,
  TabProperties:          1 << 4,
  All:                    1 << 0 | 1 << 1 | 1 << 2 | 1 << 3 | 1 << 4,
});

const NATIVE_PROPERTIES = new Set([
  'active',
  'attention',
  'audible',
  'discarded',
  'highlighted',
]);
const IGNORE_CLASSES = new Set([
  'tab',
  'split-view-main',
  'split-view-sub',
  'split-substances-container',
  Constants.kTAB_STATE_HAS_ACTIVE_SUBSTANCE,
  Constants.kTAB_STATE_SPLIT_VIEW,
]);

export class TreeItemSubstanceElement extends HTMLElement {
  static define() {
    window.customElements.define(kTREE_ITEM_SUBSTANCE_ELEMENT_NAME, TreeItemSubstanceElement);
  }

  static onWindowResize() {
    for (const element of document.querySelectorAll(kTREE_ITEM_SUBSTANCE_ELEMENT_NAME)) {
      element.invalidateTooltip();
    }
  }

  static onConfigChange(changedKey) {
    switch (changedKey) {
      case 'showCollapsedDescendantsByTooltip':
        for (const element of document.querySelectorAll(kTREE_ITEM_SUBSTANCE_ELEMENT_NAME)) {
          element.invalidateTooltip();
        }
        break;

      case 'labelOverflowStyle':
        for (const element of document.querySelectorAll(kTREE_ITEM_SUBSTANCE_ELEMENT_NAME)) {
          element.updateOverflow();
        }
        break;
    }
  }

  constructor() {
    super();
    // We should initialize private properties with blank value for better performance with a fixed shape.
    this.reservedUpdateTooltip = null;
    this.hasCustomTooltip = false;
    this.tooltipText = null;
    this._raw = null;
    this._$TST = null;
    this._favIconUrl = null;
    this.__onMouseOver = null;
    this.__onMouseEnter = null;
    this.__onMouseLeave = null;
    this._extraItemsContainerBehindRoot = null;
    this._extraItemsContainerFrontRoot = null;
    this._extraItemsContainerAboveRoot = null;
    this._extraItemsContainerBelowRoot = null;
    this.$onLabelOverflowSelf ||= this.$onLabelOverflow.bind(this);
  }

  connectedCallback() {
    if (this.initialized) {
      this.initializeContents();
      this._startListening();
      return;
    }

    /* The DOM structure will be fulfilled as following with delayed creations of elements:

      <${kTREE_ITEM_SUBSTANCE_ELEMENT_NAME} draggable="true">
        <span class="${Constants.kBACKGROUND} base"></span>
        <span class="${Constants.kBACKGROUND}">
          <span class="${Constants.kBURSTER}"></span>
        </span>
        <${kTAB_TWISTY_ELEMENT_NAME}></${kTAB_TWISTY_ELEMENT_NAME}>
        <span class="ui">
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} above"></span>
          <span class="caption">
            <${kTAB_FAVICON_ELEMENT_NAME}></${kTAB_FAVICON_ELEMENT_NAME}>
            <${kTAB_SOUND_BUTTON_ELEMENT_NAME}></${kTAB_SOUND_BUTTON_ELEMENT_NAME}>
            <${kTREE_ITEM_LABEL_ELEMENT_NAME}></${kTREE_ITEM_LABEL_ELEMENT_NAME}>
            <${kTAB_COUNTER_ELEMENT_NAME}></${kTAB_COUNTER_ELEMENT_NAME}>
            <${kTAB_CLOSE_BOX_ELEMENT_NAME}></${kTAB_CLOSE_BOX_ELEMENT_NAME}>
          </span>
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} below"></span>
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} behind"></span>
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} front"></span>
        </span>
        <span class="${Constants.kHIGHLIGHTER}"></span>
        <span class="${Constants.kCONTEXTUAL_IDENTITY_MARKER}"></span>
      </${kTREE_ITEM_SUBSTANCE_ELEMENT_NAME}>
    */

    this.insertAdjacentHTML('beforeend', `
        <span class="${Constants.kBACKGROUND} base"></span>
        <span class="${Constants.kBACKGROUND}"></span>
        <${kTAB_TWISTY_ELEMENT_NAME}></${kTAB_TWISTY_ELEMENT_NAME}>
        <span class="ui">
          <span class="caption">
            <${kTAB_FAVICON_ELEMENT_NAME}></${kTAB_FAVICON_ELEMENT_NAME}>
            <${kTAB_SOUND_BUTTON_ELEMENT_NAME}></${kTAB_SOUND_BUTTON_ELEMENT_NAME}>
            <${kTREE_ITEM_LABEL_ELEMENT_NAME}></${kTREE_ITEM_LABEL_ELEMENT_NAME}>
            <${kTAB_COUNTER_ELEMENT_NAME}></${kTAB_COUNTER_ELEMENT_NAME}>
            <${kTAB_CLOSE_BOX_ELEMENT_NAME}></${kTAB_CLOSE_BOX_ELEMENT_NAME}>
          </span>
        </span>
        <span class="${Constants.kHIGHLIGHTER}"></span>
    `.trim().replace(/>\s+</g, '><'));

    this.initializeContents();
    this._startListening();
  }

  disconnectedCallback() {
    this._endListening();
    this.labelElement?.removeOverflowChangeListener(this.$onLabelOverflowSelf);
    this.cancelTooltipUpdate();
    this._raw = null;
    this._$TST = null;
    this._favIconUrl = null;
    this._extraItemsContainerBehindRoot = null;
    this._extraItemsContainerFrontRoot = null;
    this._extraItemsContainerAboveRoot = null;
    this._extraItemsContainerBelowRoot = null;
    this.$onLabelOverflowSelf = null;
  }

  cancelTooltipUpdate() {
    if (this.reservedUpdateTooltip) {
      this.removeEventListener('mouseover', this.reservedUpdateTooltip);
      this.reservedUpdateTooltip = null;
    }
  }

  flushTooltipUpdate() {
    if (this.reservedUpdateTooltip) {
      this.removeEventListener('mouseover', this.reservedUpdateTooltip);
      this.reservedUpdateTooltip = null;
      this.updateTooltip();
    }
  }

  get initialized() {
    this.querySelector('.ui');
  }

  get type() {
    return this.getAttribute('type');
  }

  // Elements restored from cache are initialized without bundled tabs.
  // Thus we provide ability to get tab and service objects from cached/restored information.
  get raw() {
    return this._raw || (
      this._raw = (this.type == TreeItem.TYPE_GROUP ?
        TabsStore.tabGroups.get(parseInt(this.getAttribute(Constants.kAPI_NATIVE_TAB_GROUP_ID))) :
        this.type == TreeItem.TYPE_GROUP_COLLAPSED_MEMBERS_COUNTER ?
          TabsStore.tabGroups.get(parseInt(this.getAttribute(Constants.kAPI_NATIVE_TAB_GROUP_ID))).$TST.collapsedMembersCounterItem :
          Tab.get(parseInt(this.getAttribute(Constants.kAPI_TAB_ID)))
      )
    );
  }
  set raw(value) {
    return this._raw = value;
  }

  get tab() { // for backward compatibility
    return this.raw;
  }
  set tab(value) {
    return this.raw = value;
  }

  get $TST() {
    return this._$TST || (this._$TST = this.raw && this.raw.$TST);
  }
  set $TST(value) {
    return this._$TST = value;
  }

  get itemElement() {
    return this.parentNode;
  }

  get substanceElement() {
    return this;
  }

  get twisty() {
    return this.querySelector(kTAB_TWISTY_ELEMENT_NAME);
  }

  get favicon() {
    return this.querySelector(kTAB_FAVICON_ELEMENT_NAME);
  }

  get labelElement() {
    return this.querySelector(kTREE_ITEM_LABEL_ELEMENT_NAME);
  }

  get soundButtonElement() {
    return this.querySelector(kTAB_SOUND_BUTTON_ELEMENT_NAME);
  }

  get counterElement() {
    return this.querySelector(kTAB_COUNTER_ELEMENT_NAME);
  }

  get closeBox() {
    return this.querySelector(kTAB_CLOSE_BOX_ELEMENT_NAME);
  }

  get initialized() {
    return !!this.labelElement; // Using labelElement as an indicator of initialization
  }

  get favIconUrl() {
    if (!this.initialized)
      return null;

    return this.favicon.src;
  }

  set favIconUrl(url) {
    this._favIconUrl = url;
    if (!this.initialized || !this.$TST)
      return url;

    if (!url || url.startsWith('data:')) { // we don't need to use the helper for data: URI.
      this.favicon.src = TabFavIconHelper.getSafeFaviconUrl(url);
      this.favicon.classList.remove('error');
      return url;
    }

    TabFavIconHelper.loadToImage({
      image: this.favicon,
      tab:   this.$TST.tab,
      url
    });
    return url;
  }

  get overflow() {
    return this.labelElement?.overflow;
  }

  get label() {
    const label = this.labelElement;
    return label ? label.value : null;
  }
  set label(value) {
    const label = this.labelElement;
    if (label)
      label.value = value;

    this.dataset.title = value; // for custom CSS https://github.com/piroor/treestyletab/issues/2242

    if (!this.$TST) // called before binding on restoration from cache
      return;

    if (this.$TST.collapsed) {
      this.labelElement.invalidateOverflow();
      this._needToUpdateOverflow = true;
    }
  }

  invalidateTooltip() {
    if (this.reservedUpdateTooltip)
      return;

    this.useTabPreviewTooltip = false;
    this.hasCustomTooltip = false;
    this.tooltipText = null;
    Permissions.isGranted(Permissions.ALL_URLS); // cache last state for the updateTooltip()
    this.reservedUpdateTooltip = () => {
      this.reservedUpdateTooltip = null;
      this.updateTooltip();
    };
    this.addEventListener('mouseover', this.reservedUpdateTooltip, { once: true });
  }

  updateTooltip() {
    if (!this.$TST) // called before binding on restoration from cache
      return;

    const raw = this.$TST.raw;

    // Priority of tooltip contents and methods
    // 1. Is the tab preview panel activated by the user? (option)
    //    * NO => Use legacy tooltip anyway.
    //      - Set "title" attribute for the legacy tooltip, if the tab is faviconized,
    //        or the tab has long title with overflow state, or custom tooltip.
    //      - Otherwise remove "title" attribute to suppress the legacy tooltip.
    //    * YES => Go ahead.
    // 2. Can we show tab preview panel in the active tab? (permission)
    //    * YES => Remove "title" attribute to suppress the legacy tooltip.
    //             Tooltip will be shown with tab preview panel in the active tab.
    //    * NO => Go ahead.
    // 3. Do we have custom tooltip? (for collapsed tree, specified via API, etc.)
    //    * YES => Set "title" attribute for the legacy tooltip with custom contents.
    //    * NO => Go ahead for the default tooltip.
    // 4. Can we show tab preview panel in the sidebar for the default tooltip? (option)
    //    * YES => Remove "title" attribute to suppress the legacy tooltip.
    //             The default tooltip will be shown with tab preview panel in the sidebar.
    //    * NO => Set "title" attribute for the legacy tooltip, if the tab is faviconized,
    //            or the tab has long title with overflow state.

    const canCaptureTab = Permissions.isGrantedSync(Permissions.ALL_URLS);
    const canInjectScriptToTab = Permissions.canInjectScriptToTabSync(Tab.getActiveTab(TabsStore.getCurrentWindowId()));
    this.useTabPreviewTooltip = !!(
      configs.tabPreviewTooltip &&
      (canCaptureTab ||
       IS_CHROME ||
       raw.type == TreeItem.TYPE_GROUP) &&
      (((configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT) &&
        canInjectScriptToTab) ||
       (configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR))
    );

    let debugTooltip;
    if (configs.debug) {
      debugTooltip = `
${raw.title}
#${raw.id}
(${this.className})
uniqueId = <${this.$TST.uniqueId.id}>
duplicated = <${!!this.$TST.uniqueId.duplicated}> / <${this.$TST.uniqueId.originalTabId}> / <${this.$TST.uniqueId.originalId}>
restored = <${!!this.$TST.uniqueId.restored}>
rawId = ${raw.id}
windowId = ${raw.windowId}
index = ${raw.index}
`.trim();
      this.$TST.setAttribute('title', debugTooltip);
      if (!this.useTabPreviewTooltip) {
        this.tooltip = debugTooltip;
        this.tooltipHtml = `<pre>${sanitizeForHTMLText(debugTooltip)}</pre>`;
        return;
      }
    }

    this.tooltip                = this.$TST.defaultTooltipText;
    this.tooltipWithDescendants = this.$TST.tooltipTextWithDescendants;
    this.tooltipHtml            = this.$TST.tooltipHtml;
    this.tooltipHtmlWithDescendants = this.$TST.tooltipHtmlWithDescendants;

    const appliedTooltipText = this.appliedTooltipText;
    this.hasCustomTooltip = (
      appliedTooltipText !== null &&
      appliedTooltipText != this.$TST.defaultTooltipText
    );
    //console.log('this.useTabPreviewTooltip ', { useTabPreviewTooltip: this.useTabPreviewTooltip, /*canRunScript,*/ canInjectScriptToTab, hasCustomTooltip: this.hasCustomTooltip });

    this.tooltipText = configs.debug ?
      debugTooltip :
      (this.useTabPreviewTooltip &&
       (canInjectScriptToTab ||
        !(this.hasCustomTooltip && configs.showCollapsedDescendantsByLegacyTooltipOnSidebar))) ?
        null :
        appliedTooltipText;
    if (typeof this.tooltipText == 'string')
      this.$TST.setAttribute('title', this.tooltipText);
    else
      this.$TST.removeAttribute('title');
  }

  get useTooltipWithDescendants() {
    return (
      (
        (configs.showCollapsedDescendantsByTooltip &&
         this.$TST.subtreeCollapsed) ||
        (this.$TST.raw.type == TreeItem.TYPE_GROUP &&
         this.$TST.raw.collapsed)
      ) &&
      this.$TST.hasChild
    );
  }

  get appliedTooltipText() {
    if (this.useTooltipWithDescendants) {
      return this.tooltipWithDescendants;
    }

    const highPriorityTooltipText = this.$TST.highPriorityTooltipText;
    if (typeof highPriorityTooltipText == 'string') {
      if (highPriorityTooltipText)
        return highPriorityTooltipText;

      return null;
    }

    let tooltip = null;

    const raw = this.$TST.raw;
    if (raw.type == TreeItem.TYPE_TAB &&
        (this.classList.contains('faviconized') ||
         this.overflow ||
         this.tooltip != raw.title))
      tooltip = this.tooltip;
    else
      tooltip = null;

    const lowPriorityTooltipText = this.$TST.lowPriorityTooltipText;
    if (typeof lowPriorityTooltipText == 'string' &&
        !this.getAttribute('title')) {
      if (lowPriorityTooltipText)
        tooltip = lowPriorityTooltipText;
      else
        tooltip = null;
    }
    return tooltip;
  }

  get appliedTooltipHtml() {
    if (this.useTooltipWithDescendants) {
      return this.tooltipHtmlWithDescendants;
    }

    const highPriorityTooltipText = this.$TST.highPriorityTooltipText;
    if (typeof highPriorityTooltipText == 'string') {
      if (highPriorityTooltipText)
        return sanitizeForHTMLText(highPriorityTooltipText);

      return null;
    }

    let tooltip = null;

    const raw = this.$TST.raw;
    if (raw.type == TreeItem.TYPE_TAB &&
        (this.classList.contains('faviconized') ||
         this.overflow ||
         this.tooltip != raw.title))
      tooltip = this.tooltipHtml;
    else
      tooltip = null;

    const lowPriorityTooltipText = this.$TST.lowPriorityTooltipText;
    if (typeof lowPriorityTooltipText == 'string' &&
        !this.getAttribute('title')) {
      if (lowPriorityTooltipText)
        tooltip = sanitizeForHTMLText(lowPriorityTooltipText);
      else
        tooltip = null;
    }
    return tooltip;
  }

  _updateTabAndAncestorsTooltip(tab) {
    if (!TabsStore.ensureLivingItem(tab))
      return;
    for (const updateTab of [tab].concat(tab.$TST.ancestors)) {
      const tabElement = updateTab.$TST.element;
      if (!tabElement)
        continue;
      tabElement.substanceElement?.invalidateTooltip();
      // on the "fade" mode, overflow style was already updated,
      // so we don't need to update the status here.
      if (configs.labelOverflowStyle != 'fade')
        tabElement.updateOverflow();
    }
  }

  initializeContents() {
    this.labelElement?.addOverflowChangeListener(this.$onLabelOverflowSelf);
    this.twisty?.makeAccessible();
    this.soundButtonElement?.makeAccessible();
    this.closeBox?.makeAccessible();
  }
  $onLabelOverflow() {
    if (!this.$TST ||
        this.$TST.tab?.pinned)
      return;
    this.invalidateTooltip();
  }

  applyAttributes() {
    this.favIconUrl = this._favIconUrl ||= this.raw?.favIconUrl;
    //this.setAttribute('aria-selected', this.classList.contains(Constants.kTAB_STATE_HIGHLIGHTED) ? 'true' : 'false');

    if (this.getAttribute('type') == TreeItem.TYPE_TAB && this.raw) {
      this.dataset.index = this.raw.index;
    }

    this.labelElement.value = this.dataset.title;

    this.setAttribute(Constants.kAPI_TAB_ID, this.getAttribute(Constants.kAPI_TAB_ID));
    this.setAttribute(Constants.kAPI_WINDOW_ID, this.getAttribute(Constants.kAPI_WINDOW_ID));
    this.labelElement.setAttribute(Constants.kAPI_TAB_ID, this.getAttribute(Constants.kAPI_TAB_ID));
    this.labelElement.setAttribute(Constants.kAPI_WINDOW_ID, this.getAttribute(Constants.kAPI_WINDOW_ID));

    switch (this.getAttribute('type')) {
      case TreeItem.TYPE_TAB:
        if (this.raw) {
          this.dataset.index =
            this.labelElement.dataset.index = this.raw.index;
        }
      case TreeItem.TYPE_GROUP:
        this.setAttribute('draggable', true);
        break;

      default:
        this.removeAttribute('draggable');
        break;
    }

    this.labelElement.applyAttributes();
  }

  invalidate(targets) {
    if (targets & TabInvalidationTarget.Twisty)
      this.twisty?.invalidate();

    if (targets & TabInvalidationTarget.SoundButton)
      this.soundButtonElement?.invalidate();

    if (targets & TabInvalidationTarget.CloseBox)
      this.closeBox?.invalidate();

    if (targets & TabInvalidationTarget.Overflow) {
      this.labelElement?.invalidateOverflow();
      this._needToUpdateOverflow = true;
    }
  }

  update(targets) {
    if (!this.initialized)
      return;

    if (targets & TabUpdateTarget.Counter)
      this.counterElement?.update();

    if (targets & TabUpdateTarget.Overflow)
      this.updateOverflow();

    if (targets & TabUpdateTarget.TabProperties)
      this.updateTabProperties();
  }

  updateTabProperties() {
    if (!this.$TST) // called before binding on restoration from cache
      return;

    const raw       = this.$TST.raw;
    const classList = this.classList;

    this.label = raw.$TST.title;

    const tab = this.$TST.tab;
    if (tab) {
      const openerOfGroupTab = tab && this.$TST.isGroupTab && Tab.getOpenerFromGroupTab(tab);
      this.favIconUrl = openerOfGroupTab?.favIconUrl || tab?.favIconUrl;

      for (const state of classList) {
        if (IGNORE_CLASSES.has(state) ||
            NATIVE_PROPERTIES.has(state))
          continue;
        if (!this.$TST.states.has(state))
          classList.remove(state);
      }
      for (const state of this.$TST.states) {
        if (IGNORE_CLASSES.has(state))
          continue;
        if (!classList.contains(state))
          classList.add(state);
        if (state.startsWith('contextual-identity-'))
          this.ensureContextualIdentityMarker();
      }

      for (const state of NATIVE_PROPERTIES) {
        if (raw[state] == classList.contains(state))
          continue;
        classList.toggle(state, raw[state]);
      }

      if (this.$TST.childIds.length > 0)
        this.setAttribute(Constants.kCHILDREN, `|${this.$TST.childIds.join('|')}|`);
      else
        this.removeAttribute(Constants.kCHILDREN);

      if (this.$TST.parentId)
        this.setAttribute(Constants.kPARENT, this.$TST.parentId);
      else
        this.removeAttribute(Constants.kPARENT);

      const alreadyGrouped = this.$TST.getAttribute(Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER) || '';
      if (this.getAttribute(Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER) != alreadyGrouped)
        this.setAttribute(Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER, alreadyGrouped);

      const opener = this.$TST.getAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID) || '';
      if (this.getAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID) != opener)
        this.setAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID, opener);

      const uri = this.$TST.getAttribute(Constants.kCURRENT_URI) || tab?.url;
      if (this.getAttribute(Constants.kCURRENT_URI) != uri)
        this.setAttribute(Constants.kCURRENT_URI, uri);

      const favIconUri = this.$TST.getAttribute(Constants.kCURRENT_FAVICON_URI) || tab?.favIconUrl;
      if (this.getAttribute(Constants.kCURRENT_FAVICON_URI) != favIconUri)
        this.setAttribute(Constants.kCURRENT_FAVICON_URI, favIconUri);

      const level = this.$TST.getAttribute(Constants.kLEVEL) || 0;
      if (this.getAttribute(Constants.kLEVEL) != level)
        this.setAttribute(Constants.kLEVEL, level);

      const id = this.$TST.uniqueId.id;
      if (this.getAttribute(Constants.kPERSISTENT_ID) != id)
        this.setAttribute(Constants.kPERSISTENT_ID, id);

      if (this.$TST.subtreeCollapsed) {
        if (!classList.contains(Constants.kTAB_STATE_SUBTREE_COLLAPSED))
          classList.add(Constants.kTAB_STATE_SUBTREE_COLLAPSED);
      }
      else {
        if (classList.contains(Constants.kTAB_STATE_SUBTREE_COLLAPSED))
          classList.remove(Constants.kTAB_STATE_SUBTREE_COLLAPSED);
      }
    }

    const group = this.$TST.nativeTabGroup || this.$TST.group;
    if (group) {
      this.style.setProperty('--tab-group-color', `var(--tab-group-color-${group.color})`);
      this.style.setProperty('--tab-group-color-pale', `var(--tab-group-color-${group.color}-pale)`);
      this.style.setProperty('--tab-group-color-invert', `var(--tab-group-color-${group.color}-invert)`);
    }
    if (this.$TST.group) {
      classList.toggle(Constants.kTAB_STATE_SUBTREE_COLLAPSED, group.collapsed);
    }
  }

  updateOverflow() {
    if (this._needToUpdateOverflow ||
        configs.labelOverflowStyle == 'fade') {
      this._needToUpdateOverflow = false;
      this.labelElement?.updateOverflow();
    }
    this.invalidateTooltip();
  }

  ensureBurster() {
    const background = this.querySelector(`.${Constants.kBACKGROUND}:not(.base)`);
    if (background && !background.querySelector(`.${Constants.kBURSTER}`)) {
      const burster = document.createElement('span');
      burster.className = Constants.kBURSTER;
      background.appendChild(burster);
    }
  }

  ensureContextualIdentityMarker() {
    if (!this.querySelector(`.${Constants.kCONTEXTUAL_IDENTITY_MARKER}`)) {
      const marker = document.createElement('span');
      marker.className = Constants.kCONTEXTUAL_IDENTITY_MARKER;
      this.appendChild(marker);
    }
  }

  get safeExtraItemsContainerBehindRoot() {
    if (this._extraItemsContainerBehindRoot)
      return this._extraItemsContainerBehindRoot;

    let container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.behind`);
    if (!container) {
      container = document.createElement('span');
      container.className = `${Constants.kEXTRA_ITEMS_CONTAINER} behind`;
      const ui = this.querySelector('.ui');
      const below = ui.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.below`);
      ui.insertBefore(container, below ? below.nextSibling : ui.querySelector('.caption').nextSibling);
    }
    return this.unsafeExtraItemsContainerBehindRoot;
  }
  get unsafeExtraItemsContainerBehindRoot() {
    const container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.behind`);
    if (container && !this._extraItemsContainerBehindRoot) {
      this._extraItemsContainerBehindRoot = container.shadowRoot || container.attachShadow({ mode: 'open' });
      this._extraItemsContainerBehindRoot.itemById ||= new Map();
    }
    return this._extraItemsContainerBehindRoot;
  }

  get safeExtraItemsContainerFrontRoot() {
    if (this._extraItemsContainerFrontRoot)
      return this._extraItemsContainerFrontRoot;

    let container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.front`);
    if (!container) {
      container = document.createElement('span');
      container.className = `${Constants.kEXTRA_ITEMS_CONTAINER} front`;
      this.querySelector('.ui').appendChild(container);
    }
    return this.unsafeExtraItemsContainerFrontRoot;
  }
  get unsafeExtraItemsContainerFrontRoot() {
    const container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.front`);
    if (container && !this._extraItemsContainerFrontRoot) {
      this._extraItemsContainerFrontRoot = container.shadowRoot || container.attachShadow({ mode: 'open' });
      this._extraItemsContainerFrontRoot.itemById ||= new Map();
    }
    return this._extraItemsContainerFrontRoot;
  }

  get safeExtraItemsContainerAboveRoot() {
    if (this._extraItemsContainerAboveRoot)
      return this._extraItemsContainerAboveRoot;

    let container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.above`);
    if (!container) {
      container = document.createElement('span');
      container.className = `${Constants.kEXTRA_ITEMS_CONTAINER} above`;
      const ui = this.querySelector('.ui');
      ui.insertBefore(container, ui.querySelector('.caption'));
    }
    return this.unsafeExtraItemsContainerAboveRoot;
  }
  get unsafeExtraItemsContainerAboveRoot() {
    const container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.above`);
    if (container && !this._extraItemsContainerAboveRoot) {
      this._extraItemsContainerAboveRoot = container.shadowRoot || container.attachShadow({ mode: 'open' });
      this._extraItemsContainerAboveRoot.itemById ||= new Map();
    }
    return this._extraItemsContainerAboveRoot;
  }

  get safeExtraItemsContainerBelowRoot() {
    if (this._extraItemsContainerBelowRoot)
      return this._extraItemsContainerBelowRoot;

    let container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.below`);
    if (!container) {
      container = document.createElement('span');
      container.className = `${Constants.kEXTRA_ITEMS_CONTAINER} below`;
      const ui = this.querySelector('.ui');
      ui.insertBefore(container, ui.querySelector('.caption').nextSibling);
    }
    return this.unsafeExtraItemsContainerBelowRoot;
  }
  get unsafeExtraItemsContainerBelowRoot() {
    const container = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.below`);
    if (container && !this._extraItemsContainerBelowRoot) {
      this._extraItemsContainerBelowRoot = container.shadowRoot || container.attachShadow({ mode: 'open' });
      this._extraItemsContainerBelowRoot.itemById ||= new Map();
    }
    return this._extraItemsContainerBelowRoot;
  }

  cleanup() {
    this._extraItemsContainerBehindRoot?.host.remove();
    this._extraItemsContainerBehindRoot = null;
    this._extraItemsContainerFrontRoot?.host.remove();
    this._extraItemsContainerFrontRoot = null;
    this._extraItemsContainerAboveRoot?.host.remove();
    this._extraItemsContainerAboveRoot = null;
    this._extraItemsContainerBelowRoot?.host.remove();
    this._extraItemsContainerBelowRoot = null;

    this.querySelector(`.${Constants.kBURSTER}`)?.remove();
    this.querySelector(`.${Constants.kCONTEXTUAL_IDENTITY_MARKER}`)?.remove();
  }

  _startListening() {
    if (this.__onMouseOver)
      return;
    this.addEventListener('mouseover', this.__onMouseOver = this._onMouseOver.bind(this));
    this.addEventListener('mouseenter', this.__onMouseEnter = this._onMouseEnter.bind(this));
    this.addEventListener('mouseleave', this.__onMouseLeave = this._onMouseLeave.bind(this));
  }

  _endListening() {
    if (!this.__onMouseOver)
      return;
    this.removeEventListener('mouseover', this.__onMouseOver);
    this.__onMouseOver = null;
    this.removeEventListener('mouseenter', this.__onMouseEnter);
    this.__onMouseEnter = null;
    this.removeEventListener('mouseleave', this.__onMouseLeave);
    this.__onMouseLeave = null;
  }

  _onMouseOver(_event) {
    this._updateTabAndAncestorsTooltip(this.$TST?.raw);
  }

  _onMouseEnter(event) {
    this.flushTooltipUpdate();
    const tabSubstanceEnterEvent = new MouseEvent(kEVENT_TREE_ITEM_SUBSTANCE_ENTER, {
      ...event,
      clientX:  event.clientX,
      clientY:  event.clientY,
      screenX:  event.screenX,
      screenY:  event.screenY,
      bubbles:  true,
      composed: true,
    });
    this.dispatchEvent(tabSubstanceEnterEvent);
  }

  _onMouseLeave(event) {
    const tabSubstanceLeaveEvent = new UIEvent(kEVENT_TREE_ITEM_SUBSTANCE_LEAVE, {
      ...event,
      bubbles:  true,
      composed: true,
    });
    this.dispatchEvent(tabSubstanceLeaveEvent);
  }
}

window.addEventListener('resize', TreeItemSubstanceElement.onWindowResize);
configs.$addObserver(TreeItemSubstanceElement.onConfigChange);
