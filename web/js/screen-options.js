// Screen choices come from the selected machine, not the hub's desktop.
export const SCREEN_SOURCES = { mirror: 'My monitor', virtual: 'Extra monitor', session: 'Separate desktop' };
export const SCREEN_ENCODINGS = { images: 'Images', av1: 'AV1 video', h264: 'H.264 video' };

export function screenChoices(machine) {
  const offered = (field, labels, fallback) => {
    if (!machine.screen) return [];
    const known = Object.keys(labels).filter((v) => machine[field]?.includes(v));
    // Older machine lists have no metadata. Keep the hub's existing choices;
    // a joined machine gets only the portable baseline in that case.
    return known.length ? known : fallback;
  };
  return {
    sources: offered('screenSources', SCREEN_SOURCES, machine.local ? Object.keys(SCREEN_SOURCES) : ['mirror']),
    encodings: offered('screenEncodings', SCREEN_ENCODINGS, machine.local ? Object.keys(SCREEN_ENCODINGS) : ['images']),
  };
}

/** Use supported choices without overwriting the machine's saved preferences. */
export function pictureOptions(machine, get) {
  const { sources, encodings } = screenChoices(machine);
  const source = sources.includes(get('source')) ? get('source') : sources[0] ?? 'mirror';
  const encoding = encodings.includes(get('encoding')) ? get('encoding') : encodings[0] ?? 'images';
  return {
    source,
    encoding,
    matchMonitor: Boolean(machine.local && source === 'mirror' && get('matchMonitor')),
    monitor: machine.local ? get('monitor') : 'primary',
    direct: Boolean(machine.local && source === 'session' && encoding !== 'images' && get('direct')),
  };
}

/** Permission notices on portal streams (docs/protocol.md). */
export function portalPermissions(notice) {
  const waiting = notice.startsWith('Waiting for ');
  const control = !waiting && !notice.startsWith('View only:');
  return {
    waiting,
    control,
    clipboard: control && !notice.startsWith('Clipboard unavailable:') && !notice.includes('Clipboard sharing is unavailable.'),
  };
}
