const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token') || '';
function message(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'notice error' : 'notice'; }
async function request(path, options = {}) {
  const r = await fetch(path, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || 'Could not load evaluation.');
  return data;
}
async function load() {
  if (!token) throw new Error('Missing evaluation token.');
  const data = await request('/api/public-evaluation?token=' + encodeURIComponent(token));
  if (data.item.status === 'submitted') { message('This evaluation has already been submitted. Thank you!'); return; }
  if (data.item.status !== 'sent') { message('This evaluation is not available yet.', true); return; }
  const details = $('details');
  for (const [key, value] of [['PO Number', data.item.po_number], ['Supplier', data.item.supplier_name], ['Evaluator', data.item.evaluator_name]]) {
    const p = document.createElement('p'); p.className = 'detail';
    const label = document.createElement('strong'); label.textContent = key + ': ';
    p.append(label, document.createTextNode(value)); details.appendChild(p);
  }
  $('formCard').hidden = false; message('Please rate the supplier and submit once.');
}
$('evaluationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('evaluationForm').querySelector('button'); button.disabled = true;
  try {
    await request('/api/public-evaluation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, rating: Number($('rating').value), comments: $('comments').value }) });
    $('formCard').hidden = true; message('Evaluation submitted successfully. Thank you!');
  } catch (error) { message(error.message, true); button.disabled = false; }
});
load().catch((err) => message(err.message, true));
