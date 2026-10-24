import React, { useState, type KeyboardEvent } from 'react';

export function Composer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState('');

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="kd2-composer">
      <textarea
        className="kd2-composer__input"
        value={value}
        placeholder="Ask KarkeDikha…"
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
      />
      <button type="button" className="kd2-composer__submit" disabled={disabled || !value.trim()} onClick={submit}>
        Send
      </button>
    </div>
  );
}
