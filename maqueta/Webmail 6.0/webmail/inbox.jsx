// ============ Webmail 6.0 — Sidebar + Message list + Thread view ============
const { useState: _iuseState } = React;

function Sidebar({ folder, setFolder, collapsed, onCompose, counts, view, setView }) {
  const labelFor = (id) => WM_LABELS.find((l) => l.id === id);
  return (
    <nav style={{ width: collapsed ? 72 : 256, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg)",
      display: "flex", flexDirection: "column", transition: "width .18s", overflow: "hidden", paddingTop: 8 }}>
      <div style={{ padding: collapsed ? "8px 16px 14px" : "8px 14px 14px" }}>
        <button onClick={onCompose} style={{ display: "flex", alignItems: "center", gap: 12, padding: collapsed ? 0 : "0 22px 0 16px",
          height: 48, width: collapsed ? 48 : "auto", borderRadius: collapsed ? "50%" : 14, border: "none", cursor: "pointer",
          background: "var(--compose-bg)", color: "var(--compose-fg)", fontFamily: "inherit", fontSize: 14, fontWeight: 600,
          boxShadow: "var(--shadow-sm)", justifyContent: collapsed ? "center" : "flex-start", transition: "all .15s" }}
          onMouseEnter={(e) => e.currentTarget.style.boxShadow = "var(--shadow-md)"} onMouseLeave={(e) => e.currentTarget.style.boxShadow = "var(--shadow-sm)"}>
          <Icon name="pencil" size={20} />{!collapsed && "Redactar"}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
        {WM_FOLDERS.map((f) => {
          const active = folder === f.id && view === "mail";
          const c = counts[f.id] ?? f.count;
          return (
            <button key={f.id} onClick={() => { setFolder(f.id); setView("mail"); }} title={f.name}
              style={{ display: "flex", alignItems: "center", gap: 16, width: collapsed ? "auto" : "calc(100% - 8px)",
                margin: collapsed ? "0 auto" : "0 0 0 0", padding: collapsed ? 0 : "0 16px", height: 36, borderRadius: collapsed ? "50%" : "0 18px 18px 0",
                justifyContent: collapsed ? "center" : "flex-start", border: "none", cursor: "pointer", fontFamily: "inherit",
                background: active ? "var(--accent-soft)" : "transparent", color: active ? "var(--accent-ink)" : "var(--text-1)",
                fontWeight: active ? 700 : 500, fontSize: 14, width: collapsed ? 48 : undefined, marginLeft: collapsed ? "auto" : 0, marginRight: collapsed ? "auto" : 0 }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--hover)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
              <Icon name={f.icon} size={19} fill={active && (f.icon === "star") ? "currentColor" : "none"} />
              {!collapsed && <><span style={{ flex: 1, textAlign: "left" }}>{f.name}</span>
                {c > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: active ? "var(--accent-ink)" : "var(--text-2)" }}>{c}</span>}</>}
            </button>
          );
        })}
        {!collapsed && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-3)", padding: "0 16px 8px" }}>Etiquetas</div>
            {WM_LABELS.map((l) => (
              <button key={l.id} style={{ display: "flex", alignItems: "center", gap: 16, width: "100%", padding: "0 16px", height: 34, border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 14, color: "var(--text-1)", fontWeight: 500 }}
                onMouseEnter={(e) => e.currentTarget.style.background = "var(--hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: l.color, flexShrink: 0 }} />
                <span style={{ flex: 1, textAlign: "left" }}>{l.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!collapsed && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", fontSize: 11.5, color: "var(--text-3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><span>Almacenamiento</span><span style={{ fontWeight: 600 }}>4.2 / 15 GB</span></div>
          <div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}><div style={{ width: "28%", height: "100%", background: "var(--accent)" }} /></div>
        </div>
      )}
    </nav>
  );
}

const CATEGORIES = [
  { id: "primary", name: "Principal", icon: "inbox" },
  { id: "updates", name: "Novedades", icon: "bell" },
  { id: "promotions", name: "Promociones", icon: "tag" },
];

function MessageRow({ thread, selected, onSelect, onStar, onArchive, onTrash, checked, onCheck, density }) {
  const [hover, setHover] = _iuseState(false);
  const labels = (thread.labels || []).map((id) => WM_LABELS.find((l) => l.id === id)).filter(Boolean);
  const isUnread = thread.unread;
  const compact = density === "compact";
  return (
    <div onClick={() => onSelect(thread)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: compact ? "0 14px" : "0 14px", minHeight: compact ? 40 : 52,
        cursor: "pointer", borderBottom: "1px solid var(--border)", position: "relative",
        background: selected ? "var(--accent-soft)" : checked ? "color-mix(in srgb, var(--accent) 9%, var(--surface))" : isUnread ? "var(--surface)" : "var(--surface-dim)",
        boxShadow: selected ? "inset 3px 0 0 var(--accent)" : "none", transition: "background .08s" }}>
      <div onClick={(e) => { e.stopPropagation(); onCheck(thread.id); }} style={{ display: "flex" }}>
        <span style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${checked ? "var(--accent)" : "var(--border-strong)"}`, background: checked ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>{checked && <Icon name="check" size={12} strokeWidth={3} />}</span>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onStar(thread.id); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", color: thread.starred ? "#f4b400" : "var(--text-3)" }}>
        <Icon name="star" size={18} fill={thread.starred ? "#f4b400" : "none"} />
      </button>
      <Avatar person={thread.from} size={compact ? 26 : 30} />
      <div style={{ width: compact ? 150 : 168, flexShrink: 0, overflow: "hidden" }}>
        <span style={{ fontSize: 13.5, fontWeight: isUnread ? 700 : 500, color: "var(--text-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{thread.from.name}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
        {labels.map((l) => <LabelChip key={l.id} label={l} />)}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: isUnread ? 700 : 500, color: "var(--text-1)" }}>{thread.subject}</span>
          <span style={{ fontSize: 13.5, color: "var(--text-2)" }}>{"  —  " + thread.snippet}</span>
        </span>
      </div>
      {thread.attachments && thread.attachments.length > 0 && <Icon name="paperclip" size={15} style={{ color: "var(--text-3)" }} />}
      <div style={{ width: 92, flexShrink: 0, textAlign: "right", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 2 }}>
        {hover ? (
          <>
            <IconBtn name="archive" size={17} btnSize={30} label="Archivar" onClick={(e) => { e.stopPropagation(); onArchive(thread.id); }} />
            <IconBtn name="trash" size={17} btnSize={30} label="Eliminar" onClick={(e) => { e.stopPropagation(); onTrash(thread.id); }} />
          </>
        ) : (
          <span style={{ fontSize: 12.5, fontWeight: isUnread ? 700 : 500, color: isUnread ? "var(--accent-ink)" : "var(--text-2)" }}>{thread.date}</span>
        )}
      </div>
    </div>
  );
}

function MessageList({ threads, folder, selected, onSelect, actions, category, setCategory, density, checkedIds, onCheck, title }) {
  const showCats = folder === "inbox";
  const visible = showCats ? threads.filter((t) => (t.category || "primary") === category) : threads;
  const folderName = title || (WM_FOLDERS.find((f) => f.id === folder) || {}).name || folder;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, background: "var(--surface)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 16px", height: 52, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" }}>{folderName}</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>{visible.length} conversaciones</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <IconBtn name="refresh" label="Sincronizar" />
          <IconBtn name="filter" label="Filtrar" />
          <IconBtn name="more" label="Más" />
        </div>
      </div>
      {showCats && (
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0, paddingLeft: 8 }}>
          {CATEGORIES.map((c) => {
            const count = threads.filter((t) => (t.category || "primary") === c.id && t.unread).length;
            const active = category === c.id;
            return (
              <button key={c.id} onClick={() => setCategory(c.id)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 18px", height: 44, border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit",
                  fontSize: 13.5, fontWeight: active ? 700 : 500, color: active ? "var(--accent)" : "var(--text-2)", borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1 }}>
                <Icon name={c.icon} size={17} />{c.name}
                {count > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>{count}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {visible.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-3)", gap: 12, padding: 40 }}>
            <Icon name="inbox" size={48} strokeWidth={1.3} />
            <div style={{ fontSize: 14, fontWeight: 500 }}>No hay nada por aquí</div>
          </div>
        ) : visible.map((t) => (
          <MessageRow key={t.id} thread={t} selected={selected && selected.id === t.id} onSelect={onSelect}
            onStar={actions.star} onArchive={actions.archive} onTrash={actions.trash}
            checked={checkedIds.includes(t.id)} onCheck={onCheck} density={density} />
        ))}
      </div>
    </div>
  );
}

function Attachment({ a }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", minWidth: 180, cursor: "pointer" }}
      onMouseEnter={(e) => e.currentTarget.style.background = "var(--hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "var(--surface)"}>
      <div style={{ width: 34, height: 34, borderRadius: 7, background: "color-mix(in srgb, var(--accent) 13%, transparent)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="file" size={18} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
        <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{a.size}</div>
      </div>
      <IconBtn name="download" size={16} btnSize={30} label="Descargar" />
    </div>
  );
}

function ThreadView({ thread, onClose, actions, onReply }) {
  if (!thread) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-3)", gap: 16, background: "var(--surface-dim)" }}>
        <div style={{ width: 96, height: 96, borderRadius: "50%", background: "var(--surface)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)" }}><Icon name="mail" size={42} strokeWidth={1.2} /></div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-2)" }}>Selecciona una conversación</div>
        <div style={{ fontSize: 13, maxWidth: 280, textAlign: "center" }}>Elige un mensaje de la lista para leerlo aquí. Headers primero, cuerpo bajo demanda.</div>
      </div>
    );
  }
  const labels = (thread.labels || []).map((id) => WM_LABELS.find((l) => l.id === id)).filter(Boolean);
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", minWidth: 0, background: "var(--surface)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 10px 0 14px", height: 52, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <IconBtn name="arrowLeft" label="Cerrar" onClick={onClose} />
        <IconBtn name="archive" label="Archivar" onClick={() => actions.archive(thread.id)} />
        <IconBtn name="trash" label="Eliminar" onClick={() => actions.trash(thread.id)} />
        <IconBtn name="clock" label="Posponer" />
        <IconBtn name="tag" label="Etiquetar" />
        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          <IconBtn name="printer" label="Imprimir" />
          <IconBtn name="more" label="Más" />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ padding: "22px 28px 8px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
            <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0, letterSpacing: "-0.02em", flex: 1, lineHeight: 1.3 }}>{thread.subject}</h1>
            <button onClick={() => actions.star(thread.id)} style={{ background: "none", border: "none", cursor: "pointer", color: thread.starred ? "#f4b400" : "var(--text-3)", display: "flex", padding: 4 }}><Icon name="star" size={20} fill={thread.starred ? "#f4b400" : "none"} /></button>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>{labels.map((l) => <LabelChip key={l.id} label={l} />)}</div>
        </div>
        {thread.messages.map((m, i) => (
          <div key={i} style={{ padding: "16px 28px", borderTop: i > 0 ? "1px solid var(--border)" : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
              <Avatar person={m.from} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{m.from.name}</span>
                  <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>&lt;{m.from.email}&gt;</span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>para {typeof m.to === "string" ? m.to : "mí"}</div>
              </div>
              <span style={{ fontSize: 12.5, color: "var(--text-3)", whiteSpace: "nowrap" }}>{m.date}</span>
              <IconBtn name="reply" size={17} btnSize={32} label="Responder" onClick={() => onReply(thread, m, "reply")} />
            </div>
            <div style={{ fontSize: 14.5, lineHeight: 1.65, color: "var(--text-1)", paddingLeft: 52 }}>
              {m.body.map((p, j) => <p key={j} style={{ margin: "0 0 13px" }}>{p}</p>)}
              {m.attachments && m.attachments.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><Icon name="paperclip" size={14} />{m.attachments.length} adjunto(s)</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{m.attachments.map((a, k) => <Attachment key={k} a={a} />)}</div>
                </div>
              )}
            </div>
          </div>
        ))}
        <div style={{ padding: "8px 28px 28px 80px", display: "flex", gap: 10 }}>
          <Btn variant="secondary" icon="reply" onClick={() => onReply(thread, thread.messages[thread.messages.length - 1], "reply")}>Responder</Btn>
          <Btn variant="secondary" icon="replyAll" onClick={() => onReply(thread, thread.messages[thread.messages.length - 1], "replyAll")}>Responder a todos</Btn>
          <Btn variant="secondary" icon="forward" onClick={() => onReply(thread, thread.messages[thread.messages.length - 1], "forward")}>Reenviar</Btn>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, MessageList, ThreadView, CATEGORIES });
