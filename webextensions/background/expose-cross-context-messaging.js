/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// Exposes the module for common/tst-api.js and
// common/tabs-internal-operation.js: dynamic import() is disallowed in the
// MV3 service worker, and they register their handlers (e.g. for closing
// tabs from a group tab) while they are evaluated. A module body runs only
// after everything it imports, so this cannot be done by background/index.js
// (they are among its imports): the service worker entry point imports this
// module before it.
import CrossContextMessaging from '/extlib/cross-context-messaging-bg.js';

globalThis.__treestyletabCrossContextMessaging = CrossContextMessaging;
