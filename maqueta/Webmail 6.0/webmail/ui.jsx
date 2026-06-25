// ============ Webmail 6.0 — UI primitives ============
const { useState, useEffect, useRef } = React;

function Avatar({ person, size = 36 }) {
  const isEmoji = person.initials && /\p{Emoji}/u.test(person.initials) && person.initials.length <= 2 && !/[A-Z]/.test(person.initials);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: person.color || "var(--accent)", color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 600, fontSize: size * 0.4, letterSpacing: "-0.01em", userSelect: "none",
    }}>{person.initials || (person.name || "?")[0]}</div>
  );
}

function IconBtn({ name, size = 20, label, onClick, active, danger, style = {}, btnSize = 38 }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} title={label} aria-label={label}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: btnSize, height: btnSize, borderRadius: "50%", border: "none", cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: hover ? "var(--hover)" : "transparent",
        color: active ? "var(--accent)" : danger ? "var(--danger)" : "var(--text-2)",
        transition: "background .12s, color .12s", ...style,
      }}>
      <Icon name={name} size={size} />
    </button>
  );
}

function Btn({ children, onClick, variant = "primary", size = "md", icon, style = {}, type = "button", full }) {
  const [hover, setHover] = useState(false);
  const pads = size === "sm" ? "6px 14px" : size === "lg" ? "12px 26px" : "9px 22px";
  const fs = size === "sm" ? 13 : 14;
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    padding: pads, fontSize: fs, fontWeight: 600, fontFamily: "inherit", borderRadius: 8,
    cursor: "pointer", transition: "all .13s", border: "1px solid transparent", whiteSpace: "nowrap",
    width: full ? "100%" : "auto", letterSpacing: "0.01em",
  };
  const variants = {
    primary: { background: hover ? "var(--accent-700)" : "var(--accent)", color: "#fff", boxShadow: hover ? "0 2px 8px rgba(27,102,255,.35)" : "none" },
    secondary: { background: hover ? "var(--hover)" : "transparent", color: "var(--text-1)", borderColor: "var(--border)" },
    ghost: { background: hover ? "var(--hover)" : "transparent", color: "var(--accent)" },
    danger: { background: hover ? "var(--danger)" : "transparent", color: hover ? "#fff" : "var(--danger)", borderColor: "var(--danger)" },
  };
  return (
    <button type={type} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...base, ...variants[variant], ...style }}>
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 18} />}{children}
    </button>
  );
}

function LabelChip({ label, onRemove }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600,
      padding: "2px 8px", borderRadius: 5, lineHeight: 1.5,
      color: label.color, background: `color-mix(in srgb, ${label.color} 14%, transparent)`,
    }}>
      {label.name}
      {onRemove && <span onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ cursor: "pointer", opacity: .7, marginLeft: 1, display: "flex" }}><Icon name="x" size={11} /></span>}
    </span>
  );
}

function Switch({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} role="switch" aria-checked={checked}
      style={{
        width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", padding: 2,
        background: checked ? "var(--accent)" : "var(--border-strong)", transition: "background .15s",
        display: "flex", alignItems: "center", justifyContent: checked ? "flex-end" : "flex-start",
      }}>
      <span style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "all .15s" }} />
    </button>
  );
}

function Tooltip({ text, children }) {
  return <span title={text}>{children}</span>;
}

// category pill for inbox tabs
function fmtAttachIcon(type) {
  return type === "pdf" ? "file" : type === "har" ? "file" : "paperclip";
}

Object.assign(window, { Avatar, IconBtn, Btn, LabelChip, Switch, Tooltip, fmtAttachIcon });
