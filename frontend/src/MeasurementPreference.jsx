import React, { useEffect, useState } from 'react';
import { measurementAllowed, setMeasurement } from './marketing';
export default function MeasurementPreference() {
  const [enabled, setEnabled] = useState(false);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { setEnabled(measurementAllowed()); setBlocked(navigator.doNotTrack === '1' || !!navigator.globalPrivacyControl); }, []);
  return <div><label style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}><input type="checkbox" checked={enabled} disabled={blocked} onChange={e => { setMeasurement(e.target.checked); setEnabled(measurementAllowed()); }} style={{ marginTop: 6 }} />Allow website conversion and performance measurement in this browser</label>
    <p style={{ fontSize: 13 }}>{blocked ? 'Your browser’s privacy signal disables measurement.' : 'You can change this choice at any time. Disabling stops new measurements; it does not delete an access request.'}</p></div>;
}
