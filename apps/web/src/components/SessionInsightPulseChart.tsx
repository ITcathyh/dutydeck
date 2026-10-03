import { useMemo, useState } from 'react';
import type { PulseBucket } from '@dutydeck/shared';
import { metricValueText, metricTitle } from './SessionInsightShared';

type BucketKey = 'inputUncached' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning' | 'total';

const bucketOptions: Array<{ id: BucketKey; label: string }> = [
  { id: 'inputUncached', label: '未缓存输入' },
  { id: 'cacheRead', label: '缓存读取' },
  { id: 'cacheWrite', label: '缓存写入' },
  { id: 'output', label: '输出' },
  { id: 'reasoning', label: '推理输出' },
  { id: 'total', label: '可追踪合计' }
];

const formatTick = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
};

/**
 * Token 脉冲：按固定时间桶展示选定分桶的增量。
 *
 * 只用品牌色一种序列（单序列不引入分类色板），柱条 2px 间隔、基线对齐，
 * 悬浮 <title> 给出该桶质量/分母；同时提供数据表视图，保证信息不只靠颜色与图形。
 * 缺时间的样本不会进入时间桶，服务端在覆盖说明中单列未定位量。
 */
export function SessionInsightPulseChart({ buckets }: { buckets: PulseBucket[] }) {
  const [bucket, setBucket] = useState<BucketKey>('total');
  const [showTable, setShowTable] = useState(false);

  const { bars, max, missingTotal } = useMemo(() => {
    const values = buckets.map(item => item.tokens[bucket].value ?? 0);
    const peak = values.reduce((max, value) => Math.max(max, value), 0);
    const missing = buckets.reduce((sum, item) => sum + item.missingCount, 0);
    return {
      bars: buckets.map((item, index) => ({
        bucket: item,
        value: values[index]!,
        unknown: item.tokens[bucket].value === null
      })),
      max: peak,
      missingTotal: missing
    };
  }, [buckets, bucket]);

  if (!buckets.length) {
    return <p className="text-caption text-subtle">分析范围内没有可定位到时间的 Token 样本。</p>;
  }

  const width = 720;
  const height = 160;
  const gap = 2;
  const barWidth = Math.max(2, width / bars.length - gap);

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="选择 Token 分桶">
      {bucketOptions.map(option => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === bucket}
          onClick={() => setBucket(option.id)}
          className={`rounded-sm border px-2 py-0.5 text-caption ${option.id === bucket
            ? 'border-action bg-action-soft text-action'
            : 'border-default text-subtle hover:text-primary'}`}
        >{option.label}</button>
      ))}
      <button type="button" className="ml-auto text-caption text-link underline-offset-2 hover:underline" onClick={() => setShowTable(value => !value)}>
        {showTable ? '隐藏数据表' : '查看数据表'}
      </button>
    </div>
    <svg role="img" aria-label={`${bucketOptions.find(option => option.id === bucket)!.label} Token 按时间桶分布，共 ${bars.length} 个桶，峰值 ${max.toLocaleString('zh-CN')}`} viewBox={`0 0 ${width} ${height}`} className="w-full">
      <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} className="stroke-border-strong"/>
      {bars.map(({ bucket: item, value, unknown }, index) => {
        const barHeight = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * (height - 24)) : 0;
        const x = index * (barWidth + gap);
        const y = height - barHeight;
        return <rect
          key={`${item.startAt}-${index}`}
          x={x}
          y={y}
          width={barWidth}
          height={barHeight}
          className={unknown ? 'fill-border-strong' : 'fill-action'}
          rx="1"
        >
          <title>{`${formatTick(item.startAt)}–${formatTick(item.endAt)}\n${metricValueText(item.tokens[bucket])} token\n${metricTitle(item.tokens[bucket])}\n样本 ${item.sampleCount} · 缺失 ${item.missingCount}`}</title>
        </rect>;
      })}
    </svg>
    <p className="text-caption text-subtle">
      峰值 {max.toLocaleString('zh-CN')} token/桶；{missingTotal > 0 ? `另有 ${missingTotal.toLocaleString('zh-CN')} 个缺失样本未计入柱条；` : ''}
      灰色柱位表示该桶分桶值未知，不按 0 处理。脉冲只描述观察区间，不代表模型解码速度。
    </p>
    {showTable && <div className="max-h-60 overflow-auto rounded-md border border-subtle">
      <table className="w-full text-caption">
        <thead className="sticky top-0 bg-muted text-subtle">
          <tr>
            <th className="px-2 py-1 text-left font-medium">时间范围</th>
            <th className="px-2 py-1 text-right font-medium">{bucketOptions.find(option => option.id === bucket)!.label}</th>
            <th className="px-2 py-1 text-right font-medium">样本 / 缺失</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-subtle">
          {bars.map(({ bucket: item, value }, index) => (
            <tr key={`${item.startAt}-row-${index}`}>
              <td className="px-2 py-1 text-secondary">{formatTick(item.startAt)}–{formatTick(item.endAt)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{value.toLocaleString('zh-CN')}</td>
              <td className="px-2 py-1 text-right tabular-nums text-subtle">{item.sampleCount} / {item.missingCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>}
  </div>;
}
