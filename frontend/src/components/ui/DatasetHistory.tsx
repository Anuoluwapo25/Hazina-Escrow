import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import { History } from 'lucide-react';
import { api, DatasetHistory as DatasetHistoryData } from '../../lib/api';
import { Skeleton } from './SkeletonLoader';

const SPARKLINE_DAYS = 30;
const RECENT_VERSIONS = 6;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Buyer-facing view of a dataset's back catalogue (#600): how often it changes,
 * and which versions can be bought as of a point in time. Payloads never appear
 * here — only the shape of the history.
 */
export default function DatasetHistory({ datasetId }: { datasetId: string }) {
  const { data, isLoading, isError } = useQuery<DatasetHistoryData>({
    queryKey: ['dataset-history', datasetId],
    queryFn: () => api.getDatasetHistory(datasetId, { days: SPARKLINE_DAYS }),
    enabled: Boolean(datasetId),
  });

  // Newest first: the version a buyer is most likely to want is at the top.
  const recent = useMemo(
    () => (data ? [...data.snapshots].reverse().slice(0, RECENT_VERSIONS) : []),
    [data],
  );
  const changesInWindow = useMemo(
    () => (data?.changeFrequency ?? []).reduce((sum, point) => sum + point.changes, 0),
    [data],
  );

  if (isLoading) return <Skeleton variant="rounded" height={200} />;
  if (isError || !data || data.total === 0) return null;

  return (
    <section className="glass-card p-6 md:p-8" aria-labelledby="dataset-history-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2
          id="dataset-history-heading"
          className="font-display text-2xl font-semibold text-foreground flex items-center gap-2"
        >
          <History className="w-5 h-5 text-gold" />
          History
        </h2>
        <span className="text-xs uppercase tracking-wide font-body text-muted-2">
          {data.total} version{data.total === 1 ? '' : 's'} · {changesInWindow} change
          {changesInWindow === 1 ? '' : 's'} in {SPARKLINE_DAYS} days
        </span>
      </div>

      <div className="h-24 w-full" data-testid="history-sparkline">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.changeFrequency}>
            <defs>
              <linearGradient id="historySpark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f5c451" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#f5c451" stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, 'dataMax']} />
            <Tooltip
              contentStyle={{
                background: 'rgba(10,10,12,0.9)',
                border: '1px solid rgba(245,196,81,0.3)',
                borderRadius: 12,
                fontSize: 12,
              }}
              labelStyle={{ color: '#9ca3af' }}
            />
            <Area
              type="monotone"
              dataKey="changes"
              stroke="#f5c451"
              strokeWidth={2}
              fill="url(#historySpark)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-5 space-y-2">
        {recent.map(snapshot => (
          <li
            key={snapshot.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-void/60 px-3 py-2"
          >
            <span className="font-mono text-xs text-foreground-muted">
              {snapshot.contentHash.slice(0, 12)}…
            </span>
            <span className="text-sm text-foreground">
              {new Date(snapshot.validFrom).toLocaleString()}
            </span>
            <span className="text-xs text-muted">
              {snapshot.validTo === null ? 'current' : formatBytes(snapshot.byteSize)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
