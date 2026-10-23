import React, { useEffect, useState } from 'react';
import { Input, Select } from './Controls';
import { useAuth } from './contexts';
import { Problem } from './SalesWorkspace';
export function FlowActionEditor({ module, action = { type: 'createActivity', config: {} }, onChange }) {
  const { apiFetch } = useAuth();
  const [metadata, setMetadata] = useState({ fields: [], relations: [] }), [target, setTarget] = useState({ fields: [] }), [error, setError] = useState('');
  useEffect(() => { apiFetch('/flows/field-metadata/' + module).then(setMetadata).catch(e => setError(e.message)); }, [module, apiFetch]);
  const relation = metadata.relations.find(r => r.name === action.config?.relation);
  useEffect(() => { if (relation) apiFetch('/flows/field-metadata/' + relation.module).then(setTarget).catch(e => setError(e.message)); }, [relation?.module, apiFetch]);
  const fields = action.type === 'updateRelated' ? target.fields : metadata.fields;
  const field = fields.find(f => f.name === action.config?.field);
  const set = (key, value) => onChange({ ...action, config: { ...action.config, [key]: value } });
  return <div className="space-y-2"><Problem message={error} /><Select label="Action" value={action.type} options={['updateField','updateRelated','createActivity','createNotification']} onChange={type => onChange({ type, config: {} })} />
    {action.type === 'updateRelated' && <Select label="Relationship" placeholder="Choose related records" value={action.config?.relation || ''} options={metadata.relations.map(r => ({ value: r.name, label: r.name + ' · ' + r.module }))} onChange={v => onChange({ ...action, config: { relation: v } })} />}
    {['updateField','updateRelated'].includes(action.type) ? <><Select label="Field" placeholder="Choose a field" value={action.config?.field || ''} options={fields.map(f => ({ value: f.name, label: f.name + ' · ' + f.type }))} onChange={v => set('field',v)} />{field?.type === 'Boolean' ? <Select label="New value" value={String(action.config?.value ?? false)} options={['true','false']} onChange={v => set('value', v === 'true')} /> : <Input label="New value" type={['Int','Float'].includes(field?.type) ? 'number' : 'text'} value={action.config?.value ?? ''} onChange={v => set('value', ['Int','Float'].includes(field?.type) ? Number(v) : v)} />}</> : <Input label="Subject or title" value={action.config?.subject || action.config?.title || ''} onChange={v => onChange({ ...action, config: { subject: v, title: v } })} />}
  </div>;
}
