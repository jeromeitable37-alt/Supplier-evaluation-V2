/**
 * New Supplier Evaluation project: Cloudflare Worker + Supabase + Resend.
 * All admin endpoints require a valid Supabase Auth user listed in admin_users.
 * No API secrets or evaluation tokens are logged.
 */

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function validEmail(input) {
  return typeof input === 'string' && input.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(input);
}

function validFrom(input) {
  if (typeof input !== 'string' || input.length > 320) return false;
  const match = /^([^<>\r\n]{1,100}) <([^<>]+)>$/.exec(input);
  return validEmail(match ? match[2] : input);
}

function validUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '');
}

async function getPayload(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 16384) throw new Error('Request too large.');
  const body = await request.text();
  if (body.length > 16384) throw new Error('Request too large.');
  return JSON.parse(body || '{}');
}

function assertSupabaseConfigured(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }
  if (!/^https:\/\/[^/]+\.supabase\.co\/?$/.test(env.SUPABASE_URL)) {
    throw new Error('SUPABASE_URL must be your Supabase project URL.');
  }
}

async function supabaseRest(env, path, options = {}) {
  assertSupabaseConfigured(env);
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
  if (!r.ok) throw new Error(`Database request failed (${r.status}).`);
  return data;
}

async function requireAdmin(request, env) {
  const match = /^Bearer (.+)$/i.exec(request.headers.get('authorization') || '');
  if (!match) return null;
  assertSupabaseConfigured(env);
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${match[1]}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!validUuid(user.id)) return null;
  const matches = await supabaseRest(env, `admin_users?user_id=eq.${user.id}&select=user_id&limit=1`);
  return Array.isArray(matches) && matches.length > 0 ? user : null;
}

function b64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signToken(id, env) {
  if (!env.EVALUATION_TOKEN_SECRET || env.EVALUATION_TOKEN_SECRET.length < 32) {
    throw new Error('EVALUATION_TOKEN_SECRET must be at least 32 characters.');
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.EVALUATION_TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)));
  return `${id}.${b64url(signature)}`;
}

async function verifyToken(raw, env) {
  const match = /^([a-f\d-]{36})\.([A-Za-z\d_-]{43})$/i.exec(String(raw || ''));
  if (!match || !validUuid(match[1])) return null;
  const expected = (await signToken(match[1], env)).split('.')[1];
  // Compare every character without returning early.
  let mismatch = expected.length ^ match[2].length;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ (match[2].charCodeAt(i) || 0);
  return mismatch === 0 ? match[1] : null;
}

function publicEvaluationUrl(id, env) {
  if (!env.APP_BASE_URL) throw new Error('APP_BASE_URL is missing.');
  const url = new URL(env.APP_BASE_URL);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('APP_BASE_URL must be HTTPS.');
  return new URL('/evaluate.html', url).toString();
}

async function createRequest(body, user, env) {
  const poNumber = String(body.poNumber || '').trim();
  const supplierName = String(body.supplierName || '').trim();
  const evaluatorName = String(body.evaluatorName || '').trim();
  const evaluatorEmail = String(body.evaluatorEmail || '').trim().toLowerCase();
  if (!poNumber || poNumber.length > 80 || !supplierName || supplierName.length > 160 ||
      !evaluatorName || evaluatorName.length > 120 || !validEmail(evaluatorEmail)) {
    return response({ ok: false, error: 'Enter a valid PO number, supplier, evaluator name and email.' }, 400);
  }
  const inserted = await supabaseRest(env, 'evaluation_requests?select=id,po_number,supplier_name,evaluator_name,evaluator_email,status,created_at', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ po_number: poNumber, supplier_name: supplierName, evaluator_name: evaluatorName, evaluator_email: evaluatorEmail, created_by: user.id }),
  });
  return response({ ok: true, item: inserted[0] }, 201);
}

async function listRequests(env) {
  const items = await supabaseRest(env, 'evaluation_requests?select=id,po_number,supplier_name,evaluator_name,evaluator_email,status,email_sent_at,submitted_at,created_at,resend_email_id&order=created_at.desc&limit=100');
  return response({ ok: true, items });
}

function emailHtml(item, url) {
  const po = escapeHtml(item.po_number);
  const supplier = escapeHtml(item.supplier_name);
  const name = escapeHtml(item.evaluator_name);
  const safeUrl = escapeHtml(url);
  return `<!doctype html><html lang="en"><body style="background:#f4f5fb;padding:24px;font-family:Arial,sans-serif;color:#1f2937"><div style="max-width:680px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden"><div style="background:#4f247c;color:white;padding:24px"><div style="font-size:12px;letter-spacing:1px">SUPPLIER EVALUATION</div><h1 style="font-size:24px;margin:8px 0">Evaluation Request</h1><p style="margin:0">PO ${po}</p></div><div style="padding:24px"><p>Hello <strong>${name}</strong>,</p><p>You're invited to complete the supplier evaluation for this Purchase Order.</p><table style="border-collapse:collapse;width:100%;margin:20px 0"><tr><td style="padding:10px;background:#f8fafc">PO Number</td><td style="padding:10px;background:#f8fafc">${po}</td></tr><tr><td style="padding:10px">Supplier</td><td style="padding:10px">${supplier}</td></tr></table><p style="text-align:center;margin:32px 0"><a href="${safeUrl}" style="background:#238356;color:white;padding:14px 22px;text-decoration:none;border-radius:8px">Complete Evaluation</a></p><p style="font-size:12px;color:#6b7280">This unique evaluation link is for its intended recipient. Only one submission is allowed.</p></div></div></body></html>`;
}

async function sendRequestEmail(id, env) {
  const [item] = await supabaseRest(env, `evaluation_requests?id=eq.${id}&select=id,po_number,supplier_name,evaluator_name,evaluator_email,status&limit=1`);
  if (!item) return response({ ok: false, error: 'Evaluation request not found.' }, 404);
  if (item.status !== 'pending') return response({ ok: false, error: 'Already sent, submitted or currently being processed.' }, 409);
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !validFrom(env.RESEND_FROM_EMAIL)) {
    return response({ ok: false, error: 'Resend is not configured. Add a verified From domain and API key.' }, 503);
  }
  if (!validEmail(env.RESEND_REPLY_TO_EMAIL)) return response({ ok: false, error: 'RESEND_REPLY_TO_EMAIL must be a valid Gmail address.' }, 503);
  const claimed = await supabaseRest(env, `evaluation_requests?id=eq.${id}&status=eq.pending&select=id`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'sending' }),
  });
  if (!claimed?.length) return response({ ok: false, error: 'Request was already claimed.' }, 409);
  try {
    const token = await signToken(item.id, env);
    const url = new URL(publicEvaluationUrl(item.id, env));
    url.searchParams.set('token', token);
    const subject = `Supplier Evaluation Request | PO ${item.po_number}`.replace(/[\r\n]/g, ' ');
    const payload = {
      from: env.RESEND_FROM_EMAIL,
      reply_to: env.RESEND_REPLY_TO_EMAIL,
      to: [item.evaluator_email],
      subject,
      html: emailHtml(item, url.toString()),
      text: `Hello ${item.evaluator_name},\n\nPlease complete the evaluation for PO ${item.po_number} (${item.supplier_name}).\n\n${url.toString()}\n\nThis link can only be submitted once.`,
    };
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `supplier-evaluation/${id}` },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.id) throw new Error(`Resend rejected this email (${r.status}). Check domain verification and API key.`);
    await supabaseRest(env, `evaluation_requests?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'sent', email_sent_at: new Date().toISOString(), resend_email_id: data.id }),
    });
    return response({ ok: true, message: 'Accepted by Resend (Inbox delivery not guaranteed).', resend_email_id: data.id });
  } catch (error) {
    // A transient error can leave status "sending"; never automatically resend on uncertain outcomes.
    // If Resend accepted the email but updating the DB failed, a human should reconcile it.
    return response({ ok: false, error: error instanceof Error ? error.message : 'Could not send email.', note: 'Review Resend delivery logs before retrying. The request is locked to prevent duplicates.' }, 502);
  }
}

async function publicGet(token, env) {
  const id = await verifyToken(token, env);
  if (!id) return response({ ok: false, error: 'Invalid evaluation link.' }, 404);
  const [item] = await supabaseRest(env, `evaluation_requests?id=eq.${id}&select=po_number,supplier_name,evaluator_name,status&limit=1`);
  if (!item) return response({ ok: false, error: 'Evaluation not found.' }, 404);
  return response({ ok: true, item });
}

async function publicSubmit(body, env) {
  const id = await verifyToken(body.token, env);
  if (!id) return response({ ok: false, error: 'Invalid evaluation link.' }, 404);
  const rating = Number(body.rating);
  const comments = String(body.comments || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || comments.length > 2000) {
    return response({ ok: false, error: 'Rating must be 1–5; comments must be under 2,000 characters.' }, 400);
  }
  const changed = await supabaseRest(env, `evaluation_requests?id=eq.${id}&status=eq.sent&select=id`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'submitted', rating, comments, submitted_at: new Date().toISOString() }),
  });
  if (!changed?.length) return response({ ok: false, error: 'This evaluation is already submitted or unavailable.' }, 409);
  return response({ ok: true, message: 'Evaluation submitted successfully.' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return response({ ok: true, service: 'Supplier Evaluation — Resend starter', emailConfigured: Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && env.RESEND_REPLY_TO_EMAIL), databaseConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY) });
      }
      if (url.pathname === '/api/config' && request.method === 'GET') {
        return response({ supabaseUrl: env.SUPABASE_URL || '', supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY || '' });
      }
      if (url.pathname === '/api/public-evaluation' && request.method === 'GET') return publicGet(url.searchParams.get('token'), env);
      if (url.pathname === '/api/public-evaluation' && request.method === 'POST') return publicSubmit(await getPayload(request), env);
      if (url.pathname.startsWith('/api/')) {
        const admin = await requireAdmin(request, env);
        if (!admin) return response({ ok: false, error: 'Admin login required.' }, 401);
        if (url.pathname === '/api/requests' && request.method === 'GET') return listRequests(env);
        if (url.pathname === '/api/requests' && request.method === 'POST') return createRequest(await getPayload(request), admin, env);
        const send = /^\/api\/requests\/([\da-f-]{36})\/send$/.exec(url.pathname);
        if (send && request.method === 'POST' && validUuid(send[1])) return sendRequestEmail(send[1], env);
        return response({ ok: false, error: 'API endpoint not found.' }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof SyntaxError ? 'Invalid JSON.' : error instanceof Error ? error.message : 'Unexpected server error.';
      return response({ ok: false, error: message }, error instanceof SyntaxError ? 400 : 500);
    }
  },
};
