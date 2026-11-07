export function isValidExistingBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.startsWith("."))
    return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock"))
    return false;
  if (
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.includes("/.")
  )
    return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(value)) return false;
  return true;
}
