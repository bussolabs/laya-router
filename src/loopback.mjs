/**
 * Whether a request reaching a loopback proxy did not come from a local client. Binding to
 * 127.0.0.1 keeps other machines out, but not a web page in the user's browser: through DNS
 * rebinding the page reaches the proxy under its own host name, and a cross-site `text/plain`
 * POST needs no CORS preflight. Claude Code and Codex send `Host: 127.0.0.1:<port>` and no
 * `Origin`, so anything else is refused.
 */
export function isForeignRequest(headers, port) {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!local.includes(String(headers.host ?? "").toLowerCase())) return true;
  const origin = headers.origin;
  return origin !== undefined && !local.some((host) => origin.toLowerCase() === `http://${host}`);
}
