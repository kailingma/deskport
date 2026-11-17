import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify } from './hosts.js';

const configDir = process.env.DESKPORT_CONFIG_DIR || path.join(os.homedir(), '.config', 'deskport');

// Load env files from the config dir. Values already in process.env win.
for (const name of ['deskport.env', 'rdp.env']) {
  const file = path.join(configDir, name);
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const env = process.env;

function list(value) {
  return (value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const config = {
  configDir,
  host: env.DESKPORT_HOST || '127.0.0.1',
  port: Number(env.DESKPORT_PORT || 7900),
  insecureDev: env.DESKPORT_INSECURE_DEV === '1',
  // With DESKPORT_INSECURE_DEV=1, who the page is signed in as. Unset, that is
  // dev@localhost and an admin; set, the admin lists and access.json apply.
  devEmail: (env.DESKPORT_DEV_EMAIL || '').trim().toLowerCase(),

  // This machine in a multi-host setup (docs/multi-host.md). The id appears in
  // /h/<id>/ paths, so it is a slug; the name is what a UI shows.
  self: {
    id: slugify(env.DESKPORT_HOST_ID || os.hostname()),
    name: env.DESKPORT_HOST_NAME || os.hostname(),
  },
  // DESKPORT_UI=0 runs the server without the web page: only the API and the
  // WebSockets, for a machine that another host's UI will control.
  ui: env.DESKPORT_UI !== '0',
  // This machine's host work runs in the agent shim, a child process that
  // talks to this server over the hub and agent protocol (docs/protocol.md).
  // DESKPORT_RELAY=0 runs it in this process instead.
  relay: env.DESKPORT_RELAY !== '0',
  hostsFile: path.join(configDir, 'hosts.json'),
  // Machines that joined this hub (hub/registry.js).
  agentsFile: env.DESKPORT_AGENTS_FILE || path.join(configDir, 'agents.json'),
  // Who may use which machine (hub/access.js), written by the admin page.
  accessFile: env.DESKPORT_ACCESS_FILE || path.join(configDir, 'access.json'),
  // Per-person preferences (hub/prefs.js).
  prefsFile: env.DESKPORT_PREFS_FILE || path.join(configDir, 'prefs.json'),
  // The key agent builds are signed with (hub/releases.js).
  releaseKeyFile: env.DESKPORT_RELEASE_KEY_FILE || path.join(configDir, 'release.key'),

  access: {
    // e.g. "myteam.cloudflareaccess.com"
    teamDomain: (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    // The Application Audience (AUD) tag from the Access application
    aud: env.CF_ACCESS_AUD || '',
    allowedEmails: list(env.DESKPORT_ALLOWED_EMAILS),
    // Admins use every machine and manage people, machines and join tokens.
    // Empty: everyone in DESKPORT_ALLOWED_EMAILS (hub/access.js).
    adminEmails: list(env.DESKPORT_ADMIN_EMAILS),
  },

  guacd: {
    host: env.GUACD_HOST || '127.0.0.1',
    port: Number(env.GUACD_PORT || 4822),
  },

  rdp: {
    hostname: env.RDP_HOST || '127.0.0.1',
    port: Number(env.RDP_PORT || 3390),
    username: env.RDP_USERNAME || '',
    password: env.RDP_PASSWORD || '',
    // The separate headless desktop (scripts/desktop-session.sh) uses the same credentials.
    sessionPort: Number(env.RDP_SESSION_PORT || 3391),
    sessionUnit: env.DESKPORT_SESSION_UNIT || 'deskport-session.service',
  },

  terminal: {
    tmuxSession: env.DESKPORT_TMUX_SESSION || 'web',
    cwd: env.DESKPORT_TERM_CWD || os.homedir(),
  },
};

export function validateConfig() {
  const problems = [];
  if (config.host !== '127.0.0.1' && config.host !== '::1' && config.host !== 'localhost') {
    problems.push(`DESKPORT_HOST must be a loopback address (got ${config.host}); expose it through cloudflared instead`);
  }
  if (!config.insecureDev) {
    if (!config.access.teamDomain) problems.push('CF_ACCESS_TEAM_DOMAIN is not set');
    if (!config.access.aud) problems.push('CF_ACCESS_AUD is not set');
  }
  if (!config.rdp.username || !config.rdp.password) problems.push('RDP_USERNAME / RDP_PASSWORD are not set (see rdp.env)');
  return problems;
}
