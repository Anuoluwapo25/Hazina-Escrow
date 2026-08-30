/**
 * SubscriptionPlanCard.tsx — buyer-facing subscription offer on a dataset.
 *
 * Lists plans from the backend's event index (price / period / seats left)
 * with a btn-gold Subscribe CTA. Clicking runs the non-custodial flow:
 * build unsigned XDR server-side → sign in Freighter → relay. After a
 * confirmed subscription the access-pass query is invalidated so the badge
 * and data actions refresh.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Loader2, Users } from 'lucide-react';
import clsx from 'clsx';
import type { AccessPassPlan } from '../../lib/api';
import { subscribeToDataset, renewSubscription } from '../../lib/accessPass';
import { formatUSDC } from '../../lib/utils';
import { useToastContext } from './useToastContext';
import { useI18n } from '../../i18n';
import type { AccessPassStatus } from '../../hooks/useAccessPass';

const DAY_SECONDS = 86_400;

/** Human period label for the preset lengths; falls back to raw days. */
function periodLabel(seconds: number, t: ReturnType<typeof useI18n>['t']): string {
  if (seconds === DAY_SECONDS) return t('accessPass.period.day');
  if (seconds === 7 * DAY_SECONDS) return t('accessPass.period.week');
  if (seconds === 30 * DAY_SECONDS) return t('accessPass.period.month');
  const days = Math.round(seconds / DAY_SECONDS);
  return t('accessPass.period.days').replace('{days}', String(days));
}

interface Props {
  plans: AccessPassPlan[];
  passStatus: AccessPassStatus;
  /** Called after a confirmed subscribe/renew so callers can refresh state. */
  onSubscribed?: () => void;
}

export default function SubscriptionPlanCard({ plans, passStatus, onSubscribed }: Props) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const { success: toastSuccess, error: toastError } = useToastContext();
  const [busyPlanId, setBusyPlanId] = useState<number | 'renew' | null>(null);

  if (plans.length === 0) return null;

  const firstDatasetId = plans[0]?.datasetId;

  const handleSubscribe = async (planId: number, datasetId: string) => {
    setBusyPlanId(planId);
    try {
      const result = await subscribeToDataset(datasetId, planId);
      toastSuccess(t('accessPass.card.subscribed'), result.txHash.slice(0, 16) + '…');
      await queryClient.invalidateQueries({ queryKey: ['access-pass'] });
      onSubscribed?.();
    } catch (err) {
      toastError(
        t('accessPass.card.subscribeFailed'),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusyPlanId(null);
    }
  };

  const handleRenew = async (datasetId: string) => {
    setBusyPlanId('renew');
    try {
      await renewSubscription(datasetId);
      toastSuccess(t('accessPass.card.renewed'));
      await queryClient.invalidateQueries({ queryKey: ['access-pass'] });
      onSubscribed?.();
    } catch (err) {
      toastError(
        t('accessPass.card.renewFailed'),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusyPlanId(null);
    }
  };

  return (
    <section data-testid="subscription-plan-card" className="glass-card p-6">
      <h2 className="font-display text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-gold" />
        {t('accessPass.card.title')}
      </h2>

      <div className="space-y-3">
        {plans.map(plan => {
          const soldOut = typeof plan.seatsLeft === 'number' && plan.seatsLeft <= 0;
          const busy = busyPlanId === plan.planId || busyPlanId === 'renew';
          return (
            <article
              key={plan.planId}
              className="rounded-xl bg-void/50 border border-border/50 p-4"
            >
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <p className="font-display font-bold text-xl text-gold">
                  ${formatUSDC(plan.pricePerPeriod, locale)}
                </p>
                <p className="text-xs text-muted">{periodLabel(plan.periodSeconds, t)}</p>
              </div>
              <p
                className={clsx(
                  'text-xs font-body mb-3 flex items-center gap-1.5',
                  soldOut ? 'text-red-400' : 'text-foreground-muted',
                )}
              >
                <Users className="w-3 h-3" />
                {typeof plan.seatsLeft === 'number'
                  ? t('accessPass.card.seatsLeft')
                      .replace('{left}', String(plan.seatsLeft))
                      .replace('{total}', String(plan.maxSeats))
                  : t('accessPass.card.seatsUnknown')}
              </p>
              <button
                type="button"
                disabled={soldOut || !plan.active || busy}
                onClick={() => handleSubscribe(plan.planId, plan.datasetId)}
                className={clsx(
                  'btn-gold w-full py-2.5 flex items-center justify-center gap-2 text-sm',
                  (soldOut || !plan.active || busy) && 'opacity-50 cursor-not-allowed',
                )}
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {!plan.active
                  ? t('accessPass.card.inactive')
                  : soldOut
                    ? t('accessPass.card.soldOut')
                    : passStatus === 'expired'
                      ? t('accessPass.card.resubscribe')
                      : t('accessPass.card.subscribe')}
              </button>
            </article>
          );
        })}
      </div>

      {passStatus === 'active' && (
        <button
          type="button"
          disabled={busyPlanId !== null}
          onClick={() => firstDatasetId && handleRenew(firstDatasetId)}
          className="mt-3 w-full py-2.5 rounded-xl border border-border-gold/30 text-gold text-sm font-body font-semibold hover:bg-gold/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busyPlanId === 'renew' && <Loader2 className="w-4 h-4 animate-spin inline mr-2" />}
          {t('accessPass.card.renew')}
        </button>
      )}

      <p className="text-[11px] text-muted-2 font-body mt-3">{t('accessPass.card.custodyNote')}</p>
    </section>
  );
}
