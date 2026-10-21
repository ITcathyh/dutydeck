import type { ConfigRepository, ResultPrincipal } from '@dutydeck/shared';
import { readLarkConfig } from './config.js';
import { PluginResultError } from '../plugins/result-service.js';
export interface PluginResultIdentity {
  redirectUri(tenant: string): Promise<string>;
  authorize(tenant: string, redirectUri: string, state: string): Promise<string>;
  exchange(tenant: string, redirectUri: string, code: string): Promise<ResultPrincipal>;
}
/** Test-only transport injection is never derived from a request or a plugin. */
export interface PluginResultIdentityOptions {
  fetcher?: typeof fetch; allowLoopback?: boolean;
  accountsBase?: string; apiBase?: string;
}
export class LarkPluginResultIdentity implements PluginResultIdentity {
  constructor(private readonly configs: ConfigRepository, private readonly options: PluginResultIdentityOptions = {}) {}
  private async bot(tenant: string) { const bot=await readLarkConfig(this.configs,tenant); if (!bot) throw new PluginResultError('RESULT_IDENTITY_UNAVAILABLE'); return bot; }
  async redirectUri(tenant: string) {
    const bot=await this.bot(tenant);
    let url: URL;
    try { url=new URL(bot.webBaseUrl ?? ''); } catch { throw new PluginResultError('RESULT_WEB_URL_REQUIRED'); }
    if (url.username || url.password || url.search || url.hash || (url.protocol!=='https:' && !(this.options.allowLoopback && url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw new PluginResultError('RESULT_WEB_URL_REQUIRED');
    return `${url.href.replace(/\/$/,'')}/api/plugin-results/oauth/callback`;
  }
  async authorize(tenant: string, redirectUri: string, state: string) {
    const bot=await this.bot(tenant);
    if (await this.redirectUri(tenant)!==redirectUri) throw new PluginResultError('RESULT_IDENTITY_UNAVAILABLE');
    const base=this.options.accountsBase ?? (bot.brand==='lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn');
    const url=new URL('/open-apis/authen/v1/authorize',base);
    url.search=new URLSearchParams({client_id:tenant,redirect_uri:redirectUri,response_type:'code',state}).toString();
    return url.href;
  }
  async exchange(tenant: string, redirectUri: string, code: string): Promise<ResultPrincipal> {
    try {
      const bot=await this.bot(tenant);
      if (await this.redirectUri(tenant)!==redirectUri) throw new Error();
      const base=this.options.apiBase ?? (bot.brand==='lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn');
      const fetcher=this.options.fetcher ?? fetch;
      const tokenResponse=await fetcher(`${base}/open-apis/authen/v2/oauth/token`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',code,client_id:tenant,client_secret:bot.appSecret,redirect_uri:redirectUri}),signal:AbortSignal.timeout(15_000)});
      const token=await tokenResponse.json() as {access_token?:string;error?:unknown;code?:number};
      if (!tokenResponse.ok || token.error || (token.code!==undefined && token.code!==0) || typeof token.access_token!=='string' || !token.access_token) throw new Error();
      const userResponse=await fetcher(`${base}/open-apis/authen/v1/user_info`,{headers:{authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(15_000)});
      const user=await userResponse.json() as {code?:number;data?:{open_id?:string}};
      if (!userResponse.ok || user.code!==0 || typeof user.data?.open_id!=='string' || !/^ou_[A-Za-z0-9_-]+$/.test(user.data.open_id)) throw new Error();
      return {provider:'lark',tenant,subject:user.data.open_id};
    } catch { throw new PluginResultError('RESULT_LOGIN_FAILED'); }
  }
}
