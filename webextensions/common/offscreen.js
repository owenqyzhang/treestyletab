/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Offscreen document: reports the system color scheme to the service
# worker (which has no matchMedia).
*/
'use strict';

const COLOR_SCHEME_MESSAGE_TYPE = 'treestyletab:compat-color-scheme';

const query = window.matchMedia('(prefers-color-scheme: dark)');

function report() {
  chrome.runtime.sendMessage({
    type: COLOR_SCHEME_MESSAGE_TYPE,
    dark: query.matches,
  }).catch(_error => {});
}

query.addEventListener('change', report);
report();
