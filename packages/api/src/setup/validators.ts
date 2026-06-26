import mongoose from 'mongoose';
import { Redis } from 'ioredis';

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export async function validateMongoDb(uri: string): Promise<ValidationResult> {
  let connection: typeof mongoose | undefined;
  try {
    connection = await mongoose.connect(uri);
    await connection.connection.db?.admin().ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'MongoDB connection failed' };
  } finally {
    await mongoose.disconnect();
  }
}

export async function validateRedis(url: string): Promise<ValidationResult> {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 5000,
  });
  try {
    await client.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Redis connection failed' };
  } finally {
    await client.quit();
  }
}
