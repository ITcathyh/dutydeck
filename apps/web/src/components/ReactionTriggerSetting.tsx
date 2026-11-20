import { useId } from 'react';
import { botSettingFields } from '../settings-search';
import { Field, Input } from './primitives';

export function ReactionTriggerSetting({ id, value, onChange }: { id?: string; value: string; onChange(value: string): void }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-options`;
  return <Field htmlFor={inputId} label={botSettingFields.reactionTriggerEmoji.label}
    hint="选择常用表情，或填写飞书表情类型。留空关闭。点表情的人确认后，机器人就会处理原消息。">
    <Input id={inputId} list={listId} value={value} placeholder="例如 THUMBSUP" onChange={event => onChange(event.target.value)}/>
    <datalist id={listId}>
      <option value="THUMBSUP" label="👍 赞"/>
      <option value="SMILE" label="🙂 微笑"/>
      <option value="DONE" label="完成"/>
    </datalist>
  </Field>;
}
