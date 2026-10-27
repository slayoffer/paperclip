import { loadConfig, type Config } from "../config.js";
import { createHash } from "node:crypto";
import { createStorageProviderFromConfig } from "./provider-registry.js";
import { createStorageService } from "./service.js";
import type { StorageService } from "./types.js";

let cachedStorageService: StorageService | null = null;
let cachedSignature: string | null = null;

function signatureForConfig(config: Config): string {
  return JSON.stringify({
    provider: config.storageProvider,
    localDisk: config.storageLocalDiskBaseDir,
    s3Bucket: config.storageS3Bucket,
    s3Region: config.storageS3Region,
    s3Endpoint: config.storageS3Endpoint,
    s3Prefix: config.storageS3Prefix,
    s3ForcePathStyle: config.storageS3ForcePathStyle,
  });
}

export function createStorageServiceFromConfig(config: Config): StorageService {
  const service = createStorageService(createStorageProviderFromConfig(config));
  service.bindingId = createHash("sha256").update(signatureForConfig(config)).digest("hex");
  return service;
}

export function getStorageService(): StorageService {
  const config = loadConfig();
  const signature = signatureForConfig(config);
  if (!cachedStorageService || cachedSignature !== signature) {
    cachedStorageService = createStorageServiceFromConfig(config);
    cachedSignature = signature;
  }
  return cachedStorageService;
}

export type { StorageService, PutFileResult } from "./types.js";
