/**
 * Document Template Generator
 * Generates printable HTML for quotes and invoices.
 * Can be rendered client-side, printed to PDF, or served as HTML.
 */

function generateDocumentHtml(type, data) {
  const isInvoice = type === 'INVOICE';
  const title = isInvoice ? 'Invoice' : 'Quote';
  const number = data.number || '';
  const dateStr = formatDate(data.date);
  const dueStr = isInvoice ? formatDate(data.dueDate) : formatDate(data.validUntil);
  const dueDateLabel = isInvoice ? 'Due Date' : 'Valid Until';

  const items = (data.items || []).map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">${esc(item.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${esc(item.sku || '')}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${currency(item.unitPrice)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${item.discount ? currency(item.discount) : '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${currency(item.total)}</td>
    </tr>
  `).join('');

  const accountAddr = data.account ? [
    data.account.name,
    data.account.address,
    [data.account.city, data.account.state, data.account.zip].filter(Boolean).join(', '),
    data.account.country,
  ].filter(Boolean).join('<br>') : '';

  const contactInfo = data.contact ? [
    `${data.contact.firstName || ''} ${data.contact.lastName || ''}`.trim(),
    data.contact.email,
    data.contact.phone,
  ].filter(Boolean).join('<br>') : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title} ${number}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#333; padding:40px; max-width:800px; margin:auto; }
    .header { display:flex; justify-content:space-between; margin-bottom:40px; }
    .header h1 { font-size:28px; color:#1a1a2e; }
    .badge { display:inline-block; padding:4px 12px; border-radius:4px; font-size:12px; font-weight:600; text-transform:uppercase; }
    .badge-draft { background:#ffeaa7; color:#d35400; }
    .badge-sent { background:#dfe6e9; color:#2d3436; }
    .badge-accepted { background:#55efc4; color:#00b894; }
    .badge-paid { background:#55efc4; color:#00b894; }
    .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:30px; margin-bottom:30px; }
    .info-block h3 { font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#999; margin-bottom:8px; }
    .info-block p { font-size:14px; line-height:1.6; }
    table { width:100%; border-collapse:collapse; margin-bottom:30px; }
    thead th { padding:10px 8px; text-align:left; border-bottom:2px solid #1a1a2e; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:#666; }
    .totals { margin-left:auto; width:300px; }
    .totals .row { display:flex; justify-content:space-between; padding:6px 0; font-size:14px; }
    .totals .total { border-top:2px solid #1a1a2e; font-size:18px; font-weight:700; padding-top:10px; margin-top:6px; }
    .terms { margin-top:40px; padding-top:20px; border-top:1px solid #eee; }
    .terms h3 { font-size:12px; text-transform:uppercase; color:#999; margin-bottom:8px; }
    .terms p { font-size:13px; color:#666; line-height:1.6; }
    .footer { margin-top:60px; text-align:center; font-size:11px; color:#aaa; }
    @media print { body { padding:20px; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${title}</h1>
      <p style="color:#666;margin-top:4px;">#${esc(number)}</p>
    </div>
    <div style="text-align:right;">
      <span class="badge badge-${(data.status || '').toLowerCase()}">${esc(data.status || 'Draft')}</span>
      <p style="margin-top:8px;font-size:13px;color:#666;">Date: ${dateStr}</p>
      <p style="font-size:13px;color:#666;">${dueDateLabel}: ${dueStr}</p>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-block">
      <h3>Bill To</h3>
      <p>${accountAddr || '<em>No account</em>'}</p>
    </div>
    <div class="info-block">
      <h3>Contact</h3>
      <p>${contactInfo || '<em>No contact</em>'}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th style="text-align:center;">SKU</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Unit Price</th>
        <th style="text-align:right;">Discount</th>
        <th style="text-align:right;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${items || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#999;">No items</td></tr>'}
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Subtotal</span><span>${currency(data.subtotal)}</span></div>
    ${data.discount ? `<div class="row"><span>Discount</span><span style="color:#e74c3c;">-${currency(data.discount)}</span></div>` : ''}
    <div class="row"><span>Tax</span><span>${currency(data.tax)}</span></div>
    <div class="row total"><span>Total</span><span>${currency(data.total)}</span></div>
  </div>

  ${data.terms ? `<div class="terms"><h3>Terms</h3><p>${esc(data.terms)}</p></div>` : ''}
  ${data.notes ? `<div class="terms"><h3>Notes</h3><p>${esc(data.notes)}</p></div>` : ''}

  <div class="footer">
    <p>Generated by Sales Nebula CRM</p>
  </div>

  <script>
    // Auto-trigger print dialog if opened in browser
    if (window.location.search.includes('print=true')) {
      window.onload = () => window.print();
    }
  </script>
</body>
</html>`;
}

function formatDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function currency(amount, currencyCode = 'USD') {
  if (amount === null || amount === undefined) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(amount);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { generateDocumentHtml };
