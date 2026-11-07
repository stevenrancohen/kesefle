#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api/ui-preferences.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');

assert.match(api, /requireAuth\(handlerImpl\)/, 'preferences endpoint must require a verified user');
assert.match(api, /const PERSONAS = \['single', 'employee', 'couple', 'family', 'freelancer', 'business', 'mixed'\]/);
assert.match(api, /const SPACES = \['personal', 'household', 'business'\]/);
assert.match(api, /ui:\$\{userSub\}/, 'preferences must be tenant-scoped');
assert.doesNotMatch(api, /taxId/, 'UI response must not expose tax identifiers');
assert.match(app, /\/api\/ui-preferences/);
assert.match(app, /data-space="personal"/);
assert.match(app, /data-space="household"/);
assert.match(app, /data-space="business"/);
assert.match(app, /aria-label="בחירת מרחב כספי"/);
assert.match(app, /function filterRowsForSpace/);
assert.match(app, /min-height:44px/, 'interactive controls should meet mobile touch target guidance');

console.log('UI preferences/persona contract: PASS');
