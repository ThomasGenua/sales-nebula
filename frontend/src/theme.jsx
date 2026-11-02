import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const ThemeContext = createContext({
  theme: "dark",
  toggleTheme: () => {},
  setTheme: () => {},
});

export function ThemeProvider({ children }) {
  // Match prerendered markup on the first render. The head script already
  // applies the saved palette before paint; hydrate the controls afterwards.
  const [theme, setThemeState] = useState('dark');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { setThemeState(localStorage.getItem('sn_theme') === 'light' ? 'light' : 'dark'); } catch {}
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.setAttribute("data-theme", theme);
    try { window.localStorage.setItem("sn_theme", theme); } catch {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#F4F1E8" : "#060B1A");
  }, [theme, ready]);

  const setTheme = useCallback((next) => {
    setThemeState(next === "light" ? "light" : "dark");
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => (current === "light" ? "dark" : "light"));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function BrandMark({ size = 32, alt = "Sales Nebula" }) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.22), display: "block", objectFit: "cover" }}
    />
  );
}

export function ThemeToggle({ compact = false }) {
  const { theme, toggleTheme } = useTheme();
  const light = theme === "light";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={light ? "Switch to dark background" : "Switch to light background"}
      title={light ? "Dark background" : "Light background"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        width: compact ? 36 : "auto",
        height: 36,
        padding: compact ? 0 : "0 12px",
        borderRadius: 8,
        border: "1px solid var(--sn-rule)",
        background: "var(--sn-raised)",
        color: "var(--sn-cream)",
        cursor: "pointer",
        fontFamily: "Inter, sans-serif",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {light ? <Moon size={16} /> : <Sun size={16} />}
      {!compact && <span>{light ? "Dark" : "Light"}</span>}
    </button>
  );
}
