process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'supersecretkeysupersecretkey123456';
process.env.MONGODB_URI = 'mongodb://localhost:27017/webmail_test';
process.env.REDIS_URL = 'mock';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.FRONTEND_URL = 'http://localhost:5173';
