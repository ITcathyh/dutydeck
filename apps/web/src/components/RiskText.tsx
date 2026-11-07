import type { RiskSegment } from '../permission-risk';

/** Command text with its risky segments highlighted. */
export function RiskText({ segments }: { segments: RiskSegment[] }) {
  return <>{segments.map((segment, index) => segment.risky
    ? <mark key={index} className="rounded-sm bg-danger-soft px-0.5 font-semibold text-danger">{segment.text}</mark>
    : segment.text)}</>;
}
