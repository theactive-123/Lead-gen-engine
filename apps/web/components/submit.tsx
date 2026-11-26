'use client';
import { useFormStatus } from 'react-dom';

/** A form button that shows it is working and cannot be pressed twice. */
export function Submit({ children, className, pending = 'Saving…', confirm }: { children: React.ReactNode; className: string; pending?: string; confirm?: string }) {
  const { pending: busy } = useFormStatus();
  return (
    <button type="submit" disabled={busy} className={className}
      onClick={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      {busy ? pending : children}
    </button>
  );
}
