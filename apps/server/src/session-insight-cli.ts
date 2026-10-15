import { analyzeFilesRequestSchema, analyzeFilesResultSchema } from '@dutydeck/shared';
import { analyzeSessionInsightFiles, SESSION_INSIGHT_ENGINE_VERSIONS } from './session-insight-analyzer.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === 'version' && args[1] === '--json') {
    process.stdout.write(JSON.stringify(SESSION_INSIGHT_ENGINE_VERSIONS) + '\n');
    return;
  }
  if (args.length !== 3 || args[0] !== 'analyze' || args[1] !== '--format' || args[2] !== 'json') {
    process.exitCode = 2;
    return;
  }

  const chunks: Buffer[] = [];
  // The host limits inputs to 32 files; bound malformed direct CLI requests as well.
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      process.exitCode = 2;
      return;
    }
    chunks.push(chunk);
  }

  let request;
  try {
    request = analyzeFilesRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    process.exitCode = 2;
    return;
  }
  let analysis;
  try {
    analysis = await analyzeSessionInsightFiles(request);
  } catch (error) {
    if (error instanceof Error && [
      'invalid_analysis_request', 'source_conflict', 'snapshot_byte_budget_exceeded'
    ].includes(error.message)) {
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const result = analyzeFilesResultSchema.parse(analysis);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.files.some(file => file.status === 'error') ? 3 : 0;
}

main().catch(() => {
  // Paths, source text and exception details never cross the process boundary.
  process.stderr.write('Session insight analysis failed.\n');
  process.exitCode = 1;
});
