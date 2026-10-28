import type { FastifyInstance } from 'fastify';
import { connectDb, disconnectDb, pingDb, isConnected } from '../db/client.js';

export function registerAuthRoutes(app: FastifyInstance) {
  // Whether this server currently holds a working DB connection.
  app.get('/api/session', async () => {
    const connected = isConnected() ? await pingDb() : false;
    return { connected };
  });

  // Log in = open the DB connection with the supplied credentials.
  app.post('/api/login', async (req: any, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'Usuário e senha são obrigatórios.' });
    }
    try {
      await connectDb(String(username), String(password));
      return { connected: true };
    } catch (err: any) {
      app.log.error({ err: err?.message }, 'login/connect failed');
      const raw = String(err?.message ?? '');
      const auth = /access denied|ER_ACCESS_DENIED|authentication/i.test(raw);
      return reply.code(auth ? 401 : 503).send({
        error: auth
          ? 'Usuário ou senha inválidos.'
          : 'Não foi possível conectar ao banco de dados. Verifique a conexão.',
      });
    }
  });

  app.post('/api/logout', async () => {
    await disconnectDb();
    return { connected: false };
  });
}
