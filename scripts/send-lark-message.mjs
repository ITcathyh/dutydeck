#!/usr/bin/env node

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const appId = required('LARK_APP_ID');
const appSecret = required('LARK_APP_SECRET');
const receiveId = required('LARK_RECEIVE_ID');
const receiveIdType = process.env.LARK_RECEIVE_ID_TYPE?.trim() || 'email';
const text = process.env.LARK_MESSAGE_TEXT?.trim() || 'Dockmux 飞书 OpenAPI 联调成功。';
const baseUrl = (process.env.LARK_OPEN_API_BASE_URL?.trim() || 'https://open.feishu.cn').replace(/\/$/, '');
const supportedReceiveIdTypes = new Set(['open_id', 'union_id', 'user_id', 'email', 'chat_id']);

if (!supportedReceiveIdTypes.has(receiveIdType)) throw new Error(`Unsupported LARK_RECEIVE_ID_TYPE: ${receiveIdType}`);

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) {
    const message = payload.msg || payload.message || `${response.status} ${response.statusText}`;
    throw new Error(`Lark OpenAPI request failed: ${message} (code: ${payload.code ?? 'HTTP_ERROR'})`);
  }
  return payload;
}

const tokenResponse = await postJson(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal/`, {
  app_id: appId,
  app_secret: appSecret
});

const messageResponse = await postJson(
  `${baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
  {
    receive_id: receiveId,
    msg_type: 'text',
    content: JSON.stringify({ text })
  },
  { authorization: `Bearer ${tokenResponse.tenant_access_token}` }
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  messageId: messageResponse.data?.message_id,
  chatId: messageResponse.data?.chat_id
})}\n`);
