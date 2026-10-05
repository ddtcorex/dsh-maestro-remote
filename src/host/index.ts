import type { Context } from '@deepseek-ai/cordis';
import { createRpcHandler, type NotifierLike, RPC_CHANNEL } from './rpc.js';

export { RPC_CHANNEL };

/**
 * The tunnel, proxy and PIN endpoints.
 *
 * These nine used to be served by `dsh-maestro-review` on
 * `/dsh-maestro-review`, each delegating straight back to the `maestroTunnel`
 * service the sibling row provides. The stub that used to live here answered a
 * bare `{ ok: true }` with no `value` on a channel no client called; a client
 * reads `res.value`, so that shape answers every field with `undefined`.
 *
 * The tunnel service is read opportunistically rather than injected: declaring
 * it would force this row to wait for the sibling row, and `tunnel.ts` makes
 * the same decision deliberately for the same reason.
 */
export default {
  inject: ['webServer', 'connection'] as const,
  apply(ctx: Context) {
    ctx.effect(() => {
      const tunnel = (ctx as any).maestroTunnel;
      if (tunnel === undefined) {
        // No tunnel provider installed: register nothing rather than answer
        // endpoints that cannot work. A missing service disables the feature
        // and logs one line; it never throws and never blocks boot.
        (ctx as any).logger?.warn?.(
          'maestro-remote: no maestroTunnel service; the tunnel RPC is not registered',
        );
        return () => {};
      }
      const notifier = (ctx as any).get?.('maestroNotifier') as NotifierLike | undefined;
      const dispose = (ctx as any).connection.rpc.handle(
        RPC_CHANNEL,
        createRpcHandler({ tunnel, notifier, logger: (ctx as any).logger }),
      );
      return () => {
        try {
          dispose();
        } catch {
          // Teardown must never throw.
        }
      };
    });
  },
};