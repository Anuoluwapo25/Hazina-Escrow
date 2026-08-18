import { useState } from 'react';
import { Shield, ShieldCheck, ShieldAlert, ShieldX, ChevronDown, ChevronUp } from 'lucide-react';
import clsx from 'clsx';
import type { AuditReport } from '../../lib/api';

interface QualityScoreBadgeProps {
  auditReport: AuditReport | null | undefined;
  compact?: boolean;
}

function getScoreTier(score: number): {
  label: string;
  color: string;
  bg: string;
  icon: typeof Shield;
} {
  if (score >= 0.8) {
    return { label: 'High Quality', color: 'text-emerald-400', bg: 'bg-emerald-400/10 border-emerald-400/30', icon: ShieldCheck };
  }
  if (score >= 0.5) {
    return { label: 'Moderate', color: 'text-amber-400', bg: 'bg-amber-400/10 border-amber-400/30', icon: Shield };
  }
  if (score >= 0.3) {
    return { label: 'Low Quality', color: 'text-orange-400', bg: 'bg-orange-400/10 border-orange-400/30', icon: ShieldAlert };
  }
  return { label: 'Poor Quality', color: 'text-red-400', bg: 'bg-red-400/10 border-red-400/30', icon: ShieldX };
}

export function QualityScoreBadge({ auditReport, compact = false }: QualityScoreBadgeProps) {
  if (!auditReport) {
    return (
      <span className={clsx(
        'type-badge border border-border/30 bg-surface/50 text-muted-2 backdrop-blur-md',
        compact ? 'text-[9px]' : 'text-[10px]',
      )}>
        <Shield className={clsx('animate-pulse', compact ? 'w-2.5 h-2.5' : 'w-3 h-3')} />
        Not yet audited
      </span>
    );
  }

  const tier = getScoreTier(auditReport.overallScore);
  const Icon = tier.icon;
  const percentage = Math.round(auditReport.overallScore * 100);

  return (
    <span className={clsx(
      'type-badge border backdrop-blur-md shadow-lg',
      tier.color,
      tier.bg,
      compact ? 'text-[9px]' : 'text-[10px]',
    )}>
      <Icon className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {percentage}% {tier.label}
    </span>
  );
}

interface QualityScorePanelProps {
  auditReport: AuditReport | null | undefined;
}

export function QualityScorePanel({ auditReport }: QualityScorePanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (!auditReport) {
    return (
      <div className="glass-card p-4">
        <div className="flex items-center gap-2 text-muted-2">
          <Shield className="w-4 h-4 animate-pulse" />
          <span className="text-sm font-body">Not yet audited</span>
        </div>
        <p className="text-xs text-muted-2 mt-2 font-body">
          This dataset has not been audited yet. Audits run automatically on publish.
        </p>
      </div>
    );
  }

  const tier = getScoreTier(auditReport.overallScore);
  const percentage = Math.round(auditReport.overallScore * 100);

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-surface/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={clsx('flex items-center justify-center w-10 h-10 rounded-xl', tier.bg, 'border', tier.bg.replace('/10', '/20'))}>
            <span className={clsx('text-lg font-display font-bold', tier.color)}>
              {percentage}
            </span>
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2">
              <span className={clsx('text-sm font-display font-semibold', tier.color)}>
                {tier.label}
              </span>
              <span className="text-[10px] text-muted-2 font-body">
                ({auditReport.auditorVersion})
              </span>
            </div>
            <p className="text-xs text-muted-2 font-body">
              Audited {new Date(auditReport.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-muted-2" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-2" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/20 p-4 space-y-3">
          <h4 className="text-xs font-display font-semibold text-foreground uppercase tracking-wide">
            Why this score?
          </h4>
          {auditReport.checks.map(check => (
            <div key={check.check} className="flex items-start gap-3">
              <div className={clsx(
                'mt-0.5 w-2 h-2 rounded-full flex-shrink-0',
                check.passed ? 'bg-emerald-400' : 'bg-red-400',
              )} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-body font-medium text-foreground capitalize">
                    {check.check.replace(/([A-Z])/g, ' $1').trim()}
                  </span>
                  <span className={clsx(
                    'text-[10px] font-mono',
                    check.passed ? 'text-emerald-400' : 'text-red-400',
                  )}>
                    {Math.round(check.score * 100)}%
                  </span>
                </div>
                <p className="text-[11px] text-muted-2 font-body leading-relaxed mt-0.5">
                  {check.reason}
                </p>
              </div>
            </div>
          ))}
          <div className="border-t border-border/20 pt-3 mt-3">
            <p className="text-[10px] text-muted-2 font-body">
              Rubric version {auditReport.version}. Scores are explainable and reproducible for the same data and rubric.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export { getScoreTier };
