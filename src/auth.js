import { createRemoteJWKSet, jwtVerify } from 'jose';

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Returns an async function (req) => { email } that throws when the request
 * does not carry a valid Cloudflare Access token for this application.
 */
export function createAuthenticator({ insecureDev, access }) {
  if (insecureDev) {
    return async () => ({ email: 'dev@localhost', dev: true });
  }

  const issuer = `https://${access.teamDomain}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async function authenticate(req) {
    const token = req.headers['cf-access-jwt-assertion'] || readCookie(req.headers.cookie, 'CF_Authorization');
    if (!token) throw new AuthError('missing Cloudflare Access token');

    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience: access.aud }));
    } catch (err) {
      throw new AuthError(`invalid Cloudflare Access token: ${err.code || err.message}`);
    }

    const email = String(payload.email || '').toLowerCase();
    if (access.allowedEmails.length && !access.allowedEmails.includes(email)) {
      throw new AuthError(`${email || 'identity'} is not in DESKPORT_ALLOWED_EMAILS`);
    }
    return { email };
  };
}

export class AuthError extends Error {}

/** WebSocket upgrades must come from a page served by this same host. */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
