import type { LightIssue } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export function getLightIssue(id: string, options?: RequestOptions) {
  return api.get<LightIssue>(`/issues/${id}?view=light`, options);
}
