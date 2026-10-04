import { cn } from '@/lib/utils';

type SpinnerProps = {
  className?: string;
  size?: 'small' | 'default';
};

export function Spinner({ className, size = 'default' }: SpinnerProps) {
  return (
    <span
      className={cn('rowready-spinner', size === 'small' && 'rowready-spinner-small', className)}
      aria-hidden="true"
    >
      <svg className="spinner-ring" viewBox="0 0 40 40" fill="none" focusable="false">
        <circle className="spinner-track" cx="20" cy="20" r="17" strokeWidth="2.5" />
        <circle
          className="spinner-arc"
          cx="20"
          cy="20"
          r="17"
          strokeWidth="2.5"
          strokeDasharray="30 77"
          strokeLinecap="round"
        />
      </svg>
      <span className="spinner-core"><i /><i /><i /><i /></span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn('skeleton', className)} aria-hidden="true" />;
}

const barWidths = ['skeleton-bar-short', 'skeleton-bar-medium', 'skeleton-bar-long'] as const;

export function TableSkeleton() {
  return (
    <div className="skeleton-table" aria-hidden="true" data-testid="table-loading-skeleton">
      <div className="skeleton-table-row skeleton-table-head">
        {Array.from({ length: 7 }, (_, column) => (
          <div className={column === 0 ? 'skeleton-row-index' : 'skeleton-cell'} key={column}>
            <Skeleton className={column === 0 ? 'skeleton-bar-short' : 'skeleton-bar-medium'} />
          </div>
        ))}
      </div>
      {Array.from({ length: 12 }, (_, row) => (
        <div className="skeleton-table-row" key={row}>
          {Array.from({ length: 7 }, (_, column) => (
            <div className={column === 0 ? 'skeleton-row-index' : 'skeleton-cell'} key={column}>
              <Skeleton className={column === 0 ? 'skeleton-bar-short' : barWidths[(row + column) % barWidths.length]} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SummarySkeleton() {
  return (
    <div className="skeleton-summary" aria-hidden="true" data-testid="summary-loading-skeleton">
      {Array.from({ length: 3 }, (_, metric) => (
        <div className="skeleton-metric" key={metric}>
          <Skeleton className="skeleton-bar-short" />
          <Skeleton className="skeleton-bar-medium" />
        </div>
      ))}
    </div>
  );
}

export function ReviewSkeleton() {
  return (
    <div className="skeleton-review" aria-hidden="true" data-testid="review-loading-skeleton">
      {Array.from({ length: 3 }, (_, line) => (
        <div className="skeleton-cell" key={line}>
          <Skeleton className="skeleton-bar-short" />
          <Skeleton className="skeleton-bar-long" />
        </div>
      ))}
    </div>
  );
}
