export interface SnapshotArgsOptions {
  interactiveOnly?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
}

export function buildSnapshotArgs(opts: SnapshotArgsOptions): string[] {
  const args = ["snapshot"];
  if (opts.interactiveOnly) args.push("-i");
  if (opts.compact) args.push("-c");
  if (opts.depth != null) args.push("-d", String(opts.depth));
  if (opts.selector) args.push("-s", opts.selector);
  return args;
}

export interface FindArgsOptions {
  locator: string;
  value: string;
  action?: string;
  text?: string;
  name?: string;
  exact?: boolean;
}

export function buildFindArgs(params: FindArgsOptions): string[] {
  const args = ["find", params.locator, params.value];
  if (params.action) args.push(params.action);
  if (params.text !== undefined) args.push(params.text);
  if (params.name) args.push("--name", params.name);
  if (params.exact) args.push("--exact");
  return args;
}
