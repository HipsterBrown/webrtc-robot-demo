import type { TypedJSONRPCClient, TypedJSONRPCServer } from 'json-rpc-2.0';

export type Methods = {
  test(message: string): void;
  blink(params: { pin: string }): void;
  getStatus(): string;
}

export type RPCCLient = TypedJSONRPCClient<Methods>;
export type RPCServer = TypedJSONRPCServer<Methods>;
