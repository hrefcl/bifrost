// ============ Webmail 6.0 — Calendar (week view) ============
const { useState: _caluseState } = React;

function CalendarView() {
  const days = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  const dates = [22, 23, 24, 25, 26, 27, 28];
  const todayIdx = 2; // Wed 24
  const hours = []; for (let h = 7; h <= 20; h++) hours.push(h);
  const HOUR_H = 52;
  const fmtHour = (h) => (h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`);
  const [sel, setSel] = _caluseState(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--surface)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 24px", height: 56, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <h1 style={{ fontSize: 19, fontWeight: 600, margin: 0, letterSpacing: "-0.02em" }}>Junio 2026</h1>
        <div style={{ display: "flex", gap: 2 }}>
          <IconBtn name="chevronLeft" label="Anterior" />
          <IconBtn name="chevronRight" label="Siguiente" />
        </div>
        <Btn variant="secondary" size="sm">Hoy</Btn>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", background: "var(--bg)", borderRadius: 8, padding: 3, border: "1px solid var(--border)" }}>
            {["Día", "Semana", "Mes"].map((v, i) => (
              <button key={v} style={{ padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                background: i === 1 ? "var(--surface)" : "transparent", color: i === 1 ? "var(--text-1)" : "var(--text-2)", boxShadow: i === 1 ? "var(--shadow-sm)" : "none" }}>{v}</button>
            ))}
          </div>
          <Btn icon="plus" size="sm">Crear</Btn>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "60px repeat(7, 1fr)", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--surface)", zIndex: 5 }}>
          <div />
          {days.map((d, i) => (
            <div key={d} style={{ padding: "10px 0", textAlign: "center", borderLeft: "1px solid var(--border)" }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: i === todayIdx ? "var(--accent)" : "var(--text-3)", textTransform: "uppercase", letterSpacing: ".04em" }}>{d}</div>
              <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2, color: i === todayIdx ? "#fff" : "var(--text-1)", background: i === todayIdx ? "var(--accent)" : "transparent", width: 34, height: 34, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "2px auto 0" }}>{dates[i]}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "60px repeat(7, 1fr)", position: "relative" }}>
          <div>
            {hours.map((h) => <div key={h} style={{ height: HOUR_H, fontSize: 11, color: "var(--text-3)", textAlign: "right", paddingRight: 8, transform: "translateY(-7px)" }}>{fmtHour(h)}</div>)}
          </div>
          {days.map((d, di) => (
            <div key={d} style={{ borderLeft: "1px solid var(--border)", position: "relative" }}>
              {hours.map((h) => <div key={h} style={{ height: HOUR_H, borderBottom: "1px solid var(--border)" }} />)}
              {WM_EVENTS.filter((e) => e.day === di).map((e) => {
                const top = (e.start - 7) * HOUR_H;
                const height = (e.end - e.start) * HOUR_H - 3;
                return (
                  <div key={e.id} onClick={() => setSel(e)} style={{ position: "absolute", top, left: 3, right: 3, height, borderRadius: 6, padding: "4px 8px", overflow: "hidden", cursor: "pointer",
                    background: `color-mix(in srgb, ${e.color} 16%, var(--surface))`, borderLeft: `3px solid ${e.color}`, color: "var(--text-1)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: e.color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                    <div style={{ fontSize: 11, color: "var(--text-2)" }}>{fmtHour(Math.floor(e.start))}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {sel && (
        <div onClick={() => setSel(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 360, background: "var(--surface)", borderRadius: 14, boxShadow: "var(--shadow-lg)", padding: 22, borderTop: `4px solid ${sel.color}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <h3 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px" }}>{sel.title}</h3>
              <IconBtn name="x" btnSize={30} label="Cerrar" onClick={() => setSel(null)} />
            </div>
            <div style={{ fontSize: 13.5, color: "var(--text-2)", display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><Icon name="clock" size={15} />Hoy · {sel.start}:00 – {sel.end}:00</div>
            <div style={{ fontSize: 13.5, color: "var(--text-2)", display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><Icon name="tag" size={15} />{sel.cal}</div>
            <div style={{ display: "flex", gap: 8 }}><Btn size="sm">Editar</Btn><Btn variant="secondary" size="sm">Unirse</Btn></div>
          </div>
        </div>
      )}
    </div>
  );
}

window.CalendarView = CalendarView;
