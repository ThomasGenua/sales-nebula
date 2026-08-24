import React, { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { BrandMark, ThemeToggle } from "./theme";
import { DEMO_LOGIN, DEMO_USER, demoApiFetch, isDemoUser } from "./demo";
import {
  Search, Bell, Settings, LogOut, Menu, X, Plus, Edit2, Trash2, Eye,
  ChevronDown, ChevronRight, ChevronLeft, Filter, Download, Upload,
  Users, UserPlus, Target, Briefcase, Building2, Phone, Mail, Calendar,
  BarChart3, FileText, Package, DollarSign, Shield, Zap, Globe, Tag,
  MessageSquare, BookOpen, Layers, GitBranch, Clock, CheckCircle2,
  AlertTriangle, TrendingUp, ArrowUpRight, ArrowDownRight, RefreshCw,
  MoreVertical, Star, Pin, Send, Archive, Copy, ExternalLink, Home,
  PieChart, Activity, Inbox, FolderOpen, Webhook, Recycle, Database, Wrench,
  Smartphone, LayoutGrid, List, ChevronsUp, ArrowUp, ArrowDown,
  CalendarDays, CalendarClock, Lock, UserCheck, Timer, Flag, ListTree, ChevronsRight,
  AlertCircle, MapPin,
} from "lucide-react";

// ========================================================================
// THEME
// ========================================================================
const T = {
  base: "#060B1A", sidebar: "#081024", sidebarHover: "#0F1A38",
  card: "#0B1228", cardHover: "#101B3A", surface: "#0E1630",
  border: "#182550", borderLight: "#203060",
  heading: "#F0EDE5", body: "#C8C2B4", muted: "#7E8598", dim: "#4A5168",
  accent: "#F5A623", accentHover: "#E8961A",
  accentBg: "rgba(245,166,35,0.08)", accentBorder: "rgba(245,166,35,0.20)",
  action: "#4F8EF7",
  emerald: "#34D399", emeraldBg: "rgba(52,211,153,0.10)",
  ruby: "#F87171", rubyBg: "rgba(248,113,113,0.10)",
  amber: "#FBBF24", amberBg: "rgba(251,191,36,0.10)",
  sapphire: "#60A5FA", sapphireBg: "rgba(96,165,250,0.10)",
  amethyst: "#A78BFA", amethystBg: "rgba(167,139,250,0.10)",
  teal: "#2DD4BF", tealBg: "rgba(45,212,191,0.10)",
};

const API = "/api";

// ========================================================================
// HOOKS
// ========================================================================
const AuthContext = createContext();
function useAuth() { return useContext(AuthContext); }

function AuthProvider({ children }) {
  const [demoMode, setDemoMode] = useState(() => localStorage.getItem("sn_demo_mode") === "true");
  const [user, setUser] = useState(() => localStorage.getItem("sn_demo_mode") === "true" ? DEMO_USER : null);
  const [token, setToken] = useState(localStorage.getItem("sn_token"));
  const [loading, setLoading] = useState(true);

  const apiFetch = useCallback(async (path, opts = {}) => {
    if (demoMode) return demoApiFetch(path, opts);

    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...opts.headers },
      ...(opts.body && typeof opts.body === "object" && !opts.rawBody && { body: JSON.stringify(opts.body) }),
    });
    if (res.status === 401) { setUser(null); setToken(null); localStorage.removeItem("sn_token"); throw new Error("Unauthorized"); }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.statusText); }
    return res.json();
  }, [token, demoMode]);

  useEffect(() => {
    if (demoMode) { setUser(DEMO_USER); setLoading(false); return; }
    if (!token) { setLoading(false); return; }
    apiFetch("/auth/me").then(d => setUser(d.user || d)).catch(() => { setToken(null); localStorage.removeItem("sn_token"); }).finally(() => setLoading(false));
  }, [token, demoMode, apiFetch]);

  const login = async (email, password) => {
    if (email.trim().toLowerCase() === DEMO_LOGIN.email && password === DEMO_LOGIN.password) {
      localStorage.setItem("sn_demo_mode", "true");
      localStorage.removeItem("sn_token");
      setDemoMode(true);
      setToken(null);
      setUser(DEMO_USER);
      return;
    }

    const d = await apiFetch("/auth/login", { method: "POST", body: { email, password } });
    setToken(d.token); localStorage.setItem("sn_token", d.token); setUser(d.user);
  };
  const logout = () => {
    setUser(null); setToken(null); setDemoMode(false);
    localStorage.removeItem("sn_token");
    localStorage.removeItem("sn_demo_mode");
    window.history.pushState({}, "", "/");
    window.location.reload();
  };

  return <AuthContext.Provider value={{ user, token, demoMode, loading, login, logout, apiFetch }}>{children}</AuthContext.Provider>;
}

function useApi(path, deps = []) {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refresh = useCallback(() => {
    setLoading(true);
    apiFetch(path).then(setData).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [path, apiFetch]);
  useEffect(() => { refresh(); }, [path, ...deps]);
  return { data, loading, error, refresh };
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' ? window.matchMedia(query).matches : false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

// ========================================================================
// SHARED COMPONENTS -- ALL MOBILE-FIRST
// ========================================================================

function Badge({ children, color = "primary", className = "" }) {
  const colors = {
    primary: `bg-[${T.accentBg}] text-[${T.accent}] border-[${T.accentBorder}]`,
    success: `bg-[${T.emeraldBg}] text-[${T.emerald}]`, danger: `bg-[${T.rubyBg}] text-[${T.ruby}]`,
    warning: `bg-[${T.amberBg}] text-[${T.amber}]`, info: `bg-[${T.sapphireBg}] text-[${T.sapphire}]`,
    purple: `bg-[${T.amethystBg}] text-[${T.amethyst}]`, cyan: `bg-[${T.tealBg}] text-[${T.teal}]`,
    neutral: `bg-[${T.surface}] text-[${T.muted}]`,
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${colors[color] || colors.primary} ${className}`}>{children}</span>;
}

function Button({ children, variant = "primary", size = "md", onClick, disabled, className = "", icon: Icon, fullWidth }) {
  const variants = {
    primary: `bg-[${T.accent}] hover:bg-[${T.accentHover}] text-[${T.base}] font-semibold`,
    secondary: `bg-[${T.surface}] hover:bg-[${T.card}] text-[${T.body}] border border-[${T.border}]`,
    ghost: `hover:bg-[${T.surface}] text-[${T.muted}] hover:text-[${T.body}]`,
    danger: `bg-[${T.rubyBg}] hover:bg-[rgba(248,113,113,0.20)] text-[${T.ruby}]`,
  };
  const sizes = { sm: "px-2.5 py-1.5 text-xs min-h-[32px]", md: "px-3.5 py-2 text-sm min-h-[40px]", lg: "px-5 py-2.5 text-sm min-h-[44px]" };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg transition-all disabled:opacity-40 active:scale-[0.97] touch-manipulation ${variants[variant]} ${sizes[size]} ${fullWidth ? "w-full" : ""} ${className}`}>
      {Icon && <Icon size={size === "sm" ? 14 : 16} className="shrink-0" />}
      {children}
    </button>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, required, className = "", ...props }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="block text-xs font-medium text-[#7E8598] mb-1.5">{label}{required && <span className="text-[#F87171] ml-0.5">*</span>}</span>}
      <input type={type} value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} {...props}
        className="w-full px-3 py-2.5 bg-[#0E1630] border border-[#182550] rounded-lg text-sm text-[#F0EDE5] placeholder-[#4A5168] focus:outline-none focus:border-[#F5A623] focus:ring-1 focus:ring-[rgba(245,166,35,0.20)] transition-colors min-h-[44px]" />
    </label>
  );
}

function Select({ label, value, onChange, options = [], placeholder, className = "" }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="block text-xs font-medium text-[#7E8598] mb-1.5">{label}</span>}
      <select value={value || ""} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2.5 bg-[#0E1630] border border-[#182550] rounded-lg text-sm text-[#F0EDE5] focus:outline-none focus:border-[#F5A623] transition-colors appearance-none min-h-[44px]">
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function TextArea({ label, value, onChange, rows = 3, placeholder, className = "" }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="block text-xs font-medium text-[#7E8598] mb-1.5">{label}</span>}
      <textarea value={value || ""} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder}
        className="w-full px-3 py-2.5 bg-[#0E1630] border border-[#182550] rounded-lg text-sm text-[#F0EDE5] placeholder-[#4A5168] focus:outline-none focus:border-[#F5A623] transition-colors resize-none" />
    </label>
  );
}

// Modal: bottom sheet on mobile, centered on desktop
function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-[rgba(4,6,16,0.85)] backdrop-blur-sm" />
      <div className={`relative bg-[#0B1228] border border-[#182550] w-full
        rounded-t-2xl sm:rounded-xl shadow-2xl
        ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}
        max-h-[92vh] sm:max-h-[85vh] flex flex-col
        animate-[slideUp_0.25s_ease-out] sm:animate-[fadeScale_0.2s_ease-out]`}
        onClick={e => e.stopPropagation()}>
        {/* Drag handle on mobile */}
        <div className="sm:hidden flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-[#203060]" />
        </div>
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-[#182550]">
          <h3 className="text-base sm:text-lg font-semibold text-[#F0EDE5]">{title}</h3>
          <button onClick={onClose} className="text-[#4A5168] hover:text-[#C8C2B4] p-1.5 -mr-1 rounded-lg hover:bg-[#0E1630] transition-colors">
            <X size={18} />
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

function StatCard({ label, value, change, icon: Icon, color = "primary" }) {
  const bgColors = { primary: "bg-[rgba(245,166,35,0.08)]", success: "bg-[rgba(52,211,153,0.10)]", warning: "bg-[rgba(251,191,36,0.10)]", danger: "bg-[rgba(248,113,113,0.10)]", purple: "bg-[rgba(167,139,250,0.10)]", cyan: "bg-[rgba(45,212,191,0.10)]" };
  const iconColors = { primary: "text-[#F5A623]", success: "text-[#34D399]", warning: "text-[#FBBF24]", danger: "text-[#F87171]", purple: "text-[#A78BFA]", cyan: "text-[#2DD4BF]" };
  const isUp = change > 0;
  return (
    <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5 hover:border-[#203060] transition-colors active:scale-[0.98] touch-manipulation">
      <div className="flex items-start justify-between mb-2 sm:mb-3">
        <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-lg ${bgColors[color]} flex items-center justify-center`}>
          <Icon size={18} className={iconColors[color]} />
        </div>
        {change !== undefined && (
          <div className={`flex items-center gap-0.5 text-xs font-medium ${isUp ? "text-[#34D399]" : "text-[#F87171]"}`}>
            {isUp ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {Math.abs(change)}%
          </div>
        )}
      </div>
      <div className="text-xl sm:text-2xl font-bold text-[#F0EDE5] font-mono tracking-tight">{value}</div>
      <div className="text-xs text-[#4A5168] mt-0.5">{label}</div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, subtitle, action, onAction }) {
  return (
    <div className="text-center py-10 sm:py-16 px-4">
      {Icon && <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-[#0E1630] flex items-center justify-center mx-auto mb-3">
        <Icon size={22} className="text-[#4A5168]" />
      </div>}
      <div className="text-sm font-medium text-[#7E8598]">{title}</div>
      {subtitle && <div className="text-xs text-[#4A5168] mt-1">{subtitle}</div>}
      {action && <Button variant="primary" size="sm" onClick={onAction} className="mt-4">{action}</Button>}
    </div>
  );
}

function Spinner() {
  return <div className="flex items-center justify-center py-12"><div className="w-7 h-7 border-2 border-[#182550] border-t-[#F5A623] rounded-full animate-spin" /></div>;
}

function Toast({ message, type = "success", onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  const colors = { success: "bg-[#34D399]/10 border-[#34D399]/30 text-[#34D399]", error: "bg-[#F87171]/10 border-[#F87171]/30 text-[#F87171]" };
  return (
    <div className={`fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-xl border ${colors[type]} text-sm font-medium shadow-lg backdrop-blur-sm animate-[fadeScale_0.2s_ease-out]`}>
      {message}
    </div>
  );
}

// ========================================================================
// DATA TABLE -- responsive: table on desktop, cards on mobile
// ========================================================================

function MobileRecordCard({ row, columns, onEdit, onDelete, onRowClick }) {
  const primaryCol = columns[0];
  const secondaryCol = columns[1];
  const restCols = columns.slice(2, 5);
  return (
    <div onClick={() => onRowClick?.(row)}
      className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 active:bg-[#101B3A] transition-colors touch-manipulation">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[#F0EDE5] truncate">
            {primaryCol?.render ? primaryCol.render(row[primaryCol.key], row) : (row[primaryCol?.key] ?? "-")}
          </div>
          {secondaryCol && (
            <div className="text-xs text-[#7E8598] mt-0.5 truncate">
              {secondaryCol.render ? secondaryCol.render(row[secondaryCol.key], row) : (row[secondaryCol?.key] ?? "-")}
            </div>
          )}
        </div>
        {(onEdit || onDelete) && (
          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
            {onEdit && <button onClick={() => onEdit(row)} className="p-2 rounded-lg hover:bg-[#182550] text-[#4A5168] hover:text-[#C8C2B4]"><Edit2 size={15} /></button>}
            {onDelete && <button onClick={() => onDelete(row)} className="p-2 rounded-lg hover:bg-[rgba(248,113,113,0.10)] text-[#4A5168] hover:text-[#F87171]"><Trash2 size={15} /></button>}
          </div>
        )}
      </div>
      {restCols.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 pt-2.5 border-t border-[#182550]/50">
          {restCols.map(col => (
            <div key={col.key} className="text-xs">
              <span className="text-[#4A5168]">{col.label}: </span>
              <span className="text-[#C8C2B4]">{col.render ? col.render(row[col.key], row) : (row[col.key] ?? "-")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DataTable({ columns, data = [], onRowClick, onEdit, onDelete, selected, onSelect, loading, emptyIcon, emptyTitle }) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const [viewMode, setViewMode] = useState("auto");
  const showCards = viewMode === "cards" || (viewMode === "auto" && isMobile);
  const allSelected = data.length > 0 && selected?.length === data.length;

  if (loading) return <Spinner />;
  if (data.length === 0) return <EmptyState icon={emptyIcon || FileText} title={emptyTitle || "No records found"} />;

  // Card view (mobile default)
  if (showCards) {
    return (
      <div className="space-y-2">
        {data.length > 8 && (
          <div className="flex justify-end mb-1">
            <button onClick={() => setViewMode(showCards ? "table" : "cards")} className="flex items-center gap-1 text-xs text-[#4A5168] hover:text-[#C8C2B4] px-2 py-1 rounded">
              <List size={13} /> Table view
            </button>
          </div>
        )}
        {data.map(row => (
          <MobileRecordCard key={row.id} row={row} columns={columns} onEdit={onEdit} onDelete={onDelete} onRowClick={onRowClick} />
        ))}
      </div>
    );
  }

  // Table view (desktop default)
  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0 relative">
      {isMobile && (
        <div className="flex justify-end mb-1 px-3">
          <button onClick={() => setViewMode("cards")} className="flex items-center gap-1 text-xs text-[#4A5168] hover:text-[#C8C2B4] px-2 py-1 rounded">
            <LayoutGrid size={13} /> Card view
          </button>
        </div>
      )}
      <table className="w-full min-w-[480px]">
        <thead>
          <tr className="border-b border-[#182550]">
            {onSelect && (
              <th className="w-10 py-3 px-3">
                <input type="checkbox" checked={allSelected} onChange={e => onSelect(e.target.checked ? data.map(r => r.id) : [])}
                  className="rounded border-[#203060] bg-[#0E1630] text-[#F5A623] focus:ring-[rgba(245,166,35,0.20)]" />
              </th>
            )}
            {columns.map(col => (
              <th key={col.key} className="py-3 px-3 text-left text-xs font-medium text-[#4A5168] uppercase tracking-wider whitespace-nowrap">{col.label}</th>
            ))}
            {(onEdit || onDelete) && <th className="w-20 py-3 px-3" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#182550]/60">
          {data.map(row => (
            <tr key={row.id} onClick={() => onRowClick?.(row)}
              className="hover:bg-[#101B3A] transition-colors cursor-pointer group">
              {onSelect && (
                <td className="py-3 px-3" onClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={selected?.includes(row.id)} onChange={e => {
                    const next = e.target.checked ? [...(selected || []), row.id] : (selected || []).filter(id => id !== row.id);
                    onSelect(next);
                  }} className="rounded border-[#203060] bg-[#0E1630] text-[#F5A623]" />
                </td>
              )}
              {columns.map(col => (
                <td key={col.key} className="py-3 px-3 text-sm text-[#C8C2B4] whitespace-nowrap max-w-[200px] truncate">
                  {col.render ? col.render(row[col.key], row) : (row[col.key] ?? "-")}
                </td>
              ))}
              {(onEdit || onDelete) && (
                <td className="py-3 px-3" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    {onEdit && <button onClick={() => onEdit(row)} className="p-1.5 rounded-md hover:bg-[#182550] text-[#4A5168] hover:text-[#C8C2B4]"><Edit2 size={14} /></button>}
                    {onDelete && <button onClick={() => onDelete(row)} className="p-1.5 rounded-md hover:bg-[rgba(248,113,113,0.10)] text-[#4A5168] hover:text-[#F87171]"><Trash2 size={14} /></button>}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination({ page, total, limit, onChange }) {
  const pages = Math.ceil((total || 0) / (limit || 50));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-2 sm:px-4 py-3 border-t border-[#182550]">
      <span className="text-xs text-[#4A5168]">{total} records</span>
      <div className="flex items-center gap-1">
        <button onClick={() => onChange(page - 1)} disabled={page <= 1}
          className="p-2 rounded-lg hover:bg-[#182550] disabled:opacity-30 text-[#7E8598] min-w-[36px] min-h-[36px] flex items-center justify-center">
          <ChevronLeft size={16} />
        </button>
        <span className="text-xs text-[#C8C2B4] px-2 min-w-[60px] text-center">{page} / {pages}</span>
        <button onClick={() => onChange(page + 1)} disabled={page >= pages}
          className="p-2 rounded-lg hover:bg-[#182550] disabled:opacity-30 text-[#7E8598] min-w-[36px] min-h-[36px] flex items-center justify-center">
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

// ========================================================================
// MODULE PAGE -- generic CRUD with mobile-responsive forms
// ========================================================================

// ========================================================================
// FILTER PANEL -- responsive slide-out on mobile
// ========================================================================
function FilterPanel({ open, onClose, filters = [], values = {}, onChange, onApply, onReset }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 sm:relative sm:inset-auto" onClick={onClose}>
      <div className="absolute inset-0 bg-[rgba(4,6,16,0.6)] sm:hidden" />
      <div className="absolute right-0 top-0 bottom-0 w-72 sm:w-full sm:relative bg-[#0B1228] border-l sm:border border-[#182550] sm:rounded-xl p-4 overflow-y-auto animate-[slideLeft_0.2s_ease-out] sm:animate-none"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[#C8C2B4]">Filters</h3>
          <button onClick={onClose} className="sm:hidden p-1.5 rounded-lg hover:bg-[#0E1630] text-[#4A5168]"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          {filters.map(f => (
            <div key={f.key}>
              {f.type === "select" ? (
                <Select label={f.label} value={values[f.key] || ""} onChange={v => onChange({ ...values, [f.key]: v })} options={f.options} placeholder={`All ${f.label}`} />
              ) : f.type === "dateRange" ? (
                <div>
                  <span className="block text-xs font-medium text-[#7E8598] mb-1.5">{f.label}</span>
                  <div className="flex gap-2">
                    <input type="date" value={values[`${f.key}From`] || ""} onChange={e => onChange({ ...values, [`${f.key}From`]: e.target.value })}
                      className="flex-1 px-2 py-2 bg-[#0E1630] border border-[#182550] rounded-lg text-xs text-[#F0EDE5] min-h-[40px]" />
                    <input type="date" value={values[`${f.key}To`] || ""} onChange={e => onChange({ ...values, [`${f.key}To`]: e.target.value })}
                      className="flex-1 px-2 py-2 bg-[#0E1630] border border-[#182550] rounded-lg text-xs text-[#F0EDE5] min-h-[40px]" />
                  </div>
                </div>
              ) : (
                <Input label={f.label} value={values[f.key] || ""} onChange={v => onChange({ ...values, [f.key]: v })} type={f.type || "text"} />
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-4 pt-3 border-t border-[#182550]">
          <Button variant="secondary" size="sm" onClick={onReset} fullWidth>Reset</Button>
          <Button size="sm" onClick={onApply} fullWidth>Apply</Button>
        </div>
      </div>
      <style>{`@keyframes slideLeft { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
    </div>
  );
}

// ========================================================================
// RECORD DETAIL VIEW -- full record with tabs, related lists
// ========================================================================
function RecordDetail({ record, fields = [], relatedLists = [], onBack, onEdit, onDelete, title }) {
  const [activeTab, setActiveTab] = useState("details");
  const tabs = ["details", ...relatedLists.map(r => r.key)];

  if (!record) return null;
  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-[#0E1630] text-[#4A5168] hover:text-[#C8C2B4] transition-colors touch-manipulation">
            <ChevronLeft size={20} />
          </button>
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">{title || record.name || record.subject || record.firstName}</h1>
            <p className="text-xs text-[#4A5168]">ID: {record.id?.substring(0, 8)}...</p>
          </div>
        </div>
        <div className="flex items-center gap-2 pl-10 sm:pl-0">
          {onEdit && <Button variant="secondary" size="sm" icon={Edit2} onClick={() => onEdit(record)}>Edit</Button>}
          {onDelete && <Button variant="danger" size="sm" icon={Trash2} onClick={() => onDelete(record)}>Delete</Button>}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 mb-4 -mx-3 px-3 sm:mx-0 sm:px-0">
        {tabs.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors touch-manipulation min-h-[36px] ${
              activeTab === tab ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623]" : "text-[#7E8598] hover:bg-[#0E1630] hover:text-[#C8C2B4]"
            }`}>
            {tab === "details" ? "Details" : relatedLists.find(r => r.key === tab)?.label || tab}
          </button>
        ))}
      </div>

      {/* Detail fields */}
      {activeTab === "details" && (
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {fields.map(f => (
              <div key={f.key} className="py-2 border-b border-[#182550]/40">
                <div className="text-xs text-[#4A5168] mb-0.5">{f.label}</div>
                <div className="text-sm text-[#F0EDE5]">
                  {f.render ? f.render(record[f.key], record) : (record[f.key] ?? "-")}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-[#182550]/40 text-xs text-[#4A5168]">
            Created: {record.createdAt ? new Date(record.createdAt).toLocaleString() : "-"} | Updated: {record.updatedAt ? new Date(record.updatedAt).toLocaleString() : "-"}
          </div>
        </div>
      )}

      {/* Related lists */}
      {relatedLists.map(rl => activeTab === rl.key && (
        <div key={rl.key} className="bg-[#0B1228] border border-[#182550] rounded-xl overflow-hidden">
          <div className="p-4 border-b border-[#182550] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#C8C2B4]">{rl.label}</h3>
            {rl.count !== undefined && <span className="text-xs text-[#4A5168]">{rl.count} records</span>}
          </div>
          <div className="p-3">
            {rl.items?.length ? (
              <div className="space-y-2">
                {rl.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-[#0E1630] border border-[#182550]/50 hover:border-[#203060]">
                    <div>
                      <div className="text-sm text-[#F0EDE5]">{item.name || item.subject || item.title || "Record"}</div>
                      <div className="text-xs text-[#7E8598] mt-0.5">{item.status || item.type || item.stage || ""}</div>
                    </div>
                    <div className="text-xs text-[#4A5168]">{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ""}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-xs text-[#4A5168]">No {rl.label.toLowerCase()} found</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ========================================================================
// MINI CHART -- responsive sparkline bar chart
// ========================================================================
function MiniBarChart({ data = [], height = 120, label, valueKey = "value", labelKey = "label", color = "#F5A623" }) {
  const max = Math.max(...data.map(d => d[valueKey] || 0), 1);
  return (
    <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5">
      {label && <h3 className="text-xs font-semibold text-[#C8C2B4] mb-3">{label}</h3>}
      <div className="flex items-end gap-1" style={{ height }}>
        {data.map((d, i) => {
          const pct = ((d[valueKey] || 0) / max) * 100;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              <div className="text-[9px] text-[#4A5168] opacity-0 group-hover:opacity-100 transition-opacity font-mono">
                {typeof d[valueKey] === "number" ? d[valueKey].toLocaleString() : d[valueKey]}
              </div>
              <div className="w-full rounded-t" style={{ height: `${Math.max(pct, 2)}%`, backgroundColor: color, opacity: 0.7 + (pct / 300), transition: "height 0.3s ease" }} />
              <div className="text-[8px] sm:text-[9px] text-[#4A5168] truncate w-full text-center">{d[labelKey]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ========================================================================
// DONUT CHART -- responsive
// ========================================================================
function DonutChart({ data = [], size = 140, label }) {
  const total = data.reduce((s, d) => s + (d.value || 0), 0) || 1;
  const colors = ["#F5A623", "#34D399", "#60A5FA", "#A78BFA", "#F87171", "#FBBF24", "#2DD4BF"];
  let cumAngle = 0;

  const segments = data.map((d, i) => {
    const angle = ((d.value || 0) / total) * 360;
    const startAngle = cumAngle;
    cumAngle += angle;
    const start = (startAngle * Math.PI) / 180;
    const end = ((startAngle + angle) * Math.PI) / 180;
    const r = size / 2 - 4;
    const cx = size / 2; const cy = size / 2;
    const largeArc = angle > 180 ? 1 : 0;
    const x1 = cx + r * Math.cos(start); const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end); const y2 = cy + r * Math.sin(end);
    const ir = r * 0.55;
    const x3 = cx + ir * Math.cos(end); const y3 = cy + ir * Math.sin(end);
    const x4 = cx + ir * Math.cos(start); const y4 = cy + ir * Math.sin(start);
    return { ...d, color: colors[i % colors.length], path: `M${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} L${x3},${y3} A${ir},${ir} 0 ${largeArc},0 ${x4},${y4} Z` };
  });

  return (
    <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5">
      {label && <h3 className="text-xs font-semibold text-[#C8C2B4] mb-3">{label}</h3>}
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <svg width={size} height={size} className="shrink-0">
          {segments.map((seg, i) => <path key={i} d={seg.path} fill={seg.color} opacity={0.85} />)}
          <text x={size/2} y={size/2-6} textAnchor="middle" fill="#F0EDE5" fontSize="18" fontWeight="bold" fontFamily="monospace">{total.toLocaleString()}</text>
          <text x={size/2} y={size/2+10} textAnchor="middle" fill="#4A5168" fontSize="9">TOTAL</text>
        </svg>
        <div className="flex flex-wrap sm:flex-col gap-2 sm:gap-1.5">
          {segments.map((seg, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="text-xs text-[#7E8598]">{seg.label}</span>
              <span className="text-xs font-mono text-[#C8C2B4]">{seg.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ========================================================================
// NOTIFICATION PANEL -- slide from right on all sizes
// ========================================================================
function NotificationPanel({ open, onClose }) {
  const { data: notifications } = useApi("/mobile/notifications?limit=20");
  const items = notifications?.data || notifications || [];

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-[rgba(4,6,16,0.6)]" />
      <div className="absolute right-0 top-0 bottom-0 w-80 max-w-[90vw] bg-[#0B1228] border-l border-[#182550] shadow-2xl flex flex-col animate-[slideLeft_0.2s_ease-out]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-4 border-b border-[#182550]">
          <h3 className="text-sm font-semibold text-[#F0EDE5]">Notifications</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#0E1630] text-[#4A5168]"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {items.length === 0 ? (
            <div className="text-center py-12 text-xs text-[#4A5168]">No notifications</div>
          ) : items.map((n, i) => (
            <div key={i} className="px-4 py-3 border-b border-[#182550]/40 hover:bg-[#0E1630] transition-colors">
              <div className="flex items-start gap-3">
                <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.read ? "bg-[#4A5168]" : "bg-[#F5A623]"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[#F0EDE5]">{n.title || n.message || "Notification"}</div>
                  {n.body && <div className="text-xs text-[#7E8598] mt-0.5 line-clamp-2">{n.body}</div>}
                  <div className="text-[10px] text-[#4A5168] mt-1">{n.createdAt ? new Date(n.createdAt).toLocaleString() : ""}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ========================================================================
// QUICK ACTIONS PANEL -- command palette style
// ========================================================================
function QuickActions({ open, onClose, onAction }) {
  const [search, setSearch] = useState("");
  const inputRef = useRef(null);

  const actions = [
    { id: "newContact", label: "New Contact", icon: UserPlus, shortcut: "C" },
    { id: "newLead", label: "New Lead", icon: UserPlus, shortcut: "L" },
    { id: "newDeal", label: "New Deal", icon: Target, shortcut: "D" },
    { id: "newCase", label: "New Case", icon: Shield, shortcut: "S" },
    { id: "newActivity", label: "New Activity", icon: Calendar, shortcut: "A" },
    { id: "newQuote", label: "New Quote", icon: FileText, shortcut: "Q" },
    { id: "search", label: "Global Search", icon: Search, shortcut: "/" },
    { id: "dashboard", label: "Go to Dashboard", icon: Home, shortcut: "H" },
    { id: "settings", label: "Settings", icon: Settings, shortcut: "," },
  ];

  const filtered = search ? actions.filter(a => a.label.toLowerCase().includes(search.toLowerCase())) : actions;

  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] sm:pt-[20vh] px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-[rgba(4,6,16,0.7)] backdrop-blur-sm" />
      <div className="relative w-full max-w-md bg-[#0B1228] border border-[#182550] rounded-2xl shadow-2xl overflow-hidden animate-[fadeScale_0.15s_ease-out]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#182550]">
          <Search size={16} className="text-[#4A5168]" />
          <input ref={inputRef} value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm text-[#F0EDE5] placeholder-[#4A5168] focus:outline-none" />
          <kbd className="hidden sm:inline px-1.5 py-0.5 rounded bg-[#0E1630] text-[10px] text-[#4A5168] border border-[#182550]">ESC</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.map(action => (
            <button key={action.id}
              onClick={() => { onAction(action.id); onClose(); setSearch(""); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#C8C2B4] hover:bg-[#0E1630] hover:text-[#F0EDE5] transition-colors touch-manipulation">
              <action.icon size={16} className="text-[#7E8598] shrink-0" />
              <span className="flex-1 text-left">{action.label}</span>
              <kbd className="hidden sm:inline px-1.5 py-0.5 rounded bg-[#0E1630] text-[10px] text-[#4A5168] border border-[#182550]">{action.shortcut}</kbd>
            </button>
          ))}
          {filtered.length === 0 && <div className="text-center py-6 text-xs text-[#4A5168]">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}

// ========================================================================
// ACTIVITY TIMELINE -- inline record timeline
// ========================================================================
function ActivityTimeline({ activities = [] }) {
  if (!activities.length) return <div className="text-center py-8 text-xs text-[#4A5168]">No activity yet</div>;
  const typeColors = { Call: "#34D399", Email: "#60A5FA", Meeting: "#A78BFA", Task: "#FBBF24", Note: "#F87171", Update: "#F5A623" };
  return (
    <div className="relative pl-6 sm:pl-8">
      <div className="absolute left-2 sm:left-3 top-2 bottom-2 w-px bg-[#182550]" />
      {activities.map((a, i) => (
        <div key={i} className="relative pb-4 last:pb-0">
          <div className="absolute left-[-16px] sm:left-[-20px] top-1 w-3 h-3 rounded-full border-2 border-[#0B1228]"
            style={{ backgroundColor: typeColors[a.type] || "#4A5168" }} />
          <div className="bg-[#0E1630] border border-[#182550]/50 rounded-lg p-3 hover:border-[#203060] transition-colors">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[#F0EDE5]">{a.subject || a.title || a.action || "Activity"}</div>
                {a.description && <div className="text-xs text-[#7E8598] mt-1 line-clamp-2">{a.description}</div>}
              </div>
              <Badge color={a.status === "Completed" ? "success" : a.status === "Open" ? "info" : "neutral"}>
                {a.type || a.status || ""}
              </Badge>
            </div>
            <div className="text-[10px] text-[#4A5168] mt-2">{a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ========================================================================
// KPI ROW -- compact horizontal metrics strip
// ========================================================================
function KpiRow({ items = [] }) {
  return (
    <div className="flex items-stretch gap-2 overflow-x-auto pb-1 -mx-3 px-3 sm:mx-0 sm:px-0 sm:gap-3">
      {items.map((item, i) => (
        <div key={i} className="flex-shrink-0 min-w-[100px] sm:flex-1 bg-[#0B1228] border border-[#182550] rounded-lg px-3 py-2.5">
          <div className="text-[10px] text-[#4A5168] uppercase tracking-wider">{item.label}</div>
          <div className="text-base sm:text-lg font-bold font-mono text-[#F0EDE5] mt-0.5">{item.value}</div>
          {item.sub && <div className="text-[10px] text-[#7E8598] mt-0.5">{item.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ========================================================================
// INLINE EDIT CELL
// ========================================================================
function InlineEdit({ value, onSave, type = "text" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef(null);

  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  if (!editing) {
    return (
      <span onClick={() => { setDraft(value); setEditing(true); }}
        className="cursor-pointer hover:bg-[#0E1630] px-1 -mx-1 rounded transition-colors group inline-flex items-center gap-1">
        {value || <span className="text-[#4A5168] italic">Empty</span>}
        <Edit2 size={11} className="text-[#4A5168] opacity-0 group-hover:opacity-100" />
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <input ref={inputRef} type={type} value={draft || ""} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { onSave(draft); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
        className="px-2 py-1 bg-[#0E1630] border border-[#F5A623] rounded text-sm text-[#F0EDE5] focus:outline-none w-32" />
      <button onClick={() => { onSave(draft); setEditing(false); }} className="p-1 rounded text-[#34D399] hover:bg-[#34D399]/10"><CheckCircle2 size={14} /></button>
      <button onClick={() => setEditing(false)} className="p-1 rounded text-[#F87171] hover:bg-[#F87171]/10"><X size={14} /></button>
    </div>
  );
}

// ========================================================================
// PROGRESS BAR
// ========================================================================
function ProgressBar({ value = 0, max = 100, label, color = "#F5A623", showValue = true }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div>
      {(label || showValue) && (
        <div className="flex justify-between items-center mb-1.5">
          {label && <span className="text-xs text-[#7E8598]">{label}</span>}
          {showValue && <span className="text-xs font-mono text-[#C8C2B4]">{Math.round(pct)}%</span>}
        </div>
      )}
      <div className="h-2 bg-[#0E1630] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}
function ModulePage({ title, icon: Icon, endpoint, columns, formFields, emptyTitle, createTitle, editTitle, nameField = "name", detailFields, filterDefs }) {
  const { apiFetch } = useAuth();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState([]);
  const [detailRecord, setDetailRecord] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterValues, setFilterValues] = useState({});
  const [viewMode, setViewMode] = useState("list");
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState("desc");
  const limit = 50;

  const load = useCallback(() => {
    setLoading(true);
    let qs = `?page=${page}&limit=${limit}`;
    if (search) qs += `&search=${encodeURIComponent(search)}`;
    if (sortField) qs += `&sortBy=${sortField}&sortDir=${sortDir}`;
    Object.entries(filterValues).forEach(([k, v]) => { if (v) qs += `&${k}=${encodeURIComponent(v)}`; });
    apiFetch(`${endpoint}${qs}`)
      .then(d => { setItems(d.data || d.items || (Array.isArray(d) ? d : [])); setTotal(d.total ?? d.length ?? 0); })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [page, search, endpoint, apiFetch, sortField, sortDir, filterValues]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    try {
      if (editing) { await apiFetch(`${endpoint}/${editing.id}`, { method: "PUT", body: form }); }
      else { await apiFetch(endpoint, { method: "POST", body: form }); }
      setModalOpen(false); setEditing(null); setForm({}); load();
      setToast({ message: editing ? "Updated successfully" : "Created successfully", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row[nameField] || "this record"}?`)) return;
    try {
      await apiFetch(`${endpoint}/${row.id}`, { method: "DELETE" });
      if (detailRecord?.id === row.id) setDetailRecord(null);
      load(); setToast({ message: "Deleted", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const bulkDelete = async () => {
    if (!selected.length || !confirm(`Delete ${selected.length} records?`)) return;
    try {
      await Promise.all(selected.map(id => apiFetch(`${endpoint}/${id}`, { method: "DELETE" })));
      setSelected([]); load();
      setToast({ message: `Deleted ${selected.length} records`, type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  // Detail view
  if (detailRecord) {
    return (
      <>
        <RecordDetail
          record={detailRecord}
          title={detailRecord[nameField] || detailRecord.firstName || detailRecord.subject}
          fields={detailFields || formFields?.map(f => ({ key: f.key, label: f.label, render: f.render })) || columns}
          onBack={() => setDetailRecord(null)}
          onEdit={row => { setEditing(row); setForm({ ...row }); setModalOpen(true); }}
          onDelete={remove}
        />
        <Modal open={modalOpen} onClose={() => { setModalOpen(false); setEditing(null); }}
          title={`Edit ${title.slice(0, -1)}`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {(formFields || []).map(f => {
              if (f.type === "select") return <Select key={f.key} label={f.label} value={form[f.key]} onChange={v => setForm(p => ({ ...p, [f.key]: v }))} options={f.options} placeholder={`Select ${f.label}`} />;
              if (f.type === "textarea") return <TextArea key={f.key} label={f.label} value={form[f.key]} onChange={v => setForm(p => ({ ...p, [f.key]: v }))} className="sm:col-span-2" />;
              return <Input key={f.key} label={f.label} value={form[f.key]} onChange={v => setForm(p => ({ ...p, [f.key]: v }))} type={f.type || "text"} required={f.required} />;
            })}
          </div>
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
            <Button variant="secondary" onClick={() => { setModalOpen(false); setEditing(null); }} fullWidth className="sm:w-auto">Cancel</Button>
            <Button onClick={save} fullWidth className="sm:w-auto">Update</Button>
          </div>
        </Modal>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </>
    );
  }

  const activeFilterCount = Object.values(filterValues).filter(Boolean).length;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={20} className="text-[#F5A623] hidden sm:block" />}
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">{title}</h1>
          {total > 0 && <span className="text-xs text-[#4A5168] bg-[#0E1630] px-2 py-0.5 rounded-full">{total}</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 sm:flex-initial relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A5168]" />
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder={`Search ${title.toLowerCase()}...`}
              className="w-full sm:w-48 lg:w-56 pl-9 pr-3 py-2.5 bg-[#0E1630] border border-[#182550] rounded-lg text-sm text-[#F0EDE5] placeholder-[#4A5168] focus:outline-none focus:border-[#F5A623] min-h-[44px]" />
          </div>
          {filterDefs && (
            <Button variant="secondary" size="md" icon={Filter} onClick={() => setFilterOpen(true)} className="relative">
              <span className="hidden sm:inline">Filter</span>
              {activeFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#F5A623] text-[9px] text-[#060B1A] font-bold flex items-center justify-center">{activeFilterCount}</span>
              )}
            </Button>
          )}
          {selected.length > 0 && (
            <Button variant="danger" size="md" icon={Trash2} onClick={bulkDelete}>
              <span className="hidden sm:inline">Delete ({selected.length})</span>
            </Button>
          )}
          <Button icon={Plus} onClick={() => { setEditing(null); setForm({}); setModalOpen(true); }} size="md">
            <span className="hidden sm:inline">New</span>
          </Button>
        </div>
      </div>

      {/* Filter Panel (mobile: overlay; desktop: inline above table) */}
      {filterDefs && filterOpen && (
        <div className="mb-4 hidden sm:block">
          <FilterPanel open={true} onClose={() => setFilterOpen(false)}
            filters={filterDefs} values={filterValues} onChange={setFilterValues}
            onApply={() => { setPage(1); load(); setFilterOpen(false); }}
            onReset={() => { setFilterValues({}); setPage(1); }} />
        </div>
      )}
      {filterDefs && <FilterPanel open={filterOpen} onClose={() => setFilterOpen(false)}
        filters={filterDefs} values={filterValues} onChange={setFilterValues}
        onApply={() => { setPage(1); load(); setFilterOpen(false); }}
        onReset={() => { setFilterValues({}); setPage(1); }} />}

      {/* Table/Cards */}
      <div className="bg-[#0B1228] border border-[#182550] rounded-xl overflow-hidden">
        <div className="p-2 sm:p-0">
          <DataTable columns={columns} data={items} loading={loading}
            onRowClick={row => setDetailRecord(row)}
            onEdit={row => { setEditing(row); setForm({ ...row }); setModalOpen(true); }}
            onDelete={remove} selected={selected} onSelect={setSelected}
            emptyTitle={emptyTitle || `No ${title.toLowerCase()} yet`} />
        </div>
        <Pagination page={page} total={total} limit={limit} onChange={setPage} />
      </div>

      {/* Create/Edit Modal */}
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); setEditing(null); }}
        title={editing ? (editTitle || `Edit ${title.slice(0, -1)}`) : (createTitle || `New ${title.slice(0, -1)}`)}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {(formFields || []).map(f => {
            if (f.type === "select") return <Select key={f.key} label={f.label} value={form[f.key]} onChange={v => setForm(p => ({ ...p, [f.key]: v }))} options={f.options} placeholder={`Select ${f.label}`} />;
            if (f.type === "textarea") return <TextArea key={f.key} label={f.label} value={form[f.key]} onChange={v => setForm(p => ({ ...p, [f.key]: v }))} className="sm:col-span-2" />;
            return <Input key={f.key} label={f.label} value={form[f.key]} onChange={v => setForm(p => ({ ...p, [f.key]: v }))} type={f.type || "text"} required={f.required} />;
          })}
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => { setModalOpen(false); setEditing(null); }} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={save} fullWidth className="sm:w-auto">{editing ? "Update" : "Create"}</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function ContactsPage() {
  const statusBadge = (v) => {
    const c = { Active: "success", Inactive: "neutral", Lead: "info" };
    return <Badge color={c[v] || "primary"}>{v || "Active"}</Badge>;
  };
  return <ModulePage title="Contacts" icon={Users} endpoint="/contacts" nameField="lastName"
    columns={[
      { key: "firstName", label: "First Name" }, { key: "lastName", label: "Last Name" },
      { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
      { key: "title", label: "Title" }, { key: "status", label: "Status", render: statusBadge },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Active","Inactive","Lead"] },
      { key: "leadSource", label: "Source", type: "select", options: ["Web","Referral","Campaign","Social","Other"] },
      { key: "createdAt", label: "Created", type: "dateRange" },
    ]}
    detailFields={[
      { key: "firstName", label: "First Name" }, { key: "lastName", label: "Last Name" },
      { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
      { key: "mobilePhone", label: "Mobile" }, { key: "title", label: "Job Title" },
      { key: "department", label: "Department" }, { key: "leadSource", label: "Lead Source" },
      { key: "mailingCity", label: "City" }, { key: "mailingState", label: "State" },
      { key: "mailingCountry", label: "Country" }, { key: "status", label: "Status" },
    ]}
    formFields={[
      { key: "firstName", label: "First Name", required: true }, { key: "lastName", label: "Last Name", required: true },
      { key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone", type: "tel" },
      { key: "title", label: "Job Title" }, { key: "department", label: "Department" },
      { key: "mobilePhone", label: "Mobile", type: "tel" }, { key: "leadSource", label: "Lead Source", type: "select", options: ["Web","Referral","Campaign","Social","Other"] },
    ]} />;
}

function LeadsPage() {
  const statusBadge = v => { const c = { New: "info", Contacted: "warning", Qualified: "success", Unqualified: "danger" }; return <Badge color={c[v] || "primary"}>{v || "New"}</Badge>; };
  return <ModulePage title="Leads" icon={UserPlus} endpoint="/leads"
    columns={[
      { key: "firstName", label: "Name", render: (v, r) => `${r.firstName || ""} ${r.lastName || ""}` },
      { key: "company", label: "Company" }, { key: "email", label: "Email" },
      { key: "status", label: "Status", render: statusBadge },
      { key: "score", label: "Score", render: v => <span className="font-mono text-[#F5A623]">{v || 0}</span> },
    ]}
    formFields={[
      { key: "firstName", label: "First Name", required: true }, { key: "lastName", label: "Last Name", required: true },
      { key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone", type: "tel" },
      { key: "company", label: "Company" }, { key: "title", label: "Title" },
      { key: "status", label: "Status", type: "select", options: ["New","Contacted","Qualified","Unqualified","Nurture"] },
      { key: "source", label: "Source", type: "select", options: ["Web","Referral","Campaign","Social","Partner","Other"] },
    ]} />;
}

function DealsPage() {
  const stageBadge = v => { const c = { "Closed Won": "success", "Closed Lost": "danger", Negotiation: "warning", Qualification: "info", Discovery: "purple", Proposal: "cyan" }; return <Badge color={c[v] || "primary"}>{v || "-"}</Badge>; };
  return <ModulePage title="Deals" icon={Target} endpoint="/deals"
    columns={[
      { key: "name", label: "Deal" }, { key: "stage", label: "Stage", render: stageBadge },
      { key: "value", label: "Value", render: v => <span className="font-mono">${(v || 0).toLocaleString()}</span> },
      { key: "probability", label: "Prob", render: v => `${v || 0}%` },
      { key: "closeDate", label: "Close", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    filterDefs={[
      { key: "stage", label: "Stage", type: "select", options: ["Qualification","Discovery","Proposal","Negotiation","Closed Won","Closed Lost"] },
      { key: "closeDate", label: "Close Date", type: "dateRange" },
    ]}
    detailFields={[
      { key: "name", label: "Deal Name" }, { key: "stage", label: "Stage" },
      { key: "value", label: "Value", render: v => `$${(v||0).toLocaleString()}` },
      { key: "probability", label: "Probability", render: v => `${v||0}%` },
      { key: "closeDate", label: "Close Date", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "source", label: "Source" }, { key: "type", label: "Type" },
      { key: "nextStep", label: "Next Step" }, { key: "description", label: "Description" },
    ]}
    formFields={[
      { key: "name", label: "Deal Name", required: true }, { key: "value", label: "Value", type: "number" },
      { key: "stage", label: "Stage", type: "select", options: ["Qualification","Discovery","Proposal","Negotiation","Closed Won","Closed Lost"] },
      { key: "probability", label: "Probability %", type: "number" },
      { key: "closeDate", label: "Close Date", type: "date" }, { key: "source", label: "Source" },
      { key: "description", label: "Description", type: "textarea" },
    ]} />;
}

function AccountsPage() {
  return <ModulePage title="Accounts" icon={Building2} endpoint="/accounts"
    columns={[
      { key: "name", label: "Account" }, { key: "industry", label: "Industry" },
      { key: "phone", label: "Phone" }, { key: "type", label: "Type" },
      { key: "website", label: "Website" }, { key: "annualRevenue", label: "Revenue", render: v => v ? `$${(v/1000).toFixed(0)}K` : "-" },
    ]}
    formFields={[
      { key: "name", label: "Account Name", required: true }, { key: "industry", label: "Industry" },
      { key: "phone", label: "Phone", type: "tel" }, { key: "website", label: "Website" },
      { key: "type", label: "Type", type: "select", options: ["Prospect","Customer","Partner","Vendor","Competitor"] },
      { key: "annualRevenue", label: "Annual Revenue", type: "number" },
      { key: "billingCity", label: "City" }, { key: "billingCountry", label: "Country" },
    ]} />;
}

function ActivitiesPage() {
  const typeBadge = v => { const c = { Call: "success", Email: "info", Meeting: "purple", Task: "warning" }; return <Badge color={c[v] || "primary"}>{v || "-"}</Badge>; };
  return <ModulePage title="Activities" icon={Calendar} endpoint="/activities"
    columns={[
      { key: "subject", label: "Subject" }, { key: "type", label: "Type", render: typeBadge },
      { key: "status", label: "Status" },
      { key: "dueDate", label: "Due", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[
      { key: "subject", label: "Subject", required: true },
      { key: "type", label: "Type", type: "select", options: ["Call","Email","Meeting","Task","Demo","Follow-up"] },
      { key: "status", label: "Status", type: "select", options: ["Open","InProgress","Completed","Deferred","Cancelled"] },
      { key: "priority", label: "Priority", type: "select", options: ["Low","Medium","High"] },
      { key: "dueDate", label: "Due Date", type: "date" }, { key: "duration", label: "Duration (min)", type: "number" },
      { key: "description", label: "Notes", type: "textarea" },
    ]} />;
}

function CasesPage() {
  const priBadge = v => { const c = { Critical: "danger", High: "warning", Medium: "info", Low: "neutral" }; return <Badge color={c[v] || "primary"}>{v || "-"}</Badge>; };
  return <ModulePage title="Cases" icon={Shield} endpoint="/cases"
    columns={[
      { key: "caseNumber", label: "#" }, { key: "subject", label: "Subject" },
      { key: "status", label: "Status" }, { key: "priority", label: "Priority", render: priBadge },
      { key: "origin", label: "Origin" },
    ]}
    formFields={[
      { key: "subject", label: "Subject", required: true },
      { key: "status", label: "Status", type: "select", options: ["New","Open","Pending","Escalated","Closed"] },
      { key: "priority", label: "Priority", type: "select", options: ["Low","Medium","High","Critical"] },
      { key: "origin", label: "Origin", type: "select", options: ["Phone","Email","Web","Chat","Social"] },
      { key: "type", label: "Type", type: "select", options: ["Question","Problem","Feature Request","Bug"] },
      { key: "description", label: "Description", type: "textarea" },
    ]} />;
}

function ProductsPage() {
  return <ModulePage title="Products" icon={Package} endpoint="/products"
    columns={[
      { key: "name", label: "Product" }, { key: "code", label: "Code" },
      { key: "category", label: "Category" },
      { key: "price", label: "Price", render: v => <span className="font-mono">${(v || 0).toLocaleString()}</span> },
      { key: "active", label: "Active", render: v => v !== false ? <Badge color="success">Yes</Badge> : <Badge color="neutral">No</Badge> },
    ]}
    formFields={[
      { key: "name", label: "Product Name", required: true }, { key: "code", label: "Product Code" },
      { key: "category", label: "Category" }, { key: "price", label: "Price", type: "number", required: true },
      { key: "description", label: "Description", type: "textarea" },
    ]} />;
}

function QuotesPage() {
  return <ModulePage title="Quotes" icon={FileText} endpoint="/quotes"
    columns={[
      { key: "name", label: "Quote" }, { key: "quoteNumber", label: "#" }, { key: "status", label: "Status" },
      { key: "totalAmount", label: "Total", render: v => <span className="font-mono">${(v || 0).toLocaleString()}</span> },
      { key: "expirationDate", label: "Expires", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[
      { key: "name", label: "Quote Name", required: true },
      { key: "status", label: "Status", type: "select", options: ["Draft","Pending","Approved","Rejected","Accepted"] },
      { key: "expirationDate", label: "Expiration", type: "date" }, { key: "discount", label: "Discount %", type: "number" },
      { key: "terms", label: "Terms", type: "textarea" },
    ]} />;
}

function InvoicesPage() {
  return <ModulePage title="Invoices" icon={DollarSign} endpoint="/invoices"
    columns={[
      { key: "invoiceNumber", label: "#" }, { key: "status", label: "Status" },
      { key: "totalAmount", label: "Total", render: v => <span className="font-mono">${(v || 0).toLocaleString()}</span> },
      { key: "dueDate", label: "Due", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Sent","Paid","Overdue","Cancelled"] },
      { key: "dueDate", label: "Due Date", type: "date", required: true },
      { key: "notes", label: "Notes", type: "textarea" },
    ]} />;
}

function CampaignsPage() {
  return <ModulePage title="Campaigns" icon={Send} endpoint="/campaigns"
    columns={[
      { key: "name", label: "Campaign" }, { key: "type", label: "Type" }, { key: "status", label: "Status" },
      { key: "startDate", label: "Start", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "budgetedCost", label: "Budget", render: v => v ? `$${(v/1000).toFixed(0)}K` : "-" },
    ]}
    formFields={[
      { key: "name", label: "Name", required: true },
      { key: "type", label: "Type", type: "select", options: ["Email","Social","Webinar","Event","Content","PPC","Referral"] },
      { key: "status", label: "Status", type: "select", options: ["Planned","Active","Completed","Cancelled"] },
      { key: "startDate", label: "Start", type: "date" }, { key: "endDate", label: "End", type: "date" },
      { key: "budgetedCost", label: "Budget", type: "number" },
      { key: "description", label: "Description", type: "textarea" },
    ]} />;
}

function EmailsPage() {
  return <ModulePage title="Emails" icon={Mail} endpoint="/emails"
    columns={[
      { key: "subject", label: "Subject" }, { key: "to", label: "To" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Sent'?'success':v==='Opened'?'info':v==='Bounced'?'danger':'neutral'}>{v||'Draft'}</Badge> },
      { key: "sentAt", label: "Sent", render: v => v ? new Date(v).toLocaleString() : "-" },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Sent","Opened","Bounced","Failed"] },
    ]}
    detailFields={[
      { key: "subject", label: "Subject" }, { key: "to", label: "To" }, { key: "from", label: "From" },
      { key: "status", label: "Status" }, { key: "body", label: "Body" },
      { key: "sentAt", label: "Sent At", render: v => v ? new Date(v).toLocaleString() : "-" },
      { key: "openedAt", label: "Opened At", render: v => v ? new Date(v).toLocaleString() : "-" },
    ]}
    formFields={[{ key: "subject", label: "Subject", required: true },{ key: "to", label: "To", required: true },{ key: "body", label: "Body", type: "textarea" }]}
  />;
}
function KnowledgePage() {
  return <ModulePage title="Knowledge" icon={BookOpen} endpoint="/knowledge"
    columns={[
      { key: "title", label: "Title" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Published'?'success':v==='Archived'?'neutral':'warning'}>{v||'Draft'}</Badge> },
      { key: "category", label: "Category" },
      { key: "viewCount", label: "Views", render: v => <span className="font-mono">{v||0}</span> },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Published","Archived"] },
      { key: "category", label: "Category", type: "select", options: ["Getting Started","Troubleshooting","FAQ","How-To","Policy"] },
    ]}
    detailFields={[
      { key: "title", label: "Title" }, { key: "status", label: "Status" }, { key: "category", label: "Category" },
      { key: "body", label: "Content" }, { key: "viewCount", label: "Views" },
      { key: "createdAt", label: "Created", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "updatedAt", label: "Updated", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[{ key: "title", label: "Title", required: true },{ key: "status", label: "Status", type: "select", options: ["Draft","Published","Archived"] },{ key: "category", label: "Category" },{ key: "body", label: "Body", type: "textarea" }]}
  />;
}
function ContractsPage() {
  return <ModulePage title="Contracts" icon={FileText} endpoint="/contracts"
    columns={[
      { key: "contractNumber", label: "#" }, { key: "name", label: "Contract" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Activated'?'success':v==='Terminated'?'danger':v==='Expired'?'warning':'neutral'}>{v||'Draft'}</Badge> },
      { key: "startDate", label: "Start", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "endDate", label: "End", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "value", label: "Value", render: v => v ? `$${(v/1000).toFixed(0)}K` : "-" },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Activated","Terminated","Expired"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "contractNumber", label: "Contract #" },
      { key: "status", label: "Status" }, { key: "value", label: "Value", render: v => v ? `$${v.toLocaleString()}` : "-" },
      { key: "startDate", label: "Start", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "endDate", label: "End", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "description", label: "Description" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "status", label: "Status", type: "select", options: ["Draft","Activated","Terminated","Expired"] },{ key: "startDate", label: "Start", type: "date" },{ key: "endDate", label: "End", type: "date" },{ key: "value", label: "Value", type: "number" }]}
  />;
}
function OrdersPage() {
  return <ModulePage title="Orders" icon={Package} endpoint="/orders"
    columns={[
      { key: "name", label: "Order" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Fulfilled'?'success':v==='Cancelled'?'danger':v==='Activated'?'info':'neutral'}>{v||'Draft'}</Badge> },
      { key: "totalAmount", label: "Total", render: v => <span className="font-mono">${(v||0).toLocaleString()}</span> },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Activated","Fulfilled","Cancelled"] },
    ]}
    formFields={[{ key: "name", label: "Order Name", required: true },{ key: "status", label: "Status", type: "select", options: ["Draft","Activated","Fulfilled","Cancelled"] },{ key: "totalAmount", label: "Total", type: "number" }]}
  />;
}
function SubscriptionsPage() {
  return <ModulePage title="Subscriptions" icon={RefreshCw} endpoint="/subscriptions"
    columns={[
      { key: "subscriptionNumber", label: "#" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Active'?'success':v==='Cancelled'?'danger':v==='Expired'?'warning':'neutral'}>{v||'Pending'}</Badge> },
      { key: "billingFrequency", label: "Billing" },
      { key: "totalPrice", label: "Price", render: v => <span className="font-mono">${(v||0).toLocaleString()}</span> },
      { key: "endDate", label: "Ends", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Active","Pending","Expired","Cancelled"] },
      { key: "billingFrequency", label: "Billing", type: "select", options: ["Monthly","Quarterly","Annual"] },
    ]}
    formFields={[{ key: "status", label: "Status", type: "select", options: ["Active","Pending","Expired","Cancelled"] },{ key: "billingFrequency", label: "Billing", type: "select", options: ["Monthly","Quarterly","Annual"] },{ key: "unitPrice", label: "Unit Price", type: "number", required: true },{ key: "startDate", label: "Start", type: "date" },{ key: "endDate", label: "End", type: "date" }]}
  />;
}
function WorkOrdersPage() {
  return <ModulePage title="Work Orders" icon={Wrench} endpoint="/field-service"
    columns={[
      { key: "workOrderNumber", label: "#" }, { key: "subject", label: "Subject" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Completed'?'success':v==='Cancelled'?'danger':v==='InProgress'?'info':'warning'}>{v||'New'}</Badge> },
      { key: "priority", label: "Priority", render: v => <Badge color={v==='Critical'?'danger':v==='High'?'warning':'neutral'}>{v||'Medium'}</Badge> },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["New","Scheduled","Dispatched","InProgress","Completed","Cancelled"] },
      { key: "priority", label: "Priority", type: "select", options: ["Low","Medium","High","Critical"] },
    ]}
    detailFields={[
      { key: "subject", label: "Subject" }, { key: "status", label: "Status" },
      { key: "priority", label: "Priority" }, { key: "description", label: "Description" },
      { key: "address", label: "Address" },
      { key: "startDate", label: "Start", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "endDate", label: "End", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[{ key: "subject", label: "Subject", required: true },{ key: "status", label: "Status", type: "select", options: ["New","Scheduled","Dispatched","InProgress","Completed","Cancelled"] },{ key: "priority", label: "Priority", type: "select", options: ["Low","Medium","High","Critical"] },{ key: "description", label: "Description", type: "textarea" }]}
  />;
}
function EntitlementsPage() {
  return <ModulePage title="Entitlements" icon={Shield} endpoint="/entitlements"
    columns={[
      { key: "name", label: "Entitlement" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Active'?'success':v==='Expired'?'danger':'neutral'}>{v||'Inactive'}</Badge> },
      { key: "type", label: "Type" },
      { key: "startDate", label: "Start", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "casesPerEntitlement", label: "Case Limit", render: v => v || "Unlimited" },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Active","Expired","Inactive"] },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "status", label: "Status", type: "select", options: ["Active","Expired","Inactive"] },{ key: "type", label: "Type" },{ key: "startDate", label: "Start", type: "date" },{ key: "endDate", label: "End", type: "date" },{ key: "casesPerEntitlement", label: "Case Limit", type: "number" }]}
  />;
}
function CustomObjectsPage() {
  return <ModulePage title="Custom Objects" icon={Database} endpoint="/custom-objects"
    columns={[
      { key: "label", label: "Label" }, { key: "apiName", label: "API Name" },
      { key: "description", label: "Description" },
    ]}
    detailFields={[
      { key: "label", label: "Label" }, { key: "apiName", label: "API Name" },
      { key: "pluralLabel", label: "Plural Label" }, { key: "description", label: "Description" },
      { key: "createdAt", label: "Created", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[{ key: "label", label: "Label", required: true },{ key: "apiName", label: "API Name" },{ key: "pluralLabel", label: "Plural Label" },{ key: "description", label: "Description" }]}
  />;
}
function AiAgentsPage() {
  return <ModulePage title="AI Agents" icon={Zap} endpoint="/ai-agents"
    columns={[
      { key: "name", label: "Name" }, { key: "type", label: "Type" },
      { key: "active", label: "Active", render: v => <Badge color={v?'success':'neutral'}>{v?'Active':'Inactive'}</Badge> },
      { key: "description", label: "Description" },
    ]}
    filterDefs={[
      { key: "type", label: "Type", type: "select", options: ["SDR","DealCoach","ServiceAgent","Admin"] },
      { key: "active", label: "Active", type: "select", options: ["true","false"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "type", label: "Type" },
      { key: "active", label: "Status", render: v => v ? "Active" : "Inactive" },
      { key: "description", label: "Description" },
      { key: "config", label: "Configuration" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "type", label: "Type", type: "select", options: ["SDR","DealCoach","ServiceAgent","Admin"] },{ key: "description", label: "Description" }]}
  />;
}
function FlowBuilderPage() {
  return <ModulePage title="Flow Builder" icon={GitBranch} endpoint="/flows"
    columns={[
      { key: "name", label: "Name" }, { key: "type", label: "Type" }, { key: "module", label: "Module" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Active'?'success':v==='Draft'?'neutral':'warning'}>{v||'Draft'}</Badge> },
      { key: "version", label: "Ver", render: v => <span className="font-mono">v{v||1}</span> },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Active","Inactive"] },
      { key: "type", label: "Type", type: "select", options: ["RecordTriggered","ScreenFlow","Scheduled","AutoLaunched"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "type", label: "Type" }, { key: "module", label: "Module" },
      { key: "status", label: "Status" }, { key: "version", label: "Version" },
      { key: "triggerType", label: "Trigger" }, { key: "description", label: "Description" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "type", label: "Type", type: "select", options: ["RecordTriggered","ScreenFlow","Scheduled","AutoLaunched"] },{ key: "module", label: "Module" },{ key: "description", label: "Description" }]}
  />;
}
function MarketplacePage() {
  return <ModulePage title="Marketplace" icon={Globe} endpoint="/marketplace"
    columns={[
      { key: "name", label: "Name" }, { key: "category", label: "Category" },
      { key: "author", label: "Author" },
      { key: "pricing", label: "Pricing", render: v => <Badge color={v==='Free'?'success':v==='Paid'?'warning':'info'}>{v||'Free'}</Badge> },
      { key: "rating", label: "Rating", render: v => v ? `${v}/5` : "-" },
      { key: "installCount", label: "Installs", render: v => <span className="font-mono">{v||0}</span> },
    ]}
    filterDefs={[
      { key: "category", label: "Category", type: "select", options: ["Utility","Analytics","Integration","Sales","Service","Marketing"] },
      { key: "pricing", label: "Pricing", type: "select", options: ["Free","Paid","Freemium"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "author", label: "Author" },
      { key: "category", label: "Category" }, { key: "pricing", label: "Pricing" },
      { key: "rating", label: "Rating" }, { key: "installCount", label: "Installs" },
      { key: "description", label: "Description" }, { key: "version", label: "Version" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "author", label: "Author", required: true },{ key: "category", label: "Category", type: "select", options: ["Utility","Analytics","Integration","Sales","Service"] },{ key: "pricing", label: "Pricing", type: "select", options: ["Free","Paid","Freemium"] },{ key: "description", label: "Description" }]}
  />;
}

// ========================================================================
// SPECIAL PAGES
// ========================================================================

function ForecastsPage() {
  const { data, loading } = useApi("/forecasts/current");
  if (loading) return <Spinner />;
  const f = data || {};
  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Forecasts</h1>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Closed" value={`$${((f.closed || 0) / 1000).toFixed(0)}K`} icon={CheckCircle2} color="success" />
        <StatCard label="Commit" value={`$${((f.commit || 0) / 1000).toFixed(0)}K`} icon={Target} color="primary" />
        <StatCard label="Best Case" value={`$${((f.bestCase || 0) / 1000).toFixed(0)}K`} icon={TrendingUp} color="purple" />
        <StatCard label="Pipeline" value={`$${((f.pipeline || 0) / 1000).toFixed(0)}K`} icon={BarChart3} color="cyan" />
      </div>
      {f.categories && (
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Forecast Categories</h3>
          <div className="space-y-3">
            {Object.entries(f.categories || {}).map(([cat, val]) => (
              <div key={cat} className="flex items-center gap-3">
                <div className="w-24 sm:w-32 text-xs text-[#7E8598] truncate">{cat}</div>
                <div className="flex-1 h-5 bg-[#0E1630] rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-[#F5A623] to-[#FBBF24] rounded-full" style={{ width: `${Math.min(100, (val / (f.quota || 1)) * 100)}%` }} />
                </div>
                <div className="w-20 text-right text-xs font-mono text-[#C8C2B4]">${(val / 1000).toFixed(0)}K</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowsPage() {
  return <ModulePage title="Workflows" icon={GitBranch} endpoint="/workflows"
    columns={[
      { key: "name", label: "Workflow" }, { key: "module", label: "Module" },
      { key: "triggerType", label: "Trigger" },
      { key: "active", label: "Active", render: v => <Badge color={v ? "success" : "neutral"}>{v ? "Active" : "Inactive"}</Badge> },
      { key: "executionCount", label: "Runs", render: v => <span className="font-mono">{v || 0}</span> },
    ]}
    formFields={[
      { key: "name", label: "Name", required: true }, { key: "module", label: "Module", required: true },
      { key: "triggerType", label: "Trigger", type: "select", options: ["create","update","delete","createOrUpdate","scheduled"] },
      { key: "description", label: "Description", type: "textarea" },
    ]} />;
}

function DashboardPage() {
  const { data: stats, loading } = useApi("/dashboard");
  const { data: pipelineData } = useApi("/deals/stats/pipeline");
  const { data: recentDeals } = useApi("/deals?limit=5&sortBy=updatedAt&sortDir=desc");
  const { data: recentActivities } = useApi("/activities?limit=8&sortBy=createdAt&sortDir=desc");
  const pipeline = Array.isArray(pipelineData) ? pipelineData : (pipelineData?.pipeline || []);
  const deals = recentDeals?.data || recentDeals?.items || (Array.isArray(recentDeals) ? recentDeals : []);
  const activities = recentActivities?.data || recentActivities?.items || (Array.isArray(recentActivities) ? recentActivities : []);

  if (loading) return <Spinner />;
  const s = stats || {};
  const counts = s.counts || {};
  const pipe = s.pipeline || {};
  const rev = s.revenue || {};

  // Prepare chart data
  const pipelineChartData = pipeline.slice(0, 8).map(st => ({ label: (st.stage || st._id || "").substring(0, 8), value: st.value || 0 }));
  const donutData = [
    { label: "Won", value: rev.wonThisMonth?.count || counts.wonDeals || 0 },
    { label: "Open", value: counts.openDeals || pipe.dealCount || 0 },
    { label: "Lost", value: counts.lostDeals || 0 },
  ].filter(d => d.value > 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Dashboard</h1>
          <p className="text-xs text-[#4A5168]">Sales performance overview</p>
        </div>
      </div>

      {/* KPI strip - scrollable on mobile */}
      <KpiRow items={[
        { label: "Pipeline", value: `$${((pipe.totalValue || 0) / 1000).toFixed(0)}K`, sub: `${pipe.dealCount || 0} deals` },
        { label: "Won MTD", value: `$${((rev.wonThisMonth?.value || 0) / 1000).toFixed(0)}K` },
        { label: "Open Leads", value: counts.leads || 0 },
        { label: "Win Rate", value: `${s.winRate || pipe.winRate || 0}%` },
        { label: "Cases", value: counts.openCases || 0 },
      ]} />

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mt-4 mb-4 sm:mb-6">
        <StatCard label="Total Deals" value={pipe.dealCount || counts.openDeals || 0} icon={Target} color="primary" change={12} />
        <StatCard label="Pipeline Value" value={`$${((pipe.totalValue || 0) / 1000).toFixed(0)}K`} icon={DollarSign} color="success" change={8} />
        <StatCard label="Contacts" value={counts.contacts || 0} icon={Users} color="purple" />
        <StatCard label="Accounts" value={counts.accounts || 0} icon={Building2} color="cyan" />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 mb-4 sm:mb-6">
        {pipelineChartData.length > 0 && (
          <MiniBarChart data={pipelineChartData} label="Pipeline by Stage" height={140} />
        )}
        {donutData.length > 0 && (
          <DonutChart data={donutData} label="Deal Outcomes" size={130} />
        )}
      </div>

      {/* Pipeline bars */}
      {pipeline?.length > 0 && (
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6 mb-4">
          <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Pipeline Detail</h3>
          <div className="space-y-3">
            {pipeline.map(st => (
              <div key={st.stage || st._id}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-[#7E8598]">{st.stage || st._id}</span>
                  <span className="text-xs font-mono text-[#C8C2B4]">${((st.value || 0) / 1000).toFixed(0)}K ({st.count || 0})</span>
                </div>
                <ProgressBar value={st.value || 0} max={pipeline.reduce((s, p) => Math.max(s, p.value || 0), 1)} showValue={false} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity and deals side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {/* Recent Deals */}
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-[#C8C2B4] mb-3">Recent Deals</h3>
          <div className="space-y-2">
            {deals.slice(0, 5).map(deal => (
              <div key={deal.id} className="flex items-center justify-between p-2.5 rounded-lg bg-[#0E1630] border border-[#182550]/50">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[#F0EDE5] truncate">{deal.name}</div>
                  <div className="text-xs text-[#7E8598]">{deal.stage}</div>
                </div>
                <div className="text-sm font-mono text-[#F5A623] ml-3">${((deal.value || 0) / 1000).toFixed(0)}K</div>
              </div>
            ))}
            {deals.length === 0 && <div className="text-xs text-[#4A5168] text-center py-4">No recent deals</div>}
          </div>
        </div>

        {/* Activity Timeline */}
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-[#C8C2B4] mb-3">Recent Activity</h3>
          <ActivityTimeline activities={activities.slice(0, 6)} />
        </div>
      </div>
    </div>
  );
}

function GlobalSearchPage() {
  const { apiFetch } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try { const d = await apiFetch(`/search?q=${encodeURIComponent(query)}`); setResults(d); } catch (e) { setResults({ error: e.message }); }
    finally { setLoading(false); }
  };
  const moduleIcons = { contacts: Users, leads: UserPlus, deals: Target, accounts: Building2, cases: Shield, products: Package };
  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Search</h1>
      <div className="flex gap-2 mb-6">
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A5168]" />
          <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
            placeholder="Search across all modules..."
            className="w-full pl-10 pr-4 py-3 bg-[#0E1630] border border-[#182550] rounded-xl text-sm text-[#F0EDE5] placeholder-[#4A5168] focus:outline-none focus:border-[#F5A623] min-h-[48px]" />
        </div>
        <Button onClick={search} size="lg">Search</Button>
      </div>
      {loading && <Spinner />}
      {results && !results.error && Object.entries(results).map(([mod, items]) => {
        if (!Array.isArray(items) || items.length === 0) return null;
        const ModIcon = moduleIcons[mod] || FileText;
        return (
          <div key={mod} className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <ModIcon size={15} className="text-[#F5A623]" />
              <h3 className="text-sm font-semibold text-[#C8C2B4] capitalize">{mod}</h3>
              <span className="text-xs text-[#4A5168]">({items.length})</span>
            </div>
            <div className="space-y-1.5">
              {items.slice(0, 5).map(item => (
                <div key={item.id} className="bg-[#0B1228] border border-[#182550] rounded-lg p-3 hover:border-[#203060] transition-colors">
                  <div className="text-sm text-[#F0EDE5]">{item.name || item.firstName || item.subject || item.title || "Untitled"}</div>
                  <div className="text-xs text-[#4A5168] mt-0.5">{item.email || item.status || item.stage || ""}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettingsPage() {
  const { user, apiFetch } = useAuth();
  const [activeTab, setActiveTab] = useState("profile");
  const [profile, setProfile] = useState({ firstName: user?.firstName, lastName: user?.lastName, email: user?.email });
  const [toast, setToast] = useState(null);

  const tabs = [
    { id: "profile", label: "Profile", icon: Users },
    { id: "security", label: "Security", icon: Shield },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "system", label: "System", icon: Settings },
  ];

  const saveProfile = async () => {
    try {
      await apiFetch(`/users/${user.id}`, { method: "PUT", body: profile });
      setToast({ message: "Profile updated", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Settings</h1>

      {/* Tab bar - scrollable on mobile */}
      <div className="flex items-center gap-1 overflow-x-auto pb-2 mb-4 -mx-3 px-3 sm:mx-0 sm:px-0">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors min-h-[36px] touch-manipulation ${
              activeTab === tab.id ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623]" : "text-[#7E8598] hover:bg-[#0E1630]"
            }`}>
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {activeTab === "profile" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Personal Information</h3>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#F5A623] to-[#E8961A] flex items-center justify-center text-xl font-bold text-[#F0EDE5]">
                {user?.firstName?.[0]}{user?.lastName?.[0]}
              </div>
              <div>
                <div className="text-sm font-medium text-[#F0EDE5]">{user?.firstName} {user?.lastName}</div>
                <div className="text-xs text-[#7E8598]">{user?.email}</div>
                <div className="text-xs text-[#4A5168] mt-0.5">{user?.role || "User"}</div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <Input label="First Name" value={profile.firstName} onChange={v => setProfile(p => ({ ...p, firstName: v }))} />
              <Input label="Last Name" value={profile.lastName} onChange={v => setProfile(p => ({ ...p, lastName: v }))} />
              <Input label="Email" value={profile.email} onChange={v => setProfile(p => ({ ...p, email: v }))} type="email" />
              <Input label="Phone" value={profile.phone} onChange={v => setProfile(p => ({ ...p, phone: v }))} type="tel" />
            </div>
            <Button onClick={saveProfile} size="md">Save Changes</Button>
          </div>
          <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Account Details</h3>
            <div className="space-y-3">
              {[["User ID", user?.id?.substring(0, 12) + "..."], ["Role", user?.role || "User"], ["Created", user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-"], ["Last Login", user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "-"], ["Status", "Active"]].map(([k, v]) => (
                <div key={k} className="flex justify-between py-2 border-b border-[#182550]/40">
                  <span className="text-xs text-[#7E8598]">{k}</span>
                  <span className="text-xs text-[#C8C2B4] font-mono">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Security tab */}
      {activeTab === "security" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Change Password</h3>
            <div className="space-y-3 mb-4">
              <Input label="Current Password" type="password" value="" onChange={() => {}} />
              <Input label="New Password" type="password" value="" onChange={() => {}} />
              <Input label="Confirm Password" type="password" value="" onChange={() => {}} />
            </div>
            <Button size="md">Update Password</Button>
          </div>
          <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Two-Factor Authentication</h3>
            <p className="text-xs text-[#7E8598] mb-4">Add an extra layer of security to your account.</p>
            <Button variant="secondary" size="md" icon={Shield}>Enable 2FA</Button>
          </div>
        </div>
      )}

      {/* Notifications tab */}
      {activeTab === "notifications" && (
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Notification Preferences</h3>
          <div className="space-y-4">
            {[["Deal updates", "Get notified when deals change stage"], ["New leads", "Alerts for newly assigned leads"], ["Case assignments", "Notifications for case routing"], ["Task reminders", "Reminders for upcoming due dates"], ["Mentions", "When someone mentions you in a comment"], ["Weekly digest", "Weekly summary of your pipeline"]].map(([title, desc], i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-[#182550]/40">
                <div>
                  <div className="text-sm text-[#F0EDE5]">{title}</div>
                  <div className="text-xs text-[#4A5168]">{desc}</div>
                </div>
                <div className="w-10 h-5 rounded-full bg-[#F5A623] relative cursor-pointer touch-manipulation">
                  <div className="absolute right-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* System tab */}
      {activeTab === "system" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">System Information</h3>
            <div className="space-y-2">
              {[["Version", "4.1.0"], ["Modules", "86 routes"], ["Models", "173"], ["API Endpoints", "575+"], ["Indexes", "253"], ["Database", "PostgreSQL + Prisma"]].map(([k, v]) => (
                <div key={k} className="flex justify-between py-1.5 border-b border-[#182550]/40">
                  <span className="text-xs text-[#7E8598]">{k}</span>
                  <span className="text-xs text-[#C8C2B4] font-mono">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Data Management</h3>
            <div className="space-y-3">
              <Button variant="secondary" size="sm" icon={Download} fullWidth>Export All Data</Button>
              <Button variant="secondary" size="sm" icon={Upload} fullWidth>Import Data</Button>
              <Button variant="secondary" size="sm" icon={Recycle} fullWidth>Recycle Bin</Button>
              <Button variant="danger" size="sm" icon={Trash2} fullWidth>Clear Cache</Button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function AdminDashboardPage() {
  const { data: sys, loading } = useApi("/admin/dashboard/system");
  const { data: actData } = useApi("/admin/dashboard/activity");
  if (loading) return <Spinner />;
  const d = sys || {}; const p = d.platform || {}; const r = d.records || {}; const sec = d.security || {};
  const rev = d.revenue || {}; const auto = d.automation || {}; const health = d.health || {};
  const act = actData || {};
  const upHrs = Math.floor((health.uptime || 0) / 3600);
  const memMB = Math.round((health.memoryUsage?.heapUsed || 0) / 1048576);

  const Pill = ({ label, value, color = "amber" }) => {
    const cls = { amber: "text-[#F5A623] border-[#F5A623]/20", green: "text-[#34D399] border-[#34D399]/20", blue: "text-[#60A5FA] border-[#60A5FA]/20", red: "text-[#F87171] border-[#F87171]/20", purple: "text-[#A78BFA] border-[#A78BFA]/20", cyan: "text-[#22D3EE] border-[#22D3EE]/20" };
    return <div className={`px-2.5 sm:px-3 py-2 rounded-lg border ${cls[color] || cls.amber}`}><div className="text-[9px] sm:text-[10px] uppercase tracking-wider opacity-60">{label}</div><div className="text-base sm:text-lg font-bold font-mono mt-0.5">{typeof value === "number" ? value.toLocaleString() : value}</div></div>;
  };
  const Section = ({ title, children }) => <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5"><h3 className="text-xs font-semibold text-[#C8C2B4] uppercase tracking-wider mb-3">{title}</h3>{children}</div>;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 sm:mb-6">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Admin Dashboard</h1>
          <p className="text-xs text-[#4A5168]">System health and platform overview</p>
        </div>
        <div className={`self-start px-3 py-1.5 rounded-full text-xs font-medium ${health.database === 'connected' ? 'bg-[#34D399]/10 text-[#34D399]' : 'bg-[#F87171]/10 text-[#F87171]'}`}>
          {health.database === 'connected' ? 'All Systems Operational' : 'Degraded'}
        </div>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-6 gap-2 sm:gap-3 mb-4 sm:mb-6">
        <Pill label="Uptime" value={`${upHrs}h`} color="green" />
        <Pill label="Memory" value={`${memMB}MB`} color={memMB > 500 ? "red" : "blue"} />
        <Pill label="Models" value={p.models || 173} color="purple" />
        <Pill label="Endpoints" value={p.endpoints || 575} color="amber" />
        <Pill label="Indexes" value={p.indexes || 253} color="blue" />
        <Pill label="Node" value={(health.nodeVersion || "?").replace("v","").split(".")[0]} color="cyan" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4 mb-4">
        <Section title="Data Volume">
          <div className="grid grid-cols-3 gap-1.5">
            {Object.entries({ Users: r.users, Contacts: r.contacts, Leads: r.leads, Deals: r.deals, Accounts: r.accounts, Cases: r.cases, Activities: r.activities, Products: r.products, Campaigns: r.campaigns }).filter(([,v]) => v !== undefined).map(([k, v]) =>
              <div key={k} className="text-center py-1"><div className="text-sm font-bold font-mono text-[#C8C2B4]">{(v||0).toLocaleString()}</div><div className="text-[8px] sm:text-[9px] text-[#4A5168] uppercase">{k}</div></div>
            )}
          </div>
        </Section>
        <Section title="Security">
          <div className="space-y-2">
            {[["API Keys", sec.activeApiKeys, "#60A5FA"], ["Logins 24h", sec.loginsLast24h, "#22D3EE"], ["MFA Devices", sec.mfaDevicesEnrolled, "#34D399"], ["Events 24h", sec.eventsLast24h, "#A78BFA"]].map(([l, v, c]) =>
              <div key={l} className="flex justify-between text-xs"><span className="text-[#7E8598]">{l}</span><span className="font-mono font-bold" style={{ color: c }}>{(v||0).toLocaleString()}</span></div>
            )}
          </div>
        </Section>
        <Section title="Revenue & Automation">
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Pill label="Pipeline" value={`$${((rev.pipelineValue||0)/1000).toFixed(0)}K`} color="amber" />
            <Pill label="Won" value={`$${((rev.wonValue||0)/1000).toFixed(0)}K`} color="green" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Pill label="Workflows" value={auto.activeWorkflows||0} color="cyan" />
            <Pill label="Flows" value={auto.activeFlows||0} color="purple" />
            <Pill label="Approvals" value={auto.approvalsPending||0} color={auto.approvalsPending>5?"red":"amber"} />
          </div>
        </Section>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <Section title="Recent Logins">
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {(act.recentLogins || []).slice(0, 8).map((l, i) =>
              <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-[#182550]/40">
                <span className="text-[#C8C2B4] font-mono truncate flex-1">{l.userId?.substring(0, 8)}...</span>
                <span className={`mx-2 ${l.status === 'Success' ? "text-[#34D399]" : "text-[#F87171]"}`}>{l.status}</span>
                <span className="text-[#4A5168] hidden sm:inline">{l.loginTime ? new Date(l.loginTime).toLocaleString() : ""}</span>
              </div>
            )}
            {!(act.recentLogins?.length) && <div className="text-xs text-[#4A5168] text-center py-4">No recent logins</div>}
          </div>
        </Section>
        <Section title="Audit Trail">
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {(act.recentAudit || []).slice(0, 8).map((a, i) =>
              <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-[#182550]/40">
                <span className="text-[#F5A623] font-medium">{a.action || a.event}</span>
                <span className="text-[#C8C2B4]">{a.module || a.entity}</span>
                <span className="text-[#4A5168] hidden sm:inline">{a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}</span>
              </div>
            )}
            {!(act.recentAudit?.length) && <div className="text-xs text-[#4A5168] text-center py-4">No audit entries</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}

// ========================================================================
// LOGIN PAGE -- mobile-first
// ========================================================================
function LoginPage({ go }) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      await login(email, password);
      if (window.location.pathname !== "/app") {
        window.history.pushState({}, "", "/app");
      }
    } catch (e) { setError(e.message || "Login failed"); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center p-4" style={{ background: "var(--sn-void)", color: "var(--sn-cream)" }}>
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-4">
          <ThemeToggle compact />
        </div>
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <BrandMark size={56} />
          </div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--sn-cream)" }}>Sales Nebula</h1>
          <p className="text-sm mt-1" style={{ color: "var(--sn-dim)" }}>Enterprise CRM Platform</p>
        </div>
        <form onSubmit={handleLogin} className="rounded-2xl p-5 sm:p-6 space-y-4" style={{ background: "var(--sn-panel)", border: "1px solid var(--sn-rule)" }}>
          {error && <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: "rgba(248,113,113,0.10)", border: "1px solid rgba(248,113,113,0.20)", color: "var(--sn-red)" }}>{error}</div>}
          <Input label="Email" type="email" value={email} onChange={setEmail} required placeholder="your@email.com" />
          <Input label="Password" type="password" value={password} onChange={setPassword} required placeholder="Password" />
          <Button onClick={handleLogin} disabled={loading} fullWidth size="lg">
            {loading ? "Signing in..." : "Sign In"}
          </Button>

          <button
            type="button"
            onClick={() => { setEmail(DEMO_LOGIN.email); setPassword(DEMO_LOGIN.password); setError(""); }}
            className="w-full rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"
            style={{
              background: "var(--sn-raised)",
              border: "1px solid var(--sn-rule)",
              color: "var(--sn-cream)",
            }}
          >
            Use demo access
          </button>
          <p className="text-center text-xs" style={{ color: "var(--sn-dim)" }}>
            Fills the form with the shared demo login. Request an account for your own data.
          </p>
        </form>

        <div className="text-center mt-5 space-y-2">
          <div className="text-xs" style={{ color: "var(--sn-dim)" }}>
            No account? Access is granted by invitation.
          </div>
          <button
            onClick={() => (go ? go("/") : (window.location.href = "/"))}
            className="text-xs hover:underline"
            style={{ color: "var(--sn-amber)" }}
          >
            Request access
          </button>
        </div>
      </div>
    </div>
  );
}

// ========================================================================
// ADDITIONAL PAGES
// ========================================================================

// ── Reports Page ──
function ReportsPage() {
  const { apiFetch } = useAuth();
  const [reports, setReports] = useState([]); const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false); const [form, setForm] = useState({});
  const [toast, setToast] = useState(null); const [selectedReport, setSelectedReport] = useState(null); const [reportData, setReportData] = useState(null);
  const load = useCallback(() => { setLoading(true); apiFetch('/reports').then(d => setReports(d.data || d || [])).catch(() => setReports([])).finally(() => setLoading(false)); }, [apiFetch]);
  useEffect(() => { load(); }, [load]);
  const runReport = async (r) => { setSelectedReport(r); try { const d = await apiFetch(`/reports/${r.id}/run`, { method: 'POST', body: {} }); setReportData(d); } catch (e) { setToast({ message: e.message, type: 'error' }); } };
  const save = async () => { try { await apiFetch('/reports', { method: 'POST', body: form }); setModalOpen(false); setForm({}); load(); setToast({ message: 'Report created', type: 'success' }); } catch (e) { setToast({ message: e.message, type: 'error' }); } };
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4"><h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Reports</h1><Button icon={Plus} onClick={() => setModalOpen(true)}>New Report</Button></div>
      {loading ? <Spinner /> : reports.length === 0 ? <EmptyState icon={BarChart3} title="No reports yet" action="Create Report" onAction={() => setModalOpen(true)} /> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{reports.map(r => (
          <div key={r.id} onClick={() => runReport(r)} className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 hover:border-[#203060] cursor-pointer transition-colors active:scale-[0.98] touch-manipulation">
            <div className="flex items-start justify-between mb-2"><div className="text-sm font-medium text-[#F0EDE5] truncate">{r.name}</div><Badge color={r.type === 'Summary' ? 'info' : 'primary'}>{r.type || 'Tabular'}</Badge></div>
            <div className="text-xs text-[#4A5168]">{r.module || 'All'}</div></div>))}</div>)}
      {selectedReport && reportData && (<Modal open={!!selectedReport} onClose={() => { setSelectedReport(null); setReportData(null); }} title={selectedReport.name} wide>
        <div className="text-xs text-[#4A5168] mb-3">{reportData.totalRecords || 0} records</div>
        {reportData.rows?.length > 0 ? (<div className="overflow-x-auto -mx-4 sm:mx-0"><table className="w-full min-w-[400px] text-xs"><thead><tr className="border-b border-[#182550]">{Object.keys(reportData.rows[0]).slice(0,6).map(k=><th key={k} className="py-2 px-2 text-left text-[#4A5168] uppercase">{k}</th>)}</tr></thead><tbody>{reportData.rows.slice(0,20).map((row,i)=><tr key={i} className="border-b border-[#182550]/40">{Object.values(row).slice(0,6).map((v,j)=><td key={j} className="py-2 px-2 text-[#C8C2B4]">{String(v??'-').substring(0,30)}</td>)}</tr>)}</tbody></table></div>) : <div className="text-sm text-[#4A5168] text-center py-6">No data</div>}
      </Modal>)}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Report">
        <div className="space-y-3 mb-4"><Input label="Report Name" value={form.name} onChange={v => setForm(p => ({...p, name: v}))} required /><Select label="Module" value={form.module} onChange={v => setForm(p => ({...p, module: v}))} options={['contacts','leads','deals','accounts','cases','activities','products','campaigns']} placeholder="Select module" /><Select label="Type" value={form.type} onChange={v => setForm(p => ({...p, type: v}))} options={['Tabular','Summary','Matrix']} /></div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]"><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button><Button onClick={save}>Create</Button></div>
      </Modal>
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── Surveys ──
function SurveysPage() {
  return <ModulePage title="Surveys" icon={MessageSquare} endpoint="/surveys"
    columns={[
      { key: "title", label: "Title" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Published'?'success':v==='Closed'?'neutral':'warning'}>{v||'Draft'}</Badge> },
      { key: "responseCount", label: "Responses", render: v => <span className="font-mono">{v||0}</span> },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Published","Closed"] },
    ]}
    detailFields={[
      { key: "title", label: "Title" }, { key: "status", label: "Status" },
      { key: "description", label: "Description" }, { key: "responseCount", label: "Responses" },
      { key: "createdAt", label: "Created", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[{ key: "title", label: "Title", required: true },{ key: "description", label: "Description", type: "textarea" },{ key: "status", label: "Status", type: "select", options: ["Draft","Published","Closed"] }]}
  />;
}
// ── Territories ──
function TerritoriesPage() {
  return <ModulePage title="Territories" icon={Globe} endpoint="/territories"
    columns={[
      { key: "name", label: "Territory" }, { key: "type", label: "Type" },
      { key: "description", label: "Description" },
    ]}
    filterDefs={[
      { key: "type", label: "Type", type: "select", options: ["Region","State","City","Custom"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "type", label: "Type" },
      { key: "description", label: "Description" },
      { key: "createdAt", label: "Created", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "type", label: "Type", type: "select", options: ["Region","State","City","Custom"] },{ key: "description", label: "Description" }]}
  />;
}
// ── Documents ──
function DocumentsPage() {
  return <ModulePage title="Documents" icon={FolderOpen} endpoint="/documents"
    columns={[
      { key: "name", label: "Name" }, { key: "category", label: "Category" },
      { key: "mimeType", label: "Type", render: v => v ? v.split("/").pop() : "-" },
      { key: "fileSize", label: "Size", render: v => v ? `${(v/1024).toFixed(0)} KB` : "-" },
      { key: "downloadCount", label: "Downloads", render: v => <span className="font-mono">{v||0}</span> },
    ]}
    filterDefs={[
      { key: "category", label: "Category", type: "select", options: ["Contract","Proposal","Invoice","Report","Other"] },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "category", label: "Category", type: "select", options: ["Contract","Proposal","Invoice","Report","Other"] },{ key: "description", label: "Description" }]}
  />;
}
// ── Tags ──
function TagsPage() {
  return <ModulePage title="Tags" icon={Tag} endpoint="/tags"
    columns={[
      { key: "name", label: "Tag" },
      { key: "color", label: "Color", render: v => <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{background:v||'#60A5FA'}} />{v||'-'}</span> },
      { key: "module", label: "Module" },
      { key: "usageCount", label: "Used", render: v => <span className="font-mono">{v||0}</span> },
    ]}
    filterDefs={[
      { key: "module", label: "Module", type: "select", options: ["contacts","leads","deals","accounts","all"] },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "color", label: "Color", type: "select", options: ["blue","green","red","yellow","purple","cyan","orange"] },{ key: "module", label: "Module", type: "select", options: ["contacts","leads","deals","accounts","all"] }]}
  />;
}
// ── Webhooks ──
function WebhooksPage() {
  return <ModulePage title="Webhooks" icon={Webhook} endpoint="/webhooks"
    columns={[
      { key: "name", label: "Name" }, { key: "url", label: "URL" },
      { key: "active", label: "Active", render: v => <Badge color={v?'success':'neutral'}>{v?'Active':'Inactive'}</Badge> },
      { key: "lastTriggered", label: "Last Triggered", render: v => v ? new Date(v).toLocaleString() : "Never" },
    ]}
    filterDefs={[
      { key: "active", label: "Status", type: "select", options: ["true","false"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "url", label: "URL" },
      { key: "secret", label: "Secret", render: () => "********" },
      { key: "active", label: "Active" }, { key: "events", label: "Events" },
      { key: "lastTriggered", label: "Last Triggered", render: v => v ? new Date(v).toLocaleString() : "Never" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "url", label: "URL", required: true },{ key: "secret", label: "Secret" }]}
  />;
}
// ── Partners ──
function PartnersPage() {
  return <ModulePage title="Partners" icon={Briefcase} endpoint="/partners"
    columns={[
      { key: "name", label: "Partner" }, { key: "type", label: "Type" },
      { key: "tier", label: "Tier", render: v => <Badge color={v==='Platinum'?'purple':v==='Gold'?'warning':v==='Silver'?'info':'neutral'}>{v||'Registered'}</Badge> },
      { key: "status", label: "Status" }, { key: "contactEmail", label: "Email" },
    ]}
    filterDefs={[
      { key: "tier", label: "Tier", type: "select", options: ["Registered","Silver","Gold","Platinum"] },
      { key: "type", label: "Type", type: "select", options: ["Reseller","Referral","Technology","Consulting","ISV"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "type", label: "Type" }, { key: "tier", label: "Tier" },
      { key: "status", label: "Status" }, { key: "contactEmail", label: "Email" },
      { key: "phone", label: "Phone" }, { key: "website", label: "Website" },
      { key: "description", label: "Description" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "type", label: "Type", type: "select", options: ["Reseller","Referral","Technology","Consulting"] },{ key: "tier", label: "Tier", type: "select", options: ["Registered","Silver","Gold","Platinum"] },{ key: "contactEmail", label: "Email", type: "email" }]}
  />;
}
// ── Assets ──
function AssetsPage() {
  return <ModulePage title="Assets" icon={Package} endpoint="/assets"
    columns={[
      { key: "name", label: "Asset" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Active'||v==='Installed'?'success':v==='Decommissioned'?'danger':'warning'}>{v||'-'}</Badge> },
      { key: "serialNumber", label: "Serial #" },
      { key: "warrantyEndDate", label: "Warranty", render: v => { if (!v) return "-"; const d = new Date(v); const now = new Date(); return <span className={d < now ? "text-[#F87171]" : "text-[#34D399]"}>{d.toLocaleDateString()}</span>; } },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Purchased","Shipped","Installed","Active","Decommissioned"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "serialNumber", label: "Serial Number" },
      { key: "status", label: "Status" },
      { key: "installDate", label: "Installed", render: v => v ? new Date(v).toLocaleDateString() : "-" },
      { key: "warrantyEndDate", label: "Warranty Ends", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "serialNumber", label: "Serial #" },{ key: "status", label: "Status", type: "select", options: ["Purchased","Shipped","Installed","Active","Decommissioned"] },{ key: "installDate", label: "Install", type: "date" },{ key: "warrantyEndDate", label: "Warranty End", type: "date" }]}
  />;
}
// ── Notes ──
function NotesPage() {
  return <ModulePage title="Notes" icon={FileText} endpoint="/notes"
    columns={[
      { key: "title", label: "Title" }, { key: "parentModule", label: "Module" },
      { key: "createdAt", label: "Created", render: v => v ? new Date(v).toLocaleDateString() : "-" },
    ]}
    detailFields={[
      { key: "title", label: "Title" }, { key: "body", label: "Content" },
      { key: "parentModule", label: "Module" },
      { key: "createdAt", label: "Created", render: v => v ? new Date(v).toLocaleString() : "-" },
    ]}
    formFields={[{ key: "title", label: "Title", required: true },{ key: "body", label: "Content", type: "textarea" }]}
  />;
}
// ── Sequences ──
function SequencesPage() {
  return <ModulePage title="Sequences" icon={GitBranch} endpoint="/sequences"
    columns={[
      { key: "name", label: "Sequence" },
      { key: "status", label: "Status", render: v => <Badge color={v==='Active'?'success':v==='Paused'?'warning':'neutral'}>{v||'Draft'}</Badge> },
      { key: "totalSteps", label: "Steps", render: v => <span className="font-mono">{v||0}</span> },
      { key: "enrolledCount", label: "Enrolled", render: v => <span className="font-mono">{v||0}</span> },
    ]}
    filterDefs={[
      { key: "status", label: "Status", type: "select", options: ["Draft","Active","Paused","Completed"] },
    ]}
    detailFields={[
      { key: "name", label: "Name" }, { key: "status", label: "Status" },
      { key: "description", label: "Description" },
      { key: "totalSteps", label: "Steps" }, { key: "enrolledCount", label: "Enrolled" },
    ]}
    formFields={[{ key: "name", label: "Name", required: true },{ key: "status", label: "Status", type: "select", options: ["Draft","Active","Paused"] }]}
  />;
}

// ── Approvals ──
function ApprovalsPage() {
  const { apiFetch } = useAuth();
  const [pending, setPending] = useState([]); const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true); const [toast, setToast] = useState(null); const [tab, setTab] = useState('pending');
  const load = useCallback(() => { setLoading(true); Promise.all([apiFetch('/approvals/pending').catch(()=>({data:[]})),apiFetch('/approvals/history?limit=20').catch(()=>({data:[]}))]).then(([p,h])=>{setPending(p.data||p||[]);setHistory(h.data||h||[]);}).finally(()=>setLoading(false)); }, [apiFetch]);
  useEffect(() => { load(); }, [load]);
  const handleAction = async (id, action) => { try { await apiFetch(`/approvals/${id}/${action}`, { method: 'POST', body: {} }); setToast({ message: `${action}d`, type: 'success' }); load(); } catch (e) { setToast({ message: e.message, type: 'error' }); } };
  const items = tab === 'pending' ? pending : history;
  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Approvals</h1>
      <div className="flex gap-1 mb-4 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">{['pending','history'].map(t=><button key={t} onClick={()=>setTab(t)} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors capitalize touch-manipulation ${tab===t?'bg-[rgba(245,166,35,0.08)] text-[#F5A623]':'text-[#7E8598]'}`}>{t}{t==='pending'&&pending.length>0&&<span className="ml-1 text-xs bg-[#F5A623] text-[#060B1A] rounded-full px-1.5">{pending.length}</span>}</button>)}</div>
      {loading ? <Spinner /> : items.length===0 ? <EmptyState icon={CheckCircle2} title={tab==='pending'?"No pending approvals":"No history"} /> : (
        <div className="space-y-2">{items.map(a=>(<div key={a.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-4"><div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2"><div><div className="text-sm font-medium text-[#F0EDE5]">{a.module} - {a.recordId?.substring(0,8)}</div><div className="text-xs text-[#4A5168] mt-0.5">{a.createdAt?new Date(a.createdAt).toLocaleString():''}</div></div><div className="flex items-center gap-2">{a.status==='Pending'?<><Button variant="primary" size="sm" onClick={()=>handleAction(a.id,'approve')}>Approve</Button><Button variant="danger" size="sm" onClick={()=>handleAction(a.id,'reject')}>Reject</Button></>:<Badge color={a.status==='Approved'?'success':'danger'}>{a.status}</Badge>}</div></div></div>))}</div>)}
      {toast && <Toast {...toast} onClose={()=>setToast(null)} />}
    </div>
  );
}

// ── Analytics ──
function AnalyticsPage() {
  const { data, loading } = useApi("/analytics/overview");
  if (loading) return <Spinner />;
  const d = data || {};
  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Analytics</h1>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-6">
        <StatCard label="Conversion Rate" value={`${d.conversionRate||0}%`} icon={TrendingUp} color="success" />
        <StatCard label="Avg Deal Size" value={`$${((d.avgDealSize||0)/1000).toFixed(0)}K`} icon={DollarSign} color="primary" />
        <StatCard label="Sales Cycle" value={`${d.avgSalesCycle||0}d`} icon={Clock} color="cyan" />
        <StatCard label="Activities/Day" value={d.activitiesPerDay||0} icon={Activity} color="purple" />
      </div>
    </div>
  );
}

// ── Copilot Chat ──
function CopilotPage() {
  const { apiFetch } = useAuth();
  const [messages, setMessages] = useState([]); const [input, setInput] = useState(""); const [loading, setLoading] = useState(false);
  const chatRef = useRef(null);
  const send = async () => { if (!input.trim()||loading) return; setMessages(p=>[...p,{role:'user',text:input}]); setInput(""); setLoading(true); try { const d=await apiFetch('/copilot/ask',{method:'POST',body:{question:input}}); setMessages(p=>[...p,{role:'assistant',text:d.answer||d.response||JSON.stringify(d)}]); } catch(e){ setMessages(p=>[...p,{role:'assistant',text:`Error: ${e.message}`}]); } finally{setLoading(false);} };
  useEffect(()=>{chatRef.current?.scrollTo(0,chatRef.current.scrollHeight);},[messages]);
  return (
    <div className="flex flex-col h-[calc(100dvh-140px)] sm:h-[calc(100dvh-110px)]">
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-3">AI Copilot</h1>
      <div ref={chatRef} className="flex-1 overflow-y-auto space-y-3 mb-3 overscroll-contain">
        {messages.length===0&&<EmptyState icon={Zap} title="Ask me anything" subtitle="Deals, contacts, tasks, insights" />}
        {messages.map((m,i)=>(<div key={i} className={`flex ${m.role==='user'?'justify-end':'justify-start'}`}><div className={`max-w-[85%] sm:max-w-[70%] px-4 py-3 rounded-2xl text-sm ${m.role==='user'?'bg-[#F5A623] text-[#060B1A] rounded-br-md':'bg-[#0B1228] border border-[#182550] text-[#C8C2B4] rounded-bl-md'}`}>{m.text}</div></div>))}
        {loading&&<div className="flex justify-start"><div className="bg-[#0B1228] border border-[#182550] rounded-2xl rounded-bl-md px-4 py-3 text-sm text-[#4A5168] animate-pulse">Thinking...</div></div>}
      </div>
      <div className="flex gap-2"><input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()} placeholder="Ask about your CRM data..." className="flex-1 px-4 py-3 bg-[#0E1630] border border-[#182550] rounded-xl text-sm text-[#F0EDE5] placeholder-[#4A5168] focus:outline-none focus:border-[#F5A623] min-h-[48px]" /><Button onClick={send} disabled={loading} size="lg" icon={Send}><span className="hidden sm:inline">Send</span></Button></div>
    </div>
  );
}

// ── Chatter/Feed ──
function ChatterPage() {
  const { apiFetch } = useAuth();
  const [posts, setPosts] = useState([]); const [newPost, setNewPost] = useState(""); const [loading, setLoading] = useState(true); const [toast, setToast] = useState(null);
  const load = useCallback(()=>{setLoading(true);apiFetch('/chatter?limit=30').then(d=>setPosts(d.data||d||[])).catch(()=>setPosts([])).finally(()=>setLoading(false));}, [apiFetch]);
  useEffect(()=>{load();},[load]);
  const post = async()=>{if(!newPost.trim())return;try{await apiFetch('/chatter',{method:'POST',body:{body:newPost}});setNewPost("");load();}catch(e){setToast({message:e.message,type:'error'});}};
  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Chatter</h1>
      <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 mb-4"><TextArea value={newPost} onChange={setNewPost} placeholder="Share an update..." rows={2} /><div className="flex justify-end mt-2"><Button onClick={post} size="sm" icon={Send}>Post</Button></div></div>
      {loading ? <Spinner /> : posts.length===0 ? <EmptyState icon={MessageSquare} title="No posts yet" /> : (
        <div className="space-y-3">{posts.map(p=>(<div key={p.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2"><div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#F5A623] to-[#E8961A] flex items-center justify-center text-xs font-bold text-[#F0EDE5]">{(p.author?.firstName?.[0]||'U')}</div><div><div className="text-sm font-medium text-[#F0EDE5]">{p.author?.firstName||'User'} {p.author?.lastName||''}</div><div className="text-xs text-[#4A5168]">{p.createdAt?new Date(p.createdAt).toLocaleString():''}</div></div></div>
          <div className="text-sm text-[#C8C2B4]">{p.body}</div>
          <div className="flex items-center gap-3 mt-3 pt-2 border-t border-[#182550]/40"><button className="text-xs text-[#4A5168] hover:text-[#F5A623] flex items-center gap-1"><Star size={12} />{p.likeCount||0}</button><button className="text-xs text-[#4A5168] hover:text-[#60A5FA] flex items-center gap-1"><MessageSquare size={12} />{p.commentCount||0}</button></div>
        </div>))}</div>)}
      {toast && <Toast {...toast} onClose={()=>setToast(null)} />}
    </div>
  );
}

// ── Recycle Bin ──
function RecycleBinPage() {
  const { apiFetch } = useAuth();
  const [stats, setStats] = useState(null); const [items, setItems] = useState([]); const [module, setModule] = useState('contact'); const [loading, setLoading] = useState(true); const [toast, setToast] = useState(null);
  useEffect(()=>{apiFetch('/recycle-bin/stats').then(setStats).catch(()=>{});},[apiFetch]);
  useEffect(()=>{setLoading(true);apiFetch(`/recycle-bin?module=${module}&limit=50`).then(d=>setItems(d.data||d||[])).catch(()=>setItems([])).finally(()=>setLoading(false));},[module,apiFetch]);
  const restore = async(id)=>{try{await apiFetch(`/recycle-bin/${id}/restore`,{method:'POST',body:{module}});setToast({message:'Restored',type:'success'});setItems(p=>p.filter(i=>i.id!==id));}catch(e){setToast({message:e.message,type:'error'});}};
  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Recycle Bin</h1>
      {stats&&<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">{Object.entries(stats.byModule||{}).filter(([,v])=>v>0).map(([mod,count])=>(<button key={mod} onClick={()=>setModule(mod)} className={`p-3 rounded-xl border text-left touch-manipulation ${module===mod?'bg-[rgba(245,166,35,0.08)] border-[rgba(245,166,35,0.20)]':'bg-[#0B1228] border-[#182550]'}`}><div className="text-lg font-bold font-mono text-[#F0EDE5]">{count}</div><div className="text-xs text-[#4A5168] capitalize">{mod}s</div></button>))}</div>}
      {loading?<Spinner/>:items.length===0?<EmptyState icon={Recycle} title="Empty" subtitle="Deleted items appear here for 30 days" />:(
        <div className="space-y-2">{items.map(item=>(<div key={item.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 flex items-center justify-between"><div><div className="text-sm text-[#F0EDE5]">{item.name||item.firstName||item.subject||'Untitled'}</div><div className="text-xs text-[#4A5168]">Deleted {item.deletedAt?new Date(item.deletedAt).toLocaleDateString():''}</div></div><Button variant="secondary" size="sm" onClick={()=>restore(item.id)}>Restore</Button></div>))}</div>)}
      {toast && <Toast {...toast} onClose={()=>setToast(null)} />}
    </div>
  );
}

// ── Import ──
function ImportPage() {
  const [module, setModule] = useState('contacts');
  return (
    <div>
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5] mb-4">Import Data</h1>
      <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-6 max-w-lg">
        <Select label="Module" value={module} onChange={setModule} options={['contacts','leads','deals','accounts','cases','products']} />
        <div className="mt-4 p-6 border-2 border-dashed border-[#182550] rounded-xl text-center"><Upload size={24} className="mx-auto text-[#4A5168] mb-2" /><div className="text-sm text-[#7E8598]">Drag & drop a CSV file</div><div className="text-xs text-[#4A5168] mt-1">or click to browse</div></div>
        <Button fullWidth className="mt-4">Start Import</Button>
      </div>
    </div>
  );
}

// ========================================================================
// TIER 1 PAGES: Calendar, Projects (Gantt), Security Groups
// Injected into App.jsx by scripts/inject-tier1.js
// ========================================================================

// ── Shared date helpers ──
const startOfWeek = (d, wkst = 0) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() - wkst + 7) % 7)); x.setHours(0,0,0,0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const isoDay = d => new Date(d).toISOString().slice(0, 10);
const sameDay = (a, b) => isoDay(a) === isoDay(b);
const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const EVENT_COLORS = {
  Meeting: "#F5A623", Call: "#34D399", Appointment: "#60A5FA",
  Task: "#A78BFA", OutOfOffice: "#7E8598", Holiday: "#2DD4BF",
};

// ========================================================================
// CALENDAR PAGE
// ========================================================================
function CalendarPage() {
  const { apiFetch } = useAuth();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [mode, setMode] = useState("month");
  const [anchor, setAnchor] = useState(new Date());
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [form, setForm] = useState({});
  const [invitations, setInvitations] = useState([]);

  useEffect(() => { if (isMobile && mode === "month") setMode("agenda"); }, [isMobile]);

  const load = useCallback(() => {
    setLoading(true);
    const q = `date=${isoDay(anchor)}${mode === "agenda" ? "&days=14" : ""}`;
    apiFetch(`/calendar/view/${mode}?${q}`)
      .then(d => setEvents(d.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [mode, anchor, apiFetch]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiFetch('/calendar/invitations/pending').then(d => setInvitations(d.invitations || [])).catch(() => {});
  }, [apiFetch]);

  const shift = (dir) => {
    const a = new Date(anchor);
    if (mode === "day") a.setDate(a.getDate() + dir);
    else if (mode === "week") a.setDate(a.getDate() + dir * 7);
    else if (mode === "agenda") a.setDate(a.getDate() + dir * 14);
    else a.setMonth(a.getMonth() + dir);
    setAnchor(a);
  };

  const save = async () => {
    if (!form.title || !form.startAt || !form.endAt) {
      setToast({ message: "Title, start and end are required", type: "error" }); return;
    }
    try {
      await apiFetch('/calendar/events', { method: 'POST', body: {
        ...form,
        rrule: form.repeat && form.repeat !== 'none' ? form.repeat : null,
      }});
      setComposerOpen(false); setForm({}); load();
      setToast({ message: "Event created", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const respond = async (eventId, response) => {
    try {
      await apiFetch(`/calendar/events/${eventId}/respond`, { method: 'POST', body: { response } });
      setInvitations(p => p.filter(i => i.eventId !== eventId));
      setToast({ message: `Invitation ${response.toLowerCase()}`, type: "success" });
      load();
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const label = mode === "month"
    ? `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
    : mode === "week"
      ? `${startOfWeek(anchor).toLocaleDateString(undefined,{month:'short',day:'numeric'})} - ${addDays(startOfWeek(anchor),6).toLocaleDateString(undefined,{month:'short',day:'numeric'})}`
      : anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Calendar</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-[#0B1228] border border-[#182550] rounded-lg overflow-hidden">
            <button onClick={() => shift(-1)} className="p-2.5 hover:bg-[#101B3A] text-[#7E8598] touch-manipulation"><ChevronLeft size={16} /></button>
            <button onClick={() => setAnchor(new Date())} className="px-3 py-2 text-xs font-medium text-[#C8C2B4] hover:bg-[#101B3A] border-x border-[#182550] touch-manipulation">Today</button>
            <button onClick={() => shift(1)} className="p-2.5 hover:bg-[#101B3A] text-[#7E8598] touch-manipulation"><ChevronRight size={16} /></button>
          </div>
          <Button icon={Plus} onClick={() => { setForm({ eventType: 'Meeting' }); setComposerOpen(true); }}>
            <span className="hidden sm:inline">New Event</span>
          </Button>
        </div>
      </div>

      {/* View switcher + period label */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div className="text-sm font-semibold text-[#F0EDE5]">{label}</div>
        <div className="flex gap-1 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">
          {["day","week","month","agenda"].map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors touch-manipulation ${mode===m ? 'bg-[rgba(245,166,35,0.08)] text-[#F5A623]' : 'text-[#7E8598] hover:text-[#C8C2B4]'}`}>
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <div className="bg-[rgba(96,165,250,0.06)] border border-[rgba(96,165,250,0.20)] rounded-xl p-3 mb-4">
          <div className="text-xs font-semibold text-[#60A5FA] mb-2">{invitations.length} pending invitation{invitations.length>1?'s':''}</div>
          <div className="space-y-2">
            {invitations.slice(0,3).map(inv => (
              <div key={inv.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm text-[#F0EDE5] truncate">{inv.event?.title}</div>
                  <div className="text-xs text-[#4A5168]">{inv.event?.startAt ? new Date(inv.event.startAt).toLocaleString() : ''}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" onClick={() => respond(inv.eventId, 'Accepted')}>Accept</Button>
                  <Button size="sm" variant="secondary" onClick={() => respond(inv.eventId, 'Tentative')}>Maybe</Button>
                  <Button size="sm" variant="danger" onClick={() => respond(inv.eventId, 'Declined')}>Decline</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? <Spinner /> : (
        <>
          {mode === "month" && <MonthGrid anchor={anchor} events={events} onSelect={setSelected} onDayClick={dt => { setForm({ eventType:'Meeting', startAt: `${isoDay(dt)}T09:00`, endAt: `${isoDay(dt)}T10:00` }); setComposerOpen(true); }} />}
          {mode === "week" && <WeekGrid anchor={anchor} events={events} onSelect={setSelected} />}
          {mode === "day" && <DayList anchor={anchor} events={events} onSelect={setSelected} />}
          {mode === "agenda" && <AgendaList events={events} onSelect={setSelected} />}
        </>
      )}

      {/* Event detail */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title || "Event"}>
        {selected && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge color="primary">{selected.eventType}</Badge>
              {selected.isOccurrence && <Badge color="purple">Recurring</Badge>}
              {selected.status && <Badge color={selected.status==='Held'?'success':selected.status==='Cancelled'?'danger':'info'}>{selected.status}</Badge>}
            </div>
            <div className="text-sm text-[#C8C2B4]">
              {new Date(selected.startAt).toLocaleString()} to {fmtTime(selected.endAt)}
            </div>
            {selected.recurrenceDescription && <div className="text-xs text-[#7E8598]">{selected.recurrenceDescription}</div>}
            {selected.location && <div className="text-sm text-[#7E8598]">Location: {selected.location}</div>}
            {selected.meetingUrl && <a href={selected.meetingUrl} target="_blank" rel="noreferrer" className="text-sm text-[#60A5FA] hover:underline inline-flex items-center gap-1">Join meeting <ExternalLink size={12} /></a>}
            {selected.description && <div className="text-sm text-[#C8C2B4] whitespace-pre-wrap pt-2 border-t border-[#182550]">{selected.description}</div>}
            {selected.invitees?.length > 0 && (
              <div className="pt-2 border-t border-[#182550]">
                <div className="text-xs font-medium text-[#7E8598] mb-2">Attendees ({selected.invitees.length})</div>
                <div className="space-y-1">
                  {selected.invitees.map(i => (
                    <div key={i.id} className="flex items-center justify-between text-xs">
                      <span className="text-[#C8C2B4]">{i.name || i.email || 'Unknown'}{i.isOrganizer && ' (organizer)'}</span>
                      <Badge color={i.responseStatus==='Accepted'?'success':i.responseStatus==='Declined'?'danger':i.responseStatus==='Tentative'?'warning':'neutral'}>{i.responseStatus}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Composer */}
      <Modal open={composerOpen} onClose={() => setComposerOpen(false)} title="New Event">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <Input label="Title" value={form.title} onChange={v => setForm(p => ({...p, title: v}))} required className="sm:col-span-2" />
          <Select label="Type" value={form.eventType} onChange={v => setForm(p => ({...p, eventType: v}))} options={["Meeting","Call","Appointment","Task","OutOfOffice"]} />
          <Input label="Location" value={form.location} onChange={v => setForm(p => ({...p, location: v}))} />
          <Input label="Start" type="datetime-local" value={form.startAt} onChange={v => setForm(p => ({...p, startAt: v}))} required />
          <Input label="End" type="datetime-local" value={form.endAt} onChange={v => setForm(p => ({...p, endAt: v}))} required />
          <Select label="Repeat" value={form.repeat} onChange={v => setForm(p => ({...p, repeat: v}))}
            options={[
              { value: 'none', label: 'Does not repeat' },
              { value: 'FREQ=DAILY', label: 'Daily' },
              { value: 'FREQ=WEEKLY', label: 'Weekly' },
              { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday' },
              { value: 'FREQ=WEEKLY;INTERVAL=2', label: 'Every 2 weeks' },
              { value: 'FREQ=MONTHLY', label: 'Monthly' },
              { value: 'FREQ=YEARLY', label: 'Yearly' },
            ]} />
          <Input label="Meeting URL" value={form.meetingUrl} onChange={v => setForm(p => ({...p, meetingUrl: v}))} />
          <TextArea label="Description" value={form.description} onChange={v => setForm(p => ({...p, description: v}))} className="sm:col-span-2" />
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => setComposerOpen(false)} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={save} fullWidth className="sm:w-auto">Create</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function MonthGrid({ anchor, events, onSelect, onDayClick }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date();

  return (
    <div className="bg-[#0B1228] border border-[#182550] rounded-xl overflow-hidden">
      <div className="grid grid-cols-7 border-b border-[#182550]">
        {DOW.map(d => <div key={d} className="py-2 text-center text-[10px] font-semibold text-[#4A5168] uppercase tracking-wider">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const dayEvents = events.filter(e => sameDay(e.startAt, day));
          const isCurrentMonth = day.getMonth() === anchor.getMonth();
          const isToday = sameDay(day, today);
          return (
            <div key={i} onClick={() => onDayClick(day)}
              className={`min-h-[72px] sm:min-h-[96px] p-1.5 border-b border-r border-[#182550]/50 cursor-pointer transition-colors hover:bg-[#101B3A] touch-manipulation ${isCurrentMonth ? '' : 'opacity-35'}`}>
              <div className={`text-xs mb-1 w-6 h-6 flex items-center justify-center rounded-full ${isToday ? 'bg-[#F5A623] text-[#060B1A] font-bold' : 'text-[#7E8598]'}`}>
                {day.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map(e => (
                  <div key={e.id} onClick={ev => { ev.stopPropagation(); onSelect(e); }}
                    className="text-[10px] px-1 py-0.5 rounded truncate text-[#F0EDE5]"
                    style={{ background: `${EVENT_COLORS[e.eventType] || '#F5A623'}22`, borderLeft: `2px solid ${EVENT_COLORS[e.eventType] || '#F5A623'}` }}>
                    {!e.allDay && <span className="text-[#7E8598] mr-1">{fmtTime(e.startAt)}</span>}
                    {e.title}
                  </div>
                ))}
                {dayEvents.length > 3 && <div className="text-[10px] text-[#4A5168] px-1">+{dayEvents.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({ anchor, events, onSelect }) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = new Date();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
      {days.map((day, i) => {
        const dayEvents = events.filter(e => sameDay(e.startAt, day));
        const isToday = sameDay(day, today);
        return (
          <div key={i} className={`bg-[#0B1228] border rounded-xl p-2 min-h-[140px] ${isToday ? 'border-[rgba(245,166,35,0.35)]' : 'border-[#182550]'}`}>
            <div className={`text-xs font-medium mb-2 ${isToday ? 'text-[#F5A623]' : 'text-[#7E8598]'}`}>
              {DOW[day.getDay()]} {day.getDate()}
            </div>
            <div className="space-y-1">
              {dayEvents.map(e => (
                <div key={e.id} onClick={() => onSelect(e)}
                  className="text-xs px-2 py-1.5 rounded-lg cursor-pointer active:scale-[0.98] touch-manipulation"
                  style={{ background: `${EVENT_COLORS[e.eventType] || '#F5A623'}18`, borderLeft: `2px solid ${EVENT_COLORS[e.eventType] || '#F5A623'}` }}>
                  <div className="text-[#F0EDE5] truncate">{e.title}</div>
                  <div className="text-[10px] text-[#7E8598]">{fmtTime(e.startAt)}</div>
                </div>
              ))}
              {!dayEvents.length && <div className="text-[10px] text-[#4A5168] text-center py-3">No events</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayList({ anchor, events, onSelect }) {
  const dayEvents = events.filter(e => sameDay(e.startAt, anchor));
  const hours = Array.from({ length: 14 }, (_, i) => i + 7); // 7am to 8pm
  if (!dayEvents.length) return <EmptyState icon={CalendarDays} title="Nothing scheduled" subtitle="This day is clear" />;
  return (
    <div className="bg-[#0B1228] border border-[#182550] rounded-xl divide-y divide-[#182550]/50">
      {hours.map(h => {
        const slot = dayEvents.filter(e => new Date(e.startAt).getHours() === h);
        return (
          <div key={h} className="flex gap-3 p-2 min-h-[52px]">
            <div className="w-14 shrink-0 text-xs text-[#4A5168] pt-1">{h % 12 || 12}{h < 12 ? 'am' : 'pm'}</div>
            <div className="flex-1 space-y-1">
              {slot.map(e => (
                <div key={e.id} onClick={() => onSelect(e)}
                  className="px-3 py-2 rounded-lg cursor-pointer active:scale-[0.99] touch-manipulation"
                  style={{ background: `${EVENT_COLORS[e.eventType] || '#F5A623'}18`, borderLeft: `3px solid ${EVENT_COLORS[e.eventType] || '#F5A623'}` }}>
                  <div className="text-sm text-[#F0EDE5]">{e.title}</div>
                  <div className="text-xs text-[#7E8598]">{fmtTime(e.startAt)} to {fmtTime(e.endAt)}{e.location ? ` | ${e.location}` : ''}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgendaList({ events, onSelect }) {
  if (!events.length) return <EmptyState icon={CalendarDays} title="Nothing coming up" />;
  const byDay = {};
  events.forEach(e => { const k = isoDay(e.startAt); (byDay[k] = byDay[k] || []).push(e); });
  return (
    <div className="space-y-4">
      {Object.entries(byDay).sort().map(([day, list]) => (
        <div key={day}>
          <div className="text-xs font-semibold text-[#7E8598] uppercase tracking-wider mb-2">
            {new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          <div className="space-y-2">
            {list.map(e => (
              <div key={e.id} onClick={() => onSelect(e)}
                className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 flex items-center gap-3 cursor-pointer active:scale-[0.99] touch-manipulation">
                <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: EVENT_COLORS[e.eventType] || '#F5A623' }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[#F0EDE5] truncate">{e.title}</div>
                  <div className="text-xs text-[#4A5168]">{e.allDay ? 'All day' : `${fmtTime(e.startAt)} to ${fmtTime(e.endAt)}`}{e.location ? ` | ${e.location}` : ''}</div>
                </div>
                {e.isOccurrence && <RefreshCw size={13} className="text-[#4A5168] shrink-0" />}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ========================================================================
// PROJECTS PAGE
// ========================================================================
function ProjectsPage() {
  const { apiFetch } = useAuth();
  const [projects, setProjects] = useState([]);
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({});
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch('/projects?limit=50').catch(() => ({ data: [] })),
      apiFetch('/projects/analytics/portfolio').catch(() => null),
    ]).then(([p, pf]) => { setProjects(p.data || []); setPortfolio(pf); })
      .finally(() => setLoading(false));
  }, [apiFetch]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.name) { setToast({ message: "Name is required", type: "error" }); return; }
    try {
      await apiFetch('/projects', { method: 'POST', body: form });
      setModalOpen(false); setForm({}); load();
      setToast({ message: "Project created", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  if (openId) return <ProjectDetail projectId={openId} onBack={() => { setOpenId(null); load(); }} />;

  const healthColor = h => h === 'Red' ? 'danger' : h === 'Amber' ? 'warning' : 'success';

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <ListTree size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Projects</h1>
        </div>
        <Button icon={Plus} onClick={() => { setForm({ status: 'Planning' }); setModalOpen(true); }}>
          <span className="hidden sm:inline">New Project</span>
        </Button>
      </div>

      {portfolio && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-5">
          <StatCard label="Active" value={portfolio.activeProjects || 0} icon={ListTree} color="primary" />
          <StatCard label="At Risk" value={portfolio.atRisk || 0} icon={AlertTriangle} color={portfolio.atRisk > 0 ? "danger" : "success"} />
          <StatCard label="Avg Completion" value={`${portfolio.avgCompletion || 0}%`} icon={TrendingUp} color="cyan" />
          <StatCard label="Budget" value={`$${((portfolio.totalBudget||0)/1000).toFixed(0)}K`} icon={DollarSign} color="purple" />
        </div>
      )}

      {loading ? <Spinner /> : projects.length === 0 ? (
        <EmptyState icon={ListTree} title="No projects yet" action="Create Project" onAction={() => setModalOpen(true)} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {projects.map(p => (
            <div key={p.id} onClick={() => setOpenId(p.id)}
              className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 hover:border-[#203060] cursor-pointer transition-colors active:scale-[0.99] touch-manipulation">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#F0EDE5] truncate">{p.name}</div>
                  <div className="text-xs text-[#4A5168] mt-0.5">
                    {p.startDate ? new Date(p.startDate).toLocaleDateString() : 'No start'} to {p.endDate ? new Date(p.endDate).toLocaleDateString() : 'No end'}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge color={healthColor(p.health)}>{p.health || 'Green'}</Badge>
                  <Badge color="neutral">{p.status}</Badge>
                </div>
              </div>
              <ProgressBar value={p.percentComplete || 0} label="Progress" color={p.health === 'Red' ? '#F87171' : p.health === 'Amber' ? '#FBBF24' : '#34D399'} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 pt-2 border-t border-[#182550]/50 text-xs">
                <span className="text-[#4A5168]">Tasks: <span className="text-[#C8C2B4] font-mono">{p._count?.tasks ?? 0}</span></span>
                <span className="text-[#4A5168]">Hours: <span className="text-[#C8C2B4] font-mono">{p.actualHours ?? 0}</span></span>
                {p.budget ? <span className="text-[#4A5168]">Spent: <span className={`font-mono ${p.actualCost > p.budget ? 'text-[#F87171]' : 'text-[#C8C2B4]'}`}>${((p.actualCost||0)/1000).toFixed(0)}K / ${(p.budget/1000).toFixed(0)}K</span></span> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Project">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <Input label="Name" value={form.name} onChange={v => setForm(p => ({...p, name: v}))} required className="sm:col-span-2" />
          <Input label="Code" value={form.code} onChange={v => setForm(p => ({...p, code: v}))} />
          <Select label="Status" value={form.status} onChange={v => setForm(p => ({...p, status: v}))} options={["Draft","Planning","Active","OnHold","Completed"]} />
          <Input label="Start Date" type="date" value={form.startDate} onChange={v => setForm(p => ({...p, startDate: v}))} />
          <Input label="End Date" type="date" value={form.endDate} onChange={v => setForm(p => ({...p, endDate: v}))} />
          <Input label="Budget" type="number" value={form.budget} onChange={v => setForm(p => ({...p, budget: v}))} />
          <Select label="Priority" value={form.priority} onChange={v => setForm(p => ({...p, priority: v}))} options={["Low","Medium","High","Critical"]} />
          <TextArea label="Description" value={form.description} onChange={v => setForm(p => ({...p, description: v}))} className="sm:col-span-2" />
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => setModalOpen(false)} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={save} fullWidth className="sm:w-auto">Create</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function ProjectDetail({ projectId, onBack }) {
  const { apiFetch } = useAuth();
  const [tab, setTab] = useState('gantt');
  const [project, setProject] = useState(null);
  const [gantt, setGantt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [taskModal, setTaskModal] = useState(false);
  const [taskForm, setTaskForm] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch(`/projects/${projectId}`).catch(() => null),
      apiFetch(`/projects/${projectId}/gantt`).catch(() => null),
    ]).then(([p, g]) => { setProject(p); setGantt(g); }).finally(() => setLoading(false));
  }, [projectId, apiFetch]);
  useEffect(() => { load(); }, [load]);

  const addTask = async () => {
    if (!taskForm.name) { setToast({ message: "Task name is required", type: "error" }); return; }
    try {
      await apiFetch(`/projects/${projectId}/tasks`, { method: 'POST', body: taskForm });
      setTaskModal(false); setTaskForm({}); load();
      setToast({ message: "Task added", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const reschedule = async () => {
    try {
      const r = await apiFetch(`/projects/${projectId}/reschedule`, { method: 'POST', body: {} });
      setToast({ message: `Rescheduled ${r.rescheduled} tasks, ${r.criticalPath.length} on critical path`, type: "success" });
      load();
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  if (loading) return <Spinner />;
  if (!project) return <EmptyState icon={AlertTriangle} title="Project not found" action="Back" onAction={onBack} />;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-[#7E8598] hover:text-[#C8C2B4] mb-3 touch-manipulation">
        <ChevronLeft size={14} /> All projects
      </button>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">{project.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge color={project.health === 'Red' ? 'danger' : project.health === 'Amber' ? 'warning' : 'success'}>{project.health}</Badge>
            <Badge color="neutral">{project.status}</Badge>
            <span className="text-xs text-[#4A5168]">{project.percentComplete}% complete</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reschedule}>Reschedule</Button>
          <Button size="sm" icon={Plus} onClick={() => setTaskModal(true)}>Task</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
        <StatCard label="Tasks" value={project.taskSummary?.total || 0} icon={ListTree} color="primary" />
        <StatCard label="Overdue" value={project.taskSummary?.overdue || 0} icon={AlertTriangle} color={project.taskSummary?.overdue ? "danger" : "success"} />
        <StatCard label="Hours Logged" value={project.actualHours || 0} icon={Timer} color="cyan" />
        <StatCard label="Critical Path" value={gantt?.criticalPath?.length || 0} icon={Flag} color="purple" />
      </div>

      <div className="flex gap-1 mb-4 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit overflow-x-auto">
        {['gantt','tasks','milestones','team'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 rounded-md text-xs font-medium capitalize whitespace-nowrap transition-colors touch-manipulation ${tab===t ? 'bg-[rgba(245,166,35,0.08)] text-[#F5A623]' : 'text-[#7E8598]'}`}>{t}</button>
        ))}
      </div>

      {tab === 'gantt' && <GanttChart gantt={gantt} />}
      {tab === 'tasks' && <TaskList projectId={projectId} rows={gantt?.rows || []} onChanged={load} />}
      {tab === 'milestones' && <MilestoneList projectId={projectId} milestones={gantt?.milestones || []} onChanged={load} />}
      {tab === 'team' && <TeamList projectId={projectId} />}

      <Modal open={taskModal} onClose={() => setTaskModal(false)} title="New Task">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <Input label="Name" value={taskForm.name} onChange={v => setTaskForm(p => ({...p, name: v}))} required className="sm:col-span-2" />
          <Select label="Type" value={taskForm.taskType} onChange={v => setTaskForm(p => ({...p, taskType: v}))} options={["Task","Milestone","Phase","Summary"]} />
          <Select label="Priority" value={taskForm.priority} onChange={v => setTaskForm(p => ({...p, priority: v}))} options={["Low","Medium","High","Critical"]} />
          <Input label="Start" type="date" value={taskForm.startDate} onChange={v => setTaskForm(p => ({...p, startDate: v}))} />
          <Input label="Duration (days)" type="number" value={taskForm.durationDays} onChange={v => setTaskForm(p => ({...p, durationDays: v}))} />
          <Input label="Estimated Hours" type="number" value={taskForm.estimatedHours} onChange={v => setTaskForm(p => ({...p, estimatedHours: v}))} />
          <TextArea label="Description" value={taskForm.description} onChange={v => setTaskForm(p => ({...p, description: v}))} className="sm:col-span-2" />
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => setTaskModal(false)} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={addTask} fullWidth className="sm:w-auto">Add Task</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function GanttChart({ gantt }) {
  if (!gantt?.rows?.length) return <EmptyState icon={ListTree} title="No tasks to chart" subtitle="Add tasks to see the schedule" />;

  const rows = gantt.rows.filter(r => r.start && r.end);
  if (!rows.length) return <EmptyState icon={ListTree} title="Tasks need dates" subtitle="Set start dates or run Reschedule" />;

  const min = new Date(Math.min(...rows.map(r => new Date(r.start))));
  const max = new Date(Math.max(...rows.map(r => new Date(r.end))));
  const totalMs = Math.max(max - min, 86400000);
  const pct = d => ((new Date(d) - min) / totalMs) * 100;

  // Month ruler
  const ticks = [];
  const cursor = new Date(min.getFullYear(), min.getMonth(), 1);
  while (cursor <= max) {
    ticks.push({ label: `${MONTHS[cursor.getMonth()].slice(0,3)}`, left: Math.max(0, pct(cursor)) });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return (
    <div className="bg-[#0B1228] border border-[#182550] rounded-xl overflow-hidden">
      {gantt.hasCycle && (
        <div className="bg-[rgba(248,113,113,0.10)] border-b border-[rgba(248,113,113,0.20)] px-4 py-2 text-xs text-[#F87171]">
          Circular dependency detected. Schedule dates are approximate until it is resolved.
        </div>
      )}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#182550] text-xs">
        <span className="text-[#7E8598]">{rows.length} tasks over {gantt.projectDuration || 0} days</span>
        <span className="flex items-center gap-1.5 text-[#4A5168]">
          <span className="w-2.5 h-2.5 rounded-sm bg-[#F87171]" /> Critical path
        </span>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          {/* Ruler */}
          <div className="flex border-b border-[#182550]/60">
            <div className="w-48 shrink-0 px-3 py-1.5 text-[10px] font-semibold text-[#4A5168] uppercase tracking-wider border-r border-[#182550]">Task</div>
            <div className="flex-1 relative h-7">
              {ticks.map((t, i) => (
                <div key={i} className="absolute top-0 h-full border-l border-[#182550]/50 pl-1 text-[10px] text-[#4A5168] pt-1.5" style={{ left: `${t.left}%` }}>{t.label}</div>
              ))}
            </div>
          </div>

          {/* Bars */}
          {rows.map(r => {
            const left = pct(r.start);
            const width = Math.max(0.6, pct(r.end) - left);
            const barColor = r.isCritical ? '#F87171' : r.taskType === 'Milestone' ? '#A78BFA' : '#F5A623';
            return (
              <div key={r.id} className="flex items-center border-b border-[#182550]/30 hover:bg-[#101B3A] transition-colors">
                <div className="w-48 shrink-0 px-3 py-2 border-r border-[#182550] min-w-0" style={{ paddingLeft: `${12 + r.level * 14}px` }}>
                  <div className="flex items-center gap-1.5 min-w-0">
                    {r.hasChildren && <ChevronsRight size={11} className="text-[#4A5168] shrink-0" />}
                    <span className="text-xs text-[#C8C2B4] truncate">{r.wbs ? `${r.wbs} ` : ''}{r.name}</span>
                  </div>
                </div>
                <div className="flex-1 relative h-9 px-1">
                  <div className="absolute top-1/2 -translate-y-1/2 h-4 rounded" title={`${r.name}: ${r.durationDays}d, float ${r.totalFloat ?? 0}d`}
                    style={{ left: `${left}%`, width: `${width}%`, background: `${barColor}33`, border: `1px solid ${barColor}66` }}>
                    <div className="h-full rounded-l" style={{ width: `${r.percentComplete || 0}%`, background: barColor }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TaskList({ projectId, rows, onChanged }) {
  const { apiFetch } = useAuth();
  const [toast, setToast] = useState(null);

  const setStatus = async (taskId, status) => {
    try {
      await apiFetch(`/projects/tasks/${taskId}`, { method: 'PUT', body: { status } });
      onChanged(); setToast({ message: "Task updated", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  if (!rows.length) return <EmptyState icon={ListTree} title="No tasks yet" />;
  return (
    <div className="space-y-2">
      {rows.map(r => (
        <div key={r.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1" style={{ paddingLeft: `${r.level * 12}px` }}>
              <div className="text-sm text-[#F0EDE5] truncate">{r.wbs ? `${r.wbs} ` : ''}{r.name}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-[#4A5168]">
                {r.start && <span>{new Date(r.start).toLocaleDateString()}</span>}
                {r.durationDays != null && <span>{r.durationDays}d</span>}
                {r.isCritical && <span className="text-[#F87171]">Critical path</span>}
                {r.totalFloat > 0 && <span>{r.totalFloat}d float</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge color={r.status==='Completed'?'success':r.status==='Blocked'?'danger':r.status==='InProgress'?'info':'neutral'}>{r.status}</Badge>
              {r.status !== 'Completed' && (
                <button onClick={() => setStatus(r.id, 'Completed')} className="p-1.5 rounded-md hover:bg-[rgba(52,211,153,0.10)] text-[#4A5168] hover:text-[#34D399] touch-manipulation">
                  <CheckCircle2 size={15} />
                </button>
              )}
            </div>
          </div>
          {r.percentComplete > 0 && r.percentComplete < 100 && (
            <div className="mt-2"><ProgressBar value={r.percentComplete} showValue={false} color={r.isCritical ? '#F87171' : '#F5A623'} /></div>
          )}
        </div>
      ))}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function MilestoneList({ projectId, milestones, onChanged }) {
  const { apiFetch } = useAuth();
  const [toast, setToast] = useState(null);
  const complete = async (id) => {
    try { await apiFetch(`/projects/milestones/${id}/complete`, { method: 'POST', body: {} }); onChanged(); setToast({ message: "Milestone completed", type: "success" }); }
    catch (e) { setToast({ message: e.message, type: "error" }); }
  };
  if (!milestones.length) return <EmptyState icon={Flag} title="No milestones" />;
  return (
    <div className="space-y-2">
      {milestones.map(m => (
        <div key={m.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[#F0EDE5] truncate">{m.name}</div>
            <div className="text-xs text-[#4A5168]">{m.dueDate ? new Date(m.dueDate).toLocaleDateString() : 'No due date'}{m.isBillable && m.amount ? ` | $${m.amount.toLocaleString()}` : ''}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge color={m.status==='Completed'?'success':m.isOverdue?'danger':'warning'}>{m.completedAt ? 'Completed' : m.isOverdue ? 'Overdue' : m.status}</Badge>
            {!m.completedAt && <Button size="sm" variant="secondary" onClick={() => complete(m.id)}>Complete</Button>}
          </div>
        </div>
      ))}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function TeamList({ projectId }) {
  const { data, loading } = useApi(`/projects/${projectId}/resources`);
  if (loading) return <Spinner />;
  const team = Array.isArray(data) ? data : [];
  if (!team.length) return <EmptyState icon={Users} title="No team members assigned" />;
  return (
    <div className="space-y-2">
      {team.map(r => (
        <div key={r.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[#F0EDE5]">{r.role}</div>
            <div className="text-xs text-[#4A5168]">{r.openTasks} open tasks | {r.hoursLogged}h logged</div>
          </div>
          <Badge color={r.allocationPct > 100 ? 'danger' : 'info'}>{r.allocationPct}%</Badge>
        </div>
      ))}
    </div>
  );
}

// ========================================================================
// SECURITY GROUPS PAGE
// ========================================================================
function SecurityGroupsPage() {
  const { apiFetch } = useAuth();
  const [tab, setTab] = useState('groups');
  const [tree, setTree] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({});
  const [toast, setToast] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch('/security-groups/tree/all').catch(() => []),
      apiFetch('/security-groups/analytics/coverage').catch(() => null),
    ]).then(([t, c]) => { setTree(Array.isArray(t) ? t : []); setCoverage(c); })
      .finally(() => setLoading(false));
  }, [apiFetch]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.name) { setToast({ message: "Name is required", type: "error" }); return; }
    try {
      await apiFetch('/security-groups', { method: 'POST', body: form });
      setModalOpen(false); setForm({}); load();
      setToast({ message: "Group created", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const flatten = (nodes, out = []) => { nodes.forEach(n => { out.push(n); if (n.children?.length) flatten(n.children, out); }); return out; };
  const flat = flatten(tree);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Lock size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Security Groups</h1>
        </div>
        <Button icon={Plus} onClick={() => { setForm({}); setModalOpen(true); }}>
          <span className="hidden sm:inline">New Group</span>
        </Button>
      </div>

      {coverage && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-5">
          <StatCard label="Active Groups" value={coverage.activeGroups || 0} icon={Lock} color="primary" />
          <StatCard label="Memberships" value={coverage.totalMemberships || 0} icon={UserCheck} color="cyan" />
          <StatCard label="Secured Records" value={(coverage.coverage || []).reduce((s, c) => s + c.securedRecords, 0)} icon={Shield} color="success" />
          <StatCard label="Modules Covered" value={(coverage.coverage || []).filter(c => c.securedRecords > 0).length} icon={Database} color="purple" />
        </div>
      )}

      <div className="flex gap-1 mb-4 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">
        {['groups','coverage'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium capitalize transition-colors touch-manipulation ${tab===t ? 'bg-[rgba(245,166,35,0.08)] text-[#F5A623]' : 'text-[#7E8598]'}`}>{t}</button>
        ))}
      </div>

      {loading ? <Spinner /> : tab === 'groups' ? (
        flat.length === 0 ? <EmptyState icon={Lock} title="No security groups" subtitle="Groups control which records each user can see" action="Create Group" onAction={() => setModalOpen(true)} /> : (
          <div className="space-y-2">
            {flat.map(g => (
              <div key={g.id} onClick={() => setDetail(g)}
                className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 hover:border-[#203060] cursor-pointer transition-colors active:scale-[0.99] touch-manipulation"
                style={{ marginLeft: `${(g.depth || 0) * 16}px` }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    {g.depth > 0 && <ChevronsRight size={12} className="text-[#4A5168] shrink-0" />}
                    <div className="min-w-0">
                      <div className="text-sm text-[#F0EDE5] truncate">{g.name}</div>
                      {g.description && <div className="text-xs text-[#4A5168] truncate">{g.description}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-[#4A5168]">{g._count?.members ?? 0} members</span>
                    <span className="text-xs text-[#4A5168]">{g._count?.records ?? 0} records</span>
                    <Badge color={g.active ? 'success' : 'neutral'}>{g.active ? 'Active' : 'Inactive'}</Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Record coverage by module</h3>
          <div className="space-y-3">
            {(coverage?.coverage || []).map(c => (
              <div key={c.module}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[#C8C2B4] capitalize">{c.module}</span>
                  <span className="text-[#4A5168] font-mono">{c.securedRecords} / {c.totalRecords} secured</span>
                </div>
                <ProgressBar value={c.coveragePercent} showValue={false} color={c.coveragePercent > 50 ? '#34D399' : '#F5A623'} />
              </div>
            ))}
            {!(coverage?.coverage || []).length && <div className="text-sm text-[#4A5168] text-center py-4">No coverage data</div>}
          </div>
        </div>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.name || "Group"}>
        {detail && (
          <div className="space-y-3">
            {detail.description && <div className="text-sm text-[#C8C2B4]">{detail.description}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-[#0E1630] rounded-lg p-3">
                <div className="text-lg font-bold font-mono text-[#F0EDE5]">{detail._count?.members ?? 0}</div>
                <div className="text-xs text-[#4A5168]">Members</div>
              </div>
              <div className="bg-[#0E1630] rounded-lg p-3">
                <div className="text-lg font-bold font-mono text-[#F0EDE5]">{detail._count?.records ?? 0}</div>
                <div className="text-xs text-[#4A5168]">Records</div>
              </div>
            </div>
            <div className="text-xs text-[#7E8598] pt-2 border-t border-[#182550]">
              Members of this group can see every record assigned to it. Child groups inherit access from their parent unless the group is marked non-inheritable.
            </div>
          </div>
        )}
      </Modal>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Security Group">
        <div className="space-y-3 mb-4">
          <Input label="Name" value={form.name} onChange={v => setForm(p => ({...p, name: v}))} required />
          <TextArea label="Description" value={form.description} onChange={v => setForm(p => ({...p, description: v}))} rows={2} />
          <Select label="Parent Group" value={form.parentGroupId} onChange={v => setForm(p => ({...p, parentGroupId: v}))}
            options={[{ value: '', label: 'None (top level)' }, ...flat.map(g => ({ value: g.id, label: g.name }))]} />
          <label className="flex items-center gap-2 text-sm text-[#C8C2B4] cursor-pointer">
            <input type="checkbox" checked={!!form.autoAssign} onChange={e => setForm(p => ({...p, autoAssign: e.target.checked}))} />
            Automatically assign records created by members
          </label>
          <label className="flex items-center gap-2 text-sm text-[#C8C2B4] cursor-pointer">
            <input type="checkbox" checked={!!form.isNonInheritable} onChange={e => setForm(p => ({...p, isNonInheritable: e.target.checked}))} />
            Do not inherit access from the parent group
          </label>
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => setModalOpen(false)} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={save} fullWidth className="sm:w-auto">Create</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ========================================================================
// NAVIGATION
// ========================================================================
// ========================================================================
// TIER 2 PAGES: PDF Templates, Studio, SLA Board, Prospects, Bugs, Maps
// ========================================================================

const SEV_COLOR = { Blocker: "danger", Critical: "danger", Major: "warning", Minor: "info", Trivial: "neutral" };
const SLA_COLOR = { Breached: "danger", AtRisk: "warning", OnTrack: "success", Met: "success" };

// ========================================================================
// PDF TEMPLATES
// ========================================================================
function TemplatesPage() {
  const { apiFetch } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null);
  const [fields, setFields] = useState(null);
  const [preview, setPreview] = useState(null);
  const [toast, setToast] = useState(null);
  const [moduleFilter, setModuleFilter] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    apiFetch(`/pdf-templates${moduleFilter ? `?module=${moduleFilter}` : ""}`)
      .then(d => setTemplates(d.data || []))
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [apiFetch, moduleFilter]);
  useEffect(() => { load(); }, [load]);

  const openEditor = async (tpl) => {
    if (tpl?.id) {
      const full = await apiFetch(`/pdf-templates/${tpl.id}`).catch(() => tpl);
      setEditor(full);
      apiFetch(`/pdf-templates/fields/${full.module}`).then(setFields).catch(() => setFields(null));
    } else {
      setEditor({ module: "quotes", pageSize: "A4", orientation: "portrait", bodyHtml: "" });
      apiFetch(`/pdf-templates/fields/quotes`).then(setFields).catch(() => setFields(null));
    }
  };

  const save = async () => {
    if (!editor.name || !editor.bodyHtml) { setToast({ message: "Name and body are required", type: "error" }); return; }
    try {
      const path = editor.id ? `/pdf-templates/${editor.id}` : "/pdf-templates";
      await apiFetch(path, { method: editor.id ? "PUT" : "POST", body: editor });
      setEditor(null); load();
      setToast({ message: "Template saved", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const runPreview = async () => {
    try {
      const r = await apiFetch(`/pdf-templates/${editor.id}/preview`, { method: "POST", body: { format: "json" } });
      setPreview(r.html);
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const installStarter = async (module) => {
    try {
      await apiFetch(`/pdf-templates/starters/${module}/install`, { method: "POST", body: {} });
      load(); setToast({ message: "Starter template installed", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Document Templates</h1>
        </div>
        <div className="flex gap-2">
          <Select value={moduleFilter} onChange={setModuleFilter} options={[
            { value: "", label: "All modules" }, { value: "quotes", label: "Quotes" },
            { value: "invoices", label: "Invoices" }, { value: "contracts", label: "Contracts" },
            { value: "cases", label: "Cases" },
          ]} />
          <Button icon={Plus} onClick={() => openEditor(null)}><span className="hidden sm:inline">New</span></Button>
        </div>
      </div>

      {loading ? <Spinner /> : templates.length === 0 ? (
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-6 text-center">
          <FileText size={32} className="text-[#4A5168] mx-auto mb-3" />
          <div className="text-sm text-[#C8C2B4] mb-1">No templates yet</div>
          <div className="text-xs text-[#4A5168] mb-4">Install a starter to see the merge field syntax in context</div>
          <div className="flex flex-wrap gap-2 justify-center">
            {["quotes", "invoices", "cases"].map(m => (
              <Button key={m} size="sm" variant="secondary" onClick={() => installStarter(m)}>Install {m} starter</Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {templates.map(t => (
            <div key={t.id} onClick={() => openEditor(t)}
              className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 hover:border-[#203060] cursor-pointer transition-colors active:scale-[0.99] touch-manipulation">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#F0EDE5] truncate">{t.name}</div>
                  <div className="text-xs text-[#4A5168] mt-0.5">{t.description || "No description"}</div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge color="primary">{t.module}</Badge>
                  {t.isDefault && <Badge color="success">Default</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#4A5168] pt-2 border-t border-[#182550]/50">
                <span>Used <span className="text-[#C8C2B4] font-mono">{t.usageCount}</span> times</span>
                <span>{t.pageSize} {t.orientation}</span>
                {!t.active && <span className="text-[#F87171]">Inactive</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!editor} onClose={() => { setEditor(null); setPreview(null); }} title={editor?.id ? "Edit Template" : "New Template"} size="lg">
        {editor && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Name" value={editor.name} onChange={v => setEditor(p => ({ ...p, name: v }))} required />
              <Select label="Module" value={editor.module} onChange={v => { setEditor(p => ({ ...p, module: v })); apiFetch(`/pdf-templates/fields/${v}`).then(setFields).catch(() => {}); }}
                options={["quotes", "invoices", "contracts", "orders", "cases", "accounts", "contacts", "deals", "projects"]} />
              <Select label="Page Size" value={editor.pageSize} onChange={v => setEditor(p => ({ ...p, pageSize: v }))} options={["A4", "Letter", "Legal", "A3"]} />
              <Select label="Orientation" value={editor.orientation} onChange={v => setEditor(p => ({ ...p, orientation: v }))} options={["portrait", "landscape"]} />
            </div>

            {editor.validation && !editor.validation.valid && (
              <div className="bg-[rgba(248,113,113,0.10)] border border-[rgba(248,113,113,0.20)] rounded-lg p-2.5 text-xs text-[#F87171]">
                {editor.validation.errors.join(". ")}
              </div>
            )}

            <TextArea label="Body (HTML with merge fields)" value={editor.bodyHtml}
              onChange={v => setEditor(p => ({ ...p, bodyHtml: v }))} rows={12} className="font-mono text-xs" />

            {fields && (
              <div className="bg-[#0E1630] rounded-lg p-3">
                <div className="text-xs font-semibold text-[#7E8598] mb-2">Available merge fields (tap to copy)</div>
                <div className="max-h-32 overflow-y-auto space-y-2">
                  {fields.groups?.slice(0, 4).map(g => (
                    <div key={g.group}>
                      <div className="text-[10px] uppercase tracking-wider text-[#4A5168] mb-1">{g.group}</div>
                      <div className="flex flex-wrap gap-1">
                        {g.fields.slice(0, 12).map(f => (
                          <button key={f.path} onClick={() => setEditor(p => ({ ...p, bodyHtml: (p.bodyHtml || "") + `{{${f.path}}}` }))}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#0B1228] border border-[#182550] text-[#C8C2B4] hover:border-[#F5A623] touch-manipulation">
                            {f.path}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-[#4A5168] mt-2 pt-2 border-t border-[#182550]">
                  Formatters: {fields.formatters?.slice(0, 10).join(", ")}. Loops: {"{{#each lineItems}}...{{/each}}"}
                </div>
              </div>
            )}

            {preview && (
              <div className="bg-white rounded-lg p-3 max-h-64 overflow-auto">
                <div className="text-xs text-gray-500 mb-2">Preview</div>
                <div dangerouslySetInnerHTML={{ __html: preview.replace(/<\/?html[^>]*>|<\/?head>|<\/?body>|<!DOCTYPE[^>]*>/gi, "") }} />
              </div>
            )}

            <div className="flex flex-col-reverse sm:flex-row justify-between gap-2 pt-2 border-t border-[#182550]">
              {editor.id ? <Button variant="secondary" size="sm" icon={Eye} onClick={runPreview}>Preview</Button> : <div />}
              <div className="flex flex-col-reverse sm:flex-row gap-2">
                <Button variant="secondary" onClick={() => setEditor(null)} fullWidth className="sm:w-auto">Cancel</Button>
                <Button onClick={save} fullWidth className="sm:w-auto">Save</Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ========================================================================
// STUDIO
// ========================================================================
function StudioPage() {
  const { apiFetch } = useAuth();
  const [module, setModule] = useState("contacts");
  const [tab, setTab] = useState("fields");
  const [fields, setFields] = useState([]);
  const [picklists, setPicklists] = useState([]);
  const [rules, setRules] = useState([]);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch(`/studio/fields/${module}`).catch(() => []),
      apiFetch("/studio/picklists").catch(() => []),
      apiFetch(`/studio/rules/${module}`).catch(() => []),
      apiFetch("/studio/overview").catch(() => null),
    ]).then(([f, p, r, o]) => {
      setFields(Array.isArray(f) ? f : []);
      setPicklists(Array.isArray(p) ? p : []);
      setRules(Array.isArray(r) ? r : []);
      setOverview(o);
    }).finally(() => setLoading(false));
  }, [apiFetch, module]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    try {
      if (modal === "field") {
        if (!form.label || !form.fieldType) { setToast({ message: "Label and type are required", type: "error" }); return; }
        await apiFetch("/studio/fields", { method: "POST", body: { ...form, module } });
      } else if (modal === "picklist") {
        if (!form.label) { setToast({ message: "Label is required", type: "error" }); return; }
        await apiFetch("/studio/picklists", { method: "POST", body: { ...form, values: (form.valuesText || "").split("\n").map(s => s.trim()).filter(Boolean) } });
      } else if (modal === "rule") {
        if (!form.name || !form.errorMessage) { setToast({ message: "Name and error message are required", type: "error" }); return; }
        await apiFetch("/studio/rules", { method: "POST", body: {
          name: form.name, module, errorMessage: form.errorMessage, errorField: form.field,
          conditions: [{ field: form.field, operator: form.operator || "isEmpty", value: form.value }],
        }});
      }
      setModal(null); setForm({}); load();
      setToast({ message: "Saved", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const removeField = async (id) => {
    try {
      await apiFetch(`/studio/fields/${id}`, { method: "DELETE" });
      load(); setToast({ message: "Field removed", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Wrench size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Studio</h1>
        </div>
        <div className="flex gap-2">
          <Select value={module} onChange={setModule} options={["contacts", "leads", "deals", "accounts", "cases", "quotes", "projects", "prospects"]} />
          <Button icon={Plus} onClick={() => { setForm({}); setModal(tab === "picklists" ? "picklist" : tab === "rules" ? "rule" : "field"); }}>
            <span className="hidden sm:inline">Add</span>
          </Button>
        </div>
      </div>

      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-5">
          <StatCard label="Custom Fields" value={overview.activeCustomFields || 0} icon={Wrench} color="primary" />
          <StatCard label="Picklists" value={overview.picklists || 0} icon={List} color="cyan" />
          <StatCard label="Rules" value={overview.validationRules || 0} icon={Shield} color="purple" />
          <StatCard label="Modules" value={overview.modulesCustomized || 0} icon={Database} color="success" />
        </div>
      )}

      <div className="flex gap-1 mb-4 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">
        {["fields", "picklists", "rules"].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium capitalize transition-colors touch-manipulation ${tab === t ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623]" : "text-[#7E8598]"}`}>{t}</button>
        ))}
      </div>

      {loading ? <Spinner /> : (
        <>
          {tab === "fields" && (fields.length === 0 ? <EmptyState icon={Wrench} title={`No custom fields on ${module}`} subtitle="Add fields without touching the schema" /> : (
            <div className="space-y-2">
              {fields.map(f => (
                <div key={f.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-[#F0EDE5] truncate">{f.label}
                      {f.required && <span className="text-[#F87171] ml-1">*</span>}
                    </div>
                    <div className="text-xs text-[#4A5168] font-mono">{f.name}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge color="info">{f.fieldType}</Badge>
                    {f.readOnly && <Badge color="neutral">Read only</Badge>}
                    <button onClick={() => removeField(f.id)} className="p-1.5 rounded-md hover:bg-[rgba(248,113,113,0.10)] text-[#4A5168] hover:text-[#F87171] touch-manipulation">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {tab === "picklists" && (picklists.length === 0 ? <EmptyState icon={List} title="No picklists" /> : (
            <div className="space-y-2">
              {picklists.map(p => (
                <div key={p.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-sm text-[#F0EDE5]">{p.label}</div>
                    <span className="text-xs text-[#4A5168]">{p.values?.length || 0} values</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(p.values || []).slice(0, 12).map(v => (
                      <span key={v.id} className="text-[10px] px-1.5 py-0.5 rounded bg-[#0E1630] border border-[#182550] text-[#C8C2B4]">{v.label}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {tab === "rules" && (rules.length === 0 ? <EmptyState icon={Shield} title={`No validation rules on ${module}`} /> : (
            <div className="space-y-2">
              {rules.map(r => (
                <div key={r.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-[#F0EDE5] truncate">{r.name}</div>
                      <div className="text-xs text-[#4A5168] truncate">{r.errorMessage}</div>
                    </div>
                    <Badge color={r.active ? "success" : "neutral"}>{r.active ? "Active" : "Off"}</Badge>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === "picklist" ? "New Picklist" : modal === "rule" ? "New Validation Rule" : "New Custom Field"}>
        {modal === "field" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <Input label="Label" value={form.label} onChange={v => setForm(p => ({ ...p, label: v }))} required className="sm:col-span-2" />
            <Select label="Type" value={form.fieldType} onChange={v => setForm(p => ({ ...p, fieldType: v }))}
              options={["text", "textarea", "number", "currency", "percent", "date", "datetime", "boolean", "picklist", "multiselect", "url", "email", "phone"]} />
            {["picklist", "multiselect"].includes(form.fieldType) && (
              <Select label="Picklist" value={form.picklistId} onChange={v => setForm(p => ({ ...p, picklistId: v }))}
                options={picklists.map(p => ({ value: p.id, label: p.label }))} />
            )}
            <Input label="Help Text" value={form.helpText} onChange={v => setForm(p => ({ ...p, helpText: v }))} className="sm:col-span-2" />
            <label className="flex items-center gap-2 text-sm text-[#C8C2B4] cursor-pointer">
              <input type="checkbox" checked={!!form.required} onChange={e => setForm(p => ({ ...p, required: e.target.checked }))} /> Required
            </label>
            <label className="flex items-center gap-2 text-sm text-[#C8C2B4] cursor-pointer">
              <input type="checkbox" checked={!!form.searchable} onChange={e => setForm(p => ({ ...p, searchable: e.target.checked }))} /> Searchable
            </label>
          </div>
        )}
        {modal === "picklist" && (
          <div className="space-y-3 mb-4">
            <Input label="Label" value={form.label} onChange={v => setForm(p => ({ ...p, label: v }))} required />
            <TextArea label="Values (one per line)" value={form.valuesText} onChange={v => setForm(p => ({ ...p, valuesText: v }))} rows={6} />
          </div>
        )}
        {modal === "rule" && (
          <div className="space-y-3 mb-4">
            <Input label="Rule Name" value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} required />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Input label="Field" value={form.field} onChange={v => setForm(p => ({ ...p, field: v }))} />
              <Select label="Operator" value={form.operator} onChange={v => setForm(p => ({ ...p, operator: v }))}
                options={["isEmpty", "isNotEmpty", "equals", "notEquals", "contains", "greaterThan", "lessThan"]} />
              <Input label="Value" value={form.value} onChange={v => setForm(p => ({ ...p, value: v }))} />
            </div>
            <Input label="Error Message" value={form.errorMessage} onChange={v => setForm(p => ({ ...p, errorMessage: v }))} required />
            <div className="text-xs text-[#4A5168]">The rule fires when the condition is true, blocking the save with your message.</div>
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => setModal(null)} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={save} fullWidth className="sm:w-auto">Create</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ========================================================================
// SLA BOARD
// ========================================================================
function SlaPage() {
  const { apiFetch } = useAuth();
  const [board, setBoard] = useState(null);
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("board");

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch(`/sla/cases${filter ? `?slaStatus=${filter}` : ""}`).catch(() => null),
      apiFetch("/sla/report?days=30").catch(() => null),
      apiFetch("/sla/status").catch(() => null),
    ]).then(([b, r, s]) => { setBoard(b); setReport(r); setStatus(s); })
      .finally(() => setLoading(false));
  }, [apiFetch, filter]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Timer size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">SLA Board</h1>
        </div>
        {status && (
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${status.currentlyOpen ? "bg-[#34D399]" : "bg-[#7E8598]"}`} />
            <span className="text-[#7E8598]">{status.currentlyOpen ? "Desk open" : `Closed, reopens ${status.nextOpen ? new Date(status.nextOpen).toLocaleString([], { weekday: "short", hour: "numeric" }) : "soon"}`}</span>
          </div>
        )}
      </div>

      {board && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-5">
          <StatCard label="Breached" value={board.breached || 0} icon={AlertTriangle} color={board.breached ? "danger" : "success"} />
          <StatCard label="At Risk" value={board.atRisk || 0} icon={Clock} color={board.atRisk ? "warning" : "success"} />
          <StatCard label="On Track" value={board.onTrack || 0} icon={CheckCircle2} color="success" />
          <StatCard label="Compliance" value={`${report?.compliancePercent ?? 100}%`} icon={TrendingUp} color="cyan" />
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex gap-1 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">
          {["board", "report"].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-md text-sm font-medium capitalize transition-colors touch-manipulation ${tab === t ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623]" : "text-[#7E8598]"}`}>{t}</button>
          ))}
        </div>
        {tab === "board" && (
          <div className="flex gap-1 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">
            {[["", "All"], ["Breached", "Breached"], ["AtRisk", "At Risk"], ["OnTrack", "On Track"]].map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors touch-manipulation ${filter === v ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623]" : "text-[#7E8598]"}`}>{l}</button>
            ))}
          </div>
        )}
      </div>

      {loading ? <Spinner /> : tab === "board" ? (
        !board?.cases?.length ? <EmptyState icon={Timer} title="No open cases" subtitle="Nothing is running against an SLA right now" /> : (
          <div className="space-y-2">
            {board.cases.map(c => (
              <div key={c.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <div className="text-sm text-[#F0EDE5] truncate">{c.caseNumber ? `${c.caseNumber} ` : ""}{c.subject}</div>
                    <div className="text-xs text-[#4A5168] mt-0.5">
                      {c.priority} | opened {new Date(c.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge color={SLA_COLOR[c.resolutionStatus] || "neutral"}>{c.resolutionStatus}</Badge>
                    <span className="text-[10px] text-[#4A5168] font-mono">
                      {c.overdue ? "overdue" : `${c.remainingFormatted} left`}
                    </span>
                  </div>
                </div>
                <ProgressBar value={Math.min(100, c.percentUsed)} showValue={false}
                  color={c.percentUsed >= 100 ? "#F87171" : c.percentUsed >= 80 ? "#FBBF24" : "#34D399"} />
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-[#C8C2B4] mb-4">Compliance by priority, last 30 days</h3>
          <div className="space-y-3">
            {(report?.byPriority || []).map(r => (
              <div key={r.priority}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[#C8C2B4]">{r.priority}</span>
                  <span className="text-[#4A5168] font-mono">{r.met} met / {r.breached} breached | avg {r.avgResolutionHours}h</span>
                </div>
                <ProgressBar value={r.compliancePercent} showValue={false} color={r.compliancePercent >= 90 ? "#34D399" : r.compliancePercent >= 70 ? "#FBBF24" : "#F87171"} />
              </div>
            ))}
            {!(report?.byPriority || []).length && <div className="text-sm text-[#4A5168] text-center py-4">No case history in this period</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ========================================================================
// PROSPECTS
// ========================================================================
function ProspectsPage() {
  const { apiFetch } = useAuth();
  const [prospects, setProspects] = useState([]);
  const [summary, setSummary] = useState(null);
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("prospects");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch(`/prospects?limit=50${search ? `&search=${encodeURIComponent(search)}` : ""}`).catch(() => ({ data: [] })),
      apiFetch("/prospects/analytics/summary").catch(() => null),
      apiFetch("/prospects/lists/all").catch(() => []),
    ]).then(([p, s, l]) => { setProspects(p.data || []); setSummary(s); setLists(Array.isArray(l) ? l : []); })
      .finally(() => setLoading(false));
  }, [apiFetch, search]);
  useEffect(() => { const t = setTimeout(load, search ? 300 : 0); return () => clearTimeout(t); }, [load, search]);

  const save = async () => {
    if (!form.lastName) { setToast({ message: "Last name is required", type: "error" }); return; }
    try {
      await apiFetch("/prospects", { method: "POST", body: form });
      setModal(false); setForm({}); load();
      setToast({ message: "Prospect added", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const convert = async (id) => {
    try {
      await apiFetch(`/prospects/${id}/convert`, { method: "POST", body: { target: "lead" } });
      load(); setToast({ message: "Converted to lead", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Target size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Prospects</h1>
        </div>
        <Button icon={Plus} onClick={() => { setForm({}); setModal(true); }}><span className="hidden sm:inline">New Prospect</span></Button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-5">
          <StatCard label="Total" value={summary.total || 0} icon={Target} color="primary" />
          <StatCard label="High Quality" value={summary.highQuality || 0} icon={Star} color="success" />
          <StatCard label="Converted" value={`${summary.conversionRate || 0}%`} icon={TrendingUp} color="cyan" />
          <StatCard label="Avg Score" value={summary.avgScore || 0} icon={BarChart3} color="purple" />
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex gap-1 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">
          {["prospects", "lists"].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-md text-sm font-medium capitalize transition-colors touch-manipulation ${tab === t ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623]" : "text-[#7E8598]"}`}>{t}</button>
          ))}
        </div>
        {tab === "prospects" && <Input placeholder="Search prospects" value={search} onChange={setSearch} icon={Search} className="flex-1" />}
      </div>

      {loading ? <Spinner /> : tab === "prospects" ? (
        prospects.length === 0 ? <EmptyState icon={Target} title="No prospects" subtitle="Import a list or add them one at a time" action="Add Prospect" onAction={() => setModal(true)} /> : (
          <div className="space-y-2">
            {prospects.map(p => (
              <div key={p.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-[#F0EDE5] truncate">{p.fullName || `${p.firstName || ""} ${p.lastName}`.trim()}</div>
                  <div className="text-xs text-[#4A5168] truncate">
                    {[p.title, p.accountName, p.email].filter(Boolean).join(" | ") || "No details"}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right">
                    <div className={`text-sm font-mono ${p.score >= 70 ? "text-[#34D399]" : p.score >= 40 ? "text-[#F5A623]" : "text-[#7E8598]"}`}>{p.score}</div>
                    <div className="text-[10px] text-[#4A5168]">score</div>
                  </div>
                  {p.convertedAt ? <Badge color="success">Converted</Badge> : (
                    <Button size="sm" variant="secondary" onClick={() => convert(p.id)}>Convert</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        lists.length === 0 ? <EmptyState icon={List} title="No target lists" /> : (
          <div className="space-y-2">
            {lists.map(l => (
              <div key={l.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-[#F0EDE5] truncate">{l.name}</div>
                  <div className="text-xs text-[#4A5168]">{l.description || l.listType}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-[#C8C2B4] font-mono">{l.entryCount || 0}</span>
                  {l.isDynamic && <Badge color="info">Dynamic</Badge>}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="New Prospect">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <Input label="First Name" value={form.firstName} onChange={v => setForm(p => ({ ...p, firstName: v }))} />
          <Input label="Last Name" value={form.lastName} onChange={v => setForm(p => ({ ...p, lastName: v }))} required />
          <Input label="Email" type="email" value={form.email} onChange={v => setForm(p => ({ ...p, email: v }))} />
          <Input label="Phone" value={form.phoneWork} onChange={v => setForm(p => ({ ...p, phoneWork: v }))} />
          <Input label="Company" value={form.accountName} onChange={v => setForm(p => ({ ...p, accountName: v }))} />
          <Input label="Title" value={form.title} onChange={v => setForm(p => ({ ...p, title: v }))} />
          <Input label="Industry" value={form.industry} onChange={v => setForm(p => ({ ...p, industry: v }))} />
          <Input label="Source" value={form.source} onChange={v => setForm(p => ({ ...p, source: v }))} />
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => setModal(false)} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={save} fullWidth className="sm:w-auto">Create</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ========================================================================
// BUGS
// ========================================================================
function BugsPage() {
  const { apiFetch } = useAuth();
  const [bugs, setBugs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [triage, setTriage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("open");
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [detail, setDetail] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    const q = tab === "open" ? "?open=true" : tab === "closed" ? "?open=false" : "";
    Promise.all([
      apiFetch(`/bugs${q}`).catch(() => ({ data: [] })),
      apiFetch("/bugs/analytics/summary").catch(() => null),
      tab === "triage" ? apiFetch("/bugs/analytics/triage").catch(() => null) : Promise.resolve(null),
    ]).then(([b, s, t]) => { setBugs(b.data || []); setSummary(s); setTriage(t); })
      .finally(() => setLoading(false));
  }, [apiFetch, tab]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.title) { setToast({ message: "Title is required", type: "error" }); return; }
    try {
      await apiFetch("/bugs", { method: "POST", body: form });
      setModal(false); setForm({}); load();
      setToast({ message: "Bug reported", type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const setStatus = async (id, status) => {
    try {
      await apiFetch(`/bugs/${id}`, { method: "PUT", body: { status } });
      load(); setDetail(null); setToast({ message: `Marked ${status}`, type: "success" });
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  const rows = tab === "triage" ? (triage?.queue || []) : bugs;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Bugs</h1>
        </div>
        <Button icon={Plus} onClick={() => { setForm({ severity: "Major", priority: "Medium", type: "Defect" }); setModal(true); }}>
          <span className="hidden sm:inline">Report Bug</span>
        </Button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-5">
          <StatCard label="Open" value={summary.open || 0} icon={AlertTriangle} color={summary.open ? "warning" : "success"} />
          <StatCard label="Blockers" value={summary.blockers || 0} icon={AlertCircle} color={summary.blockers ? "danger" : "success"} />
          <StatCard label="Unassigned" value={summary.unassigned || 0} icon={Users} color="cyan" />
          <StatCard label="Avg Days" value={summary.avgResolutionDays || 0} icon={Clock} color="purple" />
        </div>
      )}

      <div className="flex gap-1 mb-4 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit">
        {["open", "triage", "closed"].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium capitalize transition-colors touch-manipulation ${tab === t ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623]" : "text-[#7E8598]"}`}>{t}</button>
        ))}
      </div>

      {loading ? <Spinner /> : rows.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={tab === "open" ? "No open bugs" : "Nothing here"} subtitle={tab === "open" ? "The queue is clear" : undefined} />
      ) : (
        <div className="space-y-2">
          {rows.map(b => (
            <div key={b.id} onClick={() => setDetail(b)}
              className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 hover:border-[#203060] cursor-pointer transition-colors active:scale-[0.99] touch-manipulation">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-[#F0EDE5] truncate">
                    <span className="font-mono text-[#7E8598] mr-2">{b.bugNumber}</span>{b.title}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-[#4A5168]">
                    {b.component && <span>{b.component}</span>}
                    {b.ageDays != null && <span>{b.ageDays}d old</span>}
                    {b.reopenCount > 0 && <span className="text-[#F87171]">reopened {b.reopenCount}x</span>}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge color={SEV_COLOR[b.severity] || "neutral"}>{b.severity}</Badge>
                  <Badge color="neutral">{b.status}</Badge>
                  {b.triageScore != null && <span className="text-[10px] font-mono text-[#4A5168]">score {b.triageScore}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.bugNumber}` : "Bug"}>
        {detail && (
          <div className="space-y-3">
            <div className="text-sm text-[#F0EDE5]">{detail.title}</div>
            <div className="flex flex-wrap gap-2">
              <Badge color={SEV_COLOR[detail.severity] || "neutral"}>{detail.severity}</Badge>
              <Badge color="info">{detail.priority}</Badge>
              <Badge color="neutral">{detail.status}</Badge>
              {detail.component && <Badge color="purple">{detail.component}</Badge>}
            </div>
            {detail.description && <div className="text-sm text-[#C8C2B4] whitespace-pre-wrap pt-2 border-t border-[#182550]">{detail.description}</div>}
            {detail.stepsToReproduce && (
              <div className="pt-2 border-t border-[#182550]">
                <div className="text-xs font-medium text-[#7E8598] mb-1">Steps to reproduce</div>
                <div className="text-sm text-[#C8C2B4] whitespace-pre-wrap">{detail.stepsToReproduce}</div>
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-[#182550]">
              {["InProgress", "Fixed", "Closed"].map(s => (
                <Button key={s} size="sm" variant={s === "Fixed" ? "primary" : "secondary"} onClick={() => setStatus(detail.id, s)}>{s}</Button>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={modal} onClose={() => setModal(false)} title="Report a Bug">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <Input label="Title" value={form.title} onChange={v => setForm(p => ({ ...p, title: v }))} required className="sm:col-span-2" />
          <Select label="Severity" value={form.severity} onChange={v => setForm(p => ({ ...p, severity: v }))} options={["Blocker", "Critical", "Major", "Minor", "Trivial"]} />
          <Select label="Priority" value={form.priority} onChange={v => setForm(p => ({ ...p, priority: v }))} options={["Urgent", "High", "Medium", "Low"]} />
          <Select label="Type" value={form.type} onChange={v => setForm(p => ({ ...p, type: v }))} options={["Defect", "Feature", "Enhancement", "Task", "Regression"]} />
          <Input label="Component" value={form.component} onChange={v => setForm(p => ({ ...p, component: v }))} />
          <TextArea label="Description" value={form.description} onChange={v => setForm(p => ({ ...p, description: v }))} className="sm:col-span-2" />
          <TextArea label="Steps to Reproduce" value={form.stepsToReproduce} onChange={v => setForm(p => ({ ...p, stepsToReproduce: v }))} className="sm:col-span-2" />
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2 border-t border-[#182550]">
          <Button variant="secondary" onClick={() => setModal(false)} fullWidth className="sm:w-auto">Cancel</Button>
          <Button onClick={save} fullWidth className="sm:w-auto">Report</Button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ========================================================================
// MAPS
// ========================================================================
function MapsPage() {
  const { apiFetch } = useAuth();
  const [areas, setAreas] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [markers, setMarkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch("/maps/areas").catch(() => []),
      apiFetch("/maps/analytics/coverage").catch(() => null),
      apiFetch("/maps/markers?limit=500").catch(() => ({ markers: [] })),
    ]).then(([a, c, m]) => { setAreas(Array.isArray(a) ? a : []); setCoverage(c); setMarkers(m.markers || []); })
      .finally(() => setLoading(false));
  }, [apiFetch]);
  useEffect(() => { load(); }, [load]);

  const sync = async (module) => {
    try {
      const r = await apiFetch(`/maps/markers/sync/${module}`, { method: "POST", body: {} });
      setToast({ message: `${r.created} created, ${r.updated} updated, ${r.unresolved} without coordinates`, type: "success" });
      load();
    } catch (e) { setToast({ message: e.message, type: "error" }); }
  };

  // Plot markers on an equirectangular projection scaled to their bounds
  const plot = () => {
    if (!markers.length) return null;
    const lats = markers.map(m => m.latitude), lngs = markers.map(m => m.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const spanLat = Math.max(0.01, maxLat - minLat), spanLng = Math.max(0.01, maxLng - minLng);
    return markers.slice(0, 400).map(m => ({
      ...m,
      x: ((m.longitude - minLng) / spanLng) * 96 + 2,
      y: (1 - (m.latitude - minLat) / spanLat) * 92 + 4,
    }));
  };
  const points = plot();

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <MapPin size={20} className="text-[#F5A623] hidden sm:block" />
          <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Territory Map</h1>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => sync("accounts")}>Sync Accounts</Button>
        </div>
      </div>

      {coverage && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4 mb-5">
          <StatCard label="Territories" value={coverage.areas || 0} icon={MapPin} color="primary" />
          <StatCard label="Mapped" value={coverage.totalMarkers || 0} icon={Target} color="cyan" />
          <StatCard label="Coverage" value={`${coverage.coveragePercent || 0}%`} icon={TrendingUp} color="success" />
          <StatCard label="Outside" value={coverage.markersOutsideAreas || 0} icon={AlertTriangle} color={coverage.markersOutsideAreas ? "warning" : "success"} />
        </div>
      )}

      {loading ? <Spinner /> : (
        <div className="space-y-4">
          {points && points.length > 0 && (
            <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-4">
              <div className="text-xs font-semibold text-[#7E8598] mb-3">{markers.length} mapped records</div>
              <div className="relative w-full rounded-lg bg-[#060B1A] border border-[#182550]" style={{ paddingBottom: "56%" }}>
                <div className="absolute inset-0">
                  {points.map(p => (
                    <div key={p.id} title={`${p.label}${p.sublabel ? ` (${p.sublabel})` : ""}`}
                      className="absolute w-1.5 h-1.5 rounded-full -translate-x-1/2 -translate-y-1/2 hover:w-2.5 hover:h-2.5 transition-all"
                      style={{ left: `${p.x}%`, top: `${p.y}%`, background: p.areaId ? "#F5A623" : "#7E8598" }} />
                  ))}
                </div>
              </div>
              <div className="flex gap-4 mt-2 text-[10px] text-[#4A5168]">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#F5A623]" /> In a territory</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#7E8598]" /> Unassigned</span>
              </div>
            </div>
          )}

          {areas.length === 0 ? (
            <EmptyState icon={MapPin} title="No territories defined" subtitle="Create areas to assign records by geography" />
          ) : (
            <div className="space-y-2">
              {areas.map(a => (
                <div key={a.id} className="bg-[#0B1228] border border-[#182550] rounded-xl p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: a.color || "#F5A623" }} />
                    <div className="min-w-0">
                      <div className="text-sm text-[#F0EDE5] truncate">{a.name}</div>
                      <div className="text-xs text-[#4A5168]">{a.type} | {a.shape}{a.areaSqKm ? ` | ${Math.round(a.areaSqKm).toLocaleString()} sq km` : ""}</div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-mono text-[#C8C2B4]">{a.markerCount || 0}</div>
                    <div className="text-[10px] text-[#4A5168]">records</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "divider-1", divider: true, label: "CRM" },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "leads", label: "Leads", icon: UserPlus },
  { id: "deals", label: "Deals", icon: Target },
  { id: "accounts", label: "Accounts", icon: Building2 },
  { id: "activities", label: "Activities", icon: Calendar },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "divider-2", divider: true, label: "Communication" },
  { id: "emails", label: "Emails", icon: Mail },
  { id: "campaigns", label: "Campaigns", icon: Send },
  { id: "divider-3", divider: true, label: "Revenue" },
  { id: "products", label: "Products", icon: Package },
  { id: "quotes", label: "Quotes", icon: FileText },
  { id: "invoices", label: "Invoices", icon: DollarSign },
  { id: "contracts", label: "Contracts", icon: FileText },
  { id: "orders", label: "Orders", icon: Package },
  { id: "subscriptions", label: "Subscriptions", icon: RefreshCw },
  { id: "forecasts", label: "Forecasts", icon: TrendingUp },
  { id: "divider-4", divider: true, label: "Service" },
  { id: "cases", label: "Cases", icon: Shield },
  { id: "entitlements", label: "Entitlements", icon: Shield },
  { id: "workOrders", label: "Work Orders", icon: Wrench },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "divider-5", divider: true, label: "Automation & AI" },
  { id: "workflows", label: "Workflows", icon: GitBranch },
  { id: "flowBuilder", label: "Flow Builder", icon: GitBranch },
  { id: "sequences", label: "Sequences", icon: GitBranch },
  { id: "approvals", label: "Approvals", icon: CheckCircle2 },
  { id: "aiAgents", label: "AI Agents", icon: Zap },
  { id: "copilot", label: "AI Copilot", icon: Zap },
  { id: "projects", label: "Projects", icon: ListTree },
  { id: "prospects", label: "Prospects", icon: Target },
  { id: "bugs", label: "Bugs", icon: AlertTriangle },
  { id: "sla", label: "SLA Board", icon: Timer },
  { id: "maps", label: "Territory Map", icon: MapPin },
  { id: "divider-6", divider: true, label: "Platform" },
  { id: "customObjects", label: "Custom Objects", icon: Database },
  { id: "marketplace", label: "Marketplace", icon: Globe },
  { id: "partners", label: "Partners", icon: Briefcase },
  { id: "territories", label: "Territories", icon: Globe },
  { id: "divider-7", divider: true, label: "Content" },
  { id: "documents", label: "Documents", icon: FolderOpen },
  { id: "surveys", label: "Surveys", icon: MessageSquare },
  { id: "chatter", label: "Chatter", icon: MessageSquare },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "divider-8", divider: true, label: "Tools" },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "analytics", label: "Analytics", icon: PieChart },
  { id: "search", label: "Search", icon: Search },
  { id: "import", label: "Import", icon: Upload },
  { id: "tags", label: "Tags", icon: Tag },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "recycleBin", label: "Recycle Bin", icon: Recycle },
  { id: "assets", label: "Assets", icon: Package },
  { id: "templates", label: "Templates", icon: FileText },
  { id: "studio", label: "Studio", icon: Wrench },
  { id: "securityGroups", label: "Security Groups", icon: Lock },
  { id: "admin", label: "Admin", icon: BarChart3 },
  { id: "settings", label: "Settings", icon: Settings },
];

// Mobile bottom tab items (quick-access)
const BOTTOM_TABS = [
  { id: "dashboard", label: "Home", icon: Home },
  { id: "deals", label: "Deals", icon: Target },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "more", label: "More", icon: Menu },
];

// ========================================================================
// SIDEBAR -- desktop only
// ========================================================================
function Sidebar({ page, setPage, collapsed, setCollapsed }) {
  const { logout } = useAuth();
  return (
    <div className={`hidden md:flex h-full bg-[#081024] border-r border-[#182550] flex-col transition-all duration-200 ${collapsed ? "w-16" : "w-56"}`}>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-[#182550]">
        <BrandMark size={32} />
        {!collapsed && <span className="text-sm font-bold text-[#F0EDE5] tracking-tight">Sales Nebula</span>}
      </div>
      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {NAV_ITEMS.map(item => {
          if (item.divider) {
            if (collapsed) return <div key={item.id} className="my-2 border-t border-[#182550]/60" />;
            return <div key={item.id} className="px-2 pt-4 pb-1.5 text-[10px] font-semibold text-[#4A5168] uppercase tracking-widest">{item.label}</div>;
          }
          const active = page === item.id;
          return (
            <button key={item.id} onClick={() => setPage(item.id)} title={collapsed ? item.label : undefined}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-all ${active
                ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623] font-medium"
                : "text-[#7E8598] hover:bg-[#0E1630] hover:text-[#C8C2B4]"}`}>
              <item.icon size={18} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>
      {/* Footer */}
      <div className="border-t border-[#182550] p-2">
        <button onClick={() => setCollapsed(!collapsed)} className="w-full flex items-center justify-center gap-2 px-2 py-2 rounded-lg text-[#4A5168] hover:bg-[#0E1630] hover:text-[#C8C2B4] text-sm transition-colors">
          {collapsed ? <ChevronRight size={16} /> : <><ChevronLeft size={16} /><span>Collapse</span></>}
        </button>
        <button onClick={logout} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[#4A5168] hover:bg-[rgba(248,113,113,0.10)] hover:text-[#F87171] text-sm transition-colors mt-0.5">
          <LogOut size={16} className="shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
    </div>
  );
}

// ========================================================================
// MOBILE DRAWER
// ========================================================================
function MobileDrawer({ open, onClose, page, setPage }) {
  const { logout } = useAuth();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-[rgba(4,6,16,0.85)]" onClick={onClose} />
      <div className="relative z-10 h-full w-72 max-w-[80vw] bg-[#081024] shadow-2xl flex flex-col animate-[slideRight_0.2s_ease-out]">
        <div className="flex items-center justify-between px-4 py-4 border-b border-[#182550]">
          <div className="flex items-center gap-2.5">
            <BrandMark size={32} />
            <span className="text-sm font-bold text-[#F0EDE5]">Sales Nebula</span>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[#0E1630] text-[#4A5168]"><X size={18} /></button>
        </div>
        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5 overscroll-contain">
          {NAV_ITEMS.map(item => {
            if (item.divider) return <div key={item.id} className="px-2 pt-4 pb-1.5 text-[10px] font-semibold text-[#4A5168] uppercase tracking-widest">{item.label}</div>;
            const active = page === item.id;
            return (
              <button key={item.id} onClick={() => { setPage(item.id); onClose(); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all touch-manipulation ${active
                  ? "bg-[rgba(245,166,35,0.08)] text-[#F5A623] font-medium"
                  : "text-[#7E8598] hover:bg-[#0E1630] hover:text-[#C8C2B4]"}`}>
                <item.icon size={18} className="shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="border-t border-[#182550] p-3">
          <button onClick={() => { logout(); onClose(); }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[#4A5168] hover:bg-[rgba(248,113,113,0.10)] hover:text-[#F87171] text-sm">
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </div>
      <style>{`@keyframes slideRight { from { transform: translateX(-100%); } to { transform: translateX(0); } }`}</style>
    </div>
  );
}

// ========================================================================
// BOTTOM NAV -- mobile only
// ========================================================================
function BottomNav({ page, setPage, onMoreClick }) {
  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#081024]/95 backdrop-blur-lg border-t border-[#182550] safe-area-bottom">
      <div className="flex items-stretch">
        {BOTTOM_TABS.map(tab => {
          const active = tab.id === "more" ? false : page === tab.id;
          return (
            <button key={tab.id}
              onClick={() => tab.id === "more" ? onMoreClick() : setPage(tab.id)}
              className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors touch-manipulation min-h-[56px]
                ${active ? "text-[#F5A623]" : "text-[#4A5168] active:text-[#7E8598]"}`}>
              <tab.icon size={20} strokeWidth={active ? 2.2 : 1.8} />
              <span className={`text-[10px] ${active ? "font-semibold" : "font-medium"}`}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ========================================================================
// TOP BAR
// ========================================================================
function TopBar({ user, onMenuToggle, onNotificationsToggle, onQuickActionsToggle }) {
  return (
    <div className="h-14 border-b border-[#182550] bg-[#081024]/80 backdrop-blur-sm flex items-center justify-between px-3 sm:px-4 md:px-6">
      <div className="flex items-center gap-2">
        <button onClick={onMenuToggle} className="md:hidden p-2.5 -ml-1 rounded-lg hover:bg-[#0E1630] text-[#7E8598] hover:text-[#C8C2B4] transition-colors touch-manipulation">
          <Menu size={20} />
        </button>
        {/* Quick actions trigger - desktop */}
        <button onClick={onQuickActionsToggle}
          className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0E1630] border border-[#182550] hover:border-[#203060] text-[#4A5168] hover:text-[#7E8598] transition-colors text-sm">
          <Search size={14} />
          <span>Quick actions...</span>
          <kbd className="ml-4 px-1 py-0.5 rounded bg-[#081024] text-[9px] border border-[#182550]">Ctrl+K</kbd>
        </button>
        <div className="hidden md:block ml-2">
          <ThemeToggle compact />
        </div>
      </div>
      <div className="flex items-center gap-1 sm:gap-2">
        {/* Quick action - mobile */}
        <div className="md:hidden">
          <ThemeToggle compact />
        </div>
        <button onClick={onQuickActionsToggle}
          className="md:hidden p-2.5 rounded-lg hover:bg-[#0E1630] text-[#7E8598] hover:text-[#C8C2B4] transition-colors touch-manipulation">
          <Search size={18} />
        </button>
        {/* Notifications */}
        <button onClick={onNotificationsToggle}
          className="relative p-2.5 rounded-lg hover:bg-[#0E1630] text-[#7E8598] hover:text-[#C8C2B4] transition-colors touch-manipulation">
          <Bell size={18} />
          <div className="absolute top-2 right-2 w-2 h-2 bg-[#F5A623] rounded-full" />
        </button>
        {/* User avatar */}
        <div className="flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-lg hover:bg-[#0E1630] cursor-pointer transition-colors">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#F5A623] to-[#E8961A] flex items-center justify-center text-xs font-bold text-[#F0EDE5]">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <span className="hidden sm:inline text-sm text-[#C8C2B4]">{user?.firstName} {user?.lastName}</span>
        </div>
      </div>
    </div>
  );
}

function DemoBanner({ go }) {
  return (
    <div
      role="status"
      className="shrink-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3 sm:px-4 py-2.5 text-sm"
      style={{ background: "var(--sn-amber)", color: "var(--sn-cta-text)" }}
    >
      <span className="font-medium leading-snug">
        This is demo mode. Create an account to access this page with your own data.
      </span>
      <button
        type="button"
        onClick={() => {
          if (go) go("/");
          else window.location.href = "/";
          window.setTimeout(() => { window.location.hash = "access"; }, 0);
        }}
        className="shrink-0 self-start sm:self-auto rounded-md px-3 py-1.5 text-xs font-semibold"
        style={{ background: "var(--sn-cta-text)", color: "var(--sn-amber)" }}
      >
        Request access
      </button>
    </div>
  );
}

function AppShell({ go }) {
  const { user } = useAuth();
  const demo = isDemoUser(user);
  const [page, setPage] = useState("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);

  // Keyboard shortcut for quick actions
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setQuickActionsOpen(o => !o); }
      if (e.key === "Escape") { setQuickActionsOpen(false); setNotificationsOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleQuickAction = (actionId) => {
    const pageActions = { dashboard: "dashboard", search: "search", settings: "settings" };
    if (pageActions[actionId]) { setPage(pageActions[actionId]); return; }
    // For "new" actions, navigate to page (create modal handled by page)
    const newActions = { newContact: "contacts", newLead: "leads", newDeal: "deals", newCase: "cases", newActivity: "activities", newQuote: "quotes" };
    if (newActions[actionId]) setPage(newActions[actionId]);
  };

  const pageMap = {
    dashboard: DashboardPage, contacts: ContactsPage, leads: LeadsPage,
    deals: DealsPage, accounts: AccountsPage, activities: ActivitiesPage,
    emails: EmailsPage, campaigns: CampaignsPage, products: ProductsPage,
    quotes: QuotesPage, invoices: InvoicesPage, contracts: ContractsPage,
    orders: OrdersPage, entitlements: EntitlementsPage,
    subscriptions: SubscriptionsPage, workOrders: WorkOrdersPage,
    customObjects: CustomObjectsPage, aiAgents: AiAgentsPage,
    flowBuilder: FlowBuilderPage, marketplace: MarketplacePage,
    forecasts: ForecastsPage, cases: CasesPage, knowledge: KnowledgePage,
    workflows: WorkflowsPage, search: GlobalSearchPage,
    settings: SettingsPage, admin: AdminDashboardPage,
    reports: ReportsPage, surveys: SurveysPage, territories: TerritoriesPage,
    documents: DocumentsPage, tags: TagsPage, webhooks: WebhooksPage,
    partners: PartnersPage, assets: AssetsPage, notes: NotesPage,
    sequences: SequencesPage, approvals: ApprovalsPage, analytics: AnalyticsPage,
    copilot: CopilotPage, chatter: ChatterPage, recycleBin: RecycleBinPage,
    import: ImportPage,
    calendar: CalendarPage, projects: ProjectsPage, securityGroups: SecurityGroupsPage,
    templates: TemplatesPage, studio: StudioPage, sla: SlaPage,
    prospects: ProspectsPage, bugs: BugsPage, maps: MapsPage,
  };
  const PageComponent = pageMap[page] || DashboardPage;

  return (
    <div className="flex flex-col h-[100dvh] bg-[#060B1A] overflow-hidden">
      {demo && <DemoBanner go={go} />}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      <Sidebar page={page} setPage={setPage} collapsed={collapsed} setCollapsed={setCollapsed} />
      <MobileDrawer open={mobileDrawerOpen} onClose={() => setMobileDrawerOpen(false)} page={page} setPage={setPage} />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar user={user}
          onMenuToggle={() => setMobileDrawerOpen(o => !o)}
          onNotificationsToggle={() => setNotificationsOpen(o => !o)}
          onQuickActionsToggle={() => setQuickActionsOpen(o => !o)} />

        <main className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4 md:p-6 pb-20 md:pb-6">
          <PageComponent />
        </main>
      </div>

      <BottomNav page={page} setPage={setPage} onMoreClick={() => setMobileDrawerOpen(true)} />
      <NotificationPanel open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      <QuickActions open={quickActionsOpen} onClose={() => setQuickActionsOpen(false)} onAction={handleQuickAction} />
      </div>
    </div>
  );
}

export default function App({ go } = {}) {
  return (
    <AuthProvider>
      <AppInner go={go} />
    </AuthProvider>
  );
}

function AppInner({ go }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-[100dvh] flex items-center justify-center" style={{ background: "var(--sn-void)" }}><Spinner /></div>;
  if (!user) return <LoginPage go={go} />;
  return <AppShell go={go} />;
}
