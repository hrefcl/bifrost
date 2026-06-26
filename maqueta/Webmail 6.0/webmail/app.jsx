// ============ Webmail 6.0 — App shell ============
const { useState: _auseState, useEffect: _auseEffect } = React;

function TopBar({ onMenu, account, theme, toggleTheme, query, setQuery, onSearch, view, setView, onSettings }) {
  const [focused, setFocused] = _auseState(false);
  return (
    <header style={{ height: 60, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: "1px solid var(--border)", background: "var(--surface)", zIndex: 40 }}>
      <IconBtn name="menu" label="Menú" onClick={onMenu} />
      <div onClick={() => setView("mail")} style={{ cursor: "pointer" }}><Logo size={30} /></div>
      <div style={{ flex: 1, maxWidth: 700, margin: "0 auto", position: "relative" }}>
        <form onSubmit={(e) => { e.preventDefault(); onSearch(); }} style={{ display: "flex", alignItems: "center", gap: 10, height: 44, padding: "0 8px 0 16px", borderRadius: focused ? 14 : 24,
          background: focused ? "var(--surface)" : "var(--search-bg)", border: `1px solid ${focused ? "var(--accent)" : "transparent"}`, boxShadow: focused ? "var(--shadow-md)" : "none", transition: "all .14s" }}>
          <Icon name="search" size={19} style={{ color: "var(--text-3)" }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            placeholder="Buscar en el correo" style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 14.5, fontFamily: "inherit", color: "var(--text-1)" }} />
          {query && <IconBtn name="x" size={18} btnSize={32} label="Limpiar" onClick={() => setQuery("")} />}
          <IconBtn name="filter" size={18} btnSize={32} label="Búsqueda avanzada" onClick={onSearch} />
        </form>
      </div>
      <IconBtn name={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "Modo claro" : "Modo oscuro"} onClick={toggleTheme} />
      <IconBtn name="calendar" label="Calendario" active={view === "calendar"} onClick={() => setView("calendar")} />
      <IconBtn name="settings" label="Ajustes" active={view === "settings"} onClick={onSettings} />
      <div style={{ marginLeft: 4 }}><Avatar person={account} size={34} /></div>
    </header>
  );
}

function App() {
  const [account, setAccount] = _auseState(null);
  const [theme, setTheme] = _auseState("light");
  const [accent, setAccent] = _auseState("#1b66ff");
  const [density, setDensity] = _auseState("comfortable");
  const [collapsed, setCollapsed] = _auseState(false);
  const [view, setView] = _auseState("mail"); // mail | calendar | settings | search
  const [folder, setFolder] = _auseState("inbox");
  const [category, setCategory] = _auseState("primary");
  const [selected, setSelected] = _auseState(null);
  const [checkedIds, setCheckedIds] = _auseState([]);
  const [query, setQuery] = _auseState("");
  const [searchQ, setSearchQ] = _auseState("");
  const [composer, setComposer] = _auseState(null);
  const [composerMin, setComposerMin] = _auseState(false);
  const [toast, setToast] = _auseState(null);

  // all threads in mutable state
  const [threads, setThreads] = _auseState(() => [...WM_THREADS, ...WM_DRAFTS]);

  _auseEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-700", "color-mix(in srgb, " + accent + " 82%, #000)");
  }, [theme, accent]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2600); };

  const folderThreads = threads.filter((t) => t.folder === (folder === "starred" ? "_starred" : folder) || (folder === "starred" && t.starred));
  const visibleThreads = folder === "starred" ? threads.filter((t) => t.starred) : threads.filter((t) => t.folder === folder);

  const counts = {};
  WM_FOLDERS.forEach((f) => {
    if (f.id === "inbox") counts.inbox = threads.filter((t) => t.folder === "inbox" && t.unread).length;
    else if (f.id === "drafts") counts.drafts = threads.filter((t) => t.folder === "drafts").length;
    else if (f.id === "spam") counts.spam = threads.filter((t) => t.folder === "spam").length;
    else counts[f.id] = 0;
  });

  const actions = {
    star: (id) => setThreads((ts) => ts.map((t) => t.id === id ? { ...t, starred: !t.starred } : t)),
    archive: (id) => { setThreads((ts) => ts.map((t) => t.id === id ? { ...t, folder: "archive" } : t)); if (selected && selected.id === id) setSelected(null); showToast("Conversación archivada"); },
    trash: (id) => { setThreads((ts) => ts.map((t) => t.id === id ? { ...t, folder: "trash" } : t)); if (selected && selected.id === id) setSelected(null); showToast("Movida a la papelera"); },
    read: (id) => setThreads((ts) => ts.map((t) => t.id === id ? { ...t, unread: false } : t)),
  };

  const openThread = (t) => { setSelected(t); actions.read(t.id); if (view === "search") {} };
  const onCheck = (id) => setCheckedIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

  const openComposer = (init = {}) => { setComposer({ ...init }); setComposerMin(false); };
  const reply = (thread, msg, mode) => {
    const subjPrefix = mode === "forward" ? "Fwd: " : "Re: ";
    const clean = thread.subject.replace(/^(Re: |Fwd: )+/i, "");
    openComposer({
      to: mode === "forward" ? "" : msg.from.email,
      subject: subjPrefix + clean,
      label: mode === "forward" ? "Reenviar" : mode === "replyAll" ? "Responder a todos" : "Responder",
      body: "\n\n———\nEl " + msg.date + ", " + msg.from.name + " escribió:\n> " + msg.body[0],
    });
  };
  const sendMail = (data) => {
    setComposer(null);
    showToast("Mensaje enviado a " + (data.to || "destinatario"));
  };

  if (!account) return <LoginScreen onLogin={(a) => setAccount(a)} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg)" }}>
      <TopBar onMenu={() => setCollapsed((c) => !c)} account={account} theme={theme} toggleTheme={() => setTheme((t) => t === "dark" ? "light" : "dark")}
        query={query} setQuery={setQuery} onSearch={() => { setSearchQ(query); setView("search"); setSelected(null); }} view={view} setView={(v) => { setView(v); setSelected(null); }} onSettings={() => setView("settings")} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Sidebar folder={folder} setFolder={(f) => { setFolder(f); setSelected(null); setCheckedIds([]); }} collapsed={collapsed} onCompose={() => openComposer({})} counts={counts} view={view} setView={setView} />
        <main style={{ flex: 1, display: "flex", minWidth: 0 }}>
          {view === "calendar" && <CalendarView />}
          {view === "settings" && <SettingsView theme={theme} setTheme={setTheme} density={density} setDensity={setDensity} accent={accent} setAccent={setAccent} />}
          {view === "search" && (
            <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
              <div style={{ flex: selected ? "0 0 44%" : 1, minWidth: 0, borderRight: selected ? "1px solid var(--border)" : "none" }}>
                <SearchResults query={searchQ} allThreads={threads} onSelect={openThread} />
              </div>
              {selected && <ThreadView thread={selected} onClose={() => setSelected(null)} actions={actions} onReply={reply} />}
            </div>
          )}
          {view === "mail" && (
            <>
              <div style={{ flex: selected ? "0 0 minmax(380px, 42%)" : 1, width: selected ? "42%" : "auto", minWidth: 0, borderRight: "1px solid var(--border)", display: selected ? undefined : "flex", maxWidth: selected ? 560 : "none" }}>
                <MessageList threads={visibleThreads} folder={folder} selected={selected} onSelect={openThread} actions={actions}
                  category={category} setCategory={setCategory} density={density} checkedIds={checkedIds} onCheck={onCheck} />
              </div>
              {selected && <ThreadView thread={selected} onClose={() => setSelected(null)} actions={actions} onReply={reply} />}
            </>
          )}
        </main>
      </div>
      {composer && <Composer initial={composer} onClose={() => setComposer(null)} onSend={sendMail} minimized={composerMin} onToggleMin={() => setComposerMin((m) => !m)} />}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--toast-bg)", color: "var(--toast-fg)", padding: "12px 20px", borderRadius: 10, boxShadow: "var(--shadow-lg)", fontSize: 14, fontWeight: 500, zIndex: 80, display: "flex", alignItems: "center", gap: 14 }}>
          {toast}<button onClick={() => setToast(null)} style={{ background: "none", border: "none", color: "var(--accent-300)", cursor: "pointer", fontWeight: 700, fontSize: 13, fontFamily: "inherit" }}>Deshacer</button>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
