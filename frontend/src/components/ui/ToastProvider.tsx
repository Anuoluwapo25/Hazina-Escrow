import { type ReactNode } from 'react';
import { useToast } from '../../hooks/useToast';
import { ToastContext } from './ToastContext';
import ToastContainer from './ToastContainer';

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, toast, success, error, warning, info, dismiss } = useToast();

  return (
    <ToastContext.Provider value={{ toast, success, error, warning, info, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
