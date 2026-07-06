import { describe, it, expect } from 'vitest';
import {
  parseVCards,
  parseCsv,
  parseContacts,
  detectImportFormat,
  parseCsvRows,
} from '../contact-import.js';

describe('detectImportFormat', () => {
  it('vCard por BEGIN:VCARD; CSV en otro caso', () => {
    expect(detectImportFormat('BEGIN:VCARD\nEND:VCARD')).toBe('vcard');
    expect(detectImportFormat('Name,Email\nAna,a@x.com')).toBe('csv');
  });
});

describe('parseVCards', () => {
  it('parsea FN, varios EMAIL con TYPE, TEL, ORG, TITLE, NOTE', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Ana Pérez',
      'N:Pérez;Ana;;;',
      'EMAIL;TYPE=WORK:ana@work.com',
      'EMAIL;TYPE=HOME:ana@home.com',
      'TEL;TYPE=CELL:+56 9 1234 5678',
      'ORG:Acme;Ventas',
      'TITLE:Gerenta',
      'NOTE:Contacto clave',
      'END:VCARD',
    ].join('\n');
    const [c] = parseVCards(vcf);
    expect(c.fullName).toBe('Ana Pérez');
    expect(c.email).toBe('ana@work.com');
    expect(c.emails).toEqual([
      { label: 'Trabajo', address: 'ana@work.com' },
      { label: 'Personal', address: 'ana@home.com' },
    ]);
    expect(c.phones).toEqual([{ label: 'Móvil', number: '+56 9 1234 5678' }]);
    expect(c.organization).toBe('Acme');
    expect(c.jobTitle).toBe('Gerenta');
    expect(c.notes).toBe('Contacto clave');
  });

  it('usa N cuando no hay FN (Nombre Apellido)', () => {
    const [c] = parseVCards('BEGIN:VCARD\nN:Soto;Juan;;;\nEMAIL:juan@x.com\nEND:VCARD');
    expect(c.fullName).toBe('Juan Soto');
  });

  it('varios VCARD en un archivo; ignora bloques sin nada útil', () => {
    const vcf =
      'BEGIN:VCARD\nFN:A\nEMAIL:a@x.com\nEND:VCARD\n' +
      'BEGIN:VCARD\nVERSION:3.0\nEND:VCARD\n' + // vacío → se ignora
      'BEGIN:VCARD\nFN:B\nEMAIL:b@x.com\nEND:VCARD';
    const cs = parseVCards(vcf);
    expect(cs.map((c) => c.email)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('des-escapa \\n y \\, y maneja line-folding', () => {
    const vcf = 'BEGIN:VCARD\nFN:C\nEMAIL:c@x.com\nNOTE:linea1\\nlinea2 con\\, coma\nEND:VCARD';
    const [c] = parseVCards(vcf);
    expect(c.notes).toBe('linea1\nlinea2 con, coma');
    // folding: una línea partida que continúa con espacio
    const folded = 'BEGIN:VCARD\nFN:Nombre \n Largo\nEMAIL:d@x.com\nEND:VCARD';
    expect(parseVCards(folded)[0].fullName).toBe('Nombre Largo');
  });
});

describe('parseCsvRows', () => {
  it('respeta comillas con comas y saltos internos', () => {
    const rows = parseCsvRows('a,"b,c","d\ne"\n1,2,3');
    expect(rows[0]).toEqual(['a', 'b,c', 'd\ne']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });
});

describe('parseCsv', () => {
  it('mapea headers estilo Google Contacts', () => {
    const csv = [
      'Name,Given Name,Family Name,E-mail 1 - Value,Phone 1 - Value,Organization 1 - Name,Organization 1 - Title',
      'Ana Pérez,Ana,Pérez,ANA@X.COM,+569123,Acme,Gerenta',
      ',Juan,Soto,juan@x.com,,,',
    ].join('\n');
    const cs = parseCsv(csv);
    expect(cs[0].fullName).toBe('Ana Pérez');
    expect(cs[0].email).toBe('ana@x.com'); // normalizado a minúsculas
    expect(cs[0].phones[0].number).toBe('+569123');
    expect(cs[0].organization).toBe('Acme');
    expect(cs[0].jobTitle).toBe('Gerenta');
    // fila sin "Name" → arma nombre desde Given+Family
    expect(cs[1].fullName).toBe('Juan Soto');
  });

  it('ignora filas sin email ni nombre', () => {
    expect(parseCsv('Name,Email\n,,\nAna,a@x.com').map((c) => c.email)).toEqual(['a@x.com']);
  });
});

describe('parseContacts (auto)', () => {
  it('enruta por formato detectado', () => {
    expect(parseContacts('BEGIN:VCARD\nFN:A\nEMAIL:a@x.com\nEND:VCARD')[0].email).toBe('a@x.com');
    expect(parseContacts('Name,Email\nA,a@x.com')[0].email).toBe('a@x.com');
  });
});
