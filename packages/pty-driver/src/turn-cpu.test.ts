import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { TurnCpu } from './turn-cpu.js';

describe.skipIf(process.platform !== 'linux')('verified Linux process-tree CPU activity', () => {
  it('detects a working descendant and does not count an inert root or an unknown PID as work', async () => {
    const busy = spawn(process.execPath, ['-e', 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setTimeout(()=>{const end=Date.now()+2500;while(Date.now()<end){}},300)"],{stdio:"ignore"});child.on("exit",()=>process.exit(0));process.on("SIGTERM",()=>{child.kill("SIGKILL");process.exit(0)});'], { stdio: 'ignore' });
    const idle = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const busyExit = once(busy, 'exit'), idleExit = once(idle, 'exit');
    try {
      const working = new TurnCpu(), inert = new TurnCpu();
      // /proc CPU evidence needs at least one second between observations.
      await new Promise(resolve => setTimeout(resolve, 180));
      expect(await working.active([busy.pid!])).toBe(false);
      expect(await inert.active([idle.pid!])).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 1400));
      expect(await working.active([busy.pid!])).toBe(true);
      expect(await inert.active([idle.pid!])).toBe(false);
      expect(await new TurnCpu().active([99999999])).toBe(false);
    } finally { busy.kill('SIGTERM'); idle.kill('SIGKILL'); await Promise.all([busyExit, idleExit]); }
  }, 5000);
});
