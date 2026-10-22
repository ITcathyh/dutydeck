import http from 'node:http';

// ── SSE ────────────────────────────────────────────────────────────────────
/**
 * 手写 SSE 客户端（Node 无内建 EventSource，且这里要断言 id:/event:/data: 的线格式）。
 * 返回 { events, done, close, cursor, since }：
 *  - events 持续累积，done 在收到**第一个** completed 后 resolve（步骤 3 用）
 *  - cursor()/since() 按 sequence 切分「新事件 vs 已有事件」，供 resume 步骤跨轮判定
 *
 * 为什么需要游标：resume 之后再发一轮，流里已经躺着第一轮的全部事件。
 * 只看「有没有 text」会把上一轮的输出当成本轮的产出——这个假象真的骗过我一次，
 * 当时脚本报成功，实际第二轮的 send 返回的是 409，读到的全是回放。
 */
export function openSseStream(url, debug = () => {}) {
  const events = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let settled = false;

  const req = http.get(url, response => {
    if (response.statusCode !== 200) {
      settled = true;
      rejectDone(new Error(`SSE 返回 ${response.statusCode}`));
      response.resume();
      return;
    }
    response.setEncoding('utf8');
    let buffer = '';
    response.on('data', chunk => {
      buffer += chunk;
      let index;
      // SSE 以空行分帧
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(':')) continue; // 注释帧（: connected / : heartbeat）
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        // Heartbeats carry {ts}, not an AgentEvent or a persisted sequence.
        if (!type || !data || type === 'heartbeat') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        events.push({ type, event: parsed });
        debug(`sse ${type}`, JSON.stringify(parsed.data).slice(0, 120));
        if (type === 'completed' && !settled) { settled = true; resolveDone(events); }
      }
    });
    response.on('end', () => { if (!settled) { settled = true; rejectDone(new Error('SSE 流在收到 completed 前结束')); } });
  });
  req.on('error', error => { if (!settled) { settled = true; rejectDone(error); } });

  const cursor = () => events.reduce((max, item) => Math.max(max, item.event.sequence ?? 0), 0);
  return {
    events,
    done,
    cursor,
    /** 严格晚于 `at` 的事件——即某个时间点之后真正新产生的那些。 */
    since: at => events.filter(item => (item.event.sequence ?? 0) > at),
    close: () => { try { req.destroy(); } catch { /* 已关闭 */ } }
  };
}
