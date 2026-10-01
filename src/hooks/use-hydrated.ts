'use client';
import { useSyncExternalStore } from 'react';
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
/** React's server snapshot keeps hydration deterministic without an extra state-setting effect. */
export function useHydrated() { return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot); }
