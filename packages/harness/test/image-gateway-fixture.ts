import { ImageGatewayError, parseAssetPrefix, resultUrlRefusal } from "../src/gateway/images";

/**
 * The scripted gateways' result URLs, shaped like production's: path-style on the regional S3 endpoint, under the
 * asset prefix, with SigV4 presigned query parameters (X-Amz-Credential carries encoded slashes). A fake bucket and
 * account: nothing real in this public repository. Every scripted download goes through the engine's own check.
 */
export const ASSET_PREFIX = "https://s3.example-region.amazonaws.com/example-bucket-000000000000/";
const PREFIXES = [parseAssetPrefix(ASSET_PREFIX)];

export function presignedUrl(job: string, i: number, type = "png"): string {
  const query = [
    "X-Amz-Algorithm=AWS4-HMAC-SHA256",
    "X-Amz-Credential=AKIAEXAMPLEEXAMPLE00%2F20261128%2Fexample-region%2Fs3%2Faws4_request",
    "X-Amz-Date=20261128T171547Z",
    "X-Amz-Expires=3600",
    "X-Amz-SignedHeaders=host",
    `response-content-type=image%2F${type}`,
    `X-Amz-Signature=${"0a".repeat(32)}`,
  ].join("&");
  return `${ASSET_PREFIX}generated/754/${job}/uuid_image_${i}.${type}?${query}`;
}

/** What the engine's download refuses before any fetch, thrown as it throws it. */
export function checkDownload(url: string): void {
  if (/^data:/i.test(url)) return;
  const why = resultUrlRefusal(url, PREFIXES);
  if (why) throw new ImageGatewayError(0, why, "asset_origin");
}
