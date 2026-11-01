import { it, expect, vi } from 'vitest';
import { createCliProgram } from './cli-program.js';
it('routes why and ignored with the selected bot, chat, duration and database', async () => {
 const handler = vi.fn();
 await createCliProgram('test', { larkDisposition: handler }).parseAsync(['node','cli','--database','/tmp/db','lark','why','om_1','--app','app']);
 expect(handler).toHaveBeenLastCalledWith({ messageId:'om_1',app:'app',database:'/tmp/db' });
 await createCliProgram('test', { larkDisposition: handler }).parseAsync(['node','cli','lark','ignored','--chat','oc_1','--since','7d']);
 expect(handler).toHaveBeenLastCalledWith({chat:'oc_1',since:'7d',database:undefined});
});
