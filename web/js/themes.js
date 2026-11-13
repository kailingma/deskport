// Terminal colour schemes for xterm.js. `ui` picks the surrounding chrome for the term area.

export const TERMINAL_THEMES = {
  'deskport-dark': {
    label: 'deskport dark',
    colors: {
      background: '#0f1012', foreground: '#e4e4e7', cursor: '#6b9cff', cursorAccent: '#0f1012', selectionBackground: '#2b3a5c',
      black: '#18181b', red: '#f2676b', green: '#4cc38a', yellow: '#e8b44d', blue: '#6b9cff', magenta: '#b98cf5', cyan: '#3fc2d1', white: '#d4d4d8',
      brightBlack: '#5f6068', brightRed: '#ff9a9c', brightGreen: '#7ee2b1', brightYellow: '#f5d27e', brightBlue: '#9dbdff', brightMagenta: '#d3b5ff', brightCyan: '#7edbe5', brightWhite: '#fafafa',
    },
  },
  'deskport-light': {
    label: 'deskport light',
    colors: {
      background: '#fbfbfb', foreground: '#26262b', cursor: '#2463eb', cursorAccent: '#fbfbfb', selectionBackground: '#cfdcfb',
      black: '#26262b', red: '#c7323a', green: '#1d8a4e', yellow: '#9a6a00', blue: '#2463eb', magenta: '#8a3fd1', cyan: '#0f7d8c', white: '#d4d4d8',
      brightBlack: '#6b6b74', brightRed: '#e0474f', brightGreen: '#26a861', brightYellow: '#b88400', brightBlue: '#4a80f5', brightMagenta: '#a35ae6', brightCyan: '#1597a8', brightWhite: '#f4f4f5',
    },
  },
  'solarized-dark': {
    label: 'Solarized dark',
    colors: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  'solarized-light': {
    label: 'Solarized light',
    colors: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  nord: {
    label: 'Nord',
    colors: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  'gruvbox-dark': {
    label: 'Gruvbox dark',
    colors: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
};

export const TERMINAL_FONTS = {
  system: { label: 'System monospace', family: 'ui-monospace, "SF Mono", Menlo, "Cascadia Code", "DejaVu Sans Mono", monospace' },
  jetbrains: { label: 'JetBrains Mono', family: '"JetBrains Mono Variable", ui-monospace, monospace', load: '"JetBrains Mono Variable"' },
  plex: { label: 'IBM Plex Mono', family: '"IBM Plex Mono", ui-monospace, monospace', load: '"IBM Plex Mono"' },
};
