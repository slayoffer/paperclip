import { PaperclipApiError } from "./client.js";

export type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function formatErrorResponse(error: unknown): McpTextResponse {
  const value = error instanceof PaperclipApiError
    ? {
        error: error.message,
        status: error.status,
        method: error.method,
        path: error.path,
        body: error.body,
      }
    : { error: error instanceof Error ? error.message : String(error) };
  return { ...formatTextResponse(value), isError: true };
}
