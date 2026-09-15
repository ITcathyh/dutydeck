# macOS 数据库控制进程核验

状态：实现已整合并通过独立复核，macOS 实机验收仍未运行。整合版已加入 Darwin 的数据库打开与控制者回收路径，不负责向 Agent 发停止信号。Linux 路径与既有数据库控制协议保持兼容；实际跨平台支持以实机 gate 为准。

## 依据与裁决

数据库控制只在 observeProcess 返回 dead 时回收旧登记。因此可使用保守的死亡证明：无法证明原控制者已消失就继续阻塞，不要求把所有活进程都精确识别为同一实例。弱匹配不能授权 kill，也不能用于 DriverResource 的归属。

Apple 的 ps lstart 读取内核 p_starttime 的秒值，用本地时区和 %c 格式输出；必须固定 locale/TZ。XNU 将创建时的 p_start 暴露给进程查询，并在 exec 时保留它。由此推断，在相同 host/boot 下，相同 PID 的规范化开始时间不同可证明旧进程已消失；同秒 PID 复用只能得到 unknown，不能认定同一进程。[ps 实现](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c)、[进程查询](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c)、[fork/exec 实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_fork.c)。

不使用 kern.boottime 的日历值作为启动代际：XNU 设置系统时间时会调整该值。采用只读 kern.bootsessionuuid；若接口不可读或格式不合法，则 unknown/打开失败，不能回退到 bootuuid（启动卷身份）或日历时间。[内核时钟](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/clock.c)、[sysctl 定义](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c)。

主机标识读取 I/O Registry 的 IOPlatformUUID，保存公式为 `darwin:host-v1:` + SHA256(lowercase UUID)，前缀附加在摘要之外，避免直接输出硬件 UUID。Apple 提供此键及 ioreg 读取接口；实际命令输出与普通用户可读性仍需 macOS 实机验证。[IOPlatformUUID](https://developer.apple.com/documentation/iokit/kioplatformuuidkey)、[I/O Registry](https://developer.apple.com/library/archive/documentation/DeviceDrivers/Conceptual/IOKitFundamentals/TheRegistry/TheRegistry.html)。

## 实现契约

沿用 ProcessIdentity 的 host/boot/namespace/pid/start，不把 Linux 的值改写为新格式。Darwin 值明确带协议标识：host 为 darwin:host-v1:<sha256>，boot 为规范化 bootsessionuuid，namespace 为 darwin:host-v1，start 为 darwin:lstart-v1:<规范化原始时间>。不接受没有这些标识的任意旧时间字符串。

固定绝对工具路径，无 shell、无 PATH 查找：

- `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice`：只接受恰好一项 IOPlatformUUID 字符串，验证 UUID 后转小写并计算摘要；空值、多值、截断或失败拒绝。
- `/usr/sbin/sysctl -n kern.bootsessionuuid`：只接受一行合法 UUID，转小写。
- `/bin/ps -p <正整数 PID> -o lstart=`：传 LC_ALL=C、LANG=C、TZ=UTC，去除首尾空白，验证 C locale 的完整星期/月/日/时分秒/四位年结构及取值；不使用 Date.parse 的宽松输入作为判据，不比较裁剪后的日期部分。

所有工具 stdin=ignore，stdout/stderr pipe，限制输出大小与最长 5 秒，错误不打印捕获的命令环境。诊断工具在 SQLite 写事务外运行。超时仅代表未知，绝不能当进程死亡。

currentProcessIdentity 必须取得本机标识、boot 和当前 PID 的有效 start；失败报 DATABASE_IDENTITY_UNAVAILABLE。未知 OS 仍报 DATABASE_IDENTITY_UNSUPPORTED。observeProcess 不抛错误，按以下顺序判定：

1. 拒绝 malformed identity、非正安全整数 PID、错误 namespace/start 格式。
2. 本机身份读取失败或 host 不同返回 unknown；同 host 的 boot 不同返回 dead。
3. 同 host/boot 下读取目标 PID 的 ps 开始时间。结构合法且与已保存 start 不同返回 dead；相同返回 unknown，因为不能排除同秒 PID 复用。不会把这个 unknown 扩大为“原进程已退出”。
4. ps 无结果、失败、超时或 malformed 时只允许用 process.kill(pid, 0) 的 ESRCH 证明当前 PID 不存在；成功或 EPERM 等其他错误均 unknown。signal 0 仅核验存在性，不发送停止信号；代码中不得出现 TERM/KILL。

数据库控制仍只回收 dead。活旧 Runtime、同秒碰撞、权限不足和外主机记录继续阻止接管。原本无旧控制者的新启动不会因 observe 的保守匹配而受阻，因为自身访问登记由既有协议持有；维护时不清自己的登记。

## 边界与验收

实现 ownership 只含 storage/process-identity.ts、其测试，以及一个可在 macOS 独立运行的真实进程/数据库集成测试。不得改数据库控制判据、放宽 unknown、重新设计锁协议、修改 DriverResource 核验或绕过现有关闭约束。

Linux 上可验证命令路径/参数/locale、UUID 与日期解析、外 host/boot、different-start、same-second unknown、ESRCH、EPERM、空输出/坏输出/超时。使用受控 OS 边界模拟，并保留既有真实 Linux 测试；不能将模拟计成 macOS 通过。

新增平台集成测试仅在 Linux/macOS 真实系统跑：独立 Node 打开磁盘 SQLite、活控制者阻止第二 Runtime、正常关闭后重新打开、捕获的 ChildProcess 强退后核验并重开；不得用固定 PID 或全机名字 kill。macOS 实机还要以受干扰的父 locale/TZ 调用，验证固定工具环境；测试记录 OS/架构与工具结果的安全摘要，不暴露主机 UUID。源代码支持完成与实机验收分别记录，跨平台 release gate 只有实测后才通过。
