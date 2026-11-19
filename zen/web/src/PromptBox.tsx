// One prompt box, used twice: the rail's (a new thread) and the pane's (a message to this thread).
// ⌘⏎ sends; ⇧⌘⏎ sends and moves on, where the caller offers it.

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface PromptBoxHandle {
  focus(): void;
}

interface Props {
  placeholder: string;
  onSubmit(text: string, opts: { andNext: boolean }): Promise<void>;
  disabledReason?: string | null;
  /** Buttons beside Send. */
  actions?: ReactNode;
  sendLabel?: string;
  draftKey?: string;
}

export const PromptBox = forwardRef<PromptBoxHandle, Props>(function PromptBox(p, ref) {
  const [text, setText] = useState(() => readDraft(p.draftKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  useLayoutEffect(() => {
    setText(readDraft(p.draftKey));
    setError(null);
  }, [p.draftKey]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const submit = async (andNext: boolean) => {
    const v = text.trim();
    if (!v || busy || p.disabledReason) return;
    setBusy(true);
    setError(null);
    try {
      await p.onSubmit(v, { andNext });
      setText("");
      writeDraft(p.draftKey, "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`prompt${busy ? " is-busy" : ""}`}>
      <textarea
        ref={area}
        value={text}
        rows={1}
        placeholder={p.placeholder}
        onChange={(e) => {
          setText(e.target.value);
          writeDraft(p.draftKey, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(e.shiftKey);
          }
          if (e.key === "Escape") area.current?.blur();
        }}
      />
      {(text.trim() || p.actions || error || p.disabledReason) && (
        <div className="prompt-foot">
          <span className="prompt-hint">{error ?? (text.trim() ? p.disabledReason ?? "⌘⏎ to send" : "")}</span>
          <span className="prompt-actions">
            {p.actions}
            {text.trim() && (
              <button className="send" onClick={() => void submit(false)} disabled={busy || !!p.disabledReason}>
                {busy ? "Sending…" : (p.sendLabel ?? "Send")}
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
});

function readDraft(key?: string): string {
  if (!key) return "";
  try {
    return localStorage.getItem(`frizz-draft:${key}`) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string | undefined, v: string) {
  if (!key) return;
  try {
    if (v) localStorage.setItem(`frizz-draft:${key}`, v);
    else localStorage.removeItem(`frizz-draft:${key}`);
  } catch {
    /* a private window keeps no drafts */
  }
}
