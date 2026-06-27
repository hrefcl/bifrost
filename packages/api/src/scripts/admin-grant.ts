/**
 * Recuperación de admin (el "flag de reinstall" estilo WordPress): otorga rol admin a un
 * usuario por email. SÓLO desde el servidor (CLI) — nunca expuesto en la web. Uso:
 *
 *   pnpm --filter @webmail6/api admin:grant <email>
 *
 * Requiere MONGODB_URI en el entorno (igual que el boot del API).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../models/User.js';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Uso: admin:grant <email>');
    process.exit(2);
  }
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
    console.error(`Email con formato inválido: ${email}`);
    process.exit(2);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el entorno.');
    process.exit(2);
  }
  await mongoose.connect(uri);
  try {
    const res = await User.updateOne({ primaryEmail: email }, { $set: { role: 'admin' } });
    if (res.matchedCount === 0) {
      console.error(`No existe un usuario con email ${email} (¿logueó al menos una vez?).`);
      process.exit(1);
    }
    console.log(`✅ ${email} ahora es admin.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
