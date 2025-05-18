import type { TypedJSONRPCClient, TypedJSONRPCServer } from 'json-rpc-2.0';

export type Config = Record<string, string | number>

export type Resolution = { width: number, height: number, label: string }

export type Methods = {
  test(message: string): void;
  blink(params: { pin: string }): void;
  getStatus(): string;
  startVideo(): { status: string, config: Config };
  stopVideo(): { status: string };
  getVideoStatus(): { status: string, config: Config };
  updateVideoConfig(config: Config): { status: string, config: Config };
  getAvailableResolutions(): Resolution[];
}

export type RPCCLient = TypedJSONRPCClient<Methods>;
export type RPCServer = TypedJSONRPCServer<Methods>;
