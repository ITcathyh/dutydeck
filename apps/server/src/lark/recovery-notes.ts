// 守护进程恢复场景的卡片文案（S8），coordinator replayed 注记与 reconciler
// 非终态恢复卡共用本文件，避免两处措辞各自漂移。
//
// 固化原则（终裁 S8）：恢复后信息不确定时，只在卡上补文字注记；
// 不重放审批决议、不重放文件验收——待决/终态卡的补发只走既有对账链路。

/**
 * reconciler 非终态恢复卡现有文案（reconciler.ts 恢复中的卡片 markdown），
 * 逐字保留：主控原位替换为引用本常量，卡面文案不发生任何变化。
 */
export const RECOVERY_TRACKING_NOTE = 'Dutydeck 已恢复任务状态，正在继续跟踪执行进度。';

/**
 * coordinator 对 replayed 任务（守护进程重启后从 runtime 重新接上的任务）的卡面注记。
 * 语义：守护进程重启期间任务曾排队/中断，状态已恢复。
 */
export function replayedRecoveryNote(): string {
  return '守护进程重启期间本任务曾排队或中断，状态已恢复，将继续跟踪执行进度。';
}
