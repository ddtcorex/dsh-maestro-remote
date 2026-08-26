import type { Context } from '@deepseek-ai/cordis';
export default {
  inject: ['webServer','connection'] as const,
  apply(ctx: Context) {
    ctx.effect(() => (ctx as any).connection.rpc.handle('/dsh-maestro-remote', async (req: any) => {
      if (req.endpoint === 'status') return { ok: true };
      return { error: 'unknown endpoint' };
    }));
  }
};
