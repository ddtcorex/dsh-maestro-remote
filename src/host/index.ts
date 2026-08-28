import type { Context } from '@deepseek-ai/cordis';

/** Loopback RPC channel for the remote plugin (single segment per assertChannel). */
export const RPC_CHANNEL = '/dsh-maestro-remote';

export default {
  inject: ['webServer', 'connection'] as const,
  apply(ctx: Context) {
    ctx.effect(() =>
      (ctx as any).connection.rpc.handle(
        RPC_CHANNEL,
        async (endpoint: string) => {
          if (endpoint === 'status') return { ok: true };
          return { error: `unknown endpoint: ${String(endpoint)}` };
        },
        // Required at runtime (rpc-host reads options.authority unconditionally).
        { authority: 'loopback' },
      )
    );
  },
};
