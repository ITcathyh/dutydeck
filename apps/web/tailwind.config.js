/** @type {import('tailwindcss').Config} */

/*
  语义 token 到 Tailwind 工具类的映射（docs/design-system-contract.md §13）。
  组件写 bg-surface / text-body / rounded-md，不写 bg-[var(--surface-default)]。
  值一律指向 tokens.css 的 CSS 变量，这里不出现任何字面量（唯一例外是
  fontSize 的 line-height 也走变量，成对声明）。

  已删除 ink / canvas / line / accent 四个自定义色：全仓零引用的死配置。
*/
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 表面（契约 §6，四层亮度阶梯）
        canvas: 'var(--surface-canvas)',
        surface: 'var(--surface-default)',
        muted: 'var(--surface-muted)',
        hover: 'var(--surface-hover)',
        raised: 'var(--surface-raised)',
        inverse: 'var(--surface-inverse)',
        'inverse-hover': 'var(--surface-inverse-hover)',
        // 文字。text-muted 与 Tailwind 原生语义冲突，改叫 text-subtle（契约 §13）。
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        subtle: 'var(--text-muted)',
        'on-action': 'var(--text-on-action)',
        'on-inverse': 'var(--text-inverse)',
        link: 'var(--text-link)',
        // 动作色
        action: 'var(--action-primary)',
        'action-hover': 'var(--action-primary-hover)',
        'action-soft': 'var(--action-soft)',
        'action-soft-hover': 'var(--action-soft-hover)',
        // 状态语义色（契约 §5.5：soft 底配 border 外圈）
        warning: 'var(--status-warning)',
        'warning-soft': 'var(--status-warning-soft)',
        'warning-border': 'var(--status-warning-border)',
        'warning-solid': 'var(--status-warning-solid)',
        danger: 'var(--status-danger)',
        'danger-soft': 'var(--status-danger-soft)',
        'danger-border': 'var(--status-danger-border)',
        'danger-solid': 'var(--status-danger-solid)',
        success: 'var(--status-success)',
        'success-soft': 'var(--status-success-soft)',
        'success-border': 'var(--status-success-border)',
        'success-solid': 'var(--status-success-solid)',
        info: 'var(--status-info)',
        'info-soft': 'var(--status-info-soft)',
        'info-border': 'var(--status-info-border)',
        'info-solid': 'var(--status-info-solid)',
        queued: 'var(--status-queued)',
        'queued-soft': 'var(--status-queued-soft)',
        'queued-border': 'var(--status-queued-border)',
        'attention-solid': 'var(--status-attention-solid)',
        'neutral-solid': 'var(--status-neutral-solid)',
        // 侧栏独立深色盘（双主题下恒深色，契约 §6）
        'sidebar-surface': 'var(--sidebar-surface)',
        'sidebar-border': 'var(--sidebar-border)',
        'sidebar-text': 'var(--sidebar-text)',
        'sidebar-text-strong': 'var(--sidebar-text-strong)',
        'sidebar-text-muted': 'var(--sidebar-text-muted)',
        'sidebar-text-faint': 'var(--sidebar-text-faint)',
        'sidebar-hover': 'var(--sidebar-hover)',
        'sidebar-active': 'var(--sidebar-active)',
        'sidebar-accent': 'var(--sidebar-accent)',
        'sidebar-accent-text': 'var(--sidebar-accent-text)',
        // 终端与代码块
        'terminal-bg': 'var(--terminal-bg)',
        'terminal-fg': 'var(--terminal-fg)',
        'code-surface': 'var(--code-surface)',
        'code-border': 'var(--code-border)',
        'code-header-text': 'var(--code-header-text)',
        'code-header-border': 'var(--code-header-border)',
        'code-header-bg': 'var(--code-header-bg)',
        'code-header-hover': 'var(--code-header-hover)',
        'code-inline-bg': 'var(--code-inline-bg)',
        'code-inline-text': 'var(--code-inline-text)',
        'code-inline-border': 'var(--code-inline-border)',
        // 浮层遮罩与焦点环
        scrim: 'var(--overlay-scrim)',
        'focus-ring': 'var(--focus-ring)'
      },
      // border-default / border-subtle / border-strong（契约 §5 白名单里唯一允许的三种线色）
      borderColor: {
        DEFAULT: 'var(--border-default)',
        default: 'var(--border-default)',
        subtle: 'var(--border-subtle)',
        strong: 'var(--border-strong)'
      },
      // 6 档字号，size 与 line-height 成对（契约 §2）
      fontSize: {
        meta: ['var(--font-size-meta)', { lineHeight: 'var(--line-height-meta)' }],
        caption: ['var(--font-size-caption)', { lineHeight: 'var(--line-height-caption)' }],
        body: ['var(--font-size-body)', { lineHeight: 'var(--line-height-body)' }],
        title: ['var(--font-size-title)', { lineHeight: 'var(--line-height-title)' }],
        heading: ['var(--font-size-heading)', { lineHeight: 'var(--line-height-heading)' }],
        display: ['var(--font-size-display)', { lineHeight: 'var(--line-height-display)' }]
      },
      // 4 档圆角 + full（契约 §3）。覆盖 Tailwind 默认值，让 rounded-md 等旧类名直接落到新刻度。
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        full: 'var(--radius-full)'
      },
      // 5 档层级（契约 §7）
      zIndex: {
        base: 'var(--z-base)',
        sticky: 'var(--z-sticky)',
        drawer: 'var(--z-drawer)',
        dialog: 'var(--z-dialog)',
        toast: 'var(--z-toast)'
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        panel: 'var(--shadow-panel)',
        dialog: 'var(--shadow-dialog)',
        overlay: 'var(--shadow-overlay)',
        sidebar: 'var(--sidebar-shadow)'
      },
      // 2 档动效时长（契约 §8）
      transitionDuration: {
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)'
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        emphasized: 'var(--ease-emphasized)'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['SFMono-Regular', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
};
