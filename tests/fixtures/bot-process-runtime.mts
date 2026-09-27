import { startLocalServer } from '../../apps/server/src/service.js';
const server = await startLocalServer({ webRoot: process.cwd() });
process.send?.({ ready: true, pid: process.pid });
process.on('message', async (message: { command: string }) => {
  try {
    if (message.command === 'task') {
      const session = await server.runtime.start({ agentId: 'fake-agent' });
      const task = await server.runtime.dispatch(session.id, 'bot process isolation task');
      for (let i = 0; i < 200; i++) {
        const current = (await server.runtime.getTasks(session.id)).find(item => item.id === task.id);
        if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) {
          process.send?.({ task: current.status, pid: process.pid });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Task did not finish');
    }
  } catch (error) { process.send?.({ error: String(error) }); }
});
process.on('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
