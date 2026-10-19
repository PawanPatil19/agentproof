/** Minimal, strict argument parser: unknown flags are errors, not silently ignored. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], spec: { values?: string[]; booleans?: string[] }): ParsedArgs {
  const values = new Set(spec.values ?? []);
  const booleans = new Set([...(spec.booleans ?? []), "help"]);
  const out: ParsedArgs = { positionals: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      out.positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (booleans.has(name)) out.flags[name] = true;
    else if (values.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      out.flags[name] = value;
    } else throw new UsageError(`unknown option --${name}`);
  }
  return out;
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}
