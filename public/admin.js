let config = null;
let accessToken = '';
const $ = (id) => document.getElementById(id);
const notice = (message, error = false) => {
  const el = $('notice');
  el.textContent = message || '';
  el.className = message ? (error ? 'notice error' : 'notice') : '';
};

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || 'Request failed.');
  return data;
}

async function signIn(e) {
  e.preventDefault();
  notice('Checking admin access…');
  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: config.supabasePublishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error(result.msg || result.error_description || 'Invalid login.');
  accessToken = result.access_token;
  try {
    await showRequests();
    $('loginSection').hidden = true;
    $('appSection').hidden = false;
    $('password').value = '';
    notice('Admin access verified.');
  } catch (error) { accessToken = ''; throw error; }
}

function addText(parent, tag, value, className = '') {
  const item = document.createElement(tag);
  item.textContent = value;
  if (className) item.className = className;
  parent.appendChild(item);
  return item;
}

async function showRequests() {
  const data = await api('/api/requests');
  const list = $('requests');
  list.replaceChildren();
  if (!data.items.length) { addText(list, 'p', 'No evaluation requests yet.', 'muted'); return; }
  for (const item of data.items) {
    const card = document.createElement('article'); card.className = 'request';
    const left = document.createElement('div');
    addText(left, 'b', `PO ${item.po_number}`);
    addText(left, 'p', item.supplier_name, 'small');
    addText(left, 'p', `${item.evaluator_name} · ${item.evaluator_email}`, 'muted small');
    const right = document.createElement('div'); right.className = 'request-actions';
    addText(right, 'span', item.status, 'status');
    if (item.status === 'pending') {
      const send = addText(right, 'button', 'Send evaluation email', 'primary');
      send.type = 'button';
      send.addEventListener('click', async () => {
        if (!confirm(`Send evaluation email to ${item.evaluator_email}?`)) return;
        send.disabled = true; notice('Sending through Resend…');
        try { const result = await api(`/api/requests/${item.id}/send`, { method: 'POST' }); notice(result.message); await showRequests(); }
        catch (err) { notice(err.message, true); await showRequests().catch(() => {}); }
        finally { send.disabled = false; }
      });
    }
    card.append(left, right); list.appendChild(card);
  }
}

async function createRequest(e) {
  e.preventDefault(); notice('Creating evaluation request…');
  const payload = {
    poNumber: $('poNumber').value.trim(), supplierName: $('supplierName').value.trim(),
    evaluatorName: $('evaluatorName').value.trim(), evaluatorEmail: $('evaluatorEmail').value.trim(),
  };
  await api('/api/requests', { method: 'POST', body: JSON.stringify(payload) });
  $('createForm').reset(); notice('Request created. Review it before sending.'); await showRequests();
}

$('loginForm').addEventListener('submit', (event) => { signIn(event).catch((error) => notice(error.message, true)); });
$('createForm').addEventListener('submit', (event) => { createRequest(event).catch((error) => notice(error.message, true)); });
$('refresh').addEventListener('click', () => showRequests().catch((error) => notice(error.message, true)));
$('logout').addEventListener('click', () => { accessToken = ''; $('appSection').hidden = true; $('loginSection').hidden = false; notice('Signed out.'); });
(async () => {
  try {
    config = await fetch('/api/config').then((r) => r.json());
    if (!config.supabaseUrl || !config.supabasePublishableKey) throw new Error('Supabase public configuration is not set yet.');
  } catch (error) { notice(error.message, true); $('loginForm').querySelector('button').disabled = true; }
})();
