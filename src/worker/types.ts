import type { Env } from "../common";
import type { parseGatewayConfig } from "../config";

export type GatewayCfg = ReturnType<typeof parseGatewayConfig>;

export type RouteArgs = {
  request: Request;
  env: Env;
  url: URL;
  path: string;
  token: string;
  debug: boolean;
  reqId: string;
  startedAt: number;
  gatewayCfg: GatewayCfg;
};

