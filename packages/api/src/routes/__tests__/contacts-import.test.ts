import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  resetState,
  buildTestApp,
  authHeaders,
  seedUserWithAccount,
} from '../../../test/integration-helper.js';
import type { FastifyInstance } from 'fastify';
import { Contact } from '../../models/Contact.js';
import { User } from '../../models/User.js';

describe('contactos: import + perfil displayName', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    await setupTestDb();
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetState();
  });

  it('POST /contacts/import (vCard): crea, dedup por email, campos ricos', async () => {
    const { user } = await seedUserWithAccount({ email: 'me@test.com' });
    const headers = authHeaders(app, user._id.toString());
    // Ana ya existe → no debe duplicarse.
    await Contact.create({
      userId: user._id,
      fullName: 'Ana',
      sortName: 'ana',
      email: 'ana@x.com',
      isFrequent: false,
      usageCount: 0,
      source: 'local',
    });
    const vcf = [
      'BEGIN:VCARD\nFN:Ana Nueva\nEMAIL:ana@x.com\nEND:VCARD', // dup por email → skip
      'BEGIN:VCARD\nFN:Beto\nEMAIL;TYPE=WORK:beto@x.com\nTEL;TYPE=CELL:+569\nORG:Acme\nTITLE:Dev\nNOTE:hola\nEND:VCARD',
      'BEGIN:VCARD\nFN:SinMail\nEND:VCARD', // sin email → no importable
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts/import',
      headers,
      payload: { content: vcf },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 3, imported: 1, skipped: 2 });

    const beto = await Contact.findOne({ userId: user._id, email: 'beto@x.com' }).lean();
    expect(beto?.fullName).toBe('Beto');
    expect(beto?.source).toBe('imported');
    expect(beto?.emails?.[0]).toMatchObject({ label: 'Trabajo', address: 'beto@x.com' });
    expect(beto?.phones?.[0]).toMatchObject({ number: '+569' });
    expect(beto?.organization).toBe('Acme');
    expect(beto?.jobTitle).toBe('Dev');
    // Ana no se duplicó.
    expect(await Contact.countDocuments({ userId: user._id, email: 'ana@x.com' })).toBe(1);
  });

  it('POST /contacts/import (CSV Google): mapea headers', async () => {
    const { user } = await seedUserWithAccount({ email: 'me2@test.com' });
    const headers = authHeaders(app, user._id.toString());
    const csv =
      'Name,E-mail 1 - Value,Phone 1 - Value,Organization 1 - Name\n' +
      'Carla Ruiz,CARLA@X.COM,+56111,Globex';
    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts/import',
      headers,
      payload: { content: csv },
    });
    expect(res.json()).toMatchObject({ imported: 1 });
    const carla = await Contact.findOne({ userId: user._id, email: 'carla@x.com' }).lean();
    expect(carla?.fullName).toBe('Carla Ruiz');
    expect(carla?.organization).toBe('Globex');
  });

  it('PATCH /auth/me/profile actualiza el displayName (y nunca lo vacía)', async () => {
    const { user } = await seedUserWithAccount({ email: 'me3@test.com' });
    const headers = authHeaders(app, user._id.toString());
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/profile',
      headers,
      payload: { displayName: '  Nuevo Nombre  ' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().displayName).toBe('Nuevo Nombre'); // trim
    expect((await User.findById(user._id))?.displayName).toBe('Nuevo Nombre');

    // vacío → no lo pisa (required): se conserva el anterior.
    await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/profile',
      headers,
      payload: { displayName: '   ' },
    });
    expect((await User.findById(user._id))?.displayName).toBe('Nuevo Nombre');
  });
});
