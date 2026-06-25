// ============ Webmail 6.0 — Settings ============
const { useState: _setuseState } = React;

function SettingsView({ theme, setTheme, density, setDensity, accent, setAccent }) {
  const [section, setSection] = _setuseState("general");
  const sections = [
    { id: "general", name: "General", icon: "settings" },
    { id: "accounts", name: "Cuentas", icon: "users" },
    { id: "appearance", name: "Apariencia", icon: "sun" },
    { id: "security", name: "Seguridad", icon: "shield" },
    { id: "filters", name: "Filtros y reglas", icon: "filter" },
  ];
  const Row = ({ title, desc, children }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "16px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{title}</div>{desc && <div style={{ fontSize: 13, color: "var(--text-3)", lineHeight: 1.5 }}>{desc}</div>}</div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
  const accents = [["#1b66ff", "Azul"], ["#16a34a", "Verde"], ["#9333ea", "Púrpura"], ["#ea580c", "Ámbar"], ["#0891b2", "Cian"]];

  return (
    <div style={{ display: "flex", height: "100%", background: "var(--surface)" }}>
      <div style={{ width: 230, flexShrink: 0, borderRight: "1px solid var(--border)", padding: "20px 12px" }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 16px", padding: "0 12px", letterSpacing: "-0.01em" }}>Ajustes</h1>
        {sections.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "0 12px", height: 40, borderRadius: 8, border: "none", cursor: "pointer", fontFamily: "inherit",
            fontSize: 14, fontWeight: section === s.id ? 700 : 500, background: section === s.id ? "var(--accent-soft)" : "transparent", color: section === s.id ? "var(--accent-ink)" : "var(--text-1)", marginBottom: 2 }}
            onMouseEnter={(e) => { if (section !== s.id) e.currentTarget.style.background = "var(--hover)"; }} onMouseLeave={(e) => { if (section !== s.id) e.currentTarget.style.background = "transparent"; }}>
            <Icon name={s.icon} size={18} />{s.name}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "28px 40px", maxWidth: 720 }}>
        {section === "appearance" && (<>
          <h2 style={hdr}>Apariencia</h2>
          <Row title="Tema" desc="Cambia entre claro y oscuro, o sigue el sistema.">
            <div style={{ display: "flex", background: "var(--bg)", borderRadius: 9, padding: 3, border: "1px solid var(--border)" }}>
              {[["light", "sun", "Claro"], ["dark", "moon", "Oscuro"]].map(([v, ic, lb]) => (
                <button key={v} onClick={() => setTheme(v)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                  background: theme === v ? "var(--surface)" : "transparent", color: theme === v ? "var(--text-1)" : "var(--text-2)", boxShadow: theme === v ? "var(--shadow-sm)" : "none" }}><Icon name={ic} size={16} />{lb}</button>
              ))}
            </div>
          </Row>
          <Row title="Color de acento" desc="Personaliza el color principal de la interfaz.">
            <div style={{ display: "flex", gap: 10 }}>
              {accents.map(([c, n]) => (
                <button key={c} title={n} onClick={() => setAccent(c)} style={{ width: 30, height: 30, borderRadius: "50%", background: c, border: accent === c ? "3px solid var(--surface)" : "3px solid transparent", boxShadow: accent === c ? `0 0 0 2px ${c}` : "none", cursor: "pointer" }} />
              ))}
            </div>
          </Row>
          <Row title="Densidad de la lista" desc="Compacta muestra más conversaciones por pantalla.">
            <div style={{ display: "flex", background: "var(--bg)", borderRadius: 9, padding: 3, border: "1px solid var(--border)" }}>
              {[["comfortable", "Cómoda"], ["compact", "Compacta"]].map(([v, lb]) => (
                <button key={v} onClick={() => setDensity(v)} style={{ padding: "7px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                  background: density === v ? "var(--surface)" : "transparent", color: density === v ? "var(--text-1)" : "var(--text-2)", boxShadow: density === v ? "var(--shadow-sm)" : "none" }}>{lb}</button>
              ))}
            </div>
          </Row>
        </>)}
        {section === "general" && (<>
          <h2 style={hdr}>General</h2>
          <Row title="Vista de conversación" desc="Agrupar mensajes en hilos con el algoritmo JWZ."><Switch checked={true} onChange={() => {}} /></Row>
          <Row title="Panel de lectura" desc="Mostrar el contenido del correo a la derecha de la lista."><Switch checked={true} onChange={() => {}} /></Row>
          <Row title="Auto-guardado de borradores" desc="Guarda borradores cada 10 segundos mientras escribes."><Switch checked={true} onChange={() => {}} /></Row>
          <Row title="Atajos de teclado" desc="Estilo Gmail: c redactar, e archivar, / buscar."><Switch checked={true} onChange={() => {}} /></Row>
          <Row title="Idioma" desc="Idioma de la interfaz."><span style={{ fontSize: 14, color: "var(--text-2)", display: "flex", alignItems: "center", gap: 6 }}>Español <Icon name="chevronDown" size={15} /></span></Row>
        </>)}
        {section === "accounts" && (<>
          <h2 style={hdr}>Cuentas conectadas</h2>
          {WM_ACCOUNTS.map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
              <Avatar person={a} size={42} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{a.name} {a.primary && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", marginLeft: 6 }}>PRINCIPAL</span>}</div>
                <div style={{ fontSize: 13, color: "var(--text-3)" }}>{a.email}</div>
                <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3, display: "flex", alignItems: "center", gap: 5 }}><Icon name="lock" size={12} />{a.protocol} · {a.server}</div>
              </div>
              <Btn variant="secondary" size="sm">Gestionar</Btn>
            </div>
          ))}
          <div style={{ marginTop: 16 }}><Btn variant="ghost" icon="plus">Añadir cuenta IMAP / JMAP</Btn></div>
        </>)}
        {section === "security" && (<>
          <h2 style={hdr}>Seguridad</h2>
          <Row title="Cifrado de credenciales" desc="Las contraseñas IMAP se cifran con AES-256-GCM en reposo."><span style={badge("#16a34a")}><Icon name="check" size={13} />Activo</span></Row>
          <Row title="Sesión BFF" desc="Tokens de acceso de 15 min en memoria, refresh en cookie HttpOnly."><span style={badge("#16a34a")}><Icon name="check" size={13} />Activo</span></Row>
          <Row title="Sanitización HTML (DOMPurify)" desc="Todo el HTML entrante se sanitiza en el servidor antes de renderizar."><span style={badge("#16a34a")}><Icon name="check" size={13} />Servidor</span></Row>
          <Row title="Bloquear imágenes externas" desc="Evita el rastreo por píxeles de seguimiento."><Switch checked={true} onChange={() => {}} /></Row>
          <Row title="Cifrado PGP / S/MIME" desc="Disponible en la Fase 3."><span style={badge("#ca8a04")}>Próximamente</span></Row>
        </>)}
        {section === "filters" && (<>
          <h2 style={hdr}>Filtros y reglas</h2>
          {[["De: notifications@github.com", "→ Etiqueta «Infraestructura», saltar Recibidos"], ["Asunto contiene «recibo»", "→ Etiqueta «Finanzas»"], ["De: *@jmapweekly.com", "→ Categoría Promociones"]].map(([a, b], i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
              <Icon name="filter" size={18} style={{ color: "var(--text-3)" }} />
              <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, fontWeight: 600, fontFamily: "ui-monospace, monospace" }}>{a}</div><div style={{ fontSize: 13, color: "var(--text-3)" }}>{b}</div></div>
              <IconBtn name="more" btnSize={32} label="Opciones" />
            </div>
          ))}
          <div style={{ marginTop: 16 }}><Btn variant="ghost" icon="plus">Crear regla</Btn></div>
        </>)}
      </div>
    </div>
  );
}
const hdr = { fontSize: 20, fontWeight: 600, margin: "0 0 8px", letterSpacing: "-0.02em" };
const badge = (c) => ({ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 6, color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` });

window.SettingsView = SettingsView;
