/**
 * Recycle bin entries: the snapshot a delete files, to restore the record from
 * within 30 days, and the name the bin lists and searches it by. The name was
 * read out of the JSON snapshot for display only, so the bin could not be
 * searched.
 */

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// A person is known by their name, else their email; anything else by its
// name or subject, else its number. Migration 20261020100000_recycle_bin_item_name
// names the entries already in the bin the same way.
const PEOPLE = new Set(['contacts', 'leads', 'personAccounts', 'prospects']);
const NAME_KEYS = [
  'name', 'subject', 'number', 'invoiceNumber', 'quoteNumber', 'orderNumber', 'contractNumber',
  'caseNumber', 'workOrderNumber', 'subscriptionNumber', 'email', 'to',
];

function binName(module, snapshot) {
  const record = (typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot) || {};
  const value = key => (record[key] == null ? '' : String(record[key]).trim());
  const person = PEOPLE.has(module) ? [value('firstName'), value('lastName')].filter(Boolean).join(' ') : '';
  return (person || NAME_KEYS.map(value).find(Boolean) || '').slice(0, 300) || null;
}

/** The entry for a record deleted from `module`. */
function binEntry(module, record, deletedById) {
  return {
    module,
    recordId: record.id,
    recordData: record,
    name: binName(module, record),
    deletedById,
    expiresAt: new Date(Date.now() + RETENTION_MS),
  };
}

module.exports = { binName, binEntry };
