import React, { useEffect, useState } from 'react';
import { track } from './marketing';

export const TOUR_STEPS = [
  { module: 'leads', id: 'demo-lead-1', title: 'Start with the person', copy: 'Meet Anna at TechStart. Her source, score, and needs give the team context before the first conversation.' },
  { module: 'deals', id: 'demo-deal-1', title: 'Turn interest into a next step', copy: 'Open the TechStart rollout. The stage, value, and close date keep the opportunity clear for everyone involved.' },
  { module: 'quotes', id: 'demo-quote-1', title: 'Put the proposal in writing', copy: 'Review the linked quote and its line items. This sample shows the handoff from a deal to a concrete offer; sending and accepting require a configured workspace.' },
];
const KEY = 'sn_demo_tour';
function storedStep(start) {
  if (start) return 0;
  try { const n = Number(sessionStorage.getItem(KEY) ?? -1); return Number.isInteger(n) && n >= 0 && n < 3 ? n : -1; } catch { return -1; }
}
export default function DemoTour({ navigate, start }) {
  const [step, setStep] = useState(() => storedStep(start));
  const [finished, setFinished] = useState(false);
  useEffect(() => { if (start) track('demo_start'); }, [start]);
  useEffect(() => {
    try { sessionStorage.setItem(KEY, String(step)); } catch { /* The tour also works without storage. */ }
    if (step >= 0) navigate(TOUR_STEPS[step].module, TOUR_STEPS[step].id);
  }, [step, navigate]);
  const button = 'px-3 py-2 rounded-lg border border-[#182550] text-sm font-medium hover:bg-[#182550]';
  if (step < 0) return <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
    {finished && <span role="status">Tour complete. Your next move is yours.</span>}
    <button className={button} onClick={() => { setFinished(false); setStep(0); track('demo_start'); }}>Restart guided tour</button>
    {finished && <a className={button} href="/#access">Request access</a>}
  </div>;
  const current = TOUR_STEPS[step];
  return <section aria-label="Guided product tour" className="mb-5 p-4 rounded-xl border border-[#F5A623] bg-[#0B1228]">
    <div aria-live="polite" aria-atomic="true"><p className="text-xs text-[#F5A623] mb-1">YOUR FIRST LOOK · {step + 1} OF 3</p>
      <h2 className="font-semibold text-lg text-[#F0EDE5]">{current.title}</h2><p className="text-sm text-[#7E8598] mt-1 max-w-3xl">{current.copy}</p></div>
    <div className="flex flex-wrap gap-2 mt-3">
      {step > 0 && <button className={button} onClick={() => setStep(step - 1)}>Previous</button>}
      <button className={button} onClick={() => navigate(current.module, current.id)}>Show this record</button>
      <button className={button} onClick={() => { if (step === 2) { track('tour_complete'); setFinished(true); setStep(-1); } else setStep(step + 1); }}>{step === 2 ? 'Finish tour' : 'Next step'}</button>
      <button className={button} onClick={() => setStep(-1)}>Explore on my own</button>
    </div>
  </section>;
}
