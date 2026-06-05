import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export function hasAnySelectedTool(
  options: Pick<BuildSystemPromptOptions, "selectedTools"> | undefined,
  names: readonly string[],
): boolean {
  const selected = new Set(options?.selectedTools ?? []);
  return names.some((name) => selected.has(name));
}

interface PrepareArgumentsOptions {
  aliases?: Record<string, string>;
  booleanFields?: readonly string[];
  numberFields?: readonly string[];
}

export function prepareCompatArguments<T extends Record<string, unknown>>(
  args: unknown,
  options: PrepareArgumentsOptions,
): T {
  if (!args || typeof args !== "object") return args as T;

  const input = args as Record<string, unknown>;
  const next: Record<string, unknown> = { ...input };
  let changed = false;

  for (const [from, to] of Object.entries(options.aliases ?? {})) {
    if (next[to] === undefined && next[from] !== undefined) {
      next[to] = next[from];
      changed = true;
    }
  }

  for (const field of options.numberFields ?? []) {
    const value = next[field];
    if (typeof value !== "string") continue;
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      next[field] = parsed;
      changed = true;
    }
  }

  for (const field of options.booleanFields ?? []) {
    const value = next[field];
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      next[field] = true;
      changed = true;
    } else if (normalized === "false") {
      next[field] = false;
      changed = true;
    }
  }

  return (changed ? next : args) as T;
}
