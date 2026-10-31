export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";

export class WorkspaceValidationFailure extends Error {
  code = WORKSPACE_VALIDATION_FAILURE_CODE;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceValidationFailure";
    this.resultJson = resultJson;
  }
}
