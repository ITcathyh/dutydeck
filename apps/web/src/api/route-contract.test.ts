import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../../server/src/app.js';

const directory = import.meta.dirname;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// These destinations are chosen at runtime. Keep the exceptions narrow so a new URL is checked.
const dynamic = new Set([
  '`/api/instances/${encodeURIComponent(instance)}${url.slice(4)}`', // Transport prefix for a peer instance.
  'POST `/api/sessions/${id}/${action}`', // The caller chooses the session action.
  "action.method ?? 'POST' action.path!", // Inbox actions carry a method and URL from the server.
]);

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  function visit(child: ts.Node) { nodes.push(child); ts.forEachChild(child, visit); }
  visit(node);
  return nodes;
}

function clientRoutes(file: string) {
  const source = ts.createSourceFile(file, readFileSync(join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const nodes = descendants(source);
  const calls = nodes.filter(ts.isCallExpression);
  const declarations = nodes.filter(ts.isVariableDeclaration);
  const literals = new Set(nodes.filter(node => (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))
    && node.getText().slice(1).startsWith('/api/')));
  const routes = new Set<string>();

  // Resolve URL constants and local builders from the same source that the browser runs.
  // Probe both branches so conditional method/path pairs (e.g. create vs. edit memory) stay together.
  function resolve(node: ts.Expression, enabled: boolean): string {
    literals.delete(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isConditionalExpression(node)) return resolve(enabled ? node.whenTrue : node.whenFalse, enabled);
    if (ts.isTemplateExpression(node)) {
      let path = node.head.text;
      for (const span of node.templateSpans) {
        if (path.includes('?')) break;
        path += resolve(span.expression, enabled) + span.literal.text;
      }
      return path;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'encodeURIComponent') return ':param';
      if (name === 'instanceApiUrl' || name === 'withShareToken') return resolve(node.arguments[0]!, enabled);
      const fn = declarations.find(d => d.name.getText() === name)?.initializer;
      if (fn && ts.isArrowFunction(fn)) {
        const body = fn.body;
        const result = ts.isBlock(body) ? body.statements.find(ts.isReturnStatement)?.expression : body;
        if (result) return resolve(result, enabled);
      }
    }
    if (ts.isIdentifier(node)) {
      const init = declarations.find(d => d.name.getText() === node.text)?.initializer;
      if (init && (ts.isStringLiteralLike(init) || ts.isTemplateExpression(init) || ts.isConditionalExpression(init))) {
        return resolve(init, enabled);
      }
      return ':param';
    }
    throw new Error(`Unsupported URL expression in ${file}: ${node.getText()}`);
  }

  for (const call of calls) {
    const name = call.expression.getText();
    if (!['send', 'json', 'fetch'].includes(name) || file === 'client.ts') continue;
    let [url, init] = call.arguments;
    let method: ts.Expression | undefined;
    if (name === 'send') [method, url] = call.arguments;
    else if (init && init.getText() !== 'undefined') {
      if (!ts.isObjectLiteralExpression(init) || init.properties.some(ts.isSpreadAssignment)) {
        throw new Error(`Cannot determine HTTP method in ${file}: ${init.getText()}`);
      }
      const property = init.properties.find(p => p.name?.getText() === 'method');
      if (property) {
        if (!ts.isPropertyAssignment(property)) throw new Error(`Unsupported HTTP method: ${property.getText()}`);
        method = property.initializer;
      }
    }
    const verb = method && ts.isStringLiteralLike(method) ? method.text : method?.getText() ?? 'GET';
    if (dynamic.has(`${verb} ${url!.getText()}`)) { literals.delete(url!); continue; }
    // The blob downloader takes its URL from the caller and sets the HTTP method in fetch().
    const urls = url!.getText() === 'withShareToken(instanceApiUrl(url))'
      ? calls.filter(c => c.expression.getText() === 'downloadBlob').map(c => c.arguments[0]!)
      : [url!];
    for (const target of urls) {
      for (const enabled of [true, false]) {
        const path = resolve(target, enabled).split('?')[0];
        routes.add(`${method ? resolve(method, enabled) : 'GET'} ${path}`);
      }
    }
  }
  expect([...literals].map(n => n.getText()).filter(url => !dynamic.has(url)), file).toEqual([]);
  return routes;
}

const files = readdirSync(directory).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
const routes = [...new Set(files.flatMap(file => [...clientRoutes(file)]))].sort();
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  // Construct the real router as in app.test.ts. Enable optional route groups without running handlers.
  app = await buildApp({} as Parameters<typeof buildApp>[0], {
    auth: {}, plan: {}, agentModelSettings: {}, terminalSettings: {}, plugins: {},
    lark: { env: {}, config: { get: async () => undefined }, groupManager: {}, listeningDisabled: true },
    automation: { service: {} }, workItems: { interactions: {} }, turnDiffs: {},
    memoryTools: {}, memoryManagement: {}, projectMemory: {}, usage: {}, workspaceApprovals: {},
    collaboration: { service: { repositories: {} }, previewScenario: async () => ({}) },
  } as unknown as Parameters<typeof buildApp>[1]);
  await app.ready();
});
afterAll(async () => { await app?.close(); });

it.each(routes)('registers %s', route => {
  const [method, url] = route.split(' ');
  expect(app.hasRoute({ method: method as Method, url: url! })).toBe(true);
});
