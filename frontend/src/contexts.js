import { createContext, useContext } from "react";
export const AuthContext = createContext();
export const RouteContext = createContext({ module: "dashboard", recordId: null, openRecord: () => {}, closeRecord: () => {}, navigate: () => {} });
export function useAuth() { return useContext(AuthContext); }

const PERMISSION_LEVELS = { none: 0, read: 1, edit: 2, full: 3 };
/** Whether the user's role grants at least `level` on `module`, as the API decides it. */
export function can(user, module, level) {
  const held = user?.role?.permissions?.find(p => p.module === module)?.level;
  return (PERMISSION_LEVELS[held] || 0) >= (PERMISSION_LEVELS[level] || 0);
}
