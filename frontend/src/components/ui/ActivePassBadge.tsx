/**
 * ActivePassBadge.ts — subscription status badge for the dataset sidebar.
 *
 * Renders from a useAccessPass() result:
 *   active      → emerald pulsing badge "Active · expires in …"
 *   expired     → amber badge "Expired"
 *   unavailable → neutral badge "Access status unavailable" (fail closed:
 *                 verification errors must never read as "no subscription")
 *   loading / none / no-wallet → renders nothing.
 */

import { Clock, Radio, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import type { AccessPassStatus } from '../../hooks/useAccessPass';
import { useI18n } from '../../i18n';
import { formatTimeUntil } from '../../lib/utils';

interface Props {
  status: AccessPassStatus;
  /** Pass expiry as unix seconds — required for the active state. */
  expiry?: number;
}

export default function ActivePassBadge({ status, expiry }: Props) {
  const { t, locale } = useI18n();

  if (status === 'active') {
    return (
      <span
        data-testid="active-pass-badge"
        className="type-badge inline-flex border border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
      >
        <Radio className="w-3 h-3 animate-pulse" />
        {t('accessPass.badge.active')}
        {expiry !== undefined && (
          <span className="ml-1 opacity-80">· {formatTimeUntil(expiry, locale)}</span>
        )}
      </span>
    );
  }

  if (status === 'expired') {
    return (
      <span
        data-testid="active-pass-badge"
        className="type-badge inline-flex border border-amber-400/30 bg-amber-400/10 text-amber-400"
      >
        <Clock className="w-3 h-3" />
        {t('accessPass.badge.expired')}
      </span>
    );
  }

  if (status === 'unavailable') {
    return (
      <span
        data-testid="active-pass-badge"
        className={clsx(
          'type-badge inline-flex',
          'border border-border bg-surface-2/60 text-foreground-muted',
        )}
      >
        <ShieldAlert className="w-3 h-3" />
        {t('accessPass.badge.unavailable')}
      </span>
    );
  }

  // loading | none | no-wallet — no badge yet.
  return null;
}
