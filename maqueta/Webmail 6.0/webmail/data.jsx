// ============ Webmail 6.0 — fake data ============
const WM_ACCOUNTS = [
  { id: "a1", name: "Elena Ruiz", email: "elena.ruiz@bifrost.io", color: "#1b66ff", protocol: "JMAP", server: "mail.bifrost.io", initials: "ER", primary: true },
  { id: "a2", name: "Elena (personal)", email: "elena.r@fastmail.com", color: "#16a34a", protocol: "IMAP", server: "imap.fastmail.com", initials: "EP", primary: false },
];

const WM_FOLDERS = [
  { id: "inbox", name: "Recibidos", icon: "inbox", count: 6 },
  { id: "starred", name: "Destacados", icon: "star", count: 0 },
  { id: "snoozed", name: "Pospuestos", icon: "clock", count: 0 },
  { id: "sent", name: "Enviados", icon: "send", count: 0 },
  { id: "drafts", name: "Borradores", icon: "file", count: 2 },
  { id: "archive", name: "Archivo", icon: "archive", count: 0 },
  { id: "spam", name: "Spam", icon: "shield", count: 1 },
  { id: "trash", name: "Papelera", icon: "trash", count: 0 },
];

const WM_LABELS = [
  { id: "work", name: "Trabajo", color: "#1b66ff" },
  { id: "infra", name: "Infraestructura", color: "#9333ea" },
  { id: "finance", name: "Finanzas", color: "#16a34a" },
  { id: "personal", name: "Personal", color: "#ea580c" },
];

const _people = {
  marcus: { name: "Marcus Hale", email: "marcus@stalwart.dev", color: "#9333ea", initials: "MH" },
  priya: { name: "Priya Nandakumar", email: "priya@dovecot.org", color: "#0891b2", initials: "PN" },
  team: { name: "Equipo Webmail", email: "team@bifrost.io", color: "#1b66ff", initials: "EW" },
  billing: { name: "Stripe", email: "receipts@stripe.com", color: "#635bff", initials: "S" },
  security: { name: "Centro de Seguridad", email: "security@bifrost.io", color: "#dc2626", initials: "🛡" },
  github: { name: "GitHub", email: "notifications@github.com", color: "#24292f", initials: "GH" },
  dana: { name: "Dana Okonkwo", email: "dana@cyrus.foundation", color: "#ca8a04", initials: "DO" },
  newsletter: { name: "JMAP Weekly", email: "hello@jmapweekly.com", color: "#0d9488", initials: "JW" },
  ana: { name: "Ana Belmonte", email: "ana.belmonte@bifrost.io", color: "#db2777", initials: "AB" },
};

// body is array of paragraphs
const WM_THREADS = [
  {
    id: "t1", folder: "inbox", from: _people.security, category: "primary",
    subject: "Acción requerida: rotación de claves IMAP en reposo",
    snippet: "Hemos detectado que tu credencial IMAP cifrada con AES-256-GCM cumple 90 días…",
    date: "10:42", ts: 1, unread: true, starred: true, labels: ["infra"], attachments: [],
    messages: [
      { from: _people.security, to: "elena.ruiz@bifrost.io", date: "Hoy, 10:42", body: [
        "Hola Elena,",
        "Como parte de nuestra política de defensa en capas, las credenciales IMAP almacenadas se cifran con AES-256-GCM y se rotan cada 90 días. La clave asociada a tu cuenta principal cumple ese plazo mañana.",
        "No necesitas hacer nada: la rotación es automática y transparente. Este aviso es solo para tu registro de auditoría. Si recibes una alerta de reconexión, vuelve a introducir tu contraseña de aplicación.",
        "— Centro de Seguridad, Bifrost" ] },
    ],
  },
  {
    id: "t2", folder: "inbox", from: _people.marcus, category: "primary",
    subject: "Re: Migración a JMAP — push bajo 1s funcionando 🎉",
    snippet: "Acabo de probar el WebSocket de notificaciones contra Stalwart y el push llega en…",
    date: "9:58", ts: 2, unread: true, starred: false, labels: ["work","infra"], attachments: [],
    messages: [
      { from: _people.team, to: "Elena, Marcus", date: "Ayer, 17:20", body: [
        "Equipo, el adaptador JMAP ya está en staging. ¿Alguien puede validar la latencia de push real contra Stalwart antes del viernes?" ] },
      { from: _people.marcus, to: "team@bifrost.io", date: "Hoy, 9:58", body: [
        "Acabo de probar el WebSocket de notificaciones contra Stalwart y el push llega en ~780ms de extremo a extremo. Comparado con el polling IMAP de 15 minutos esto es otro mundo.",
        "Adjunto la traza de la sesión. El único pendiente es el reintento con backoff cuando el socket se cae — abrí el issue #412.",
        "Marcus" ], attachments: [{ name: "jmap-push-trace.har", size: "248 KB", type: "har" }] },
    ],
  },
  {
    id: "t3", folder: "inbox", from: _people.github, category: "updates",
    subject: "[bifrost/webmail] #412 Reintento con backoff en WebSocket JMAP",
    snippet: "marcus-h abrió un issue: el socket de push no reintenta tras una desconexión…",
    date: "9:59", ts: 3, unread: true, starred: false, labels: ["infra"], attachments: [],
    messages: [
      { from: _people.github, to: "elena.ruiz@bifrost.io", date: "Hoy, 9:59", body: [
        "marcus-h abrió el issue #412 en bifrost/webmail",
        "El socket de push JMAP no reintenta tras una desconexión de red. Propongo backoff exponencial con jitter, máx. 30s. Etiquetas: bug, jmap, priority:high.",
        "Ver en GitHub →" ] },
    ],
  },
  {
    id: "t4", folder: "inbox", from: _people.priya, category: "primary",
    subject: "Compatibilidad Dovecot QRESYNC — informe de pruebas",
    snippet: "Probamos imapflow con qresync habilitado contra Dovecot 2.3 y la re-sincronización…",
    date: "Ayer", ts: 4, unread: false, starred: true, labels: ["work"], attachments: [{ name: "qresync-report.pdf", size: "1.2 MB", type: "pdf" }],
    messages: [
      { from: _people.priya, to: "elena.ruiz@bifrost.io", date: "Ayer, 14:03", body: [
        "Hola Elena,",
        "Probamos imapflow con QRESYNC habilitado contra Dovecot 2.3 y la re-sincronización de un buzón de 40.000 mensajes baja de 11s a 1.4s. El informe completo está adjunto.",
        "Recomendamos activarlo por defecto para servidores que anuncien la capacidad. Para Exchange lo dejamos desactivado por los problemas conocidos de CONDSTORE.",
        "Saludos, Priya" ] },
    ],
  },
  {
    id: "t5", folder: "inbox", from: _people.billing, category: "updates",
    subject: "Tu recibo de MongoDB Atlas — junio 2026",
    snippet: "Gracias por tu pago. Recibo #A4F2-9931 por $284.00 del clúster M30…",
    date: "Lun", ts: 5, unread: false, starred: false, labels: ["finance"], attachments: [{ name: "recibo-junio.pdf", size: "86 KB", type: "pdf" }],
    messages: [
      { from: _people.billing, to: "elena.ruiz@bifrost.io", date: "Lunes, 08:00", body: [
        "Gracias por tu pago.",
        "Recibo #A4F2-9931 · $284.00 · Clúster MongoDB Atlas M30 (búsqueda Atlas Search incluida).",
        "El siguiente cargo será el 1 de julio de 2026." ] },
    ],
  },
  {
    id: "t6", folder: "inbox", from: _people.newsletter, category: "promotions",
    subject: "JMAP Weekly #88 — RFC 8620 en producción",
    snippet: "Esta semana: tres proveedores anuncian soporte JMAP nativo, y por qué el push…",
    date: "Dom", ts: 6, unread: false, starred: false, labels: [], attachments: [],
    messages: [
      { from: _people.newsletter, to: "elena.ruiz@bifrost.io", date: "Domingo, 11:00", body: [
        "JMAP Weekly #88",
        "Esta semana: tres proveedores anuncian soporte JMAP nativo, un análisis del ahorro de ancho de banda (80-90% frente a IMAP) y una guía para migrar clientes legacy.",
        "Leer la edición completa →" ] },
    ],
  },
  {
    id: "t7", folder: "inbox", from: _people.dana, category: "primary",
    subject: "Threading JWZ — caso límite con References rotas",
    snippet: "Encontré un hilo donde el algoritmo JWZ agrupa mal porque el header References…",
    date: "Vie", ts: 7, unread: false, starred: false, labels: ["work"], attachments: [],
    messages: [
      { from: _people.dana, to: "elena.ruiz@bifrost.io", date: "Viernes, 16:30", body: [
        "Encontré un hilo donde el algoritmo JWZ agrupa mal porque el header References viene truncado por un MTA intermedio. ¿Hacemos fallback a subject normalizado?",
        "Tengo un caso de prueba reproducible. Dana" ] },
    ],
  },
  // Sent
  {
    id: "s1", folder: "sent", from: WM_ACCOUNTS[0], to: _people.marcus, category: "primary",
    subject: "Re: Migración a JMAP — push bajo 1s funcionando 🎉",
    snippet: "Excelente trabajo Marcus. Mergea el fix de backoff y lo revisamos en la demo del viernes.",
    date: "10:05", ts: 8, unread: false, starred: false, labels: ["work"], attachments: [],
    messages: [
      { from: WM_ACCOUNTS[0], to: "marcus@stalwart.dev", date: "Hoy, 10:05", body: [
        "Excelente trabajo Marcus. Mergea el fix de backoff cuando pase CI y lo revisamos en la demo del viernes.",
        "Elena" ] },
    ],
  },
  // Spam
  {
    id: "sp1", folder: "spam", from: { name: "Premios Globales", email: "win@l0ttery-prize.ru", color: "#dc2626", initials: "!" }, category: "primary",
    subject: "¡¡FELICIDADES!! Has sido seleccionado 🤑",
    snippet: "Reclama tu premio de 1.000.000 € haciendo clic en este enlace seguro...",
    date: "Jue", ts: 9, unread: true, starred: false, labels: [], spam: true, attachments: [],
    messages: [
      { from: { name: "Premios Globales", email: "win@l0ttery-prize.ru" }, to: "elena.ruiz@bifrost.io", date: "Jueves", body: [
        "Este mensaje fue marcado como spam por el filtro de Bifrost (puntuación 9.8/10). Los enlaces y las imágenes están bloqueados." ] },
    ],
  },
];

const WM_DRAFTS = [
  { id: "d1", folder: "drafts", from: WM_ACCOUNTS[0], to: "priya@dovecot.org", subject: "Re: Compatibilidad Dovecot QRESYNC", snippet: "Gracias Priya, activémoslo por defecto. Solo una duda sobre…", date: "11:20", ts: 10, unread: false, starred: false, labels: ["work"], messages: [{ from: WM_ACCOUNTS[0], to: "priya@dovecot.org", date: "Borrador", body: ["Gracias Priya, activémoslo por defecto. Solo una duda sobre el comportamiento con Exchange…"] }] },
  { id: "d2", folder: "drafts", from: WM_ACCOUNTS[0], to: "", subject: "(sin asunto)", snippet: "Notas para la retro del sprint…", date: "Ayer", ts: 11, unread: false, starred: false, labels: [], messages: [{ from: WM_ACCOUNTS[0], to: "", date: "Borrador", body: ["Notas para la retro del sprint…"] }] },
];

// Calendar — week events. day: 0=Mon..6=Sun, start/end in hours (24h)
const WM_EVENTS = [
  { id: "e1", title: "Daily standup", day: 0, start: 9, end: 9.5, color: "#1b66ff", cal: "Trabajo" },
  { id: "e2", title: "Demo JMAP push → Stalwart", day: 4, start: 11, end: 12, color: "#9333ea", cal: "Trabajo" },
  { id: "e3", title: "1:1 con Marcus", day: 1, start: 14, end: 14.5, color: "#0891b2", cal: "Trabajo" },
  { id: "e4", title: "Revisión de seguridad Q2", day: 2, start: 10, end: 11.5, color: "#dc2626", cal: "Trabajo" },
  { id: "e5", title: "Almuerzo equipo", day: 2, start: 13, end: 14, color: "#16a34a", cal: "Personal" },
  { id: "e6", title: "Retro de sprint", day: 4, start: 16, end: 17, color: "#1b66ff", cal: "Trabajo" },
  { id: "e7", title: "Gimnasio", day: 0, start: 18, end: 19, color: "#ea580c", cal: "Personal" },
  { id: "e8", title: "Planning Fase 3", day: 3, start: 10, end: 11, color: "#9333ea", cal: "Trabajo" },
];

const WM_CONTACTS = [
  _people.marcus, _people.priya, _people.dana, _people.ana,
  { name: "Equipo Webmail", email: "team@bifrost.io", color: "#1b66ff", initials: "EW" },
];

Object.assign(window, { WM_ACCOUNTS, WM_FOLDERS, WM_LABELS, WM_THREADS, WM_DRAFTS, WM_EVENTS, WM_CONTACTS });
