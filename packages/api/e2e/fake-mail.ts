/**
 * Fakes IMAP/SMTP en-proceso para el E2E full-stack (TD-E2E).
 *
 * No tocan red: sirven un buzón determinista desde memoria. Se inyectan a través del seam
 * `services/mail-transport` (setImapClientFactory / setSmtpTransportFactory) ANTES de
 * construir la app, de modo que la API real corre como un proceso normal contra Mongo
 * (memory-server) + Redis (mock) + este transporte falso. Implementa sólo el subconjunto
 * de la superficie de imapflow/nodemailer que ejercita el flujo login → leer → enviar.
 */

interface Addr {
  address: string;
  name?: string;
}

interface FakeMessage {
  uid: number;
  flags: Set<string>;
  size: number;
  internalDate: Date;
  envelope: {
    date: Date;
    subject: string;
    messageId: string;
    from: Addr[];
    replyTo?: Addr[];
    to: Addr[];
    cc?: Addr[];
    inReplyTo?: string;
  };
  bodyStructure: { childNodes?: { disposition?: string; type?: string }[] };
  source: Buffer;
}

function rfc822(opts: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  html: string;
}): Buffer {
  return Buffer.from(
    [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `Message-ID: ${opts.messageId}`,
      `Date: Wed, 25 Jun 2026 10:00:00 +0000`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      opts.html,
      ``,
    ].join('\r\n'),
    'utf-8'
  );
}

// Buzón INBOX compartido entre TODAS las conexiones fake (withClient construye un cliente
// por llamada, así que el estado no puede vivir en la instancia).
const INBOX: FakeMessage[] = [
  {
    uid: 1,
    flags: new Set<string>(),
    size: 512,
    internalDate: new Date('2026-06-25T10:00:00Z'),
    envelope: {
      date: new Date('2026-06-25T10:00:00Z'),
      subject: 'Welcome to Webmail 6.0',
      messageId: '<seed-1@example.com>',
      from: [{ address: 'alice@example.com', name: 'Alice Example' }],
      // Header Reply-To (como una lista de correo): las respuestas deben ir aquí, no a Alice.
      replyTo: [{ address: 'list@example.com', name: 'Webmail List' }],
      to: [{ address: 'e2e@example.com' }],
    },
    bodyStructure: {},
    source: rfc822({
      from: 'Alice Example <alice@example.com>',
      to: 'e2e@example.com',
      subject: 'Welcome to Webmail 6.0',
      messageId: '<seed-1@example.com>',
      html: '<p>Hello from the <b>E2E</b> mailbox.</p>',
    }),
  },
  {
    uid: 2,
    flags: new Set<string>(['\\Seen']),
    size: 480,
    internalDate: new Date('2026-06-24T09:00:00Z'),
    envelope: {
      date: new Date('2026-06-24T09:00:00Z'),
      subject: 'Your June invoice',
      messageId: '<seed-2@example.com>',
      from: [{ address: 'billing@example.com', name: 'Billing' }],
      // Multi-destinatario para ejercitar reply-all (CC = to+cc menos self y remitente).
      to: [{ address: 'e2e@example.com' }, { address: 'colleague@example.com', name: 'Colleague' }],
      cc: [{ address: 'boss@example.com' }],
    },
    bodyStructure: {},
    source: rfc822({
      from: 'Billing <billing@example.com>',
      to: 'e2e@example.com',
      subject: 'Your June invoice',
      messageId: '<seed-2@example.com>',
      html: '<p>Total due: <b>$42.00</b></p>',
    }),
  },
];

const FOLDERS = [
  {
    path: 'INBOX',
    name: 'INBOX',
    delimiter: '/',
    parentPath: '',
    flags: new Set<string>(),
    specialUse: '\\Inbox',
    subscribed: true,
    listed: true,
  },
  {
    path: 'Sent',
    name: 'Sent',
    delimiter: '/',
    parentPath: '',
    flags: new Set<string>(),
    specialUse: '\\Sent',
    subscribed: true,
    listed: true,
  },
];

function messagesFor(path: string): FakeMessage[] {
  return path === 'INBOX' ? INBOX : [];
}

/** Replica la semántica de un sequence-set IMAP por UID: `1:*` = todos; lista = esos UID. */
function parseRange(range: string, msgs: FakeMessage[]): FakeMessage[] {
  if (range.includes('*') || range.includes(':')) return msgs;
  const uids = new Set(
    range
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => !Number.isNaN(n))
  );
  return msgs.filter((m) => uids.has(m.uid));
}

export class FakeImapClient {
  mailbox: { path: string; uidValidity: number; uidNext: number } | false = false;

  connect(): Promise<void> {
    return Promise.resolve();
  }
  logout(): Promise<void> {
    return Promise.resolve();
  }

  list() {
    return Promise.resolve(FOLDERS.map((f) => ({ ...f, flags: new Set(f.flags) })));
  }

  getMailboxLock(path: string) {
    const msgs = messagesFor(path);
    const maxUid = msgs.reduce((m, x) => Math.max(m, x.uid), 0);
    this.mailbox = { path, uidValidity: 1, uidNext: maxUid + 1 };
    return Promise.resolve({
      release: () => {
        this.mailbox = false;
      },
    });
  }

  async *fetch(range: string, query: Record<string, unknown>) {
    const path = this.mailbox ? this.mailbox.path : 'INBOX';
    for (const m of parseRange(range, messagesFor(path))) {
      const out: Record<string, unknown> = { uid: m.uid, flags: new Set(m.flags) };
      if (query.size) out.size = m.size;
      if (query.internalDate) out.internalDate = m.internalDate;
      if (query.envelope) out.envelope = m.envelope;
      if (query.bodyStructure) out.bodyStructure = m.bodyStructure;
      yield out;
    }
  }

  fetchOne(uid: number, query: Record<string, unknown>) {
    const path = this.mailbox ? this.mailbox.path : 'INBOX';
    const m = messagesFor(path).find((x) => x.uid === uid);
    if (!m) return Promise.resolve(false);
    const out: Record<string, unknown> = { uid: m.uid };
    if (query.source) out.source = m.source;
    return Promise.resolve(out);
  }

  append(_path: string, raw: Buffer, flags?: string[]) {
    appendedToSent.push({ raw, flags: flags ?? [] });
    return Promise.resolve({ uid: 0 });
  }

  messageFlagsAdd() {
    return Promise.resolve(true);
  }
  messageFlagsRemove() {
    return Promise.resolve(true);
  }
  messageMove() {
    return Promise.resolve({ uidMap: new Map() });
  }
}

/** Registro de mensajes APPENDeados a Sent (copia tras envío). */
export const appendedToSent: { raw: Buffer; flags: string[] }[] = [];

export interface FakeSentMail {
  messageId: string;
  envelope: unknown;
  raw: string;
}
/** Registro de envíos SMTP (lo consume el aserto del E2E si hiciera falta). */
export const sentMails: FakeSentMail[] = [];

export class FakeSmtpTransport {
  sendMail(opts: { envelope?: unknown; raw?: Buffer | string }) {
    const messageId = '<e2e-sent@example.com>';
    sentMails.push({ messageId, envelope: opts.envelope, raw: opts.raw?.toString() ?? '' });
    return Promise.resolve({ messageId, accepted: [], rejected: [], response: '250 OK' });
  }
  close() {}
}
