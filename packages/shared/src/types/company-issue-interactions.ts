import type { IssueThreadInteraction, SuggestTasksPayload, AskUserQuestionsPayload, RequestConfirmationPayload, RequestCheckboxConfirmationPayload, RequestItemVerdictsPayload, ConnectionIntentPayload, SuggestTasksResult, AskUserQuestionsResult, RequestConfirmationResult, RequestCheckboxConfirmationResult, RequestItemVerdictsResult, ConnectionIntentResult } from "./issue.js";

export type CompanyIssueThreadInteraction = IssueThreadInteraction & {
  issueIdentifier: string | null;
};

export interface CompanyIssueThreadInteractionPage {
  items: CompanyIssueThreadInteraction[];
  nextCursor: string | null;
}


export type IssueThreadInteractionPayload =
  | SuggestTasksPayload
  | AskUserQuestionsPayload
  | RequestConfirmationPayload
  | RequestCheckboxConfirmationPayload
  | RequestItemVerdictsPayload
  | ConnectionIntentPayload;

export type IssueThreadInteractionResult =
  | SuggestTasksResult
  | AskUserQuestionsResult
  | RequestConfirmationResult
  | RequestCheckboxConfirmationResult
  | RequestItemVerdictsResult
  | ConnectionIntentResult;
