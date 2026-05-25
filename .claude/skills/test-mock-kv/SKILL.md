---
name: test-mock-kv
description: Mock Upstash KV in a Node test so handler logic can be exercised without network or real credentials.
---

# Mock KV in a test

Kesefle's KV layer is Upstash REST. Tests must not hit it (no creds in CI, no flakiness). Mock at the `fetch` boundary — the lowest-noise, lowest-coupling point — so the handler code under test runs unchanged.

## Steps
1. At the top of the test file, install a fetch mock:
   ```js
   const KV = {};
   const realFetch = globalThis.fetch;
   globalThis.fetch = async (url, init) => {
     const u = String(url);
     // GET /get/<key>
     const get = u.match(/\/get\/(.+)$/);
     if (get) {
       const key = decodeURIComponent(get[1]);
       return { ok: true, json: async () => ({ result: KV[key] ?? null }) };
     }
     // SET /set/<key>/<val>
     const set = u.match(/\/set\/([^/]+)\/(.+)$/);
     if (set) {
       const key = decodeURIComponent(set[1]);
       const val = decodeURIComponent(set[2]);
       KV[key] = val;
       return { ok: true, json: async () => ({ result: 'OK' }) };
     }
     return { ok: false, status: 404, json: async () => ({}) };
   };
   ```
2. Seed records the test depends on: `KV['phone:972526003090'] = JSON.stringify({ sub: 'test-sub' });` etc.
3. Set env: `process.env.KV_REST_API_URL = 'http://mock'; process.env.KV_REST_API_TOKEN = 'mock';` so the handler's fetch fires (otherwise it short-circuits to `null`).
4. After tests: `globalThis.fetch = realFetch;` to avoid bleed into other suites.

## Verification
- Handler under test reads/writes through the mock; no real network call (verify by setting `KV_REST_API_URL` to a bogus host before the mock and confirming no DNS error).
- Assertions on KV contents after handler runs are accurate.

## Common pitfalls
- Forgetting to seed a key → handler returns `no_user_for_phone`, test passes for the wrong reason.
- Mocking only `get` — when the handler also writes (e.g. heal-phone path), state leaks across tests.
- Not restoring real fetch → subsequent unrelated tests see your mock.
- Logging `KV` contents at the end → noisy CI output; gate behind a `VERBOSE` env.
