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
import { basename, join } from 'node:path';
import { DEFAULT_DRAIN_GRACE_SECONDS, revHome, stateDir } from './config.js';
import { processObservation } from './sentinels.js';

export const LAUNCHD_EXIT_TIMEOUT_SECONDS = 60;

// The service identity follows the Rev home (H-2210). It used to be the
// constant 'dev.rev', and the label is also the plist filename and the
// bootout/kickstart address — so two fleets under one login fought over one
// job and one file, and the second install silently replaced the first. The
// default home still yields 'dev.rev', so an existing install is untouched;
// ~/.rev-gp yields 'dev.rev.gp'. REV_LABEL overrides it outright, which is the
// escape when two homes share a basename.
export function serviceLabel(): string {
  const explicit = process.env['REV_LABEL']?.trim();
  if (explicit) return explicit;
  const suffix = basename(revHome())
    .replace(/^\.?rev(?=[-_.]|$)/, '')
    .replace(/^[-_.]+/, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return suffix ? `dev.rev.${suffix}` : 'dev.rev';
}

// systemd unit names are not reverse-DNS, so the launchd label is the single
// source and this is its unit spelling: dev.rev -> rev, dev.rev.gp -> rev-gp.
export function systemdUnitName(): string {
  return serviceLabel().replace(/^dev\./, '').replace(/\./g, '-');
}

const xml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export function launchdPlist(
  node: string,
  cli: string,
  opts: { label: string; home: string; path: string; logPath: string },
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(opts.label)}</string>
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
  <!-- launchd clamps ExitTimeOut at 60 seconds (H-877). This buys the largest
       available window for loop drivers to finish; detached agent sessions
       remain the protection when a bootout becomes a hard stop. Use rev stop
       for a graceful drain that may outlast this service-manager ceiling. -->
  <key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>
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
# Stop the supervisor, not the whole cgroup (H-467). Under the default
# KillMode=control-group systemd SIGTERMs every process in the unit, including
# the agent session mid-turn; the supervisor's own drain is what should end a
# loop, and it needs longer than the 90s default to do it.
KillMode=mixed
TimeoutStopSec=${DEFAULT_DRAIN_GRACE_SECONDS + 60}
Environment=PATH=${opts.path}
Environment=REV_HOME=${opts.home}

[Install]
WantedBy=default.target
`;
}

export function serviceFile(): { kind: 'launchd' | 'systemd'; file: string } {
  return process.platform === 'darwin'
    ? { kind: 'launchd', file: join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel()}.plist`) }
    : { kind: 'systemd', file: join(homedir(), '.config', 'systemd', 'user', `${systemdUnitName()}.service`) };
}

function launchctl(...args: string[]): void {
  execFileSync('launchctl', args, { stdio: 'inherit' });
}

function systemctl(...args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
}

export function installLaunchd(file: string, plist: string, domain: string, label: string, run = launchctl): void {
  writeFileSync(file, plist);
  try {
    run('bootout', `${domain}/${label}`);
  } catch {
    /* not loaded is fine */
  }
  run('bootstrap', domain, file);
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
    const domain = `gui/${process.getuid!()}`;
    const label = serviceLabel();
    installLaunchd(file, launchdPlist(node, cli, { label, home, path, logPath }), domain, label);
    console.log(`Installed and started: ${file}\nAny running supervisor was stopped and restarted; launchd allows its loop drivers 60 seconds to exit, while detached agent sessions continue to completion.\nThe supervisor now survives reboots. Logs: ${logPath}`);
  } else {
    const unit = systemdUnitName();
    writeFileSync(file, systemdUnit(node, cli, { home, path }));
    systemctl('daemon-reload');
    systemctl('enable', '--now', unit);
    console.log(`Installed and started: ${file} (systemd user unit '${unit}').`);
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
      launchctl('bootout', `gui/${process.getuid!()}/${serviceLabel()}`);
    } catch {
      /* not loaded is fine — still remove the file */
    }
  } else {
    try {
      systemctl('disable', '--now', systemdUnitName());
    } catch {
      /* not enabled is fine */
    }
  }
  rmSync(file);
  console.log(`Uninstalled: ${file}`);
}

export function serviceStart(): void {
  const { kind } = serviceFile();
  if (kind === 'launchd') launchctl('kickstart', `gui/${process.getuid!()}/${serviceLabel()}`);
  else systemctl('start', systemdUnitName());
  console.log('Supervisor start requested — check: rev status');
}

export function serviceStatusLine(): string {
  const { file } = serviceFile();
  const supervisor = processObservation('supervisor');
  return `service file: ${existsSync(file) ? file : `not installed (${file})`}\nsupervisor:   ${supervisor.state === 'unknown' ? `unobservable (recorded pid ${supervisor.pid})` : supervisor.pid ? `running (pid ${supervisor.pid})` : 'down'}`;
}
