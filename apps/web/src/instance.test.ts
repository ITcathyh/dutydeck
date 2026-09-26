import { afterEach, describe, expect, it } from 'vitest';
import { instanceApiUrl, instanceFromPath, instanceHomePath, instancePagePath, setInstance, stripInstancePath } from './instance';

afterEach(() => setInstance(undefined));

describe('其他实例的视图', () => {
  it('没进入其他实例时，页面和 API 地址都不变', () => {
    expect(instanceApiUrl('/api/sessions')).toBe('/api/sessions');
    expect(instancePagePath('/sessions/s1')).toBe('/sessions/s1');
  });

  it('进入实例后 API 经主服务转发，登录和实例列表仍属于主服务', () => {
    setInstance('tag');
    expect(instanceApiUrl('/api/sessions/s1/stream?after=0')).toBe('/api/instances/tag/sessions/s1/stream?after=0');
    expect(instanceApiUrl('/api/terminal/s1')).toBe('/api/instances/tag/terminal/s1');
    expect(instanceApiUrl('/api/auth/status')).toBe('/api/auth/status');
    expect(instanceApiUrl('/api/instances')).toBe('/api/instances');
    expect(instancePagePath('/')).toBe('/instances/tag/');
  });

  it('从页面路径读出实例前缀，去掉前缀后交给路由', () => {
    expect(instanceFromPath('/instances/tag/sessions/s1')).toBe('tag');
    expect(instanceFromPath('/instances/tag')).toBe('tag');
    expect(instanceFromPath('/sessions/s1')).toBeUndefined();
    expect(instanceFromPath('/instancesx/tag')).toBeUndefined();
    expect(stripInstancePath('/instances/tag')).toBe('/');
    expect(stripInstancePath('/instances/tag/sessions/s1')).toBe('/sessions/s1');
    expect(instanceHomePath('tag')).toBe('/instances/tag/');
    expect(instanceHomePath(undefined)).toBe('/');
  });
});
