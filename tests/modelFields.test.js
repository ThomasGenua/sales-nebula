/**
 * pickModelFields: what a form or API client may send for a record's columns.
 *
 * A link picker put back on "Select…" sends "". Kept as an id it matches no
 * record and the database refuses it with a foreign key error, which the
 * caller saw as a 500.
 */
const { pickModelFields } = require('../src/utils/modelFields');

describe('pickModelFields, links', () => {
  it('turns a blank link into no link', () => {
    const { data } = pickModelFields('deal', { name: 'Big one', accountId: '', contactId: '   ', ownerId: '' });
    expect(data).toEqual({ name: 'Big one', accountId: null, contactId: null, ownerId: null });
  });

  it('keeps a real id as it is', () => {
    const { data } = pickModelFields('deal', { accountId: 'a1b2c3', contactId: null });
    expect(data).toEqual({ accountId: 'a1b2c3', contactId: null });
  });

  it('drops a blank link the record cannot do without, rather than sending an empty id', () => {
    const { data } = pickModelFields('dealStageHistory', { dealId: '', toStage: 'Proposal' });
    expect(data).toEqual({ toStage: 'Proposal' });
  });

  it('leaves a blank text column alone: only links change meaning', () => {
    const { data } = pickModelFields('deal', { description: '', source: '' });
    expect(data).toEqual({ description: '', source: '' });
  });

  it('still coerces numbers and dates typed as text, and drops what the model does not have', () => {
    const { data, ignored } = pickModelFields('deal', { value: '5000', probability: '', closeDate: '2026-12-01', nonsense: 1, account: { id: 'x' } });
    expect(data.value).toBe(5000);
    expect(data.closeDate).toBeInstanceOf(Date);
    expect('probability' in data).toBe(false); // required column: a blank leaves it as it is
    expect(ignored.sort()).toEqual(['account', 'nonsense']);
  });
});
