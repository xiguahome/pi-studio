"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";

export interface ExpertInfo {
  name: string;
  description: string;
  source: "builtin" | "package" | "user" | "project";
  filePath: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  skills?: string[];
  disabled?: boolean;
}

function shortenPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(source: ExpertInfo["source"]): string {
  switch (source) {
    case "builtin": return "builtin";
    case "package": return "package";
    case "project": return "project";
    case "user": return "global";
    default: return source;
  }
}

// Chinese display names + one-line blurbs for builtin experts. Only shown in
// the zh-CN locale so the two languages stay isolated; English users keep the
// raw English name/description from the expert file.
const EXPERT_TRANSLATIONS: Record<string, { zh: string; blurb: string }> = {
  delegate: { zh: "委派代理", blurb: "轻量子代理，继承主模型处理简单委派任务，不自带默认读取。" },
  oracle: { zh: "决策守护", blurb: "高上下文决策一致性顾问，保护已定决策、防止执行中偏离。" },
  researcher: { zh: "网络研究员", blurb: "自主上网检索、评估并整理成聚焦的研究简报。" },
  reviewer: { zh: "审查专家", blurb: "审查代码差异、方案、计划、代码库健康度及 PR/Issue 是否合格。" },
  scout: { zh: "代码侦察兵", blurb: "快速探查代码库，返回压缩后的关键上下文供后续交接。" },
  worker: { zh: "实现代理", blurb: "负责常规任务的具体实现，以及执行 oracle 已批准的交接。" },
};

function getExpertTranslation(name: string, locale: string): { zh: string; blurb: string } | null {
  return locale === "zh-CN" ? EXPERT_TRANSLATIONS[name] || null : null;
}

function ExpertDetail({
  expert,
  cwd,
  onUse,
  onViewPrompt,
  onDelete,
  onCreateNew,
}: {
  expert: ExpertInfo;
  cwd: string;
  onUse: (name: string) => void;
  onViewPrompt: (path: string) => void;
  onDelete: (path: string) => void;
  onCreateNew: () => void;
}) {
  const { t, locale } = useI18n();

  function displayPath(p: string): string {
    if (expert.source === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header with source tag */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            flexShrink: 0,
            background:
              expert.source === "project"
                ? "rgba(99,102,241,0.12)"
                : expert.source === "builtin"
                  ? "rgba(34,197,94,0.12)"
                  : "rgba(120,120,120,0.12)",
            color:
              expert.source === "project"
                ? "rgba(99,102,241,0.8)"
                : expert.source === "builtin"
                  ? "#16a34a"
                  : "var(--text-dim)",
          }}
        >
          {sourceLabel(expert.source)}
        </span>
        {expert.disabled && (
          <span
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 3,
              background: "rgba(239,68,68,0.12)",
              color: "#ef4444",
            }}
          >
            {t("experts.disabled")}
          </span>
        )}
      </div>

      {/* File path */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.location")}
        </span>
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            wordBreak: "break-all",
          }}
        >
          {displayPath(expert.filePath)}
        </code>
      </div>

      {/* Name + Chinese translation (zh-CN only) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.name")}
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--text)", fontWeight: 600 }}>
            {getExpertTranslation(expert.name, locale)?.zh || expert.name}
          </span>
          {getExpertTranslation(expert.name, locale) && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
              {expert.name}
            </span>
          )}
        </div>
      </div>

      {/* Description + Chinese blurb (zh-CN only) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.description")}
        </span>
        {(() => {
          const tr = getExpertTranslation(expert.name, locale);
          if (!tr) {
            return (
              <span style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6 }}>
                {expert.description}
              </span>
            );
          }
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>
                {tr.blurb}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
                {expert.description}
              </span>
            </div>
          );
        })()}
      </div>

      {/* Config details */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.configuration")}
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {expert.model && (
            <span style={{
              padding: "4px 10px",
              borderRadius: 4,
              background: "var(--bg-panel)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
            }}>
              model: {expert.model}
            </span>
          )}
          {expert.thinking && (
            <span style={{
              padding: "4px 10px",
              borderRadius: 4,
              background: "var(--bg-panel)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
            }}>
              thinking: {expert.thinking}
            </span>
          )}
          {expert.systemPromptMode && (
            <span style={{
              padding: "4px 10px",
              borderRadius: 4,
              background: "var(--bg-panel)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
            }}>
              mode: {expert.systemPromptMode}
            </span>
          )}
          {expert.inheritProjectContext && (
            <span style={{
              padding: "4px 10px",
              borderRadius: 4,
              background: "var(--bg-panel)",
              fontSize: 12,
              color: "var(--text-muted)",
            }}>
              {t("experts.inheritsProjectContext")}
            </span>
          )}
          {expert.inheritSkills && (
            <span style={{
              padding: "4px 10px",
              borderRadius: 4,
              background: "var(--bg-panel)",
              fontSize: 12,
              color: "var(--text-muted)",
            }}>
              {t("experts.inheritsSkills")}
            </span>
          )}
        </div>
      </div>

      {/* Tools */}
      {expert.tools && expert.tools.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.tools")}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {expert.tools.map((tool) => (
              <span
                key={tool}
                style={{
                  padding: "3px 8px",
                  borderRadius: 4,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-dim)",
                }}
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Skills */}
      {expert.skills && expert.skills.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.skills")}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {expert.skills.map((skill) => (
              <span
                key={skill}
                style={{
                  padding: "3px 8px",
                  borderRadius: 4,
                  background: "rgba(99,102,241,0.08)",
                  border: "1px solid rgba(99,102,241,0.2)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "rgba(99,102,241,0.8)",
                }}
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, paddingTop: 8 }}>
        <button
          onClick={() => onUse(expert.name)}
          style={{
            padding: "8px 20px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {t("experts.useExpert")}
        </button>
        {!expert.disabled && (
          <button
            onClick={() => onViewPrompt(expert.filePath)}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t("experts.viewPrompt")}
          </button>
        )}
        {expert.source === "project" || expert.source === "user" ? (
          <button
            onClick={() => onDelete(expert.filePath)}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "none",
              color: "#f87171",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t("experts.delete")}
          </button>
        ) : null}
      </div>

      {/* Usage hint */}
      <div style={{
        padding: "12px 14px",
        borderRadius: 6,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        fontSize: 12,
        color: "var(--text-dim)",
        lineHeight: 1.6,
      }}>
        <code style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>
          /subagent {expert.name}
        </code>
        {" "}{t("experts.useHint", { name: expert.name })}
      </div>
    </div>
  );
}

function AddExpertPanel({
  cwd,
  projectResourcesLoaded,
  onUseExpert,
  onCreated,
}: {
  cwd: string;
  projectResourcesLoaded: boolean;
  onUseExpert: (text: string) => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();

  const inputStyle = {
    padding: "8px 12px",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    outline: "none",
  } as const;

  const toggleStyle = (on: boolean) => ({
    padding: "5px 14px",
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: on ? "rgba(99,102,241,0.1)" : "none",
    color: on ? "var(--accent)" : "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    cursor: "pointer",
  } as const);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>(["read", "grep", "find", "ls", "bash", "write", "edit"]);
  const [thinking, setThinking] = useState<string>("high");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [systemPromptMode, setSystemPromptMode] = useState<"replace" | "append">("replace");
  const [inheritProjectContext, setInheritProjectContext] = useState(true);
  const [inheritSkills, setInheritSkills] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillList, setSkillList] = useState<string[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skillsRef = useRef<HTMLDivElement>(null);
  const [defaultContext, setDefaultContext] = useState<"" | "fresh" | "fork">("");
  const [aliases, setAliases] = useState("");
  const [output, setOutput] = useState("");
  const [defaultProgress, setDefaultProgress] = useState(false);
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && Array.isArray(d.modelList)) setModelList(d.modelList); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d && Array.isArray(d.skills)) {
          const names = d.skills.map((s: { name: string }) => s.name).filter(Boolean);
          setSkillList(Array.from(new Set(names)));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  useEffect(() => {
    if (!skillsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (skillsRef.current && !skillsRef.current.contains(e.target as Node)) {
        setSkillsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [skillsOpen]);

  const commonTools = ["read", "grep", "find", "ls", "bash", "write", "edit"];

  const toggleTool = (tool: string) => {
    setSelectedTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    );
  };

  const toggleSkill = (skill: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill]
    );
  };

  const handleCreate = () => {
    if (!name.trim()) {
      setError(t("experts.nameRequired"));
      return;
    }
    if (!description.trim()) {
      setError(t("experts.descriptionRequired"));
      return;
    }

    const toolsStr = selectedTools.length ? selectedTools.join(", ") : t("experts.allToolsFallback");
    const skillsStr = selectedSkills.length ? selectedSkills.join(", ") : t("experts.noneValue");
    const aliasesStr = aliases.trim() || t("experts.noneValue");
    const modelStr = model.trim() || t("experts.fieldModelDefault");
    const dcStr = defaultContext || t("experts.defaultValue");
    const outputStr = output.trim() || t("experts.noneValue");

    const draft = [
      t("experts.draftHeader"),
      `- ${t("experts.draftName")}：${name.trim()}`,
      `- ${t("experts.draftDescription")}：${description.trim()}`,
      `- ${t("experts.draftModel")}：${modelStr}`,
      `- ${t("experts.draftThinking")}：${thinking}`,
      `- ${t("experts.draftTools")}：${toolsStr}`,
      `- ${t("experts.draftSkills")}：${skillsStr}`,
      `- ${t("experts.draftSystemPromptMode")}：${systemPromptMode}`,
      `- ${t("experts.draftDefaultContext")}：${dcStr}`,
      `- ${t("experts.draftAliases")}：${aliasesStr}`,
      `- ${t("experts.draftOutput")}：${outputStr}`,
      `- ${t("experts.draftScope")}：${scope}`,
      `- ${t("experts.draftInheritProjectContext")}：${inheritProjectContext ? t("experts.on") : t("experts.off")}`,
      `- ${t("experts.draftInheritSkills")}：${inheritSkills ? t("experts.on") : t("experts.off")}`,
      `- ${t("experts.draftDefaultProgress")}：${defaultProgress ? t("experts.on") : t("experts.off")}`,
      "",
      t("experts.draftSystemPrompt"),
      t("experts.draftSystemPromptPlaceholder"),
    ].join("\n");

    setSaving(true);
    try {
      // Echo the filled config into the chat input box; the user continues
      // typing the system prompt there and sends it to actually create the expert.
      onUseExpert(draft);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  const installPath = scope === "global"
    ? "~/.pi-studio/agents/"
    : `${shortenPath(cwd)}/.pi-studio/agents/`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
        {t("experts.createExpert")}
      </div>

      {/* Name */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.fieldName")}
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., security-auditor"
          style={{
            padding: "8px 12px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            outline: "none",
          }}
        />
      </div>

      {/* Description */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.fieldDescription")}
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this expert does..."
          style={{
            padding: "8px 12px",
            fontSize: 13,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            outline: "none",
          }}
        />
      </div>

      {/* Model + Thinking level */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldModel")}
          </label>
          <select value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle}>
            <option value="">{t("experts.fieldModelDefault")}</option>
            {modelList.map((m) => (
              <option key={`${m.provider}:${m.id}`} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldThinking")}
          </label>
          <select value={thinking} onChange={(e) => setThinking(e.target.value)} style={inputStyle}>
            {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Tools */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.fieldTools")}
        </label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {commonTools.map((tool) => (
            <button
              key={tool}
              onClick={() => toggleTool(tool)}
              style={{
                padding: "5px 10px",
                borderRadius: 4,
                border: selectedTools.includes(tool) ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: selectedTools.includes(tool) ? "rgba(99,102,241,0.1)" : "none",
                color: selectedTools.includes(tool) ? "var(--accent)" : "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {tool}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {t("experts.fieldToolsHint")}
        </span>
      </div>

      {/* System Prompt Mode + Default Context */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldSystemPromptMode")}
          </label>
          <select
            value={systemPromptMode}
            onChange={(e) => setSystemPromptMode(e.target.value as "replace" | "append")}
            style={inputStyle}
          >
            <option value="replace">{t("experts.modeReplace")}</option>
            <option value="append">{t("experts.modeAppend")}</option>
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldDefaultContext")}
          </label>
          <select
            value={defaultContext}
            onChange={(e) => setDefaultContext(e.target.value as "" | "fresh" | "fork")}
            style={inputStyle}
          >
            <option value="">{t("experts.contextDefault")}</option>
            <option value="fresh">{t("experts.contextFresh")}</option>
            <option value="fork">{t("experts.contextFork")}</option>
          </select>
        </div>
      </div>

      {/* Inheritance + progress toggles */}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldInheritProjectContext")}
          </label>
          <button type="button" onClick={() => setInheritProjectContext((v) => !v)} style={toggleStyle(inheritProjectContext)}>
            {inheritProjectContext ? t("experts.on") : t("experts.off")}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldInheritSkills")}
          </label>
          <button type="button" onClick={() => setInheritSkills((v) => !v)} style={toggleStyle(inheritSkills)}>
            {inheritSkills ? t("experts.on") : t("experts.off")}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldDefaultProgress")}
          </label>
          <button type="button" onClick={() => setDefaultProgress((v) => !v)} style={toggleStyle(defaultProgress)}>
            {defaultProgress ? t("experts.on") : t("experts.off")}
          </button>
        </div>
      </div>

      {/* Skills */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.fieldSkills")}
        </label>
        {skillList.length > 0 ? (
          <div ref={skillsRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setSkillsOpen((v) => !v)}
              style={{
                ...inputStyle,
                width: "100%",
                textAlign: "left",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
              }}
            >
              <span style={{ color: selectedSkills.length ? "var(--text)" : "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedSkills.length
                  ? t("experts.skillsSelected", { count: selectedSkills.length, list: selectedSkills.join(", ") })
                  : t("experts.skillsNone")}
              </span>
              <span style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }}>{skillsOpen ? "▲" : "▼"}</span>
            </button>
            {skillsOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  maxHeight: 220,
                  overflowY: "auto",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                  zIndex: 30,
                  padding: 6,
                }}
              >
                {skillList.map((skill) => {
                  const checked = selectedSkills.includes(skill);
                  return (
                    <label
                      key={skill}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 13,
                        background: checked ? "rgba(99,102,241,0.08)" : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSkill(skill)}
                        style={{ accentColor: "var(--accent)" }}
                      />
                      <span style={{ fontFamily: "var(--font-mono)", color: checked ? "var(--accent)" : "var(--text)" }}>
                        {skill}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <input
            value={selectedSkills.join(", ")}
            onChange={(e) => setSelectedSkills(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            placeholder={t("experts.skillsLoadingPlaceholder")}
            style={inputStyle}
          />
        )}
      </div>

      {/* Aliases + Output */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldAliases")}
          </label>
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="e.g., advisor, consultant"
            style={inputStyle}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 240 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("experts.fieldOutput")}
          </label>
          <input
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            placeholder="e.g., research.md (leave empty for none)"
            style={inputStyle}
          />
        </div>
      </div>

      {/* Scope */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("experts.fieldScope")}
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              borderRadius: 5,
              border: "1px solid var(--border)",
              overflow: "hidden",
              fontSize: 12,
            }}
          >
            {(["global", "project"] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  if (s === "global" || projectResourcesLoaded) setScope(s);
                }}
                disabled={s === "project" && !projectResourcesLoaded}
                style={{
                  padding: "6px 14px",
                  border: "none",
                  cursor: s === "project" && !projectResourcesLoaded ? "not-allowed" : "pointer",
                  background: scope === s ? "var(--bg-selected)" : "none",
                  color: scope === s ? "var(--text)" : "var(--text-dim)",
                  fontWeight: scope === s ? 600 : 400,
                  opacity: s === "project" && !projectResourcesLoaded ? 0.45 : 1,
                  borderRight: s === "global" ? "1px solid var(--border)" : "none",
                }}
              >
                {s === "global" ? t("experts.scopeGlobal") : t("experts.scopeProject")}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            → {installPath}
          </span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>
      )}

      {/* Create button */}
      <button
        onClick={handleCreate}
        disabled={saving || !name.trim() || !description.trim()}
        style={{
          padding: "10px 20px",
          borderRadius: 6,
          border: "none",
          background: "var(--accent)",
          color: "#fff",
          fontWeight: 600,
          cursor: saving || !name.trim() || !description.trim() ? "not-allowed" : "pointer",
          opacity: saving || !name.trim() || !description.trim() ? 0.5 : 1,
          fontSize: 13,
          alignSelf: "flex-start",
        }}
      >
        {saving ? t("experts.generating") : t("experts.generate")}
      </button>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {t("experts.generateHint")}
      </span>
    </div>
  );
}

export function ExpertsConfig({
  cwd,
  onClose,
  onUseExpert,
  embedded = false,
}: {
  cwd: string;
  onClose: () => void;
  onUseExpert: (prompt: string) => void;
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t, locale } = useI18n();
  const [experts, setExperts] = useState<ExpertInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [promptView, setPromptView] = useState<{
    loading: boolean;
    name?: string;
    content?: string;
    error?: string;
  } | null>(null);

  const loadExperts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/experts?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json() as { all?: ExpertInfo[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setExperts(data.all || []);
      if ((data.all?.length ?? 0) > 0 && !selected) {
        setSelected(data.all![0].name);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd, selected]);

  useEffect(() => {
    void loadExperts();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUseExpert = useCallback((name: string) => {
    onUseExpert(`/subagent ${name} `);
    onClose();
  }, [onUseExpert, onClose]);

  const handleViewPrompt = useCallback(async (filePath: string) => {
    const expert = experts.find((e) => e.filePath === filePath);
    // "View Prompt" only shows the prompt in a read-only dialog. It must NOT
    // echo the content into the input box — that is "Use Expert"'s job.
    setPromptView({ loading: true, name: expert?.name });
    try {
      // Read through the experts domain API (allowed to access
      // ~/.pi-studio/agents for global experts; /api/files would 403 there).
      const res = await fetch(`/api/experts?filePath=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data && typeof data.content === "string") {
        setPromptView({ loading: false, name: expert?.name, content: data.content });
      } else {
        setPromptView({
          loading: false,
          name: expert?.name,
          error: data?.error || `HTTP ${res.status}`,
        });
      }
    } catch (e) {
      setPromptView({
        loading: false,
        name: expert?.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [cwd, experts]);

  const handleDelete = useCallback(async (filePath: string) => {
    if (typeof window !== "undefined" && !window.confirm(t("experts.deleteConfirm"))) {
      return;
    }
    try {
      const res = await fetch("/api/experts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, cwd }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        if (typeof window !== "undefined") {
          window.alert(data?.error || t("experts.deleteFailed"));
        }
        return;
      }
      // Remove from the local list and clear selection if it was selected.
      setExperts((prev) => prev.filter((e) => e.filePath !== filePath));
      setSelected((prevSel) => {
        const deleted = experts.find((e) => e.filePath === filePath);
        return deleted && prevSel === deleted.name ? null : prevSel;
      });
    } catch (e) {
      if (typeof window !== "undefined") {
        window.alert(e instanceof Error ? e.message : String(e));
      }
    }
  }, [cwd, experts, t]);

  const selectedExpert = experts.find((e) => e.name === selected) ?? null;

  // Group experts by source
  const groups = [
    { label: "builtin", experts: experts.filter((e) => e.source === "builtin") },
    { label: "project", experts: experts.filter((e) => e.source === "project") },
    { label: "global", experts: experts.filter((e) => e.source === "user") },
  ].filter((g) => g.experts.length > 0);

  return (
    <div
      style={embedded
        ? { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }
        : {
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
      onClick={embedded ? undefined : (e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={embedded
          ? { flex: 1, minWidth: 0, minHeight: 0, background: "var(--bg)", display: "flex", flexDirection: "column", overflow: "hidden" }
          : {
              width: isMobile ? "calc(100vw - 16px)" : 800,
              maxWidth: "calc(100vw - 16px)",
              height: isMobile ? "calc(100dvh - 16px)" : "75vh",
              maxHeight: "calc(100dvh - 16px)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
              overflow: "hidden",
            }}
      >
        {/* Header */}
        {!embedded && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                {t("experts.title")}
              </span>
              <code
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  maxWidth: 320,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {shortenPath(cwd)}
              </code>
            </div>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: "2px 6px",
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: expert list */}
          <div
            style={{
              width: isMobile ? "100%" : 200,
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  {t("experts.loading")}
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "#f87171" }}>
                  {error}
                </div>
              ) : experts.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  {t("experts.noExperts")}
                </div>
              ) : (
                groups.map(({ label, experts: grpExperts }) => (
                  <div key={label} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        padding: "4px 8px 3px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {label}
                    </div>
                    {grpExperts.map((expert) => {
                      const isSelected = !addMode && selected === expert.name;
                      return (
                        <div
                          key={expert.name}
                          onClick={() => {
                            setSelected(expert.name);
                            setAddMode(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "8px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            background: isSelected ? "var(--bg-selected)" : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "none";
                          }}
                        >
                          <span
                            style={{
                              flexShrink: 0,
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: expert.disabled ? "var(--border)" : "var(--accent)",
                              boxShadow: expert.disabled ? "none" : "0 0 4px var(--accent)",
                            }}
                          />
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              flexDirection: "column",
                              gap: 1,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: isSelected ? 600 : 400,
                                color: expert.disabled ? "var(--text-dim)" : "var(--text)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                            {getExpertTranslation(expert.name, locale)?.zh || expert.name}
                          </span>
                          {getExpertTranslation(expert.name, locale) && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-dim)",
                                  fontFamily: "var(--font-mono)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {expert.name}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Add expert button */}
            <div
              style={{
                padding: "8px 6px",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div
                onClick={() => {
                  setAddMode(true);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  cursor: "pointer",
                  background: addMode ? "var(--bg-selected)" : "none",
                  color: addMode ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!addMode) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!addMode) e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {t("experts.addExpert")}
              </div>
            </div>
          </div>

          {/* Right: detail or add panel */}
          <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
            {addMode ? (
              <AddExpertPanel
                cwd={cwd}
                projectResourcesLoaded={true}
                onUseExpert={onUseExpert}
                onCreated={() => {
                  void loadExperts();
                  setAddMode(false);
                }}
              />
            ) : loading ? null : selectedExpert ? (
              <ExpertDetail
                key={selectedExpert.name}
                expert={selectedExpert}
                cwd={cwd}
                onUse={handleUseExpert}
                onViewPrompt={handleViewPrompt}
                onDelete={handleDelete}
                onCreateNew={() => setAddMode(true)}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                  gap: 16,
                }}
              >
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ opacity: 0.4 }}
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>{t("experts.selectExpert")}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Read-only prompt viewer — opened by "View Prompt", never echoes to input */}
      {promptView && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setPromptView(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: isMobile ? "calc(100vw - 16px)" : 720,
              maxWidth: "calc(100vw - 16px)",
              height: isMobile ? "calc(100dvh - 16px)" : "70vh",
              maxHeight: "calc(100dvh - 16px)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                {promptView.name
                  ? `${promptView.name} — ${t("experts.promptTitle")}`
                  : t("experts.promptTitle")}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {promptView.content ? (
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(promptView.content || "").catch(() => {});
                    }}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {t("experts.copy")}
                  </button>
                ) : null}
                <button
                  onClick={() => setPromptView(null)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 20,
                    lineHeight: 1,
                    padding: "2px 6px",
                  }}
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
              {promptView.loading ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  {t("experts.loading")}
                </div>
              ) : promptView.error ? (
                <div style={{ fontSize: 13, color: "#f87171" }}>{promptView.error}</div>
              ) : (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    color: "var(--text)",
                  }}
                >
                  {promptView.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
