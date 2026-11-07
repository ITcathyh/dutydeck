/**
 * Linux /proc/<pid>/stat 的字段。进程名 comm 可能含空格和括号，所以从最后一个 ')' 之后开始数；
 * 这里的下标比 proc(5) 的字段编号小 3。只解析、不读文件，读文件和出错处理留给调用方。
 */
export interface ProcStat {
  /** 进程状态；Z（僵尸）和 X（正在被回收）都已不会再执行。 */
  state: string;
  ppid: number;
  pgid: number;
  session: number;
  /** utime + stime + cutime + cstime，单位为时钟滴答。 */
  cpuTicks: number;
  /** 自开机起的启动时间（滴答）；和 PID 一起才能区分被复用的 PID。格式不对时为空串。 */
  start: string;
  /** 环境变量区的地址范围（proc(5) 第 50、51 个字段）；老内核或无权限时不存在或为 0。 */
  envStart?: string;
  envEnd?: string;
}

export function parseProcStat(raw: string): ProcStat {
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return {
    state: fields[0] ?? '', ppid: Number(fields[1]), pgid: Number(fields[2]), session: Number(fields[3]),
    cpuTicks: Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]),
    start: fields[19] ?? '', envStart: fields[47], envEnd: fields[48]
  };
}

/** 已退出、只剩进程表项或正在被回收的进程。 */
export const procStatExited = (stat: Pick<ProcStat, 'state'>) => stat.state === 'Z' || stat.state === 'X';
