"use client";

import { memo, useState, useEffect, useRef } from "react";
import type { ExtensionUiRequest } from "@/lib/types";

// ExtensionUiDialogRequest is select | confirm | input | editor
type SelectRequest = Extract<ExtensionUiRequest, { method: "select" }>;
type InputRequest = Extract<ExtensionUiRequest, { method: "input" }>;
type ExtensionUiDialogRequest = SelectRequest | InputRequest;

interface Props {
  request: ExtensionUiDialogRequest;
  onRespond: (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true }
  ) => void;
}

/**
 * Parse a raw option string like "1. Label — Description" into parts.
 * Falls back to the whole string as label if the pattern doesn't match.
 */
function parseOption(raw: string): { label: string; description: string } {
  // Try "N. Label — Description" (em dash, used by rpiv plugin)
  let m = raw.match(/^\d+\.\s*(.+?)\s*[—–-]\s*(.+)$/);
  if (m) return { label: m[1].trim(), description: m[2].trim() };
  // Try "N. Label" (no description)
  m = raw.match(/^\d+\.\s*(.+)$/);
  if (m) return { label: m[1].trim(), description: "" };
  // Raw fallback
  return { label: raw, description: "" };
}

export const AskUserQuestionCard = memo(function AskUserQuestionCard({ request, onRespond }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog changes
  useEffect(() => {
    setSelectedIndex(0);
    setInputValue("");
    setShowInput(false);
  }, [request.id]);

  // ── Input method (custom answer / multi-select) ──
  if (request.method === "input") {
    const lines = request.title.split("\n").filter((l) => l.trim());
    const question = lines[0]?.trim() ?? request.title;
    const detailLines = lines.slice(1); // may contain option list for multi-select
    const placeholder = request.placeholder ?? "";

    const submit = () => onRespond(request, { value: inputValue });

    return (
      <Overlay>
        <Card>
          <Header question={question} />
          <Body>
            {detailLines.length > 0 && (
              <pre style={{ margin: 0, marginBottom: 10, fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>
                {detailLines.join("\n")}
              </pre>
            )}
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={placeholder || "输入你的答案..."}
              style={inputStyle}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                else if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
            />
          </Body>
          <Footer onCancel={() => onRespond(request, { cancelled: true })} onSubmit={submit} submitLabel="确认" />
        </Card>
      </Overlay>
    );
  }

  // ── Select method (option selection) ──
  // request.options is the raw string array from the plugin (e.g.
  // ["1. Option A — desc", "2. Option B — desc", "3. Type something."])
  const rawOptions = request.options ?? [];
  const parsedOptions = rawOptions.map(parseOption);
  const question = request.title;

  // Clicking an option only selects it. The "确认选择" button commits. Plain
  // function (not useCallback) — it sits after the input-method early return,
  // so a Hook here would violate the rules-of-hooks ordering.
  const commitSelect = (index: number) => {
    const isLastTypeSomething = /type something/i.test(parsedOptions[parsedOptions.length - 1]?.label ?? "");
    if (isLastTypeSomething && index === parsedOptions.length - 1) {
      setShowInput(true);
      setTimeout(() => inputRef.current?.focus(), 50);
      return;
    }
    // Return the RAW option string — the plugin matches by exact string
    onRespond(request, { value: rawOptions[index] });
  };

  const submitInput = () => onRespond(request, { value: inputValue });

  const commitFromFooter = () => {
    // If the "Type something." input is open, commit its value; otherwise
    // commit the currently highlighted option.
    if (showInput && selectedIndex === parsedOptions.length - 1) {
      if (inputValue.trim()) submitInput();
      return;
    }
    commitSelect(selectedIndex);
  };

  return (
    <Overlay>
      <Card>
        <Header question={question} />
        <Body>
          {parsedOptions.length === 0 && (
            <div style={{ color: "var(--text-dim)", fontSize: 12, padding: "8px 0" }}>（没有选项）</div>
          )}
          {parsedOptions.map((opt, i) => {
            const isTypeSomething = /type something/i.test(opt.label);
            const isSelected = selectedIndex === i;
            return (
              <button
                key={i}
                style={{
                  ...optionStyle,
                  ...(isSelected ? optionSelectedStyle : {}),
                }}
                onClick={() => {
                  setSelectedIndex(i);
                  // "Type something." lives in the last slot — clicking it
                  // expands the custom-answer input immediately (not on commit).
                  const isTypeOpt =
                    i === parsedOptions.length - 1 &&
                    /type something/i.test(parsedOptions[i]?.label ?? "");
                  if (isTypeOpt) {
                    setShowInput(true);
                    setTimeout(() => inputRef.current?.focus(), 50);
                  } else if (showInput) {
                    // Switched away from the custom option — collapse its input.
                    setShowInput(false);
                  }
                }}
              >
                <span style={{ flexShrink: 0, paddingTop: 1 }}>
                  {isSelected ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="7" stroke="var(--accent)" strokeWidth="1.5" />
                      <circle cx="8" cy="8" r="3.5" fill="var(--accent)" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="7" stroke="var(--text-dim)" strokeWidth="1.5" />
                    </svg>
                  )}
                </span>
                <span style={optionContentStyle}>
                  <span style={{ ...optionLabelStyle, ...(isSelected ? { color: "var(--accent)" } : {}) }}>
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span style={optionDescStyle}>{opt.description}</span>
                  )}
                </span>
                {isTypeSomething && (
                  <span style={otherBadgeStyle}>自定义</span>
                )}
              </button>
            );
          })}
          {showInput && (
            <div style={customInputContainer}>
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="输入你的自定义答案..."
                style={inputStyle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitInput();
                  else if (e.key === "Escape") { setShowInput(false); setInputValue(""); }
                }}
              />
            </div>
          )}
        </Body>
        <Footer
          onCancel={() => onRespond(request, { cancelled: true })}
          onSubmit={commitFromFooter}
          submitLabel="确认选择"
        />
      </Card>
    </Overlay>
  );
});

// ── Sub-components ──

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      zIndex: 90,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
      background: "rgba(0,0,0,0.18)",
    }}>
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" style={{
      width: "min(560px, 100%)",
      maxHeight: "min(80vh, 700px)",
      border: "1px solid var(--border)",
      borderRadius: 8,
      background: "var(--bg)",
      boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>
      {children}
    </div>
  );
}

function Header({ question }: { question: string }) {
  return (
    <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px",
          color: "var(--accent)", fontFamily: "var(--font-mono)",
        }}>
          问答
        </span>
      </div>
      <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {question}
      </div>
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 14, overflowY: "auto", flex: 1 }}>{children}</div>;
}

function Footer({ onCancel, onSubmit, submitLabel }: {
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <div style={{
      display: "flex", justifyContent: "flex-end", gap: 8,
      padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)",
    }}>
      <button
        onClick={onCancel}
        style={{
          padding: "6px 10px", borderRadius: 6,
          border: "1px solid var(--border)", background: "var(--bg)",
          color: "var(--text-muted)", cursor: "pointer", fontSize: 13,
        }}
      >
        取消
      </button>
      <button
        onClick={onSubmit}
        style={{
          padding: "6px 10px", borderRadius: 6,
          border: "1px solid var(--accent)", background: "var(--accent)",
          color: "#fff", cursor: "pointer", fontSize: 13,
        }}
      >
        {submitLabel}
      </button>
    </div>
  );
}

// ── Styles ──

const optionStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "9px 10px",
  marginBottom: 4,
  borderRadius: 7,
  border: "1px solid transparent",
  backgroundColor: "var(--bg-panel)",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  transition: "background 0.1s, border-color 0.1s",
};

const optionSelectedStyle: React.CSSProperties = {
  backgroundColor: "var(--bg-selected)",
  borderColor: "var(--accent)",
};

const optionContentStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flex: 1,
  minWidth: 0,
};

const optionLabelStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--text)",
  fontWeight: 500,
};

const optionDescStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  lineHeight: 1.4,
};

const otherBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text-dim)",
  backgroundColor: "var(--bg)",
  padding: "2px 6px",
  borderRadius: 4,
  flexShrink: 0,
};

const customInputContainer: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 8,
  borderTop: "1px solid var(--border)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 10px",
  fontSize: 13,
  borderRadius: 7,
  border: "1px solid var(--border)",
  backgroundColor: "var(--bg-panel)",
  color: "var(--text)",
  outline: "none",
  boxSizing: "border-box",
};
