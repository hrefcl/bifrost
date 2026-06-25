// ============ Webmail 6.0 — Composer ============
const { useState: _cuseState, useEffect: _cuseEffect, useRef: _cuseRef } = React;

function Composer({ initial, onClose, onSend, minimized, onToggleMin }) {
  const [to, setTo] = _cuseState(initial.to || "");
  const [cc, setCc] = _cuseState("");
  const [showCc, setShowCc] = _cuseState(false);
  const [subject, setSubject] = _cuseState(initial.subject || "");
  const [body, setBody] = _cuseState(initial.body || "");
  const [saved, setSaved] = _cuseState("");
  const taRef = _cuseRef(null);

  // autosave every ~3s of inactivity
  _cuseEffect(() => {
    if (!subject && !body && !to) return;
    setSaved("Guardando…");
    const t = setTimeout(() => setSaved("Borrador guardado · " + new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })), 900);
    return () => clearTimeout(t);
  }, [subject, body, to]);

  if (minimized) {
    return (
      <div style={{ position: "fixed", bottom: 0, right: 24, width: 320, background: "var(--surface)", borderRadius: "12px 12px 0 0", boxShadow: "var(--shadow-lg)", border: "1px solid var(--border)", borderBottom: "none", zIndex: 60 }}>
        <div onClick={onToggleMin} style={{ display: "flex", alignItems: "center", padding: "12px 14px", cursor: "pointer", background: "var(--composer-head)", color: "#fff", borderRadius: "12px 12px 0 0" }}>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subject || "Mensaje nuevo"}</span>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", display: "flex", opacity: .85 }}><Icon name="x" size={18} /></button>
        </div>
      </div>
    );
  }

  const toolbar = ["bold", "italic", "list", "link", "emoji"];
  return (
    <div style={{ position: "fixed", bottom: 0, right: 24, width: 560, maxWidth: "calc(100vw - 48px)", height: 560, maxHeight: "calc(100vh - 80px)",
      background: "var(--surface)", borderRadius: "12px 12px 0 0", boxShadow: "var(--shadow-lg)", border: "1px solid var(--border)", borderBottom: "none",
      display: "flex", flexDirection: "column", zIndex: 60 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "11px 14px", background: "var(--composer-head)", color: "#fff", borderRadius: "12px 12px 0 0" }}>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{initial.label || "Mensaje nuevo"}</span>
        <button onClick={onToggleMin} title="Minimizar" style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", display: "flex", opacity: .85, padding: 4 }}><Icon name="chevronDown" size={18} /></button>
        <button onClick={onClose} title="Descartar" style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", display: "flex", opacity: .85, padding: 4 }}><Icon name="x" size={18} /></button>
      </div>
      <div style={{ padding: "0 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", height: 44, borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 13.5, color: "var(--text-3)", width: 48 }}>Para</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="destinatario@dominio.com" style={inpStyle} />
          {!showCc && <button onClick={() => setShowCc(true)} style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 }}>Cc</button>}
        </div>
        {showCc && <div style={{ display: "flex", alignItems: "center", height: 44, borderBottom: "1px solid var(--border)" }}><span style={{ fontSize: 13.5, color: "var(--text-3)", width: 48 }}>Cc</span><input value={cc} onChange={(e) => setCc(e.target.value)} style={inpStyle} /></div>}
        <div style={{ display: "flex", alignItems: "center", height: 44 }}>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Asunto" style={{ ...inpStyle, fontWeight: 600 }} />
        </div>
      </div>
      <textarea ref={taRef} value={body} onChange={(e) => setBody(e.target.value)} autoFocus placeholder="Escribe tu mensaje…"
        style={{ flex: 1, border: "none", outline: "none", resize: "none", padding: "16px", fontSize: 14.5, lineHeight: 1.6, fontFamily: "inherit", background: "transparent", color: "var(--text-1)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
        <Btn icon="send" onClick={() => onSend({ to, cc, subject, body })}>Enviar</Btn>
        <div style={{ display: "flex", gap: 2, marginLeft: 6 }}>
          {toolbar.map((t) => <IconBtn key={t} name={t} size={18} btnSize={34} label={t} />)}
          <IconBtn name="paperclip" size={18} btnSize={34} label="Adjuntar" />
        </div>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-3)" }}>{saved}</span>
        <IconBtn name="trash" size={18} btnSize={34} label="Descartar" onClick={onClose} />
      </div>
    </div>
  );
}
const inpStyle = { flex: 1, border: "none", outline: "none", fontSize: 14, fontFamily: "inherit", background: "transparent", color: "var(--text-1)", height: "100%" };

window.Composer = Composer;
