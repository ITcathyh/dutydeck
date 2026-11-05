import { Banner } from './Banner';
import { Button } from './Button';

export type ConflictBannerProps = {
  title: string;
  /** 服务端返回的冲突说明。 */
  message: string;
  /** 「你填的内容已保留，没有被提交。」之后的补充建议。 */
  advice: string;
  busy: boolean;
  onDiscard(): void;
};

/** 设置页 409 冲突提示：草稿保留，可放弃修改并载入最新。 */
export function ConflictBanner({ title, message, advice, busy, onDiscard }: ConflictBannerProps) {
  return <Banner tone="danger">
    <div className="flex items-start justify-between gap-4">
      <div>
        <strong className="block">{title}</strong>
        <p className="mt-1 text-caption">
          {message}{`。你填的内容已保留，没有被提交。${advice}`}
        </p>
      </div>
      <Button variant="secondary" size="sm" loading={busy} onClick={onDiscard}>
        放弃修改并载入最新
      </Button>
    </div>
  </Banner>;
}
