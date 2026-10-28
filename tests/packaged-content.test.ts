import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

/** Run after build:packages: no repository source or development export conditions in this probe. */
it('runs structured content through packed ACP/shared modules outside the checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-content-pack-'));
  const checkout = process.cwd();
  try {
    for (const [name, version] of [['shared', '0.1.0'], ['acp-client', '0.1.0'], ['plugin-sdk', '1.0.0']]) {
      execFileSync('pnpm', ['--filter', `@dutydeck/${name}`, 'pack', '--pack-destination', directory], { cwd: checkout, stdio: 'pipe' });
      const target = join(directory, 'node_modules', '@dutydeck', name!);
      await mkdir(target, { recursive: true });
      execFileSync('tar', ['xzf', join(directory, `dutydeck-${name}-${version}.tgz`), '-C', target, '--strip-components=1']);
    }
    for (const [name, target] of [['acpx', 'packages/acp-client/node_modules/acpx'], ['zod', 'packages/shared/node_modules/zod'], ['safe-regex2', 'packages/shared/node_modules/safe-regex2']]) await symlink(resolve(checkout, target!), join(directory, 'node_modules', name!), 'dir');
    await cp(resolve(checkout, 'tests/fixtures/mock-acp-agent.mjs'), join(directory, 'agent.mjs'));
    await writeFile(join(directory, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { eventContentLimits, extractEventArtifactReferences } from '@dutydeck/shared';
const config = { id:'pack-fixture',name:'Pack fixture',command:process.execPath,args:[new URL('./agent.mjs',import.meta.url).pathname],protocol:'acp',cwd:process.cwd(),env:{},permissionMode:'deny-all',timeout:10,capabilities:{pause:false,resume:true},builtin:false };
const turns=[];
for(let run=0;run<2;run++) {
 const events=[]; const adapter=new AcpxAdapter(config,{sessionKey:'packed-persistent-key',onEvent:event=>events.push(event)});
 try { await adapter.start(); await adapter.send('structured content fixture'); } finally { await adapter.stop(); }
 turns.push(events.filter(event=>event.type==='text'||event.type==='tool_result').map(event=>event.data.parts));
}
assert.deepEqual(turns[0],turns[1]);
assert.deepEqual(turns[0].slice(1).map(parts=>parts[0].type),['image','resource','resource_link']);
assert.equal(eventContentLimits.parts,64);
assert.equal(extractEventArtifactReferences({id:'e',taskId:'t',attemptId:'a',sequence:1,type:'text',data:{parts:turns[0][1]}})[0].source,'assistant_attachment');
console.log('PACKED_CONTENT_OK');
`);
    const output = execFileSync(process.execPath, ['probe.mjs'], { cwd: directory, env: { PATH: process.env.PATH, HOME: directory }, encoding: 'utf8' });
    expect(output.trim()).toBe('PACKED_CONTENT_OK');
    const saved = await readFile(join(directory, 'node_modules', '@dutydeck', 'shared', 'dist', 'event-content.js'), 'utf8');
    expect(saved).toContain('normalizeEventContent');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
