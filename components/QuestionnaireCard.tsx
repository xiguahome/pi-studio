"use client";

import { memo, useState } from "react";
import type { AskUserQuestionItem, QuestionnaireAnswer } from "@/lib/types";

interface Props {
  questions: AskUserQuestionItem[];
  onSubmit: (answers: QuestionnaireAnswer[]) => void;
  onCancel: () => void;
}

/**
 * Multi-question questionnaire card for the ask_user_question tool.
 *
 * pi-studio intercepts the toolCall (questions[] come straight from the tool
 * input) and drives the whole questionnaire here — one card with prev/next
 * navigation, a progress indicator, and a cached answer per question. Only on
 * submit are the answers handed back to useAgentSession, which feeds them to
 * the plugin's sequential select/input requests so the tool returns a normal
 * result. See hooks/useAgentSession.ts (questionnaire state machine).
 */
export const QuestionnaireCard = memo(function QuestionnaireCard({ questions, onSubmit, onCancel }: Props) {
  const total = questions.length;
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<(QuestionnaireAnswer | null)[]>(() => questions.map(() => null));

  const q = questions[current];
  const ans = answers[current];

  const selectedOption = !q.multiSelect && ans?.kind === "option" ? ans.optionIndex : -1;
  const multiIndices = q.multiSelect && ans?.kind === "multi" ? ans.indices : [];
  const customText = ans?.kind === "custom" ? ans.text : ans?.kind === "multi" ? (ans.customText ?? "") : "";
  const usingCustomSingle = ans?.kind === "custom";

  const update = (val: QuestionnaireAnswer | null) =>
    setAnswers((prev) => { const next = prev.slice(); next[current] = val; return next; });

  const pickOption = (idx: number) => update({ kind: "option", optionIndex: idx });
  const toggleMulti = (idx: number) => {
    const indices = ans?.kind === "multi" ? [...ans.indices] : [];
    const ct = ans?.kind === "multi" ? ans.customText : "";
    const i = indices.indexOf(idx);
    if (i >= 0) indices.splice(i, 1); else indices.push(idx);
    update({ kind: "multi", indices, customText: ct });
  };
  const setCustomSingle = (text: string) => update({ kind: "custom", text });
  const setMultiCustom = (text: string) => {
    const indices = ans?.kind === "multi" ? ans.indices : [];
    update({ kind: "multi", indices, customText: text });
  };

  // Every question needs an answer object (multi with no picks still counts —
  // the plugin treats that as an empty commit).
  const canSubmit = answers.every(Boolean);
  const isLast = current === total - 1;

  return (
    <div role="dialog" aria-modal="true" style={cardStyle}>
      {/* progress */}
      <div style={progressWrapStyle}>
        <span style={progressTextStyle}>第 {current + 1} / {total} 题</span>
        <div style={progressTrackStyle}>
          <div style={{ ...progressFillStyle, width: `${((current + 1) / total) * 100}%` }} />
        </div>
      </div>

      {/* question */}
      <div style={headStyle}>
        {q.header ? <span style={chipStyle}>{q.header}</span> : null}
        <div style={questionTextStyle}>{q.question}</div>
      </div>

      {/* options */}
      <div style={optionsStyle}>
        {q.options.map((opt, i) => {
          const selected = q.multiSelect ? multiIndices.includes(i) : selectedOption === i;
          return (
            <button
              key={i}
              style={{ ...optionStyle, ...(selected ? optionSelectedStyle : {}) }}
              onClick={() => (q.multiSelect ? toggleMulti(i) : pickOption(i))}
            >
              <span style={radioWrapStyle}>
                {q.multiSelect ? <CheckboxMark on={selected} /> : <RadioMark on={selected} />}
              </span>
              <span style={optionContentStyle}>
                <span style={{ ...optionLabelStyle, ...(selected ? { color: "var(--accent)" } : {}) }}>{opt.label}</span>
                {opt.description ? <span style={optionDescStyle}>{opt.description}</span> : null}
              </span>
            </button>
          );
        })}

        {/* custom answer row */}
        {!q.multiSelect ? (
          <CustomSingleRow
            active={usingCustomSingle}
            text={customText}
            onActivate={() => (usingCustomSingle ? update(null) : setCustomSingle(""))}
            onChange={setCustomSingle}
          />
        ) : (
          <CustomMultiRow text={customText} onChange={setMultiCustom} />
        )}
      </div>

      {/* footer */}
      <div style={footerStyle}>
        <button type="button" style={ghostBtnStyle} onClick={onCancel}>取消</button>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            style={current === 0 ? { ...ghostBtnStyle, opacity: 0.4, cursor: "not-allowed" } : ghostBtnStyle}
            disabled={current === 0}
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          >
            上一步
          </button>
          {isLast ? (
            <button
              type="button"
              style={canSubmit ? accentBtnStyle : { ...accentBtnStyle, opacity: 0.5, cursor: "not-allowed" }}
              disabled={!canSubmit}
              onClick={() => { if (canSubmit) onSubmit(answers as QuestionnaireAnswer[]); }}
            >
              提交
            </button>
          ) : (
            <button type="button" style={accentBtnStyle} onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}>
              下一步
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

// ── Sub-components ──

function RadioMark({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" stroke={on ? "var(--accent)" : "var(--text-dim)"} strokeWidth="1.5" />
      {on ? <circle cx="8" cy="8" r="3.5" fill="var(--accent)" /> : null}
    </svg>
  );
}

function CheckboxMark({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="14" height="14" rx="3" stroke={on ? "var(--accent)" : "var(--text-dim)"} strokeWidth="1.5" />
      {on ? <path d="M4 8.2 L6.8 11 L12 5" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

function CustomSingleRow({ active, text, onActivate, onChange }: {
  active: boolean;
  text: string;
  onActivate: () => void;
  onChange: (t: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        style={{ ...optionStyle, ...(active ? optionSelectedStyle : {}) }}
        onClick={onActivate}
      >
        <span style={radioWrapStyle}><RadioMark on={active} /></span>
        <span style={optionContentStyle}>
          <span style={{ ...optionLabelStyle, ...(active ? { color: "var(--accent)" } : {}) }}>自定义答案</span>
          <span style={optionDescStyle}>Type something — 手动输入你的回答</span>
        </span>
        <span style={badgeStyle}>自定义</span>
      </button>
      {active && (
        <input
          autoFocus
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder="输入你的答案..."
          style={{ ...inputStyle, marginTop: 6 }}
        />
      )}
    </div>
  );
}

function CustomMultiRow({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  return (
    <div style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
        或输入自定义答案（可与上方选择组合）
      </span>
      <input
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="自定义答案（可选）"
        style={inputStyle}
      />
    </div>
  );
}

// ── Styles ──

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxHeight: "min(70vh, 620px)",
  margin: "0 auto 10px",
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg)",
  boxShadow: "0 12px 40px rgba(0,0,0,0.22)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

const progressWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-panel)",
};

const progressTextStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--accent)",
  fontFamily: "var(--font-mono)",
  flexShrink: 0,
};

const progressTrackStyle: React.CSSProperties = {
  flex: 1,
  height: 4,
  borderRadius: 2,
  background: "var(--bg-hover)",
  overflow: "hidden",
};

const progressFillStyle: React.CSSProperties = {
  height: "100%",
  background: "var(--accent)",
  borderRadius: 2,
  transition: "width 0.2s ease",
};

const headStyle: React.CSSProperties = {
  padding: "12px 14px",
};

const chipStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.5px",
  color: "var(--accent)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "2px 7px",
  marginBottom: 6,
  fontFamily: "var(--font-mono)",
};

const questionTextStyle: React.CSSProperties = {
  color: "var(--text)",
  fontSize: 14,
  fontWeight: 650,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};

const optionsStyle: React.CSSProperties = {
  padding: "0 14px",
  overflowY: "auto",
  flex: 1,
};

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
  outline: "none",
  transition: "background-color 0.1s",
};

const optionSelectedStyle: React.CSSProperties = {
  backgroundColor: "var(--bg-selected)",
};

const radioWrapStyle: React.CSSProperties = {
  flexShrink: 0,
  paddingTop: 1,
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

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text-dim)",
  backgroundColor: "var(--bg)",
  border: "1px solid var(--border)",
  padding: "2px 6px",
  borderRadius: 4,
  flexShrink: 0,
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

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
  background: "var(--bg-panel)",
};

const ghostBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 13,
};

const accentBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};
