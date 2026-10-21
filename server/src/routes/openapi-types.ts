import type { z } from "zod";

export type OpenApiResponse = Record<string, unknown>;
export type OpenApiPathRegistration = {
  method: string;
  path: string;
  request?: {
    params?: z.ZodTypeAny;
    query?: z.ZodTypeAny;
    body?: {
      content: Record<string, { schema: unknown }>;
      required?: boolean;
    };
  };
  responses?: Record<string, OpenApiResponse>;
  [key: string]: unknown;
};
