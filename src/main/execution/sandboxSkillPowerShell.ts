// Decode data-only UTF-16 literals. PowerShell treats typographic quotes as
// delimiters too; never place arbitrary filenames/argv inside source quotes.
const literal = (value: string) => `([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf16le').toString('base64')}')))`;

/** Fixed Windows PowerShell Skill only. Invokes the approved file, not its text. */
export function sandboxSkillPowerShellArgs(args: string[]): string[] {
  const fileIndex = args.indexOf('-File');
  if (fileIndex < 0 || !args[fileIndex + 1] || args.slice(0, fileIndex).some(arg => !['-NoLogo', '-NoProfile', '-NonInteractive'].includes(arg))) {
    throw new Error('SANDBOX_SKILL_POWERSHELL_ARGS_INVALID');
  }
  const argv = args.slice(fileIndex + 2), rendered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!/^[-\u2013\u2014\u2015]./.test(arg) || /^-\d+(\.\d+)?$/.test(arg)) { rendered.push(literal(arg)); continue; }
    const colon = arg.indexOf(':'), name = arg.slice(1, colon < 0 ? undefined : colon);
    // Only ordinary parameter tokens become syntax. All values are quoted;
    // unusual parameter names fail closed rather than becoming shell code.
    if (!/^[\p{L}_?][\p{L}\p{N}_?-]*$/u.test(name)) throw new Error('SANDBOX_SKILL_POWERSHELL_PARAMETER_UNSUPPORTED');
    if (colon < 0) rendered.push(`-${name}`);
    else {
      const value = colon === arg.length - 1 ? argv[++i] : arg.slice(colon + 1);
      if (value === undefined) throw new Error('SANDBOX_SKILL_POWERSHELL_ARGS_INVALID');
      rendered.push(`-${name}:${literal(value)}`);
    }
  }
  const bootstrap = [
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '$OutputEncoding=[Console]::OutputEncoding',
    "$ProgressPreference='SilentlyContinue'",
    // Invoke the actual file: authorization, param, PSCommandPath/PSScriptRoot
    // and streaming host output remain active. Never load its contents/eval.
    `try { & ${literal(args[fileIndex + 1])} ${rendered.join(' ')}; if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }; exit 0 } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`,
  ].join('; ');
  // Process-only policy; Group Policy retains precedence. No profile, registry,
  // ACL, persistent policy or Native fallback is touched by this startup.
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', bootstrap];
}
