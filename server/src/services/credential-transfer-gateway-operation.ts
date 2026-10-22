import { credentialTransferOperationSchema, type CredentialTransferOperation } from "@paperclipai/shared";
import { ToolGatewayHttpError } from "./tool-gateway-errors.js";

export function validateTransferGatewayOperation(input: { companyId: string; issueId: string; agentId: string; userId: string;
  connectionId: string; grantId: string; operation: CredentialTransferOperation }) {
  const parsed = credentialTransferOperationSchema.safeParse(input.operation);
  if (!parsed.success || parsed.data.operation !== "r2_credential_transfer"
    || parsed.data.companyId !== input.companyId || parsed.data.issueId !== input.issueId
    || parsed.data.agentId !== input.agentId || parsed.data.userId !== input.userId
    || ![parsed.data.source, parsed.data.destination].some(binding =>
      binding.connectionId === input.connectionId && binding.grantId === input.grantId)) {
    throw new ToolGatewayHttpError(403, "The transfer operation does not match.", "transfer_operation_mismatch");
  }
  return parsed.data;
}
