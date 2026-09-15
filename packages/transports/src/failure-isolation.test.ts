import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('isolates a failed stream and observes failed background cleanup without another send', async () => {
  // A separate Node lets us observe the host's real unhandledRejection boundary.
  const moduleUrl = pathToFileURL(resolve('packages/transports/src/index.ts')).href;
  const fixture = resolve('tests/fixtures/process-driver-turn-agent.mjs');
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e', `
    import { JsonlTransport, PipeTransport } from ${JSON.stringify(moduleUrl)};
    import { setTimeout as delay } from 'node:timers/promises';
    const config = { id:'probe', name:'Probe', protocol:'jsonl', command:process.execPath, args:[${JSON.stringify(fixture)}], cwd:process.cwd(), env:{}, permissionMode:'deny-all', timeout:1, capabilities:{pause:false,resume:true}, builtin:false };
    const results = [];
    for (const Transport of [JsonlTransport, PipeTransport]) {
      const transport = new Transport(config, { onEvent(){}, killGraceMs:30 });
      try {
        await transport.start(); const original = transport.current;
        const first = transport.send('hang-forever').catch(error => error.message);
        while (!transport.activeTurn) await delay(1);
        original.child.stdout.emit('error', new Error('controlled read failure'));
        const failure = await first;
        await transport.send('next');
        results.push({ case:'stream', protocol:Transport.name, failure, reused:transport.current === original, oldExited:original.child.exitCode !== null || original.child.signalCode !== null });
      } finally { await transport.stop(); }
    }
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(String(error)));
    const transport = new JsonlTransport({ ...config, timeout:0.1 }, { onEvent(){}, killGraceMs:30 });
    const signal = transport.signalGroup.bind(transport);
    try {
      await transport.start(); transport.signalGroup = () => {};
      const failure = await transport.send('hang-forever').catch(error => error.message);
      await delay(150);
      results.push({ case:'cleanup', failure, unhandled });
      if (transport.turnTail) await transport.turnTail.catch(() => {});
    } finally { transport.signalGroup = signal; await transport.stop(); }
    process.stdout.write(JSON.stringify(results));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'close');
  expect(code, errors).toBe(0);
  expect(JSON.parse(output)).toEqual([
    { case: 'stream', protocol: 'JsonlTransport', failure: 'controlled read failure', reused: false, oldExited: true },
    { case: 'stream', protocol: 'PipeTransport', failure: 'controlled read failure', reused: false, oldExited: true },
    { case: 'cleanup', failure: 'Turn timed out after 0.1s', unhandled: [] }
  ]);
});
