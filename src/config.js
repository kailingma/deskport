import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  access: {
    // e.g. "myteam.cloudflareaccess.com"
    teamDomain: (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    // The Application Audience (AUD) tag from the Access application
    aud: env.CF_ACCESS_AUD || '',
    allowedEmails: list(env.DESKPORT_ALLOWED_EMAILS),
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
