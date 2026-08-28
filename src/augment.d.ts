declare module '@deepseek-ai/dsh-host-webserver' {}
declare module '@deepseek-ai/dsh-client-ui-slots' {}
declare module '@deepseek-ai/dsh-client-ui-settings' {}
declare module '@deepseek-ai/dsh-client-connection' {
  export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: any }
  export type RpcErrorDetailsMap = { 'bad-request': { issues: any[] } }
}

import '@deepseek-ai/cordis'
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: { port: number; register: any }
    connection: { rpc: { handle: (channel: string, handler: any, opts?: any) => () => void; call: any } }
    logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void }
  }
}
