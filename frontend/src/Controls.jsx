import React, { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { T } from "./tokens";

export function Badge({ children, color = "primary", className = "" }) {
  const colors = {
    primary: `bg-[${T.accentBg}] text-[${T.accent}] border-[${T.accentBorder}]`,
    success: `bg-[${T.emeraldBg}] text-[${T.emerald}]`, danger: `bg-[${T.rubyBg}] text-[${T.ruby}]`,
    warning: `bg-[${T.amberBg}] text-[${T.amber}]`, info: `bg-[${T.sapphireBg}] text-[${T.sapphire}]`,
    purple: `bg-[${T.amethystBg}] text-[${T.amethyst}]`, cyan: `bg-[${T.tealBg}] text-[${T.teal}]`,
    neutral: `bg-[${T.surface}] text-[${T.muted}]`,
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${colors[color] || colors.primary} ${className}`}>{children}</span>;
}

export function Button({ children, variant = "primary", size = "md", onClick, disabled, className = "", icon: Icon, fullWidth, type = "button", ariaLabel }) {
  const variants = {
    primary: `bg-[${T.accent}] hover:bg-[${T.accentHover}] text-[${T.base}] font-semibold`,
    secondary: `bg-[${T.surface}] hover:bg-[${T.card}] text-[${T.body}] border border-[${T.border}]`,
    ghost: `hover:bg-[${T.surface}] text-[${T.muted}] hover:text-[${T.body}]`,
    danger: `bg-[${T.rubyBg}] hover:bg-[rgba(248,113,113,0.20)] text-[${T.ruby}]`,
  };
  const sizes = { sm: "px-2.5 py-1.5 text-xs min-h-[32px]", md: "px-3.5 py-2 text-sm min-h-[40px]", lg: "px-5 py-2.5 text-sm min-h-[44px]" };
  return (
    <button onClick={onClick} disabled={disabled} type={type} aria-label={ariaLabel}
      className={`inline-flex items-center justify-center gap-2 rounded-lg transition-all disabled:opacity-40 active:scale-[0.97] touch-manipulation ${variants[variant]} ${sizes[size]} ${fullWidth ? "w-full" : ""} ${className}`}>
      {Icon && <Icon size={size === "sm" ? 14 : 16} className="shrink-0" />}
      {children}
    </button>
  );
}

export function Input({ label, value, onChange, type = "text", placeholder, required, className = "", ...props }) {
  // A saved date comes back as a full ISO timestamp, which a date input shows
  // as blank, so editing a record hid its dates; and 0 is a value, not blank.
  const shown = typeof value === "string" && type === "date" ? value.slice(0, 10)
    : typeof value === "string" && type === "datetime-local" ? value.slice(0, 16)
    : value ?? "";
  return (
    <label className={`block ${className}`}>
      {label && <span className="block text-xs font-medium mb-1.5" style={{ color: "var(--sn-slate)" }}>{label}{required && <span className="text-[#F87171] ml-0.5">*</span>}</span>}
      <input type={type} value={shown} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required}
        aria-label={label ? undefined : placeholder}
        {...props}
        className="w-full px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:ring-1 transition-colors min-h-[44px]"
        style={{
          background: "var(--sn-raised)",
          border: "1px solid var(--sn-rule)",
          color: "var(--sn-cream)",
        }}
      />
    </label>
  );
}

export function Select({ label, value, onChange, options = [], placeholder, className = "", disabled = false }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="block text-xs font-medium text-[#7E8598] mb-1.5">{label}</span>}
      <select value={value || ""} onChange={e => onChange(e.target.value)} disabled={disabled}
        aria-label={label ? undefined : (placeholder || "Select an option")}
        className="w-full px-3 py-2.5 bg-[#0E1630] border border-[#182550] rounded-lg text-sm text-[#F0EDE5] focus:outline-none focus:border-[#F5A623] transition-colors appearance-none min-h-[44px]">
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function TextArea({ label, value, onChange, rows = 3, placeholder, className = "", disabled = false }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="block text-xs font-medium text-[#7E8598] mb-1.5">{label}</span>}
      <textarea value={value || ""} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder} disabled={disabled}
        aria-label={label ? undefined : placeholder}
        className="w-full px-3 py-2.5 bg-[#0E1630] border border-[#182550] rounded-lg text-sm text-[#F0EDE5] placeholder-[#4A5168] focus:outline-none focus:border-[#F5A623] transition-colors resize-none" />
    </label>
  );
}

// Modal: bottom sheet on mobile, centered on desktop
export function Modal({ open, onClose, title, children, wide }) {
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useMemo(() => `modal-${Math.random().toString(36).slice(2, 9)}`, []);

  // Escape closes, focus moves into the dialog and returns to whatever opened
  // it, and Tab is kept inside while it is open.
  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;

    const onKeyDown = e => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current?.(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKeyDown);
    const firstField = panelRef.current?.querySelector('input, select, textarea, button');
    firstField?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Clicking away closes; it is a mouse convenience, so Escape covers the
          same ground for anyone else and this stays out of the tab order. */}
      <div className="absolute inset-0 bg-[rgba(4,6,16,0.85)] backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative bg-[#0B1228] border border-[#182550] w-full
        rounded-t-2xl sm:rounded-xl shadow-2xl
        ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}
        max-h-[92vh] sm:max-h-[85vh] flex flex-col
        animate-[slideUp_0.25s_ease-out] sm:animate-[fadeScale_0.2s_ease-out]`}>
        <div className="sm:hidden flex justify-center pt-2 pb-1" aria-hidden="true">
          <div className="w-10 h-1 rounded-full bg-[#203060]" />
        </div>
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-[#182550]">
          <h3 id={titleId} className="text-base sm:text-lg font-semibold text-[#F0EDE5]">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close dialog"
            className="text-[#4A5168] hover:text-[#C8C2B4] p-1.5 -mr-1 rounded-lg hover:bg-[#0E1630] transition-colors">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="px-4 sm:px-6 py-4 overflow-y-auto flex-1 overscroll-contain">{children}</div>
      </div>
      <style>{`
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes fadeScale { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
      `}</style>
    </div>
  );
}

export function Toast({ message, type = "success", onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  const colors = { success: "bg-[#34D399]/10 border-[#34D399]/30 text-[#34D399]", error: "bg-[#F87171]/10 border-[#F87171]/30 text-[#F87171]" };
  return (
    <div role={type === "error" ? "alert" : "status"} aria-live={type === "error" ? "assertive" : "polite"} className={`fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-xl border ${colors[type]} text-sm font-medium shadow-lg backdrop-blur-sm animate-[fadeScale_0.2s_ease-out]`}>
      {message}
    </div>
  );
}
