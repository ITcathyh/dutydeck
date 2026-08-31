// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useDialogFocus } from './useDialogFocus';

function Harness({ autoFocus = false }: { autoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useDialogFocus(open);
  return <><button type="button" onClick={() => setOpen(true)}>打开</button>{open && <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="测试弹窗">{autoFocus && <textarea aria-label="任务目标" autoFocus/>}<button type="button" data-dialog-initial-focus>第一项</button><button type="button" onClick={() => setOpen(false)}>完成</button></div>}</>;
}

describe('useDialogFocus', () => {
  it('moves focus in, traps Tab in the dialog, and restores the opener', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    const opener = screen.getByRole('button', { name: '打开' });
    await user.click(opener);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '第一项' })));
    await user.tab();
    const finish = screen.getByRole('button', { name: '完成' });
    expect(document.activeElement).toBe(finish);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '第一项' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(finish);
    await user.click(finish);
    expect(document.activeElement).toBe(opener);
  });

  it('restores the opener even when a dialog field uses autoFocus', async () => {
    const user = userEvent.setup();
    render(<Harness autoFocus/>);
    const opener = screen.getByRole('button', { name: '打开' });
    await user.click(opener);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '任务目标' })));
    await user.keyboard('{Tab}{Tab}');
    await user.click(screen.getByRole('button', { name: '完成' }));
    expect(document.activeElement).toBe(opener);
  });
});
