import { isSupportedNodeVersion } from "../packages/shared/src/node-version.ts";

export function isNode24ImageTag(tag) {
  const match = /^(24\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))-[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/.exec(tag);
  return match !== null && isSupportedNodeVersion(match[1]);
}
