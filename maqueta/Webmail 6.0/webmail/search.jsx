// ============ Webmail 6.0 — Advanced search ============
const { useState: _suseState } = React;

function SearchResults({ query, allThreads, onSelect, onBack }) {
  const [filters, setFilters] = _suseState({ from: "", hasAttachment: false, unreadOnly: false, folder: "all", dateRange: "any" });
  const q = query.toLowerCase();
  let results = allThreads.filter((t) => {
    const hay = (t.subject + " " + t.snippet + " " + t.from.name + " " + t.from.email + " " + t.messages.map((m) => m.body.join(" ")).join(" ")).toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (filters.from && !(t.from.name + t.from.email).toLowerCase().includes(filters.from.toLowerCase())) return false;
    if (filters.hasAttachment && !(t.attachments && t.attachments.length)) return false;
    if (filters.unreadOnly && !t.unread) return false;
    if (filters.folder !== "all" && t.folder !== filters.folder) return false;
    return true;
  });

  const chip = (active, onClick, children) => (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 18, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
      border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`, background: active ? "var(--accent-soft)" : "var(--surface)", color: active ? "var(--accent-ink)" : "var(--text-2)" }}>{children}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--surface)", overflowY: "auto" }}>
      <div style={{ padding: "20px 28px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 4 }}>Resultados de búsqueda</div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 16px", letterSpacing: "-0.02em" }}>
          {query ? <>“{query}”</> : "Búsqueda avanzada"} <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-3)" }}>· {results.length} resultados</span>
        </h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative", flex: "0 0 220px" }}>
            <Icon name="user" size={15} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)" }} />
            <input value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} placeholder="De: alguien"
              style={{ width: "100%", padding: "7px 12px 7px 32px", fontSize: 13, fontFamily: "inherit", borderRadius: 18, border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--text-1)", outline: "none", boxSizing: "border-box" }} />
          </div>
          {chip(filters.hasAttachment, () => setFilters({ ...filters, hasAttachment: !filters.hasAttachment }), <><Icon name="paperclip" size={14} />Con adjunto</>)}
          {chip(filters.unreadOnly, () => setFilters({ ...filters, unreadOnly: !filters.unreadOnly }), <><Icon name="dot" size={14} fill="currentColor" />Sin leer</>)}
          {chip(filters.folder === "inbox", () => setFilters({ ...filters, folder: filters.folder === "inbox" ? "all" : "inbox" }), <><Icon name="inbox" size={14} />Recibidos</>)}
          <span style={{ fontSize: 11.5, color: "var(--text-3)", marginLeft: 4, display: "flex", alignItems: "center", gap: 5 }}><Icon name="search" size={13} />MongoDB Atlas Search · fuzzy</span>
        </div>
      </div>
      <div style={{ flex: 1 }}>
        {results.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 40px", color: "var(--text-3)", gap: 12 }}>
            <Icon name="search" size={44} strokeWidth={1.3} />
            <div style={{ fontSize: 15, fontWeight: 600 }}>Sin resultados</div>
            <div style={{ fontSize: 13 }}>Prueba con otros términos o quita algún filtro.</div>
          </div>
        ) : results.map((t) => (
          <div key={t.id} onClick={() => onSelect(t)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 28px", borderBottom: "1px solid var(--border)", cursor: "pointer" }}
            onMouseEnter={(e) => e.currentTarget.style.background = "var(--hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
            <Avatar person={t.from} size={34} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontSize: 14, fontWeight: t.unread ? 700 : 600 }}>{t.from.name}</span>
                <span style={{ fontSize: 12, color: "var(--text-3)" }}>{t.date} · {(WM_FOLDERS.find((f) => f.id === t.folder) || {}).name}</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: t.unread ? 600 : 500, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.subject}</div>
              <div style={{ fontSize: 13, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.snippet}</div>
            </div>
            {t.attachments && t.attachments.length > 0 && <Icon name="paperclip" size={15} style={{ color: "var(--text-3)" }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

window.SearchResults = SearchResults;
