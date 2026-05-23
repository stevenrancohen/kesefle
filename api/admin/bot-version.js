// api/admin/bot-version.js
//
// Admin-only: detects when the deployed Apps Script bot is running an
// older KFL_BUILD_VERSION than what's in the repo. The bot pushes its
// version via the `x-kesefle-bot-version` header on every /api/whatsapp/
// link?phone= GET call; we stash the latest into KV `bot_version_latest`.
// This endpoint reads it back and compares to the repo's bot/ExpenseBot_
// FIXED.gs source.
//
// Returns { ok, deployed, repo, drift, last_seen_at, stale_minutes }.

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

// Read the version constant from the bot source. Vercel bundles files at
// build time, so we can fs.readFileSync at runtime if the path was
// included. We grep for the literal pattern.
function readRepoBotVersion() {
  try {
    // The bot source is at repo root: bot/ExpenseBot_FIXED.gs. Lambda fs
    // exposes the function's bundle root via process.cwd().
    const candidates = [
      path.join(process.cwd(), 'bot', 'ExpenseBot_FIXED.gs'),
      path.join(process.cwd(), '..', 'bot', 'ExpenseBot_FIXED.gs'),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, 'utf8');
      const m = src.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
  } catch (_e) { /* fall through */ }
  return null;
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const deployed = await kvGet('bot_version_latest');
  const repoVersion = readRepoBotVersion();
  const deployedVersion = deployed?.version || null;
  const deployedAt = deployed?.at || null;
  const staleMinutes = deployedAt ? Math.round((Date.now() - deployedAt) / 60000) : null;

  const drift = deployedVersion && repoVersion && deployedVersion !== repoVersion;
  const unknown = !deployedVersion || !repoVersion;

  return res.status(200).json({
    ok: true,
    deployed_version: deployedVersion,
    repo_version: repoVersion,
    last_seen_at: deployedAt ? new Date(deployedAt).toISOString() : null,
    stale_minutes: staleMinutes,
    drift,
    unknown,
    // Recommendation surfaced by the launch monitor UI.
    note: drift
      ? `Bot is running ${deployedVersion} but repo is at ${repoVersion}. Re-paste bot/ExpenseBot_DEPLOY.gs in Apps Script and deploy a new version.`
      : (deployedVersion && staleMinutes != null && staleMinutes > 60
          ? `Bot last reported ${staleMinutes} min ago. If the bot is being actively used, the deployed bot is sending too few messages or has lost connectivity.`
          : null),
  });
}

export default withRequestId(requireAdmin(handlerImpl));
