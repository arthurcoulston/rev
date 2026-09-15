# Security

Rev launches agent processes, passes them a deliberately bounded environment,
and reads and writes machine-local state. Those sessions run with the agent
CLI's permission prompts and sandbox disabled, unattended, in the folder the
roster names — that is Rev's design and not a vulnerability; the README's
"What a loop session can do" states it plainly, and it is what an operator is
consenting to when they register a loop. A vulnerability that escapes the
bounds Rev does keep — the constitution, the loop's `cwd`, the MCP allowlist,
the stripped environment — or that exposes credentials, executes unintended
commands, or permits an untrusted network writer, is security-sensitive.

Please report vulnerabilities through GitHub's private vulnerability reporting
for this repository: choose **Report a vulnerability** on the repository's
Security tab. Do not open a public issue with exploit details. Reports receive
an acknowledgement through that private channel.
