"use client";
import { createContext,useContext,useSyncExternalStore } from 'react';
interface SidebarContextType { isCollapsed: boolean; toggleCollapse: () => void; }
const SidebarContext = createContext<SidebarContextType>({ isCollapsed: false, toggleCollapse: () => {} });
export const useSidebar = () => useContext(SidebarContext);
const key = 'sidebar-collapsed';
const event = 'sidebar-collapse-change';
const snapshot = () => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } };
const serverSnapshot = () => false;
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener); window.addEventListener(event, listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(event, listener); };
}
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const isCollapsed = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const toggleCollapse = () => {
    try { localStorage.setItem(key, String(!isCollapsed)); window.dispatchEvent(new Event(event)); } catch { /* Storage unavailable. */ }
  };
  return <SidebarContext.Provider value={{ isCollapsed, toggleCollapse }}>{children}</SidebarContext.Provider>;
}
