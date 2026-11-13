# Security reference pack (options.referencePack)

The security reviewer cites one of these reference classes when raising a
finding whose claim is "this is a known vulnerability class". The citation
is the evidence discipline of the base contract applied to vulnerability
claims: name the class, name the source, name the code path.

## Vulnerability classes (CWE top cuts)

| Class | CWE | Look for |
|---|---|---|
| SQL / NoSQL injection | CWE-89 | string-concatenated queries, ORM raw-query escapes |
| OS command injection | CWE-78 | `exec`/`spawn`/shell interpolation of user input |
| Path traversal | CWE-22 | user-controlled segments joined into file paths |
| Cross-site scripting | CWE-79 | unescaped user data rendered into HTML/templates |
| Cleartext secret storage | CWE-312 | tokens/keys in config, env dumps, logs |
| Sensitive data in logs | CWE-532 | auth context logged on error paths |
| Missing authorization | CWE-862 | new endpoints/handlers without an access check |
| Weak crypto | CWE-327 | MD5/SHA1 for security, ECB, home-rolled primitives |
| Uncontrolled resource consumption | CWE-400 | unbounded loops/queries on user input |
| CI/CD script injection | CWE-78 (GH) | `${{ }}` interpolation of untrusted event fields in `run:` |
| Third-party action pinning | GH supply chain | actions referenced without a ref pin |

## Standards and hardening references

- OWASP Top 10 (2021) — the injection/broken-access-control/crypto families
  and their testing guidance.
- OWASP ASVS — verification levels for auth, session, and crypto controls.
- GitHub Actions security hardening — `permissions:` least privilege,
  `pull_request_target` pitfalls, third-party action pinning, secret
  forwarding rules, `A1C`/`A2C` mitigation patterns.
- Secret-handling doctrine — secrets enter via env/secret stores, never via
  code, config files, logs, CI annotations, or error messages; a secret in a
  diff is a BLOCKING credential-rotation event, not a style finding.

## Using the pack

A finding that names a class cites it inline, e.g.:
`🚨 **BLOCKING: SQL injection** (CWE-89, OWASP A03:2021)` — then the
`file:line` + input path + fix. The pack never substitutes for reading the
actual code: the citation discipline of the base contract binds every 🚨 to
the evidence the run read, not to the class name alone.
