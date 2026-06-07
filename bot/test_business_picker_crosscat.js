#!/usr/bin/env node
// bot/test_business_picker_crosscat.js  (auto-discovered by the gauntlet)
// Locks the business-ambiguity picker cross-category option (Steven 2026-06-07):
// the picker now offers a few REGULAR (non-business) categories, and a picked
// regular option is written to ITS OWN category (not forced to 'עסק') and does
// NOT touch the business dashboard. Structural asserts over the source (the
// consumer is deeply inline in processExpense).
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label); } }

// the picker arrays carry regular categories (appears in BOTH the matched and
// the bare picker -> at least 2 occurrences of each).
ok("offers 'אוכל לבית' as a regular option (x2 arrays)",
  (SRC.match(/category: 'אוכל',\s*subcategory: 'אוכל לבית'/g) || []).length >= 2);
ok("offers 'דלק' (תחבורה) as a regular option (x2)",
  (SRC.match(/category: 'תחבורה', subcategory: 'דלק'/g) || []).length >= 2);
ok("offers 'בריאות' as a regular option (x2)",
  (SRC.match(/category: 'בריאות', subcategory: 'בריאות'/g) || []).length >= 2);

// consumer honors the picked option's category (not hardcoded 'עסק').
ok("consumer uses __hPicked.category || 'עסק'", /var __hPCategory = __hPicked\.category \|\| 'עסק';/.test(SRC));
ok('consumer derives __hPIsBiz', /var __hPIsBiz = \(__hPCategory === 'עסק'\);/.test(SRC));

// a personal pick must NOT canonicalize to a company-dashboard bucket.
ok('normalize-to-company gated on __hPIsBiz', /__hPDashSub = \(__hPIsBiz && typeof _normalizeSubForDashboard_/.test(SRC));

// a personal pick must NOT update the business dashboard / note.
ok('business dashboard mirror gated on __hPIsBiz', /if \(__hPIsBiz\) \{[\s\S]{0,90}_updateBusinessDashboard_/.test(SRC));

// footer invites a regular category by name.
ok('footer mentions a regular category', /או הקלד כל קטגוריה אחרת \(גם רגילה\)/.test(SRC));

// safety: the existing business options still have NO category field (default
// to 'עסק') so business picks are unchanged.
ok("business option 'שיווק' still has no category field", /\{ label: 'שיווק',\s*subcategory: 'שיווק' \}/.test(SRC));

console.log('test_business_picker_crosscat: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
