# Security

Rev launches agent processes, passes them a deliberately bounded environment,
and reads and writes machine-local state. A vulnerability that escapes those
boundaries, exposes credentials, executes unintended commands, or permits an
untrusted network writer is security-sensitive.

Please report vulnerabilities through GitHub's private vulnerability reporting
for this repository: choose **Report a vulnerability** on the repository's
Security tab. Do not open a public issue with exploit details. Reports receive
an acknowledgement through that private channel.
