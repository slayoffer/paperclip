import type { DashboardSummary } from "@paperclipai/shared";
import type { CompanyFlowReport } from "@paperclipai/shared/types/company-flow";
import { api } from "./client";

export const dashboardApi = {
  flow: (companyId: string) => api.get<CompanyFlowReport>(`/companies/${companyId}/flow`),
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
};
