import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
if (process.env.DUTYDECK_TEST_PID_FILE) writeFileSync(process.env.DUTYDECK_TEST_PID_FILE, String(child.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
