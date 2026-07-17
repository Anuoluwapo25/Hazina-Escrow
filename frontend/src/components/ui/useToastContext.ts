import { useContext } from 'react';
import { ToastContext, type ToastContextValue } from './ToastContext';

export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToastContext must be used inside ToastProvider');
  return ctx;
}
