/** Linux application-process receipt from a direct local health probe. */
export type RuntimeCap = Readonly<{
  schema: "paperclip.runtime-cap.v1";
  nonce: string;
  pid: number;
  startTicks: number;
  cap: number;
  immutable: true;
}>;
