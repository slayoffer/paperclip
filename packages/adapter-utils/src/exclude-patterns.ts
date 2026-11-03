export function isRelativePathOrDescendant(relative: string, candidate: string): boolean {
  return relative === candidate || relative.startsWith(`${candidate}/`);
}

function pathContainsSegmentOrDescendant(relative: string, segment: string): boolean {
  return relative === segment ||
    relative.startsWith(`${segment}/`) ||
    relative.endsWith(`/${segment}`) ||
    relative.includes(`/${segment}/`);
}

export function parseExcludePattern(pattern: string): { scope: "segment" | "descendants" | "path"; value: string } {
  if (pattern.startsWith("*/") && pattern.endsWith("/*")) {
    return { scope: "segment", value: pattern.slice(2, -2) };
  }
  if (pattern.startsWith("*/")) {
    return { scope: "segment", value: pattern.slice(2) };
  }
  if (pattern.endsWith("/*")) {
    return { scope: "descendants", value: pattern.slice(0, -2) };
  }
  return { scope: "path", value: pattern };
}

export function excludePatternMatches(relative: string, pattern: string): boolean {
  const { scope, value } = parseExcludePattern(pattern);
  if (scope === "segment") return pathContainsSegmentOrDescendant(relative, value);
  if (scope === "descendants") return relative.startsWith(`${value}/`);
  return isRelativePathOrDescendant(relative, value);
}

export function shouldExcludePath(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => excludePatternMatches(relative, entry));
}
