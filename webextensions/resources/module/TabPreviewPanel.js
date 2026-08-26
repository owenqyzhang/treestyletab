/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// This is the main implementation to show the tab preview panel.
// See also: /siedbar/in-content-panel-tooltip.js

import InContentPanel from './InContentPanel.js';

export default class TabPreviewPanel extends InContentPanel {
  static TYPE = 'tab-preview';

  get styleRules() {
    return super.styleRules + `
      .in-content-panel-root.tab-preview-panel {
        z-index: calc(var(--max-32bit-integer) - 100); /* put preview panel below tab group menu always */

        &:not(.in-sidebar) {
          bottom: 0;
          height: 100%;
        }
        &.in-sidebar {
          bottom: auto !important;
          height: 0 !important;
        }

        &:not(.extended) {
          pointer-events: none;

          &:hover {
            opacity: 0;
          }
        }

        /* When TST is unloaded/reloaded while the root element is there,
           the root element will be left there and it block user operations
           unexpectedly. This is a workaround to avoid such a fatal situation. */
        &.extended:hover:not(:has(.in-content-panel.open)):not(:has(.in-content-panel:hover)) {
          height: 0 !important;
          pointer-events: none !important;
        }

        .in-content-panel {
          cursor: default;
          overflow: hidden; /* clip the preview with the rounded edges */

          /* https://searchfox.org/firefox-main/rev/1a4138fff3c97b328b33c107266a461edf83140a/toolkit/themes/shared/design-system/dist/tokens-platform.css */
          --border-color-deemphasized: color-mix(in srgb, currentColor 24%, transparent);

          /* https://searchfox.org/firefox-main/rev/d5c0bb96ad84524b445ee72323a4c91176d20b4c/browser/components/contextualidentity/content/usercontext.css */
          --identity-fill-color-blue: #37adff;
          --identity-fill-color-cyan: #00c79a;
          --identity-fill-color-green: #51cd00;
          --identity-fill-color-yellow: #ffcb00;
          --identity-fill-color-orange: #ff9f00;
          --identity-fill-color-red: #ff613d;
          --identity-fill-color-pink: #ff4bda;
          --identity-fill-color-purple: #af51f5;
          --identity-fill-color-violet: #764edd;
          --identity-fill-color-gray: currentColor;

          &:not(.extended) {
            pointer-events: none;
          }

          &.extended {
            max-width: min(100%, calc(var(--panel-width) * 2));
          }

          &.animation.updating,
          &.animation:not(.open) {
            margin-block-start: 1ch; /* The native tab preview panel "popups up" on the vertical tab bar. */
          }
          /*
          &[data-align="left"].updating,
          &[data-align="left"]:not(.open) {
            left: -1ch !important;
          }
          &[data-align="right"].updating,
          &[data-align="right"]:not(.open) {
            right: -1ch !important;
          }
          */

          &.extended .in-content-panel-title,
          &.extended .in-content-panel-url,
          &.extended .in-content-panel-image-container,
          &:not(.extended) .in-content-panel-extended-content {
            display: none;
          }
          &.extended .in-content-panel-contents,
          &.extended .in-content-panel-contents-inner-box {
            max-width: calc(min(100%, calc(var(--panel-width) * 2)) - (2px / var(--in-content-panel-scale)));
          }

          &.style-nova {
            /* https://searchfox.org/mozilla-central/rev/1a4138fff3c97b328b33c107266a461edf83140a/toolkit/themes/shared/design-system/tokens-shared.css */
            --border-color-deemphasized: light-dark(var(--color-gray-20), var(--color-gray-50));

            /* https://searchfox.org/firefox-main/rev/d5c0bb96ad84524b445ee72323a4c91176d20b4c/browser/components/contextualidentity/content/usercontext.css */
            --identity-fill-color-blue: light-dark(var(--color-blue-60), var(--color-blue-20));
            --identity-fill-color-cyan: light-dark(var(--color-cyan-60), var(--color-cyan-20));
            --identity-fill-color-green: light-dark(var(--color-green-60), var(--color-green-20));
            --identity-fill-color-yellow: light-dark(var(--color-yellow-60), var(--color-yellow-20));
            --identity-fill-color-orange: light-dark(var(--color-orange-60), var(--color-orange-20));
            --identity-fill-color-red: light-dark(var(--color-red-60), var(--color-red-20));
            --identity-fill-color-pink: light-dark(var(--color-pink-60), var(--color-pink-20));
            --identity-fill-color-purple: light-dark(var(--color-purple-60), var(--color-purple-20));
            --identity-fill-color-violet: light-dark(var(--color-violet-60), var(--color-violet-20));
            --identity-fill-color-gray: light-dark(var(--color-gray-60), var(--color-gray-20));

            padding-block-end: var(--panel-padding-block);
          }

          &.blank,
          & .blank,
          &.hidden,
          & .hidden {
            display: none;
          }

          &.loading,
          & .loading {
            opacity: 0;
            pointer-events: none;
          }

          &.updating,
          & .updating {
            visibility: hidden;
          }
        }

        .in-content-panel-contents-inner-box {
          max-width: calc(var(--panel-width) - (2px / var(--in-content-panel-scale)));
          min-width: calc(var(--panel-width) - (2px / var(--in-content-panel-scale)));
        }

        .in-content-panel.overflow .in-content-panel-contents {
          mask-image: linear-gradient(to top, transparent 0, black 2em);
        }

        .in-content-panel-title {
          font-size: calc(1em / var(--in-content-panel-scale));
          font-weight: bold;
          margin: var(--panel-padding-block) var(--panel-padding-inline) 0;
          max-height: 3em; /* -webkit-line-clamp looks unavailable, so this is a workaround */
          overflow: hidden;
          /* text-overflow: ellipsis; */
          -webkit-line-clamp: 2; /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#15-18 */
        }

        .in-content-panel-url {
          font-size: calc(1em / var(--in-content-panel-scale));
          margin: 0 var(--panel-padding-inline);
          opacity: 0.69; /* https://searchfox.org/mozilla-central/rev/234f91a9d3ebef0d514868701cfb022d5f199cb5/toolkit/themes/shared/design-system/tokens-shared.css#182 */
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .in-content-panel-contextual-identity {
          align-items: center;
          display: flex;
          flex-direction: row;
          font-size: calc(1em / var(--in-content-panel-scale));
          margin: 0 var(--panel-padding-inline);

          .contextual-identity {
            align-items: center;
            color: var(--identity-fill-color);
            display: flex;
            flex-direction: row;
          }

          .label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .icon {
            margin-inline-start: 0.25em;
            max-height: 1.2em;
            max-width: 1.2em;
          }

          .in-content-panel.style-nova & {
            .contextual-identity {
              background: color-mix(in srgb, currentColor 15%, transparent);
              border-radius: 1.2em;
              padding: 0 0.5em;
            }

            .label {
              order: 2;
            }

            .icon {
              margin-inline: 0 0.25em;
              order: 1;
            }
          }
        }

        .in-content-panel-extended-content {
          font-size: calc(1em / var(--in-content-panel-scale));
          margin: var(--panel-padding-block) var(--panel-padding-inline);
          white-space: pre;
        }

        .in-content-panel-memory-usage {
          font-size: calc(1em / var(--in-content-panel-scale));
          margin: 0 var(--panel-padding-inline) var(--panel-padding-block);
          opacity: 0.69; /* same as .in-content-panel-url */
        }

        .in-content-panel-image-container {
          margin-block-start: 0.25em;
          max-height: calc(var(--panel-width) * ${parseInt(this.BASE_PANEL_HEIGHT) / parseInt(this.BASE_PANEL_WIDTH)}); /* use relative value instead of 140px */
          overflow: hidden;

          .in-content-panel.has-image & {
            border-block-start: calc(1px / var(--in-content-panel-scale)) solid var(--border-color-deemphasized);
          }

          .in-content-panel.has-image.style-nova & {
            border: calc(1px / var(--in-content-panel-scale)) solid var(--border-color-deemphasized);
            border-radius: calc(var(--panel-padding-inline) * 0.6);
            margin: 0.25em calc(var(--panel-padding-inline) * 0.6) calc(var(--panel-padding-inline) * 0.6 - var(--panel-padding-block));
          }
        }

        .in-content-panel-image {
          max-width: 100%;
          opacity: 1;

          .in-content-panel.animation:not(.updating) & {
            transition: opacity 0.2s ease-out;
          }

          &.loading {
            min-height: ${this.BASE_PANEL_HEIGHT};
          }
        }

        /* tree */
        .in-content-panel-extended-content {
          ul,
          ul ul {
            margin-block: 0;
            margin-inline: var(--panel-padding-inline) 0;
            padding: 0;
            list-style: none;
          }

          ul {
            margin-inline: 0;
          }

          .title-line {
            align-items: center;
            border-radius: 0.4em;
            display: flex;
            flex-direction: row;
            max-width: 100%;
            white-space: nowrap;

            &:hover {
              background: light-dark(rgba(207, 207, 216, 0.66), rgba(207, 207, 216, 0.2)); /* https://searchfox.org/firefox-main/rev/256e8bad1a52af07e29574baf4aaf02f05b39d93/browser/themes/shared/browser-colors.css#90 */
            }

            .favicon {
              max-height: 1em;
              max-width: 1em;
            }

            .title {
              margin-inline-start: 0.25em;
              overflow: hidden;
              text-overflow: ellipsis;
            }

            .cookieStoreName {
              display: flex;
              margin-inline-start: 1ch;

              &::before {
                content: "- ";
              }
            }
          }
        }

        /* Simulate the appearance of Chrome's native tab hover card, for the
           panel rendered in the sidebar (the only available mode on Chrome). */
        &.in-sidebar {
          .in-content-panel {
            /* Chrome's hover card surface: white in light mode, an
               ELEVATED grey (not the near-black Canvas) in dark mode.
               Values follow Chrome's grey tokens. */
            background: light-dark(#ffffff, #3c4043);
            border: 1px solid light-dark(#dadce0, rgba(255, 255, 255, 0.12));
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
            color: light-dark(#202124, #e8eaed);
            font: 13px system-ui;
            line-height: 1.4;

            &.style-nova {
              padding-block-end: 0; /* the card padding is applied to the inner box instead */
            }
          }

          .in-content-panel-contents-inner-box {
            padding: 10px 12px;
          }

          .in-content-panel-title {
            display: -webkit-box;
            -webkit-box-orient: vertical;
            font-weight: 500;
            line-height: 1.4;
            margin: 0;
            max-height: 2.8em; /* 2 lines * line-height 1.4 */
          }

          .in-content-panel-url {
            color: light-dark(#5f6368, #9aa0a6);
            margin: 0;
            opacity: 1;
          }

          .in-content-panel-contextual-identity {
            margin: 0;
          }

          /* Tall collapsed-tree lists: clamp the card to the viewport and
             make the list itself scrollable (wheel + edge autoscroll). */
          .in-content-panel {
            max-height: calc(100dvh - 16px);
          }
          /* Depending on geometry the clipping element is either
             .in-content-panel-contents (via --panel-max-height set from
             the anchor tab position) or the inner box (via the viewport
             clamp above); both must actually scroll. */
          .in-content-panel-contents {
            min-height: 0;
            overflow-y: auto;
            overscroll-behavior: contain;
          }
          .in-content-panel-contents-inner-box {
            display: flex;
            flex-direction: column;
            max-height: calc(100dvh - 16px - 2px); /* minus the border */
            min-height: 0;
          }
          .in-content-panel-extended-content {
            flex: 0 1 auto;
            line-height: 1.4;
            margin: 0;
            min-height: 0;
            overflow-y: auto;
            overscroll-behavior: contain;

            /* deeper indent for nested levels of the tree list */
            ul ul {
              margin-inline: calc(var(--panel-padding-inline) * 1.5) 0;
            }

            .title-line {
              border-radius: 4px;
              line-height: 1.4;
              /* Roomy rows with a real gap between them, so the hover
                 highlight of one row never touches the neighbors' text. */
              margin-block: 2px;
              padding: 3px 8px;
            }
          }

          .in-content-panel-memory-usage {
            border-block-start: 1px solid light-dark(#e8eaed, rgba(255, 255, 255, 0.1));
            color: light-dark(#5f6368, #9aa0a6);
            margin: 6px 0 0;
            opacity: 1;
            padding-block-start: 6px;
          }

          /* keep the preview image flush with the card edges */
          .in-content-panel:not(.style-nova) .in-content-panel-image-container {
            margin: 0.25em -12px -10px;
          }
        }
      }
    `;
  }

  init(givenRoot) {
    // https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5
    this.BASE_PANEL_WIDTH  = '280px';
    this.BASE_PANEL_HEIGHT = '140px';
    this.DATA_URI_BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

    super.init(givenRoot);

    this.root.classList.add('tab-preview-panel');
  }

  async onBeforeShow(message, _sender) {
    // Simulate the behavior: show tab preview panel with delay
    // only when the panel is not shown yet.
    if (typeof message.waitInitialShowUntil == 'number' &&
        (!this.panel ||
         !this.panel.classList.contains('open'))) {
      const delay = Math.max(0, message.waitInitialShowUntil - Date.now());
      if (delay > 0) {
        await new Promise((resolve, _reject) => {
          setTimeout(resolve, delay);
        });
      }
    }
  }

  get UISource() {
    return `
      <div class="in-content-panel-title"></div>
      <div class="in-content-panel-url"></div>
      <div class="in-content-panel-contextual-identity"><label class="contextual-identity"><span class="label"></span><img class="icon"/></label></div>
      <div class="in-content-panel-extended-content"></div>
      <div class="in-content-panel-memory-usage blank"></div>
      <div class="in-content-panel-image-container">
        <img class="in-content-panel-image"/>
      </div>
    `;
  }

  prepareUI() {
    if (this.panel) {
      return;
    }
    super.prepareUI();

    this.panel.addEventListener('click', event => {
      const item = event.target.closest('.title-line[data-tab-id]');
      const id = item?.dataset.tabId;
      if (!id) {
        return;
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      browser.runtime.sendMessage({
        type:  'treestyletab:api:focus',
        tabId: parseInt(id),
      });
    }, { useCapture: true });

    const preview = this.panel.querySelector('.in-content-panel-image');
    preview.addEventListener('load', () => {
      if (preview.src)
        preview.classList.remove('loading');
    });

    // Edge autoscroll for tall collapsed-tree lists: when the card is
    // clamped to the viewport and its list overflows, hovering near the
    // card's top/bottom edge scrolls the list (a timer, not rAF: Chrome
    // throttles rAF in side panels). Elements are re-resolved on every
    // event: the panel contents can be rebuilt between shows.
    const EDGE_SCROLL_ZONE_PX      = 28;
    const EDGE_SCROLL_MAX_PX_TICK  = 8;
    let edgeScrollTimer = 0;
    let edgeScrollSpeed = 0;
    let edgeScrollTarget = null;
    const stopEdgeScroll = () => {
      if (edgeScrollTimer) {
        clearInterval(edgeScrollTimer);
        edgeScrollTimer = 0;
      }
      edgeScrollSpeed = 0;
      edgeScrollTarget = null;
    };
    const findScrollableContent = () => {
      const panel = this.root.querySelector('.in-content-panel.open');
      if (!panel)
        return null;
      for (const selector of ['.in-content-panel-extended-content', '.in-content-panel-contents-inner-box', '.in-content-panel-contents']) {
        const candidate = panel.querySelector(selector);
        if (candidate && candidate.scrollHeight > candidate.clientHeight + 1)
          return candidate;
      }
      return null;
    };
    this.root.addEventListener('pointermove', event => {
      const scrollable = findScrollableContent();
      if (!scrollable) {
        stopEdgeScroll();
        return;
      }
      // Zones are measured from the CARD's edges (what the user aims at),
      // not the inner list's.
      const rect = scrollable.closest('.in-content-panel').getBoundingClientRect();
      let speed = 0;
      if (event.clientY < rect.top + EDGE_SCROLL_ZONE_PX) {
        const strength = Math.min(EDGE_SCROLL_ZONE_PX, (rect.top + EDGE_SCROLL_ZONE_PX) - event.clientY) / EDGE_SCROLL_ZONE_PX;
        speed = -Math.ceil(strength * EDGE_SCROLL_MAX_PX_TICK);
      }
      else if (event.clientY > rect.bottom - EDGE_SCROLL_ZONE_PX) {
        const strength = Math.min(EDGE_SCROLL_ZONE_PX, event.clientY - (rect.bottom - EDGE_SCROLL_ZONE_PX)) / EDGE_SCROLL_ZONE_PX;
        speed = Math.ceil(strength * EDGE_SCROLL_MAX_PX_TICK);
      }
      edgeScrollSpeed = speed;
      edgeScrollTarget = scrollable;
      if (speed == 0) {
        stopEdgeScroll();
      }
      else if (!edgeScrollTimer) {
        edgeScrollTimer = setInterval(() => {
          if (!edgeScrollSpeed ||
              !edgeScrollTarget?.isConnected) {
            stopEdgeScroll();
            return;
          }
          edgeScrollTarget.scrollTop += edgeScrollSpeed;
        }, 16);
      }
    });
    this.root.addEventListener('pointerleave', stopEdgeScroll);
  }

  onUpdateUI({ targetId, title, url, contextualIdentity, tooltipHtml, hasPreview, previewURL, memoryUsageMB, complete, scale, ...params }) {
    this.log(`${this.type} onUpdateUI `, { panel: this.panel, targetId, title, url, contextualIdentity, tooltipHtml, hasPreview, previewURL, memoryUsageMB, ...params });

    const hasLoadablePreviewURL = previewURL && /^((https?|moz-extension|chrome-extension):|data:image\/[^,]+,.+)/.test(previewURL);
    if (previewURL)
      hasPreview = hasLoadablePreviewURL;

    const previewImage = this.panel.querySelector('.in-content-panel-image');
    previewImage.classList.toggle('blank', !hasPreview && !hasLoadablePreviewURL);
    if (!previewURL ||
        (previewURL &&
         previewURL != previewImage.src)) {
      previewImage.classList.add('loading');
      previewImage.src = previewURL || this.DATA_URI_BLANK_PNG;
      this.panel.classList.toggle('has-image', !!previewURL);
    }
    else {
      this.panel.classList.remove('has-image');
    }

    if (tooltipHtml) {
      const extendedContent = this.panel.querySelector('.in-content-panel-extended-content');
      extendedContent.innerHTML = tooltipHtml;
      this.panel.classList.add('extended');
      this.root.classList.add('extended');
    }

    // Simulate the behavior of Chrome's native tab hover card: it shows
    // the memory usage of the hovered background tab, when available.
    const memoryUsageElement = this.panel.querySelector('.in-content-panel-memory-usage');
    const hasMemoryUsage = typeof memoryUsageMB == 'number';
    memoryUsageElement.textContent = hasMemoryUsage ? `Memory usage: ${memoryUsageMB} MB` : '';
    memoryUsageElement.classList.toggle('blank', !hasMemoryUsage);

    const contextualIdentityElement = this.panel.querySelector('.in-content-panel-contextual-identity');
    contextualIdentityElement.classList.toggle('hidden', !contextualIdentity);

    if (typeof title == 'string' ||
        typeof url == 'string') {
      const titleElement = this.panel.querySelector('.in-content-panel-title');
      titleElement.textContent = title;

      const urlElement = this.panel.querySelector('.in-content-panel-url');
      urlElement.textContent = url;
      urlElement.classList.toggle('blank', !url);

      if (contextualIdentity) {
        contextualIdentityElement.querySelector('.contextual-identity').style.setProperty('--identity-fill-color', `var(--identity-fill-color-${contextualIdentity.color})`);
        contextualIdentityElement.querySelector('.label').textContent = contextualIdentity.name;
        contextualIdentityElement.querySelector('.icon').src = /^[^:]+:\/\//.test(contextualIdentity.iconUrl) ? contextualIdentity.iconUrl : browser.runtime.getURL(contextualIdentity.iconUrl);
      }

      this.panel.classList.remove('extended');
      this.root.classList.remove('extended');
    }

    if (!hasPreview) {
      this.log('updateUI: no preview, complete now');
      return;
    }

    try {
      const { width, height } = !previewImage.src || previewImage.src == this.DATA_URI_BLANK_PNG ?
        { width: this.BASE_PANEL_WIDTH, height: this.BASE_PANEL_HEIGHT } :
        this.getPngDimensionsFromDataUri(previewURL);
      this.log('updateUI: determined preview size: ', { width, height });
      const imageWidth = Math.min(window.innerWidth, Math.min(width, parseInt(this.BASE_PANEL_WIDTH)) / scale);
      const imageHeight = imageWidth / width * height;
      previewImage.style.width = previewImage.style.maxWidth = `min(100%, ${imageWidth}px)`;
      previewImage.style.height = previewImage.style.maxHeight = `${imageHeight}px`;
      requestAnimationFrame(complete);
      return true;
    }
    catch(error) {
      this.log('updateUI: could not detemine preview size ', error, previewURL);
    }

    // failsafe: if it is not a png or failed to get dimensions, give up to determine the image size before loading.
    previewImage.style.width =
    previewImage.style.height =
    previewImage.style.maxWidth =
    previewImage.style.maxHeight = '';
    previewImage.addEventListener('load', complete, { once: true });
    previewImage.addEventListener('error', complete, { once: true });
    return true;
  }

  onBeforeCompleteUpdate({ complete }) {
    const previewImage = this.panel.querySelector('.in-content-panel-image');
    previewImage.removeEventListener('load', complete);
    previewImage.removeEventListener('error', complete);
  }

  onCompleteUpdate() {
    const panelBox = this.panel.getBoundingClientRect();
    const panelHeight = panelBox.height;

    const contentsHeight = this.panel.querySelector('.in-content-panel-contents-inner-box').getBoundingClientRect().height;
    this.panel.classList.toggle('overflow', contentsHeight > panelHeight);
    this.log(`${this.type} updateUI/complete: overflow: `, contentsHeight, ' > ', panelHeight);
  }

  getPngDimensionsFromDataUri(uri) {
    if (!/^data:image\/png;base64,/i.test(uri))
      throw new Error('impossible to parse as PNG image data ', uri);

    const base64Data = uri.split(',')[1];
    const binaryData = atob(base64Data);
    const byteArray = new Uint8Array(binaryData.length);
    const requiredScanSize = Math.min(binaryData.length, 24);
    for (let i = 0; i < requiredScanSize; i++) {
      byteArray[i] = binaryData.charCodeAt(i);
    }
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < pngSignature.length; i++) {
      if (byteArray[i] !== pngSignature[i])
        throw new Error('invalid PNG header');
    }
    const width =
    (byteArray[16] << 24) |
    (byteArray[17] << 16) |
    (byteArray[18] << 8) |
    byteArray[19];
    const height =
    (byteArray[20] << 24) |
    (byteArray[21] << 16) |
    (byteArray[22] << 8) |
    byteArray[23];
    return { width, height };
  }
}
