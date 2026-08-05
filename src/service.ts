// Machine-restart resilience: the supervisor as a user-level service.
// macOS: LaunchAgent with KeepAlive on unsuccessful exit only — launchd
// restarts a crashed supervisor, but a graceful drain (exit 0) stays down
// until the operator starts the machine again. Linux: systemd user unit,
// Restart=on-failure, same semantics. The unit embeds the install-time PATH
// and REV_HOME because service managers give daemons a bare environment and
// the agent CLIs the shim spawns must still resolve.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { revHome, stateDir } from './config.js';
import { pidAlive } from './sentinels.js';

export const LABEL = 'dev.rev';

const xml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export function launchdPlist(node: string, cli: string, opts: { home: string; path: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(cli)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(opts.path)}</string>
    <key>REV_HOME</key><string>${xml(opts.home)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(opts.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(opts.logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(node: string, cli: string, opts: { home: string; path: string }): string {
  return `[Unit]
Description=Rev — keeps agent loops turning

[Service]
ExecStart=${node} ${cli} run
Restart=on-failure
RestartSec=10
Environment=PATH=${opts.path}
Environment=REV_HOME=${opts.home}

[Install]
WantedBy=default.target
`;
}

export function serviceFile(): { kind: 'launchd' | 'systemd'; file: string } {
  return process.platform === 'darwin'
    ? { kind: 'launchd', file: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`) }
    : { kind: 'systemd', file: join(homedir(), '.config', 'systemd', 'user', 'rev.service') };
}

function launchctl(...args: string[]): void {
  execFileSync('launchctl', args, { stdio: 'inherit' });
}

function systemctl(...args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
}

export function serviceInstall(): void {
  const { kind, file } = serviceFile();
  const node = process.execPath;
  const cli = process.argv[1]!;
  const home = revHome();
  const path = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  mkdirSync(join(file, '..'), { recursive: true });
  if (kind === 'launchd') {
    const logPath = join(stateDir('supervisor'), 'launchd.log');
    writeFileSync(file, launchdPlist(node, cli, { home, path, logPath }));
    launchctl('bootstrap', `gui/${process.getuid!()}`, file);
    console.log(`Installed and started: ${file}\nThe supervisor now survives reboots. Logs: ${logPath}`);
  } else {
    writeFileSync(file, systemdUnit(node, cli, { home, path }));
    systemctl('daemon-reload');
    systemctl('enable', '--now', 'rev');
    console.log(`Installed and started: ${file} (systemd user unit 'rev').`);
  }
  console.log('Stop the machine gracefully with: rev stop  (a drained supervisor stays down until started again)');
}

export function serviceUninstall(): void {
  const { kind, file } = serviceFile();
  if (!existsSync(file)) {
    console.log(`No service installed (${file} not found).`);
    return;
  }
  if (kind === 'launchd') {
    try {
      launchctl('bootout', `gui/${process.getuid!()}/${LABEL}`);
    } catch {
      /* not loaded is fine — still remove the file */
    }
  } else {
    try {
      systemctl('disable', '--now', 'rev');
    } catch {
      /* not enabled is fine */
    }
  }
  rmSync(file);
  console.log(`Uninstalled: ${file}`);
}

export function serviceStart(): void {
  const { kind } = serviceFile();
  if (kind === 'launchd') launchctl('kickstart', `gui/${process.getuid!()}/${LABEL}`);
  else systemctl('start', 'rev');
  console.log('Supervisor start requested — check: rev status');
}

export function serviceStatusLine(): string {
  const { file } = serviceFile();
  const pid = pidAlive('supervisor');
  return `service file: ${existsSync(file) ? file : `not installed (${file})`}\nsupervisor:   ${pid ? `running (pid ${pid})` : 'down'}`;
}
