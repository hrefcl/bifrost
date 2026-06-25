// ============ Webmail 6.0 — Login / multi-account ============
const { useState: _luseState } = React;

function Logo({ size = 32 }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <div style={{
        width: size, height: size, borderRadius: size * 0.28, position: "relative",
        background: "linear-gradient(135deg, var(--accent) 0%, #5b8cff 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 3px 10px rgba(27,102,255,.35)",
      }}>
        <Icon name="mail" size={size * 0.56} style={{ color: "#fff" }} strokeWidth={2.2} />
      </div>
      <span style={{ fontWeight: 700, fontSize: size * 0.5, letterSpacing: "-0.02em", color: "var(--text-1)" }}>
        Bifrost <span style={{ color: "var(--accent)", fontSize: size * 0.34, fontWeight: 600, verticalAlign: "middle", marginLeft: 1 }}>6.0</span>
      </span>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [step, setStep] = _luseState("pick"); // pick | password
  const [account, setAccount] = _luseState(WM_ACCOUNTS[0]);
  const [pwd, setPwd] = _luseState("");
  const [showPwd, setShowPwd] = _luseState(false);
  const [err, setErr] = _luseState("");

  const submit = (e) => {
    e.preventDefault();
    if (pwd.length < 4) { setErr("Introduce tu contraseña de aplicación"); return; }
    onLogin(account);
  };

  return (
    <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      background: "var(--bg)", backgroundImage: "radial-gradient(circle at 15% 15%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 45%), radial-gradient(circle at 85% 85%, color-mix(in srgb, #9333ea 7%, transparent), transparent 45%)" }}>
      <div style={{ width: 400, maxWidth: "100%" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}><Logo size={40} /></div>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "34px 34px 30px", boxShadow: "var(--shadow-lg)" }}>
          {step === "pick" && (
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px", letterSpacing: "-0.02em" }}>Inicia sesión</h1>
              <p style={{ fontSize: 14, color: "var(--text-2)", margin: "0 0 22px" }}>Elige una cuenta para continuar</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {WM_ACCOUNTS.map((a) => (
                  <button key={a.id} onClick={() => { setAccount(a); setStep("password"); setErr(""); }}
                    style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 14px", borderRadius: 10,
                      border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", textAlign: "left",
                      transition: "all .12s", fontFamily: "inherit" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--hover)"; e.currentTarget.style.borderColor = "var(--border-strong)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--surface)"; e.currentTarget.style.borderColor = "var(--border)"; }}>
                    <Avatar person={a} size={40} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-1)" }}>{a.name}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.email}</div>
                    </div>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 7px", borderRadius: 5, color: a.color, background: `color-mix(in srgb, ${a.color} 13%, transparent)` }}>{a.protocol}</span>
                  </button>
                ))}
                <button onClick={() => { setAccount({ ...WM_ACCOUNTS[0], name: "Nueva cuenta", email: "", initials: "+" }); setStep("password"); }}
                  style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 14px", borderRadius: 10, border: "1px dashed var(--border-strong)", background: "transparent", cursor: "pointer", color: "var(--text-2)", fontFamily: "inherit", fontSize: 14, fontWeight: 500 }}>
                  <div style={{ width: 40, height: 40, borderRadius: "50%", border: "1px solid var(--border-strong)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="plus" size={20} /></div>
                  Añadir otra cuenta (IMAP / JMAP)
                </button>
              </div>
            </div>
          )}
          {step === "password" && (
            <form onSubmit={submit}>
              <button type="button" onClick={() => setStep("pick")} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--text-2)", cursor: "pointer", fontSize: 13, fontFamily: "inherit", padding: 0, marginBottom: 18 }}><Icon name="arrowLeft" size={15} /> Volver</button>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
                <Avatar person={account} size={44} />
                <div><div style={{ fontWeight: 600, fontSize: 15 }}>{account.name}</div><div style={{ fontSize: 13, color: "var(--text-2)" }}>{account.email || "Configura el servidor IMAP/JMAP"}</div></div>
              </div>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", display: "block", marginBottom: 7 }}>Contraseña de aplicación</label>
              <div style={{ position: "relative", marginBottom: err ? 6 : 18 }}>
                <input type={showPwd ? "text" : "password"} value={pwd} autoFocus onChange={(e) => { setPwd(e.target.value); setErr(""); }} placeholder="••••••••••••"
                  style={{ width: "100%", padding: "12px 44px 12px 14px", fontSize: 14, fontFamily: "inherit", borderRadius: 9,
                    border: `1px solid ${err ? "var(--danger)" : "var(--border-strong)"}`, background: "var(--bg)", color: "var(--text-1)", outline: "none", boxSizing: "border-box" }}
                  onFocus={(e) => e.target.style.borderColor = "var(--accent)"} onBlur={(e) => e.target.style.borderColor = err ? "var(--danger)" : "var(--border-strong)"} />
                <button type="button" onClick={() => setShowPwd(!showPwd)} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", display: "flex" }}><Icon name={showPwd ? "sun" : "lock"} size={17} /></button>
              </div>
              {err && <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 16 }}>{err}</div>}
              <Btn type="submit" full size="lg" style={{ marginBottom: 14 }}>Acceder de forma segura</Btn>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-3)", justifyContent: "center" }}>
                <Icon name="lock" size={13} /> Credenciales cifradas con AES-256-GCM · BFF
              </div>
            </form>
          )}
        </div>
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-3)", marginTop: 20 }}>Bifrost 6.0 · IMAP &amp; JMAP</p>
      </div>
    </div>
  );
}

Object.assign(window, { LoginScreen, Logo });
