import { useState, useId } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Folder, FolderOpen, ArrowUp, RefreshCw, X, Check, Laptop } from 'lucide-react';
import { api, type SystemDirectoriesResult } from '../api';
import { Button, Dialog, IconButton, Input, Spinner, Banner } from './primitives';

export type DirectoryPickerProps = {
  value: string;
  onChange(nextPath: string): void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  description?: string;
  /**
   * 是否显示「本机选择」。
   *
   * 默认关闭，且必须由调用方从 `/api/system/capabilities` 的 `directoryPicker`
   * 传进来——原生对话框只在 macOS 可用，Linux 上点了必然报错。默认 true 等于
   * 给 Linux 用户摆一颗一定失败的按钮。服务器目录浏览器在所有平台都能用，
   * 那才是这个组件的主路径。
   */
  allowNative?: boolean;
  className?: string;
};

export function DirectoryPicker({
  value,
  onChange,
  placeholder = '请输入或选择目录路径，如 /data/projects',
  disabled = false,
  id,
  label,
  description,
  allowNative = false,
  className = ''
}: DirectoryPickerProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [modalOpen, setModalOpen] = useState(false);
  const [browsingPath, setBrowsingPath] = useState<string>('');

  const nativePicker = useMutation({
    mutationFn: api.selectDirectory,
    onSuccess: result => {
      if (result.path) onChange(result.path);
    }
  });

  const directoriesQuery = useQuery({
    queryKey: ['system-directories', browsingPath],
    queryFn: () => api.systemDirectories(browsingPath || undefined),
    enabled: modalOpen,
    staleTime: 10_000
  });

  const openBrowser = () => {
    setBrowsingPath(value.trim());
    setModalOpen(true);
  };

  const handleSelectCurrent = (path: string) => {
    onChange(path);
    setModalOpen(false);
  };

  const currentData: SystemDirectoriesResult | undefined = directoriesQuery.data;
  /*
    只有服务端**这一次成功返回**的目录才可选。

    `currentData?.path ?? browsingPath` 曾把这里变成一个假确认：403 / 404 时
    currentData 为空，browsingPath 却还是用户输入或上一次点进去的那串字符，
    按钮照样能点，于是一个不存在或没权限的目录被当成「已选好」写回表单，
    真正的失败要等到 Agent 启动时才暴露。加载中同理——那时的 browsingPath
    还没有任何人确认过。

    面包屑仍显示 browsingPath（用户要知道自己在哪、失败在哪），但只有
    `confirmedPath` 能进 onChange。
  */
  const confirmedPath = directoriesQuery.isSuccess ? currentData?.path : undefined;
  const displayPath = currentData?.path ?? browsingPath;
  const canSelect = Boolean(confirmedPath) && !directoriesQuery.isFetching;

  return (
    <div className={`space-y-1.5 ${className}`} data-testid="directory-picker">
      {label && (
        <label htmlFor={inputId} className="block text-caption font-medium text-secondary">
          {label}
        </label>
      )}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            id={inputId}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={e => onChange(e.target.value)}
            className="w-full pl-9 pr-3 font-mono text-meta"
          />
          <Folder size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={openBrowser}
          className="shrink-0 text-caption"
        >
          <FolderOpen size={14} className="mr-1.5" />
          浏览
        </Button>
        {allowNative && (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || nativePicker.isPending}
            onClick={() => nativePicker.mutate()}
            title="使用本机文件对话框选择目录"
            className="hidden shrink-0 text-caption sm:inline-flex"
          >
            <Laptop size={14} className="mr-1.5" />
            本机选择
          </Button>
        )}
      </div>
      {description && <p className="text-meta text-subtle">{description}</p>}

      {modalOpen && (
        <Dialog
          open
          onClose={() => setModalOpen(false)}
          label="选择服务器目录"
          size="md"
        >
          <Dialog.Header>
            <div>
              <h2 className="text-title font-semibold text-primary">选择服务器目录</h2>
              <p className="mt-1 text-caption text-subtle">
                浏览执行主机上的受限目录，支持深入子目录或直接确认当前位置。
              </p>
            </div>
            <span className="ml-auto">
              <IconButton label="关闭" onClick={() => setModalOpen(false)}>
                <X size={16} />
              </IconButton>
            </span>
          </Dialog.Header>
          <Dialog.Body className="space-y-3">
            {directoriesQuery.isError && (
              <Banner tone="danger" action={{ label: '重试', onClick: () => void directoriesQuery.refetch() }}>
                无法读取目录：{directoriesQuery.error.message}
              </Banner>
            )}

            {/* 当前路径与所属主机 */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-caption">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Folder size={15} className="shrink-0 text-sidebar-accent" />
                <span className="truncate font-mono font-medium text-primary" title={displayPath}>
                  {displayPath || '根目录'}
                </span>
              </div>
              {currentData?.host && (
                <span className="shrink-0 text-meta text-subtle">
                  主机：<span className="font-mono text-primary">{currentData.host}</span>
                </span>
              )}
            </div>

            {/* 可用根目录快捷跳转 */}
            {currentData?.roots && currentData.roots.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-meta">
                <span className="text-subtle">可用目录根：</span>
                {currentData.roots.map(root => (
                  <button
                    key={root}
                    type="button"
                    onClick={() => setBrowsingPath(root)}
                    className="rounded bg-surface px-2 py-0.5 font-mono text-secondary hover:bg-hover hover:text-primary"
                  >
                    {root}
                  </button>
                ))}
              </div>
            )}

            {/* 导航工具条：上一级与刷新 */}
            <div className="flex items-center justify-between gap-2 border-b border-subtle pb-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!currentData?.parent || directoriesQuery.isFetching}
                onClick={() => {
                  if (currentData?.parent) setBrowsingPath(currentData.parent);
                }}
              >
                <ArrowUp size={14} className="mr-1" />
                返回上一级
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directoriesQuery.isFetching}
                onClick={() => void directoriesQuery.refetch()}
              >
                <RefreshCw size={14} className={`mr-1 ${directoriesQuery.isFetching ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>

            {/* 目录列表 */}
            <div className="max-h-60 min-h-[140px] overflow-y-auto rounded-md border border-subtle bg-surface">
              {directoriesQuery.isLoading ? (
                <div className="grid h-36 place-items-center">
                  <Spinner label="正在读取服务器目录…" />
                </div>
              ) : currentData?.entries.length === 0 ? (
                <div className="grid h-36 place-items-center text-caption text-subtle">
                  此目录下没有子目录
                </div>
              ) : (
                <ul className="divide-y divide-subtle">
                  {currentData?.entries.map(entry => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() => setBrowsingPath(entry.path)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-caption transition-colors hover:bg-hover"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Folder size={15} className="shrink-0 text-subtle" />
                          <span className="truncate font-medium text-primary">{entry.name}</span>
                        </span>
                        <span className="shrink-0 font-mono text-meta text-subtle">进入</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!canSelect}
              title={canSelect ? undefined : '需要先成功读取这个目录，才能选它'}
              onClick={() => { if (confirmedPath) handleSelectCurrent(confirmedPath); }}
            >
              <Check size={14} className="mr-1.5" />
              选择此目录
            </Button>
          </Dialog.Footer>
        </Dialog>
      )}
    </div>
  );
}
