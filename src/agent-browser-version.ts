export const MIN_AGENT_BROWSER_VERSION = "0.33.1";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export function extractAgentBrowserVersion(output: string): string | undefined {
  return output.match(/agent-browser\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i)?.[1];
}

export function supportsAgentBrowserVersion(
  installed: string,
  required = MIN_AGENT_BROWSER_VERSION,
): boolean {
  const current = parseVersion(installed);
  const minimum = parseVersion(required);
  if (!current || !minimum) return false;

  const order = coreVersionOrder(current) - coreVersionOrder(minimum);
  if (order !== 0) return order > 0;
  return supportsEqualCoreVersion(current, minimum);
}

function coreVersionOrder(version: ParsedVersion): number {
  return version.major * 1_000_000 + version.minor * 1_000 + version.patch;
}

function supportsEqualCoreVersion(current: ParsedVersion, minimum: ParsedVersion): boolean {
  if (!current.prerelease) return true;
  if (!minimum.prerelease) return false;
  return current.prerelease >= minimum.prerelease;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}
