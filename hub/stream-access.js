// Live Read/Edit changes apply before the WebSocket close handshake finishes.
// Clients refresh their machine access and reconnect after a level change.

export function createStreamAccess({ access, log }) {
  const streams = new Set();
  access.onChange(() => {
    for (const s of streams) {
      const allowed = access.canUse(s.email, s.machineId);
      const readOnly = !access.canEdit(s.email, s.machineId);
      if (allowed && readOnly === s.readOnly) continue;
      const reason = allowed ? 'permissions changed' : 'access removed';
      const code = allowed ? 4004 : 4003;
      log(`closing a stream of ${s.email} on ${s.machineId}: ${reason}`);
      s.ws.removeAllListeners('message');
      s.ws.emit('access-changed', code, reason);
      s.ws.close(code, reason);
      streams.delete(s);
    }
  });

  return {
    track(ws, email, machineId) {
      const readOnly = !access.canEdit(email, machineId);
      const stream = { ws, email, machineId, readOnly };
      streams.add(stream);
      ws.on('close', () => streams.delete(stream));
      return { readOnly };
    },
  };
}
