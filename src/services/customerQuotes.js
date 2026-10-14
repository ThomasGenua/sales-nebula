const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (value, currency) => currency + ' ' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function snapshot(quote, currency) {
  return { number: quote.number, date: quote.createdAt.toISOString(), validUntil: quote.validUntil?.toISOString() || null, currency, account: quote.account?.name || '', contact: quote.contact ? [quote.contact.firstName, quote.contact.lastName].filter(Boolean).join(' ') : '', terms: quote.terms || '', subtotal: quote.subtotal, discount: quote.discount, tax: quote.tax, total: quote.total,
    items: quote.items.map(i => ({ name: i.product?.name || i.description || 'Item', description: i.description || '', quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount, total: i.total })) };
}
async function loadQuote(db, id) {
  return db.quote.findFirst({ where: { id, deletedAt: null }, include: { items: { include: { product: { select: { name: true } } } }, account: { select: { name: true } }, contact: { select: { firstName: true, lastName: true } } } });
}
function pdf(data, receipt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, right: 48, bottom: 80, left: 48 }, info: { Title: 'Quote ' + data.number, Author: 'Sales Nebula' }, bufferPages: true });
    const chunks = []; doc.on('data', b => chunks.push(b)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#14233e').text('QUOTE');
    doc.fontSize(13).text(data.number).moveDown();
    doc.font('Helvetica').fontSize(10).fillColor('#334155').text('Issued: ' + data.date.slice(0, 10));
    if (data.validUntil) doc.text('Valid until: ' + data.validUntil.slice(0, 10));
    doc.moveDown().font('Helvetica-Bold').text(data.account || data.contact || 'Customer');
    if (data.account && data.contact) doc.font('Helvetica').text(data.contact);
    doc.moveDown();
    const header = () => { doc.font('Helvetica-Bold').fontSize(10).fillColor('#14233e').text('Items', 48, doc.y); doc.moveDown(0.7); };
    header();
    for (const item of data.items) {
      doc.font('Helvetica').fontSize(10);
      const height = Math.max(48, doc.heightOfString(item.name, { width: 310 }) + 25);
      if (doc.y + height > 740) { doc.addPage(); header(); }
      const y = doc.y;
      doc.fillColor('#14233e').text(item.name, 48, y, { width: 310 });
      const nameEnd = doc.y;
      doc.text(money(item.total, data.currency), 370, y, { width: 175, align: 'right' });
      doc.y = Math.max(doc.y, nameEnd) + 5;
      if (item.description && item.description !== item.name) doc.fillColor('#334155').text(item.description, 48, doc.y, { width: 497 });
      doc.fillColor('#64748b').fontSize(9).text(item.quantity + ' × ' + money(item.unitPrice, data.currency) + (item.discount ? '  less ' + money(item.discount, data.currency) : ''), 48, doc.y + 5, { width: 490 });
      doc.moveTo(48, doc.y + 5).lineTo(545, doc.y + 5).strokeColor('#dce2eb').stroke(); doc.y += 15;
    }
    if (doc.y > 590) doc.addPage();
    for (const [label, value] of [['Subtotal', data.subtotal], ['Discount', -data.discount], ['Tax', data.tax], ['Total', data.total]]) {
      doc.font(label === 'Total' ? 'Helvetica-Bold' : 'Helvetica').fontSize(label === 'Total' ? 14 : 10).fillColor('#14233e').text(label + ': ' + money(value, data.currency), 48, doc.y, { width: 497, align: 'right' }); doc.moveDown(0.4);
    }
    if (data.terms) { doc.moveDown().font('Helvetica-Bold').fontSize(11).text('Terms', 48); doc.font('Helvetica').fontSize(10).text(data.terms, { width: 497 }); }
    if (receipt?.acceptedAt) { doc.moveDown().font('Helvetica-Bold').text('Accepted'); doc.font('Helvetica').text(receipt.acceptedName + ' · ' + receipt.acceptedEmail).text(new Date(receipt.acceptedAt).toISOString()); }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // The footer sits below the content margin; prevent PDFKit from flowing it to a new page.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor('#64748b').text('Quote ' + data.number + '   •   ' + (i + 1) + ' / ' + range.count, 48, 780, { width: 497, align: 'center', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
function html(data, receipt, token) {
  const amount = v => escape(money(v, data.currency));
  return '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quote ' + escape(data.number) + '</title><style>body{font:16px system-ui;background:#f4f6fa;color:#14233e;margin:0}main{max-width:800px;margin:32px auto;background:white;padding:32px;border-radius:12px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}.money{text-align:right}label{display:block;margin:16px 0}input{padding:10px}button,a{display:inline-block;padding:12px}button{background:#14233e;color:white;border:0;border-radius:6px}pre{white-space:pre-wrap;font:inherit}</style></head><body><main><h1>Quote ' + escape(data.number) + '</h1><p>' + [data.account, data.contact].filter(Boolean).map(escape).join(' · ') + '</p><p>Issued ' + escape(data.date.slice(0, 10)) + (data.validUntil ? ' · Valid until ' + escape(data.validUntil.slice(0, 10)) : '') + '</p><table><thead><tr><th>Item</th><th>Quantity</th><th>Unit price</th><th>Total</th></tr></thead><tbody>' + data.items.map(i => '<tr><td>' + escape(i.name) + (i.description && i.description !== i.name ? '<br>' + escape(i.description) : '') + '</td><td>' + i.quantity + '</td><td>' + amount(i.unitPrice) + '</td><td>' + amount(i.total) + '</td></tr>').join('') + '</tbody></table><p class="money">Subtotal ' + amount(data.subtotal) + ' · Discount ' + amount(data.discount) + ' · Tax ' + amount(data.tax) + '</p><h2 class="money">Total ' + amount(data.total) + '</h2><h2>Terms</h2><pre>' + escape(data.terms || 'No additional terms.') + '</pre><a href="/api/public/quotes/' + token + '/pdf">Download PDF</a>' + (receipt.acceptedAt ? '<h2>Accepted</h2><p>' + escape(receipt.acceptedName) + ' · ' + escape(new Date(receipt.acceptedAt).toISOString()) + '</p>' : '<h2>Accept this quote</h2><form method="post" action="/api/public/quotes/' + token + '/accept"><label>Your full name <input name="name" required maxlength="150" autocomplete="name"></label><label>Email address <input name="email" type="email" required maxlength="254" autocomplete="email"></label><label><input name="consent" type="checkbox" value="yes" required> I accept this quote and its terms.</label><button type="submit">Accept quote</button></form>') + '</main></body></html>';
}
async function publicShare(db, token) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const share = await db.quoteShare.findUnique({ where: { tokenHash: hash(token) } });
  if (!share || share.revokedAt || share.expiresAt <= new Date()) return null;
  const quote = await db.quote.findFirst({ where: { id: share.quoteId, deletedAt: null } });
  if (!quote || !share.acceptedAt && (quote.updatedAt.getTime() !== share.quoteVersion.getTime() || ['Accepted', 'Rejected'].includes(quote.status))) return null;
  return { share, quote };
}
module.exports = { hash, snapshot, loadQuote, pdf, html, publicShare };
