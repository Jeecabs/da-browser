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
  json?: boolean;
}

export function buildFindArgs(params: FindArgsOptions): string[] {
  const args = ["find", params.locator, params.value];
  if (params.action) args.push(params.action);
  if (params.text !== undefined) args.push(params.text);
  if (params.name) args.push("--name", params.name);
  if (params.exact) args.push("--exact");
  if (params.json) args.push("--json");
  return args;
}

export type TabAction = "list" | "new" | "close" | "switch";

export interface TabArgsOptions {
  action: TabAction;
  url?: string;
  index?: number;
}

export function buildTabArgs(params: TabArgsOptions): string[] {
  const args = ["tab", params.action];
  switch (params.action) {
    case "list":
      if (params.url !== undefined || params.index !== undefined) {
        throw new Error("browser_tab list does not accept url or index.");
      }
      args.push("--json");
      return args;
    case "new":
      if (params.index !== undefined) {
        throw new Error("browser_tab new does not accept an index.");
      }
      if (params.url) args.push(params.url);
      return args;
    case "close":
      if (params.url !== undefined) {
        throw new Error("browser_tab close does not accept a url.");
      }
      if (params.index !== undefined) args.push(String(params.index));
      return args;
    case "switch":
      if (params.url !== undefined) {
        throw new Error("browser_tab switch does not accept a url.");
      }
      if (params.index === undefined) {
        throw new Error("browser_tab switch requires an index.");
      }
      args.push(String(params.index));
      return args;
    default: {
      const exhaustive: never = params.action;
      throw new Error(`Unknown browser_tab action: ${String(exhaustive)}`);
    }
  }
}

export type IsCheck = "visible" | "enabled" | "checked";

export interface IsArgsOptions {
  check: IsCheck;
  selector: string;
}

export function buildIsArgs(params: IsArgsOptions): string[] {
  if (!params.selector || !params.selector.trim()) {
    throw new Error("browser_is requires a selector.");
  }
  return ["is", params.check, params.selector, "--json"];
}

export type EmulateSetting = "viewport" | "device" | "geo" | "offline" | "media";

export interface EmulateArgsOptions {
  setting: EmulateSetting;
  width?: number;
  height?: number;
  device?: string;
  latitude?: number;
  longitude?: number;
  offline?: boolean;
  media?: "dark" | "light";
  reducedMotion?: boolean;
}

export function buildEmulateArgs(params: EmulateArgsOptions): string[] {
  const args = ["emulate", params.setting];
  switch (params.setting) {
    case "viewport":
      if (params.width === undefined || params.height === undefined) {
        throw new Error("browser_emulate viewport requires width and height.");
      }
      args.push(String(params.width), String(params.height));
      return args;
    case "device":
      if (!params.device) {
        throw new Error("browser_emulate device requires device name.");
      }
      args.push(params.device);
      return args;
    case "geo":
      if (params.latitude === undefined || params.longitude === undefined) {
        throw new Error("browser_emulate geo requires latitude and longitude.");
      }
      args.push(String(params.latitude), String(params.longitude));
      return args;
    case "offline":
      if (params.offline === undefined) {
        throw new Error("browser_emulate offline requires offline boolean.");
      }
      args.push(params.offline ? "true" : "false");
      return args;
    case "media":
      if (!params.media && params.reducedMotion === undefined) {
        throw new Error("browser_emulate media requires media (dark|light) or reducedMotion.");
      }
      if (params.media) args.push(params.media);
      if (params.reducedMotion !== undefined) {
        args.push("--reduced-motion", params.reducedMotion ? "reduce" : "no-preference");
      }
      return args;
    default: {
      const exhaustive: never = params.setting;
      throw new Error(`Unknown browser_emulate setting: ${String(exhaustive)}`);
    }
  }
}

export type CaptureAction = "start" | "stop";

export interface CaptureArgsOptions {
  action: CaptureAction;
  file?: string;
}

export function buildRecordArgs(params: CaptureArgsOptions): string[] {
  const args = ["record", params.action];
  if (params.action === "start" && params.file) args.push(params.file);
  if (params.action === "stop" && params.file !== undefined) {
    throw new Error("browser_record stop does not accept a file path.");
  }
  return args;
}

export function buildTraceArgs(params: CaptureArgsOptions): string[] {
  const args = ["trace", params.action];
  if (params.action === "start" && params.file) args.push(params.file);
  if (params.action === "stop" && params.file !== undefined) {
    throw new Error("browser_trace stop does not accept a file path.");
  }
  return args;
}
