import { ZodError, type z } from 'zod';
import { RuntimeError } from '@dutydeck/shared';

/** 按 schema 解析请求输入；校验失败转成带指定错误码的 400。 */
export function parseOrThrow<S extends z.ZodTypeAny>(code: string, schema: S, input: unknown): z.output<S> {
  try { return schema.parse(input); }
  catch (error) {
    if (error instanceof ZodError) throw new RuntimeError(code, error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '), 400);
    throw error;
  }
}
