import type { InboxAction, InboxResponse } from '@dutydeck/shared';
import { json, send } from './client';

export const inboxRequests = {
  inbox: () => json<InboxResponse>('/api/inbox', { cache: 'no-store' }),
  /** 待处理条目上的动作：服务端给出原对象现有的接口与带版本的请求体，这里原样调用。 */
  inboxAction: (action: InboxAction) => send<unknown>(action.method ?? 'POST', action.path!, action.body ?? {})
};
