import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const env = { ASSETS: { fetch: () => new Response('static') } };

test('health reports incomplete setup without exposing secrets', async () => {
  const r = await worker.fetch(new Request('https://example.workers.dev/api/health'), env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    ok: true, service: 'Supplier Evaluation — Resend starter', emailConfigured: false, databaseConfigured: false,
  });
});

test('unauthenticated sends are forbidden', async () => {
  const r = await worker.fetch(new Request('https://example.workers.dev/api/requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/send', { method: 'POST' }), env);
  assert.equal(r.status, 401);
});

test('invalid public links do not expose evaluation data', async () => {
  const r = await worker.fetch(new Request('https://example.workers.dev/api/public-evaluation?token=bad'), env);
  assert.equal(r.status, 404);
});

test('non-API routes return static assets', async () => {
  const r = await worker.fetch(new Request('https://example.workers.dev/'), env);
  assert.equal(await r.text(), 'static');
});

test('authorized send uses verified From and Gmail Reply-To for another recipient domain', async () => {
  const originalFetch = globalThis.fetch;
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const adminId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const envWithEmail = {
    ...env,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_demo',
    SUPABASE_SERVICE_ROLE_KEY: 'legacy_service_role_demo',
    EVALUATION_TOKEN_SECRET: 'a-long-random-secret-longer-than-32-characters',
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'Supplier Evaluation <evaluation@example.com>',
    RESEND_REPLY_TO_EMAIL: 'fyreboji@gmail.com',
    APP_BASE_URL: 'https://example.workers.dev',
  };
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const ok = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/v1/user')) return ok({ id: adminId });
    if (url.includes('admin_users?')) return ok([{ user_id: adminId }]);
    if (url.includes('evaluation_requests?id=eq.') && init.method === 'PATCH' && url.includes('status=eq.pending')) return ok([{ id }]);
    if (url.includes('evaluation_requests?id=eq.') && init.method === 'PATCH') return ok(null);
    if (url.includes('evaluation_requests?id=eq.')) return ok([{ id, po_number: 'PO 100', supplier_name: '<script>alert(1)</script>', evaluator_name: 'A. Evaluator', evaluator_email: 'employee@sgen.edu.ph', status: 'pending' }]);
    if (url === 'https://api.resend.com/emails') return ok({ id: 'resend-accepted-id' });
    throw new Error('Unexpected fetch ' + url);
  };
  try {
    const r = await worker.fetch(new Request(`https://example.workers.dev/api/requests/${id}/send`, {
      method: 'POST', headers: { Authorization: 'Bearer demo-jwt' },
    }), envWithEmail);
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    const data = await r.json();
    assert.equal(data.resend_email_id, 'resend-accepted-id');
    const resend = requests.find((item) => item.url === 'https://api.resend.com/emails');
    const payload = JSON.parse(resend.init.body);
    assert.equal(payload.reply_to, 'fyreboji@gmail.com');
    assert.equal(payload.from, 'Supplier Evaluation <evaluation@example.com>');
    assert.deepEqual(payload.to, ['employee@sgen.edu.ph']);
    assert.equal(resend.init.headers['Idempotency-Key'], `supplier-evaluation/${id}`);
    assert.match(payload.text, /evaluate\.html\?token=/);
    assert.doesNotMatch(payload.html, /<script>alert\(1\)<\/script>/);
    assert.match(payload.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
