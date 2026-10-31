const literal = value => `'${value.replaceAll("'", "''")}'`;

export function skillProbe({ workspace, run, overwrite, deletion, marker }) {
  // Windows PowerShell 5.1 requires a BOM for UTF-8 script source. These exact
  // approved bytes are snapshotted; the product never rewrites a user's script.
  return `\uFEFF$ErrorActionPreference='Stop'
$actualCwd=[IO.Directory]::GetCurrentDirectory(); $expectedCwd=${literal(workspace)}
if (-not [string]::Equals($actualCwd.TrimEnd('\\'),$expectedCwd.TrimEnd('\\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'SKILL_CWD_MISMATCH' }
Write-Output ('SKILL_PROCESS_CWD='+$actualCwd)
Write-Output 'CHINESE_STDOUT=星丛技能中文输出'
[Console]::Error.WriteLine('CHINESE_STDERR=星丛技能中文错误')
$w=${literal(run)}; $o=${literal(overwrite)}; $d=${literal(deletion)}; $m=${literal(marker)}
$f=[IO.Path]::Combine($w,'inside-'+[guid]::NewGuid().ToString('N')+'.txt')
[IO.File]::WriteAllText($f,'ONE'); [IO.File]::WriteAllText($f,'TWO')
if ([IO.File]::ReadAllText($f) -ne 'TWO') { throw 'INSIDE_CONTENT_FAIL' }
[IO.File]::Delete($f); if ([IO.File]::Exists($f)) { throw 'INSIDE_DELETE_FAIL' }
Write-Output 'INSIDE_CRUD=PASS'
try { [IO.File]::WriteAllText($o,'UNEXPECTED'); throw 'OUTSIDE_WRITE_UNEXPECTED_SUCCESS' } catch { if ($_.Exception.GetBaseException() -isnot [UnauthorizedAccessException]) { throw }; Write-Output 'OUTSIDE_WRITE=DENIED' }
try { [IO.File]::Delete($d); throw 'OUTSIDE_DELETE_UNEXPECTED_SUCCESS' } catch { if ($_.Exception.GetBaseException() -isnot [UnauthorizedAccessException]) { throw }; Write-Output 'OUTSIDE_DELETE=DENIED' }
try { [IO.File]::AppendAllText($PSCommandPath,'UNEXPECTED'); throw 'SNAPSHOT_WRITE_UNEXPECTED_SUCCESS' } catch { if ($_.Exception.GetBaseException() -isnot [UnauthorizedAccessException]) { throw }; Write-Output 'SNAPSHOT_WRITE=DENIED' }
Write-Output ('MARKER='+$m)
`;
}
