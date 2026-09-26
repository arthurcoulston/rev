import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { installLaunchd, launchdPlist, serviceLabel, systemdUnit, systemdUnitName } from '../src/service.js';

describe('service unit generation', () => {
  it('launchd: restarts on crash only — a graceful drain (exit 0) stays down', () => {
    const p = launchdPlist('/usr/local/bin/node', '/opt/rev/dist/cli.js', {
      label: 'dev.rev',
      home: '/Users/x/.rev',
      path: '/usr/local/bin:/usr/bin',
      logPath: '/Users/x/.rev/state/supervisor/launchd.log',
    });
    expect(p).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(p).toContain('<string>/opt/rev/dist/cli.js</string>');
    expect(p).toContain('<string>run</string>');
    expect(p).toContain('<key>Label</key><string>dev.rev</string>');
    expect(p).toContain('<key>REV_HOME</key><string>/Users/x/.rev</string>');
    expect(p).toContain('launchd.log');
    // H-877: launchd clamps larger values to 60 seconds. Bootout is the hard
    // path; detached sessions survive if their loop drivers are swept.
    expect(p).toContain('<key>ExitTimeOut</key><integer>60</integer>');
  });
  it('launchd: XML-escapes paths', () => {
    const p = launchdPlist('/node', '/a&b/cli.js', { label: 'dev.rev.a&b', home: '/h', path: '/p', logPath: '/l' });
    expect(p).toContain('/a&amp;b/cli.js');
    expect(p).toContain('<key>Label</key><string>dev.rev.a&amp;b</string>');
  });
  it('launchd: replaces a loaded service before bootstrapping the new plist', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-service-')), 'dev.rev.plist');
    const calls: string[][] = [];
    installLaunchd(file, '<plist>new</plist>', 'gui/501', 'dev.rev.gp', (...args) => calls.push(args));
    expect(readFileSync(file, 'utf8')).toBe('<plist>new</plist>');
    expect(calls).toEqual([
      ['bootout', 'gui/501/dev.rev.gp'],
      ['bootstrap', 'gui/501', file],
    ]);
  });
  it('launchd: installs when no service is loaded', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-service-')), 'dev.rev.plist');
    const calls: string[][] = [];
    installLaunchd(file, '<plist/>', 'gui/501', 'dev.rev', (...args) => {
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

// H-2210: the label is also the plist filename and the bootout/kickstart
// address, so a second fleet under the same login needs its own. The default
// home must keep 'dev.rev' — the personal install is already bootstrapped
// under that name, and its own plist exports REV_HOME=~/.rev back to it.
describe('service identity follows the Rev home', () => {
  const saved = { home: process.env['REV_HOME'], label: process.env['REV_LABEL'] };
  const set = (home?: string, label?: string) => {
    if (home === undefined) delete process.env['REV_HOME'];
    else process.env['REV_HOME'] = home;
    if (label === undefined) delete process.env['REV_LABEL'];
    else process.env['REV_LABEL'] = label;
  };
  afterEach(() => set(saved.home, saved.label));

  it('unset home and the default home both stay dev.rev', () => {
    set(undefined);
    expect(serviceLabel()).toBe('dev.rev');
    set(join(homedir(), '.rev'));
    expect(serviceLabel()).toBe('dev.rev');
  });
  it('a suffixed home gets a suffixed label', () => {
    set(join(homedir(), '.rev-gp'));
    expect(serviceLabel()).toBe('dev.rev.gp');
    expect(systemdUnitName()).toBe('rev-gp');
  });
  it('a home that is not a rev- name keeps its whole basename, sanitized', () => {
    set('/tmp/fleet two');
    expect(serviceLabel()).toBe('dev.rev.fleet-two');
    set('/tmp/revhome');
    expect(serviceLabel()).toBe('dev.rev.revhome');
  });
  it('REV_LABEL overrides the derivation, and the unit name follows it', () => {
    set(join(homedir(), '.rev-gp'), 'dev.rev.second');
    expect(serviceLabel()).toBe('dev.rev.second');
    expect(systemdUnitName()).toBe('rev-second');
  });
  it('the default unit name is plain rev', () => {
    set(undefined);
    expect(systemdUnitName()).toBe('rev');
  });
});
