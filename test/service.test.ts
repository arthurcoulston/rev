import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { installLaunchd, launchdPlist, systemdUnit } from '../src/service.js';

describe('service unit generation', () => {
  it('launchd: restarts on crash only — a graceful drain (exit 0) stays down', () => {
    const p = launchdPlist('/usr/local/bin/node', '/opt/rev/dist/cli.js', {
      home: '/Users/x/.rev',
      path: '/usr/local/bin:/usr/bin',
      logPath: '/Users/x/.rev/state/supervisor/launchd.log',
    });
    expect(p).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(p).toContain('<string>/opt/rev/dist/cli.js</string>');
    expect(p).toContain('<string>run</string>');
    expect(p).toContain('<key>REV_HOME</key><string>/Users/x/.rev</string>');
    expect(p).toContain('launchd.log');
    // H-877: launchd clamps larger values to 60 seconds. Bootout is the hard
    // path; detached sessions survive if their loop drivers are swept.
    expect(p).toContain('<key>ExitTimeOut</key><integer>60</integer>');
  });
  it('launchd: XML-escapes paths', () => {
    const p = launchdPlist('/node', '/a&b/cli.js', { home: '/h', path: '/p', logPath: '/l' });
    expect(p).toContain('/a&amp;b/cli.js');
  });
  it('launchd: replaces a loaded service before bootstrapping the new plist', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-service-')), 'dev.rev.plist');
    const calls: string[][] = [];
    installLaunchd(file, '<plist>new</plist>', 'gui/501', (...args) => calls.push(args));
    expect(readFileSync(file, 'utf8')).toBe('<plist>new</plist>');
    expect(calls).toEqual([
      ['bootout', 'gui/501/dev.rev'],
      ['bootstrap', 'gui/501', file],
    ]);
  });
  it('launchd: installs when no service is loaded', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-service-')), 'dev.rev.plist');
    const calls: string[][] = [];
    installLaunchd(file, '<plist/>', 'gui/501', (...args) => {
      calls.push(args);
      if (args[0] === 'bootout') throw new Error('not loaded');
    });
    expect(calls.at(-1)).toEqual(['bootstrap', 'gui/501', file]);
  });
  it('systemd: on-failure restart with the embedded environment', () => {
    const u = systemdUnit('/usr/bin/node', '/opt/rev/dist/cli.js', { home: '/home/x/.rev', path: '/usr/bin' });
    expect(u).toContain('ExecStart=/usr/bin/node /opt/rev/dist/cli.js run');
    expect(u).toContain('Restart=on-failure');
    expect(u).toContain('Environment=REV_HOME=/home/x/.rev');
    expect(u).toContain('WantedBy=default.target');
    // H-467: stop the supervisor, not every process in the cgroup, and give
    // its drain longer than systemd's 90s default to finish.
    expect(u).toContain('KillMode=mixed');
    expect(u).toContain('TimeoutStopSec=660');
  });
});
