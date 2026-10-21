export default function register(api) {
  api.registerResultTool({
    name: 'export-report',
    description: 'Export a private CSV report. JSON arguments: {"reportId":"report identifier"}. The model receives only a delivery receipt.',
    inputSchema: { parse(input) {
      if (!input || Object.keys(input).join(',') !== 'reportId' || typeof input.reportId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.reportId)) throw new Error('INVALID_INPUT');
      return { reportId: input.reportId };
    } },
    async execute(input, { signal }) {
      const base = new URL(api.config.source_url);
      if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('INVALID_SOURCE');
      const response = await fetch(new URL(encodeURIComponent(input.reportId), base.href.replace(/\/$/, '') + '/'), { signal });
      if (!response.ok) throw new Error('SOURCE_UNAVAILABLE');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 10 * 1024 * 1024) throw new Error('SOURCE_TOO_LARGE');
        chunks.push(chunk);
      }
      return { files: [{ name: 'report.csv', data: Buffer.concat(chunks) }] };
    }
  });
}
