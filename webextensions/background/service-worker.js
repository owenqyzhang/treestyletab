/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Chrome MV3 service worker entry point. The compat layer must be
# imported (and thus evaluated) before any other module so that the
# `browser` global is patched before anything registers listeners.
*/
'use strict';

import '/common/browser-compat.js';
import './index.js';
